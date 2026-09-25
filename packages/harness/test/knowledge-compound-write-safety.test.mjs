import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInsightCompound } from '../lib/compound.mjs';
import { runRemember } from '../lib/knowledge/remember.mjs';
import { solutionsWriteTarget } from '../lib/project-layout.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('runInsightCompound does not write through a leftover symlinked docs/solutions directory', () => {
  const ws = tempDir('probeC-ws-');
  const copilotHome = tempDir('probeC-ch-');
  const home = tempDir('probeC-hh-');
  const outside = tempDir('probeC-outside-');

  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    flags: { title: 'probe insight', body: 'PROBE_C_WRITE_CONTENT should never land outside the workspace', category: 'insights' },
    log: () => {},
    kind: 'insight',
  });

  assert.equal(result.pass, true, JSON.stringify(result));
  const target = solutionsWriteTarget(ws, { home });
  assert.equal(target.kind, 'user');
  assert.ok(fs.existsSync(path.join(target.base, result.path)));
  assert.ok(!fs.existsSync(path.join(outside, 'insights')), 'nothing was written through the leftover symlink');
  assert.ok(fs.lstatSync(path.join(ws, 'docs', 'solutions')).isSymbolicLink(), 'the symlink itself is untouched');
});

test('runInsightCompound still writes normally when docs/solutions is a plain directory (no false-positive refusal)', () => {
  const ws = tempDir('probeC-ok-ws-');
  const copilotHome = tempDir('probeC-ok-ch-');
  const home = tempDir('probeC-ok-hh-');
  fs.mkdirSync(path.join(ws, 'docs', 'solutions'), { recursive: true });

  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    flags: { title: 'a normal insight', body: 'a normal insight body', category: 'insights' },
    log: () => {},
    kind: 'insight',
  });

  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.ok(result.path.startsWith('docs/solutions/insights/'));
  const target = solutionsWriteTarget(ws, { home });
  assert.equal(target.kind, 'user', 'an untracked leftover dir must not capture new episodes');
  assert.ok(fs.existsSync(path.join(target.base, result.path)), 'the episode file was actually written');
  assert.equal(fs.existsSync(path.join(ws, result.path)), false);
});

test('harness remember does not write its episode through a leftover symlinked docs/solutions directory', () => {
  const ws = tempDir('probeC-remember-ws-');
  const copilotHome = tempDir('probeC-remember-ch-');
  const harnessHome = tempDir('probeC-remember-hh-');
  const outside = tempDir('probeC-remember-outside-');

  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const result = runRemember({
    workspace: ws,
    copilotHome,
    home: harnessHome,
    flags: { trigger: 'a probe trigger for the leftover symlink remember case' },
    argv: ['a probe claim that must never land outside the workspace'],
    log: () => {},
  });

  assert.equal(result.pass, true, JSON.stringify(result));
  const target = solutionsWriteTarget(ws, { home: harnessHome });
  assert.equal(target.kind, 'user');
  assert.ok(fs.existsSync(path.join(target.base, result.episodePath)));
  assert.ok(fs.readdirSync(outside).length === 0, 'nothing was written through the leftover symlink');
});

test('runInsightCompound refuses when git-tracked docs/solutions is a symlink', () => {
  const ws = tempDir('probeC-ts-ws-');
  const copilotHome = tempDir('probeC-ts-ch-');
  const home = tempDir('probeC-ts-hh-');
  const outside = tempDir('probeC-ts-out-');
  trackWorkspaceSolutions(ws);
  fs.rmSync(path.join(ws, 'docs', 'solutions'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    flags: { title: 'tracked symlink', body: 'must not land outside via a tracked symlink' },
    log: () => {},
    kind: 'insight',
  });

  assert.equal(result.pass, true, JSON.stringify(result));
  const target = solutionsWriteTarget(ws, { home });
  assert.equal(target.kind, 'user');
  assert.ok(fs.existsSync(path.join(target.base, result.episodePath || result.path)));
  assert.ok(!fs.existsSync(path.join(outside, 'insights')), 'a tracked symlink is not the write target');
});
