#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  assertEqual,
  cleanup,
  git,
  initWorkspace,
  runHarness,
  writeEvidence,
} from './lib.mjs';

const SPEC_REL = 'docs/specs/overview.md';
const ADR_REL = 'docs/adr/0000-architecture.md';
const created = [];

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} stdout was not JSON: ${result.stdout}\n${result.stderr}`);
  }
}

try {
  const ctx = initWorkspace();
  created.push(ctx.ws, ctx.home, ctx.copilotHome);

  const hinted = runHarness(['orient', '--query', 'architecture'], ctx);
  assertEqual(hinted.status, 0, `orient hint exit (${hinted.stderr})`);
  const hintBody = parseJson(hinted, 'orient-hint');
  assertEqual((hintBody.intentSources || []).length, 0, 'orient intentSources before prepare');
  if (!(hintBody.nextTools || []).includes('harness prepare')) {
    throw new Error(`nextTools missing harness prepare: ${JSON.stringify(hintBody.nextTools)}`);
  }

  const prepared = runHarness(['prepare'], ctx);
  assertEqual(prepared.status, 0, `prepare exit (${prepared.stderr})`);
  const preparedBody = parseJson(prepared, 'prepare');
  assertEqual(preparedBody.created, 2, 'prepare created');
  assertEqual(preparedBody.git, true, 'prepare git');
  const specPath = path.join(ctx.ws, SPEC_REL);
  const adrPath = path.join(ctx.ws, ADR_REL);
  const specBody = fs.readFileSync(specPath, 'utf8');
  const adrBody = fs.readFileSync(adrPath, 'utf8');
  if (!specBody.includes('TODO') || !adrBody.includes('TODO')) {
    throw new Error('starter files are missing TODO');
  }

  const seen = runHarness(['orient', '--query', 'architecture'], ctx);
  assertEqual(seen.status, 0, `orient after prepare exit (${seen.stderr})`);
  const seenBody = parseJson(seen, 'orient-seen');
  const paths = (seenBody.intentSources || []).map((source) => source.path).sort();
  assertEqual(JSON.stringify(paths), JSON.stringify([ADR_REL, SPEC_REL]), 'orient paths');
  assertEqual(seenBody.intentSources.find((source) => source.path === SPEC_REL).kind, 'spec', 'spec kind');
  assertEqual(seenBody.intentSources.find((source) => source.path === ADR_REL).kind, 'adr', 'adr kind');

  const edited = '# Edited overview\n\nPO owns this file now.\n';
  fs.writeFileSync(specPath, edited);
  const skipped = runHarness(['prepare'], ctx);
  assertEqual(skipped.status, 0, `prepare skip exit (${skipped.stderr})`);
  const skippedBody = parseJson(skipped, 'prepare-skip');
  assertEqual(skippedBody.files.find((file) => file.path === SPEC_REL).status, 'skipped', 'spec skipped');
  assertEqual(fs.readFileSync(specPath, 'utf8'), edited, 'edited spec kept');

  const ignoredCtx = initWorkspace();
  created.push(ignoredCtx.ws, ignoredCtx.home, ignoredCtx.copilotHome);
  fs.writeFileSync(path.join(ignoredCtx.ws, '.gitignore'), 'docs/\n');
  git(ignoredCtx.ws, ['add', '--', '.gitignore']);
  git(ignoredCtx.ws, ['commit', '-qm', 'ignore docs']);
  const ignored = runHarness(['prepare'], ignoredCtx);
  assertEqual(ignored.status, 0, `prepare ignore exit (${ignored.stderr})`);
  const ignoredBody = parseJson(ignored, 'prepare-ignore');
  assertEqual(ignoredBody.created, 0, 'ignored created');
  if (!ignoredBody.files.every((file) => file.status === 'ignored')) {
    throw new Error(`expected ignored statuses: ${JSON.stringify(ignoredBody.files)}`);
  }
  if (fs.existsSync(path.join(ignoredCtx.ws, SPEC_REL)) || fs.existsSync(path.join(ignoredCtx.ws, ADR_REL))) {
    throw new Error('gitignored prepare wrote a starter file');
  }
  const ignoredOrient = runHarness(['orient', '--query', 'architecture'], ignoredCtx);
  assertEqual(ignoredOrient.status, 0, `orient ignore exit (${ignoredOrient.stderr})`);
  const ignoredOrientBody = parseJson(ignoredOrient, 'orient-ignore');
  if (!(ignoredOrientBody.nextTools || []).includes('un-ignore docs/specs and docs/adr, then harness prepare')) {
    throw new Error(`nextTools missing un-ignore hint: ${JSON.stringify(ignoredOrientBody.nextTools)}`);
  }

  const evidence = writeEvidence('prepare', {
    feature: 'prepare',
    steps: [
      { command: 'orient before prepare', exit: hinted.status, intentSources: hintBody.intentSources, nextTools: hintBody.nextTools },
      { command: 'prepare', exit: prepared.status, created: preparedBody.created, files: preparedBody.files },
      { command: 'orient after prepare', exit: seen.status, intentSources: seenBody.intentSources },
      { command: 'prepare after edit', exit: skipped.status, files: skippedBody.files, spec: edited },
      { command: 'prepare with docs gitignored', exit: ignored.status, files: ignoredBody.files, nextTools: ignoredOrientBody.nextTools },
    ],
  });
  process.stdout.write(`prove-prepare passed\n${evidence.dest}\n${evidence.copied || ''}\n`);
} finally {
  cleanup(created);
}
