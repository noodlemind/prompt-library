import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { applyRetired, syncAssetsToTarget } from '../lib/sync.mjs';
import { parsePlanFrontmatter } from '../lib/plan-parse.mjs';
import { scanPlansForGate } from '../lib/gate.mjs';
import { CONTEXT_PACK_MAX_BYTES, buildContextPack } from '../lib/context-pack.mjs';
import { extractGoalFromPlan } from '../lib/plan-goal.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { createEvidenceBinding, readEvidence, validateEvidence, writeEvidence } from '../lib/evidence.mjs';
import { ensureHarnessDir } from '../lib/session.mjs';
import { installGlobalHarnessShim, globalHarnessShimPath, INSTALL_FIX_HINT } from '../lib/global-bin.mjs';
import { harnessRunnerSource, RUNNER_VERSION, writeHarnessRunner } from '../lib/resolve-harness-bin.mjs';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { recordSkillUsage } from '../lib/telemetry.mjs';
import { mergeVSCodeSettings, parseVSCodeSettings } from '../lib/vscode-settings.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { validatePlanScope } from '../lib/plan-scope.mjs';
import { listCommands } from '../lib/registry.mjs';
import { HELP_COMMAND_ORDER } from '../bin/harness.mjs';
import YAML from 'yaml';
import { approveProject } from '../lib/trust.mjs';
import { tempDir, runHarness, writePlan, packageRoot, binPath } from './helpers/index.mjs';
import {
  writeKnowledgeSolution,
  runIndex,
  writeProductSolution,
  writeChecks,
  writeVersionedPlan,
  initGit,
  runHook,
  runHookWithPolicy,
  hookResponse,
  assertHookBlocked,
  recordSuccessfulEdit,
} from './helpers/cli-fixtures.mjs';

function readEvents(workspace) {
  const eventsPath = path.join(workspace, '.harness', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('lifecycle commands append schema-v2 events and omit non-lifecycle commands', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });

  assert.equal(
    runHarness(['orient', '--query', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json']).status,
    0
  );
  assert.equal(runHarness(['gate', '--workspace', workspace, '--json']).status, 0);
  assert.equal(
    runHarness(['recall', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json']).status,
    0
  );

    const events = readEvents(workspace);
  assert.deepEqual(events.map((event) => event.type), [
    'command.start', 'orient', 'command.result',
    'command.start', 'gate', 'command.result',
    'command.start', 'recall', 'command.result',
  ]);
  for (const [index, event] of events.entries()) {
    assert.equal(event.version, 2);
    assert.match(event.id, /.+/);
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(['pass', 'warn', 'fail', 'pending'].includes(event.result));
        if (index === 0) assert.ok(event.session === null || /.+/.test(event.session));
    else assert.match(event.session, /.+/);
    assert.equal(event.host, 'harness-cli');
  }
  assert.deepEqual(
    events.filter((e) => e.type === 'command.start').map((e) => e.result),
    ['pending', 'pending', 'pending']
  );
  assert.deepEqual(
    events.filter((e) => e.type === 'command.result').map((e) => e.result),
    ['pass', 'pass', 'pass']
  );
});

test('lifecycle events carry gen_ai.usage token estimates and events --summary rolls them up', () => {
  const workspace = tempDir('harness-usage-');
  const copilotHome = tempDir('harness-copilot-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  assert.equal(
    runHarness(['orient', '--query', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome]).status,
    0
  );
  assert.equal(runHarness(['gate', '--workspace', workspace]).status, 0);

  const events = readEvents(workspace);
  const orient = events.find((e) => e.type === 'orient');
  assert.ok(orient?.usage, 'orient event must carry usage');
  assert.ok(Number.isInteger(orient.usage['gen_ai.usage.input_tokens']));
  assert.ok(orient.usage['gen_ai.usage.output_tokens'] > 0, 'orient output tokens reflect the context pack');
  assert.equal(orient.usage.estimated, true);

  const summary = runHarness(['events', '--summary', '--workspace', workspace]);
  assert.equal(summary.status, 0);
  assert.match(summary.stdout, /tokens\s+in=\d+ out=\d+ total=\d+ · est/);
  assert.match(summary.stdout, /orient\s+\d+/);
});

test('gate human output is answer-first and hides passing checks unless verbose', () => {
  const workspace = tempDir('harness-terse-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  const terse = runHarness(['gate', '--workspace', workspace]);
  assert.equal(terse.status, 0, terse.stderr);
  const lines = terse.stdout.trim().split('\n');
  // Piped output degrades to the ascii surface: [ok]/[x] glyph, -> arrow.
  assert.match(lines[0], /^(\[ok\]|\[x\])\s+gate\s+(pass|blocked)/);
  assert.ok(!/^\[ok\]\s+C1/m.test(terse.stdout), 'passing checks are hidden by default');
  assert.match(terse.stdout, /^-> /m);

  const verbose = runHarness(['gate', '--workspace', workspace, '--verbose']);
  assert.match(verbose.stdout, /^\[ok\]\s+C1/m);
});

test('json output is compact by default and pretty only with --verbose', () => {
  const workspace = tempDir('harness-json-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  const compact = runHarness(['gate', '--workspace', workspace, '--json']);
  assert.equal(compact.stdout.trim().split('\n').length, 1, 'compact json is a single line');
  assert.equal(JSON.parse(compact.stdout).pass, true);

  const pretty = runHarness(['gate', '--workspace', workspace, '--json', '--verbose']);
  assert.ok(pretty.stdout.trim().split('\n').length > 1, 'verbose json is pretty-printed');
  assert.equal(JSON.parse(pretty.stdout).pass, true);
});

test('events output is bounded and never dumps full history', () => {
  const workspace = tempDir('harness-bounded-');
  const eventDir = path.join(workspace, '.harness');
  fs.mkdirSync(eventDir, { recursive: true });
  const many = Array.from({ length: 60 }, (_, i) => ({ version: 2, type: 'gate', session: 's', result: 'pass' }));
  fs.writeFileSync(path.join(eventDir, 'events.jsonl'), `${many.map(JSON.stringify).join('\n')}\n`);

  const dflt = JSON.parse(runHarness(['events', '--workspace', workspace, '--json']).stdout);
  assert.equal(dflt.count, 20, 'default caps at 20');
  assert.equal(dflt.totalMatched, 60);

  const zero = JSON.parse(runHarness(['events', '--workspace', workspace, '--limit=0', '--json']).stdout);
  assert.equal(zero.count, 20, '--limit=0 no longer dumps everything');

  const huge = JSON.parse(runHarness(['events', '--workspace', workspace, '--limit=99999', '--json']).stdout);
  assert.ok(huge.count <= 200, 'a huge limit is capped at the hard ceiling');
});

test('event logging can be disabled', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');

  const noEventsResult = runHarness([
    'recall',
    'orders timeout',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--no-events',
    '--json',
  ]);
  const envResult = runHarness(
    ['recall', 'checkout timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json'],
    { env: { HARNESS_NO_EVENTS: '1' } }
  );

  assert.equal(noEventsResult.status, 0, noEventsResult.stderr);
  assert.equal(envResult.status, 0, envResult.stderr);
  assert.deepEqual(readEvents(workspace), []);
});

test('events command returns aggregate json output', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  runHarness(['gate', '--workspace', workspace, '--json']);

  const result = runHarness(['events', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
    assert.equal(body.count, 3);
  assert.equal(body.summary.total, 3);
  assert.equal(body.summary.lastActivePlan, 'docs/plans/2026-05-22-fix-example-plan.md');
  assert.deepEqual(body.events.map((e) => e.type), ['command.start', 'gate', 'command.result']);
});

test('events command filters by session and failures and supports summary-only output', () => {
  const workspace = tempDir('harness-workspace-');
  const eventDir = path.join(workspace, '.harness');
  fs.mkdirSync(eventDir, { recursive: true });
  const events = [
    { version: 2, type: 'pre_tool', session: 's1', result: 'pass', decision: 'allow' },
    { version: 2, type: 'pre_tool', session: 's1', result: 'fail', decision: 'block', blockedReason: 'missing gate' },
    { version: 2, type: 'verify', session: 's2', result: 'pass', decision: null },
  ];
  fs.writeFileSync(path.join(eventDir, 'events.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`);

  const bySession = JSON.parse(runHarness(['events', '--workspace', workspace, '--session', 's1', '--json']).stdout);
  assert.equal(bySession.count, 2);
  assert.ok(bySession.events.every((event) => event.session === 's1'));

  const failures = JSON.parse(runHarness(['events', '--workspace', workspace, '--failures', '--json']).stdout);
  assert.equal(failures.count, 1);
  assert.equal(failures.events[0].decision, 'block');

  const summary = JSON.parse(runHarness(['events', '--workspace', workspace, '--summary', '--json']).stdout);
  assert.equal(summary.summary.total, 3);
  assert.equal(Object.hasOwn(summary, 'events'), false);
});

test('events omit prompt and query content entirely', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const query = `${'x'.repeat(130)}SECRET-TAIL`;

  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  const result = runHarness(['orient', '--query', query, '--workspace', workspace, '--copilot-home', copilotHome, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const raw = fs.readFileSync(path.join(workspace, '.harness', 'events.jsonl'), 'utf8');
  const [event] = readEvents(workspace);
  assert.equal(Object.hasOwn(event, 'queryPreview'), false);
  assert.equal(Object.hasOwn(event, 'queryHash'), false);
  assert.equal(raw.includes('orders timeout'), false);
  assert.equal(raw.includes('SECRET-TAIL'), false);
  assert.equal(raw.includes('## Overview'), false);
});

test('harness verify --learnings threads cited learning ids onto the verify event', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 2;\n');

  const result = runHarness([
    'verify',
    '--plan',
    plan,
    '--base',
    'HEAD',
    '--workspace',
    workspace,
    '--learnings',
    'a/b,c/d',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const events = fs
    .readFileSync(path.join(workspace, '.harness', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const verifyEvent = events.find((e) => e.type === 'verify');
  assert.ok(verifyEvent, JSON.stringify(events));
  assert.deepEqual(verifyEvent.learnings, ['a/b', 'c/d']);
});
