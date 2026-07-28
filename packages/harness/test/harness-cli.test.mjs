import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
import { installGlobalHarnessShim, globalHarnessShimPath } from '../lib/global-bin.mjs';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { recordSkillUsage } from '../lib/telemetry.mjs';
import { mergeVSCodeSettings, parseVSCodeSettings } from '../lib/vscode-settings.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { validatePlanScope } from '../lib/plan-scope.mjs';
import YAML from 'yaml';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHarness(args, options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
}

function writePlan(workspace, { frontmatter = '', activity = '- Plan created.' } = {}) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, '2026-05-22-fix-example-plan.md');
  fs.writeFileSync(
    planPath,
    `---
title: "Fix example"
status: in-progress
plan_lock: true
phase: 1
${frontmatter}---

# Fix example

## Overview

Do the work.

## Intent Contract

- **Goal:** Fix example
- **Expected outputs:** code change
- **Success criteria:** tests pass

## Acceptance Criteria

- [ ] Example is fixed.

## Verification Plan

Run the relevant test command.

## Impacted Files

- src/example.ts

## Activity

${activity}
`,
    'utf8'
  );
  return planPath;
}

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

test('help works from a clean repo checkout without installed package deps', () => {
  const result = runHarness(['help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /^setup\s+install · upgrade/m);
  assert.match(result.stdout, /@dev-kit\/harness/);
  assert.match(result.stdout, /^harness /);
});

test('recall positional query excludes option values', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const result = runHarness([
    'recall',
    'orders timeout',
    '--limit',
    '3',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).query, 'orders timeout');
});

test('plan frontmatter parser handles strings and inline arrays', () => {
  const fm = parsePlanFrontmatter(`---
title: "Fix example"
intent: "Make intent parseable"
expected_outputs: ["gate warning", "event log"]
success_criteria: [tests pass, "json output"]
verification_commands: []
org_objectives: ["platform reliability"]
---
`);

  assert.equal(fm.intent, 'Make intent parseable');
  assert.deepEqual(fm.expected_outputs, ['gate warning', 'event log']);
  assert.deepEqual(fm.success_criteria, ['tests pass', 'json output']);
  assert.deepEqual(fm.verification_commands, []);
  assert.deepEqual(fm.org_objectives, ['platform reliability']);
});

test('validate-plan reports malformed YAML frontmatter as a schema failure', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('title: "Verify example"', 'title: [unterminated'));

  const result = runHarness(['validate-plan', '--plan', plan, '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.match(body.checks.find((check) => check.id === 'P-schema')?.message || '', /Invalid YAML frontmatter/i);
});

test('gate rejects malformed policy files and invalid enforcement overrides', () => {
  const workspace = tempDir('harness-workspace-');
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'policy.yaml'), 'version: 1\nenforcement: [unterminated\n', 'utf8');

  const malformed = runHarness(['gate', '--workspace', workspace, '--json']);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Invalid harness policy/i);

  fs.writeFileSync(path.join(configDir, 'policy.yaml'), 'enforcement: enforce\n', 'utf8');
  const missingVersion = runHarness(['gate', '--workspace', workspace, '--json']);
  assert.equal(missingVersion.status, 1);
  assert.match(missingVersion.stderr, /expected version 1/i);

  fs.writeFileSync(path.join(configDir, 'policy.yaml'), 'version: 1\nenforcement: enforce\n', 'utf8');
  const invalidOverride = runHarness(['gate', '--enforcement=warn=typo', '--workspace', workspace, '--json']);
  assert.equal(invalidOverride.status, 1);
  assert.match(invalidOverride.stderr, /Invalid enforcement mode: warn=typo/i);
});

test('gate scan skips malformed plan frontmatter and continues to a locked plan', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'a-malformed.md'), '---\ntitle: [unterminated\n---\n', 'utf8');
  fs.writeFileSync(path.join(plansDir, 'b-locked.md'), '---\nplan_lock: true\n---\n', 'utf8');

  assert.equal(scanPlansForGate(workspace), 'docs/plans/b-locked.md');
});

test('harness artifact paths do not collide for same-named plans in different directories', () => {
  const workspace = tempDir('harness-workspace-');
  const first = writeEvidence(workspace, { plan: 'docs/plans/team-a/change.md', outcome: 'passed', checks: [] });
  const second = writeEvidence(workspace, { plan: 'docs/plans/team-b/change.md', outcome: 'failed', checks: [] });

  assert.notEqual(first, second);
  assert.equal(readEvidence(workspace, 'docs/plans/team-a/change.md')?.outcome, 'passed');
  assert.equal(readEvidence(workspace, 'docs/plans/team-b/change.md')?.outcome, 'failed');
});

test('evidence metadata is authoritative and malformed hashed evidence falls back to legacy', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = 'docs/plans/change.md';
  const rel = writeEvidence(workspace, {
    version: 999,
    verifiedAt: '2000-01-01T00:00:00.000Z',
    evidencePath: 'caller-controlled.json',
    plan,
    outcome: 'passed',
    checks: [],
  });
  const generated = JSON.parse(fs.readFileSync(path.join(workspace, rel), 'utf8'));
  assert.equal(generated.version, 2);
  assert.notEqual(generated.verifiedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(generated.evidencePath, rel);

  fs.writeFileSync(path.join(workspace, rel), '{malformed', 'utf8');
  const legacy = path.join(workspace, '.harness', 'evidence', 'change.json');
  fs.writeFileSync(legacy, JSON.stringify({ plan, outcome: 'failed' }), 'utf8');
  assert.equal(readEvidence(workspace, plan)?.outcome, 'failed');
});

test('malformed evidence bindings fail closed without crashing validation', () => {
  const workspace = tempDir('harness-workspace-');
  const planPath = writeVersionedPlan(workspace);
  initGit(workspace);
  const plan = loadPlan(workspace, planPath);
  const binding = createEvidenceBinding({ workspace, plan, base: 'HEAD', changedFiles: [] });
  binding.changedFiles = 'not-an-array';

  const result = validateEvidence({
    workspace,
    plan,
    evidence: {
      version: 2,
      plan: planPath,
      outcome: 'passed',
      verifiedAt: new Date().toISOString(),
      binding,
    },
  });

  assert.equal(result.pass, false);
  assert.match(result.message, /not bound|binding.*invalid/i);
});

test('harness gitignore matching uses complete lines and preserves missing newline boundaries', () => {
  const workspace = tempDir('harness-workspace-');
  const harnessDir = path.join(workspace, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(path.join(harnessDir, '.gitignore'), '# evidence/ is documented here\ncontext-pack.md', 'utf8');

  ensureHarnessDir(workspace, false);

  const lines = fs.readFileSync(path.join(harnessDir, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(lines.includes('context-pack.md'));
  assert.ok(lines.includes('events.jsonl'));
  assert.ok(lines.includes('evidence/'));
  assert.ok(lines.includes('session.json'));
});

test('verify gate requires executed verification evidence, not just a plan heading', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-05-22-fix-example-plan.md'),
    `---
title: "Fix example"
status: in-progress
plan_lock: true
phase: 1
intent: "Fix example safely"
expected_outputs: ["code change"]
success_criteria: ["tests pass"]
---

# Fix example

## Overview

Do the work.

## Acceptance Criteria

- [ ] Example is fixed.

## Verification Plan

Run the relevant test command.

## Activity

- Plan created.
`,
    'utf8'
  );

  const result = runHarness([
    'gate',
    '--phase',
    'verify',
    '--workspace',
    workspace,
    '--json',
  ]);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.exitCode, 1);
  assert.equal(body.checks.find((check) => check.id === 'V1')?.pass, false);
  assert.equal(body.nextTools.includes('harness compound'), false);
});

test('gate rejects unsupported phases instead of bypassing lifecycle checks', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const result = runHarness(['gate', '--phase', 'typo', '--plan', plan, '--workspace', workspace, '--json']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid --phase/i);
});

test('implement gate rejects a terminal explicit plan', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('status: in-progress', 'status: done'), 'utf8');

  const result = runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  assert.match(JSON.parse(result.stdout).blockedReason, /not implementable/i);
});

test('verify gate accepts passed harness evidence, not activity prose', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  const verify = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);
  assert.equal(verify.status, 0, verify.stderr);

  const result = runHarness([
    'gate',
    '--phase',
    'verify',
    '--plan',
    plan,
    '--workspace',
    workspace,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'V1')?.pass, true);
});

test('gate warns by default when locked plan lacks intent contract', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace);

  const result = runHarness(['gate', '--workspace', workspace, '--json']);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.equal(body.exitCode, 2);
  assert.equal(body.checks.find((check) => check.id === 'I1')?.severity, 'warn');
  assert.equal(body.checks.find((check) => check.id === 'I2')?.severity, 'warn');
  assert.equal(body.checks.find((check) => check.id === 'I3')?.severity, 'warn');
});

test('gate strict intent fails when locked plan lacks intent contract', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace);

  const result = runHarness(['gate', '--workspace', workspace, '--strict-intent', '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.checks.find((check) => check.id === 'I1')?.severity, 'fail');
});

test('gate passes intent checks when locked plan has intent contract', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });

  const result = runHarness(['gate', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'I1')?.pass, true);
  assert.equal(body.checks.find((check) => check.id === 'I2')?.pass, true);
  assert.equal(body.checks.find((check) => check.id === 'I3')?.pass, true);
});

test('gate directs a planned plan through in-progress and a fresh gate before edits', () => {
  const workspace = tempDir('harness-workspace-');
  const planPath = writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace('status: in-progress', 'status: planned'));

  const result = runHarness(['gate', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.match(body.nextTools[0], /status to in-progress/i);
  assert.match(body.nextTools[1], /harness gate --phase implement/i);
  assert.match(body.nextTools[2], /only after the fresh gate passes/i);
});

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
  assert.deepEqual(events.map((event) => event.type), ['orient', 'gate']);
  for (const event of events) {
    assert.equal(event.version, 2);
    assert.match(event.id, /.+/);
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(['pass', 'warn', 'fail'].includes(event.result));
    assert.match(event.session, /.+/);
    assert.equal(event.host, 'harness-cli');
  }
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
  assert.equal(body.count, 1);
  assert.equal(body.summary.total, 1);
  assert.equal(body.summary.lastActivePlan, 'docs/plans/2026-05-22-fix-example-plan.md');
  assert.equal(body.events[0].type, 'gate');
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

test('preserved knowledge files are not reported as harness-owned', () => {
  const assetsRoot = tempDir('harness-assets-');
  const targetRoot = tempDir('harness-target-');
  const rel = path.join('knowledge', 'solutions', '.gitkeep');
  fs.mkdirSync(path.dirname(path.join(assetsRoot, rel)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(targetRoot, rel)), { recursive: true });
  fs.writeFileSync(path.join(assetsRoot, rel), '', 'utf8');
  fs.writeFileSync(path.join(targetRoot, rel), '', 'utf8');

  const stats = syncAssetsToTarget(
    assetsRoot,
    targetRoot,
    {
      dryRun: false,
      preserveKnowledge: true,
      verbose: false,
    },
    () => {}
  );

  assert.equal(stats.skipped, 1);
  assert.deepEqual(stats.files, []);
});

test('hook install rewrites source cwd to the hydrated user hook directory', () => {
  const assetsRoot = tempDir('harness-assets-');
  const targetRoot = tempDir('harness-target-');
  const hooksDir = path.join(assetsRoot, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'gate.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(
    path.join(hooksDir, 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node gate.mjs', cwd: '.github/hooks' }] }],
      },
    })
  );

  syncAssetsToTarget(assetsRoot, targetRoot, { dryRun: false, preserveKnowledge: true, verbose: false }, () => {});

  const installed = JSON.parse(fs.readFileSync(path.join(targetRoot, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(installed.hooks.PreToolUse[0].hooks[0].cwd, path.join(targetRoot, 'hooks'));
});

test('VS Code configuration explicitly discovers hydrated user hooks', () => {
  const settings = mergeVSCodeSettings({ 'chat.hookFilesLocations': { 'custom/hooks': true } });
  assert.equal(settings['chat.hookFilesLocations']['custom/hooks'], true);
  assert.equal(settings['chat.hookFilesLocations']['~/.copilot/hooks'], true);
});

test('VS Code settings parser preserves URL strings and accepts JSONC comments', () => {
  const settings = parseVSCodeSettings(`{
    // User setting
    "service.url": "https://example.test/path", // inline comment
    /* existing hook */
    "chat.hookFilesLocations": {"custom/hooks": true,},
  }`);
  assert.equal(settings['service.url'], 'https://example.test/path');
  assert.equal(settings['chat.hookFilesLocations']['custom/hooks'], true);
});

test('VS Code doctor distinguishes a missing installed hook bundle from package assets', () => {
  const copilotHome = tempDir('harness-copilot-');
  const assetsRoot = tempDir('harness-assets-');
  const workspace = tempDir('harness-workspace-');
  const sourceHooks = path.resolve(packageRoot, '../../.github/hooks');
  fs.cpSync(sourceHooks, path.join(assetsRoot, 'hooks'), { recursive: true });
  const settingsPath = path.join(tempDir('harness-vscode-'), 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(mergeVSCodeSettings({})));

  const result = runDoctor({
    copilotHome,
    assetsRoot,
    pkgRoot: packageRoot,
    flags: { workspace, host: 'vscode' },
    vscodeSettingsPaths: [settingsPath],
  });

  assert.equal(fs.existsSync(path.join(assetsRoot, 'hooks', 'hooks.json')), true);
  assert.equal(fs.existsSync(path.join(copilotHome, 'hooks')), false);
  assert.equal(result.checks.find((check) => check.id === 'V1')?.pass, false);
});

test('VS Code doctor proves discovery, gate, post-tool, and completion behavior', () => {
  const copilotHome = tempDir('harness-copilot-');
  const assetsRoot = tempDir('harness-assets-');
  const workspace = tempDir('harness-workspace-');
  const sourceHooks = path.resolve(packageRoot, '../../.github/hooks');
  fs.cpSync(sourceHooks, path.join(assetsRoot, 'hooks'), { recursive: true });
  syncAssetsToTarget(assetsRoot, copilotHome, { dryRun: false, preserveKnowledge: true, verbose: false }, () => {});
  const settingsPath = path.join(tempDir('harness-vscode-'), 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(mergeVSCodeSettings({})));

  const result = runDoctor({
    copilotHome,
    assetsRoot,
    pkgRoot: packageRoot,
    flags: { workspace, host: 'vscode' },
    vscodeSettingsPaths: [settingsPath],
  });
  const hostChecks = result.checks.filter((check) => /^V\d+$/.test(check.id));

  assert.deepEqual(hostChecks.map((check) => check.id), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9']);
  assert.ok(hostChecks.every((check) => check.pass), JSON.stringify(hostChecks, null, 2));
});

test('retired cleanup refuses paths outside copilot home', () => {
  const parent = tempDir('harness-parent-');
  const copilotHome = path.join(parent, 'copilot');
  const outside = path.join(parent, 'outside-retired');
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete', 'utf8');

  const stats = applyRetired(
    copilotHome,
    ['../outside-retired'],
    { files: ['../outside-retired'] },
    { dryRun: false },
    () => {}
  );

  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
  assert.equal(stats.removed, 0);
  assert.equal(stats.skipped, 1);
});

test('uninstall refuses lock paths outside copilot home', () => {
  const parent = tempDir('harness-parent-');
  const copilotHome = path.join(parent, 'copilot');
  const outside = path.join(parent, 'outside-uninstall');
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete', 'utf8');
  fs.writeFileSync(
    path.join(copilotHome, '.harness-lock.json'),
    JSON.stringify({ files: ['../outside-uninstall'] }, null, 2),
    'utf8'
  );

  const result = runHarness(['uninstall', '--copilot-home', copilotHome]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
});

test('orient context-pack includes Goal Intent Contract from active plan', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });

  const result = runHarness([
    'orient',
    '--query',
    'fix example',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.planGoal);
  assert.equal(body.planGoal.intent, 'Fix example safely');
  assert.deepEqual(body.planGoal.success_criteria, ['tests pass']);

  const pack = fs.readFileSync(path.join(workspace, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /## Goal \(Intent Contract\)/);
  assert.match(pack, /Fix example safely/);
  assert.match(pack, /Intent Contract \(excerpt\)/);
});

test('validate-plan strict-intent fails locked plan with empty intent contract', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, 'empty-intent-plan.md'),
    `---
title: "Empty intent"
status: planned
plan_lock: true
phase: 1
intent: "Do something"
success_criteria: ["done"]
expected_outputs: ["change"]
---

# Empty intent

## Overview

Overview text.

## Intent Contract

- **Goal:**
- **Expected outputs:**
- **Success criteria:**

## Acceptance Criteria

- [ ] Done.

## Verification Plan

Run tests.

## Impacted Files

- src/example.ts

## Activity

- Created.
`,
    'utf8'
  );

  const result = runHarness([
    'validate-plan',
    '--plan',
    'docs/plans/empty-intent-plan.md',
    '--workspace',
    workspace,
    '--strict-intent',
    '--json',
  ]);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.checks.find((c) => c.id === 'S5')?.pass, false);
});

test('extractGoalFromPlan reads intent contract and frontmatter', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  const plan = loadPlan(workspace, 'docs/plans/2026-05-22-fix-example-plan.md');
  const goal = extractGoalFromPlan(plan);
  assert.equal(goal.planPath, 'docs/plans/2026-05-22-fix-example-plan.md');
  assert.equal(goal.intent, 'Fix example safely');
  assert.deepEqual(goal.success_criteria, ['tests pass']);
  assert.ok(goal.intentContractExcerpt.includes('Fix example'));
});

test('context pack stays within byte budget cap', () => {
  const recall = Array.from({ length: 20 }, (_, i) => ({
    title: `Solution ${i}`,
    path: `knowledge/solutions/cat/s-${i}.md`,
    score: 0.9,
    summary: 'x'.repeat(200),
  }));
  const body = buildContextPack({
    query: 'a'.repeat(500),
    recall,
    plans: Array.from({ length: 10 }, (_, i) => ({
      path: `docs/plans/plan-${i}.md`,
      status: 'in-progress',
      plan_lock: true,
      score: 0.5,
    })),
    activePlan: {
      path: 'docs/plans/active.md',
      status: 'in-progress',
      plan_lock: true,
      phase: 1,
      memoryExcerpt: 'y'.repeat(1500),
    },
    gatePreview: { pass: false, blockedReason: 'blocked'.repeat(50) },
    nextTools: ['harness gate'],
  });
  assert.ok(Buffer.byteLength(body, 'utf8') <= CONTEXT_PACK_MAX_BYTES);
  assert.match(body, /truncated to 2KB budget/);
});

test('context pack truncation never splits a multibyte character, whatever the cut point', () => {
  // é is 2 bytes, ✓ and € are 3 bytes, 🎉 is 4 bytes (a surrogate pair in
  // UTF-16) — a long run of each so the fixed truncation cut point (a
  // constant byte offset from the top of the pack) is guaranteed to fall
  // somewhere inside this block once the query is long enough to force
  // truncation, regardless of how many bytes precede it.
  const multibyte = 'é'.repeat(300) + '✓'.repeat(300) + '€'.repeat(300) + '🎉'.repeat(300);
  // Shifting the block by 1..16 leading ASCII bytes walks the fixed cut
  // point through every possible sub-character byte offset (mod 2, 3, and
  // 4), so across this range every multibyte width gets cut mid-character
  // at least once.
  for (let pad = 0; pad < 16; pad++) {
    const body = buildContextPack({ query: 'a'.repeat(pad) + multibyte, recall: [], plans: [], learnings: [] });
    assert.ok(
      Buffer.byteLength(body, 'utf8') <= CONTEXT_PACK_MAX_BYTES,
      `pad=${pad}: byte length must stay within the budget`
    );
    assert.ok(!body.includes('�'), `pad=${pad}: no replacement character from a split multibyte sequence`);
  }
});

test('validate-plan fails when required sections missing', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, 'bad-plan.md'),
    `---
title: "Bad"
status: open
plan_lock: false
---

# Bad

## Overview

Only overview.
`,
    'utf8'
  );

  const result = runHarness([
    'validate-plan',
    '--plan',
    'docs/plans/bad-plan.md',
    '--workspace',
    workspace,
    '--json',
  ]);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.checks.find((c) => c.id === 'P-schema')?.pass, false);
  assert.equal(body.checks.find((c) => c.id === 'S2')?.pass, false);
});

test('validate-plan passes a complete versioned locked plan', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const result = runHarness(['validate-plan', '--plan', plan, '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.equal(body.checks.find((c) => c.id === 'S4')?.pass, true);
});

test('validate-plan and gate reject pre-completed planned work and output-irrelevant checks', () => {
  const workspace = tempDir('harness-workspace-');
  const sentinel = path.join(workspace, 'schema-check-ran');
  const plan = writeVersionedPlan(workspace, {
    required: ['schema-validation'],
    criteria: { AC1: ['schema-validation'] },
    impacted: ['docs/upgrade-guide.md'],
  });
  writeChecks(workspace, {
    'fixture-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
    'schema-validation': { command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`] },
  });
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs
      .readFileSync(full, 'utf8')
      .replace('status: in-progress', 'status: planned')
      .replace('  - "verified change"', '  - "docs/upgrade-guide.md"'),
    'utf8'
  );

  const invalid = runHarness(['validate-plan', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(invalid.status, 1, invalid.stderr);
  const invalidBody = JSON.parse(invalid.stdout);
  assert.match(invalidBody.blockedReason, /planned plan cannot claim completed work/i);
  assert.match(invalidBody.blockedReason, /schema-focused check schema-validation is not relevant/i);

  const invalidGate = runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(invalidGate.status, 1, invalidGate.stderr);
  assert.match(JSON.parse(invalidGate.stdout).blockedReason, /schema-focused check schema-validation is not relevant/i);

  const invalidVerify = runHarness(['verify', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(invalidVerify.status, 1, invalidVerify.stderr);
  const invalidVerifyBody = JSON.parse(invalidVerify.stdout);
  assert.equal(invalidVerifyBody.checks.find((check) => check.id === 'plan-readiness')?.status, 'failed');
  assert.equal(fs.existsSync(sentinel), false, 'irrelevant named check must not execute');

  fs.writeFileSync(
    full,
    fs
      .readFileSync(full, 'utf8')
      .replaceAll('schema-validation', 'fixture-tests')
      .replace('- [x] **AC1**', '- [ ] **AC1**')
      .replace('- [x] Implement the example.', '- [ ] Implement the example.'),
    'utf8'
  );
  const valid = runHarness(['validate-plan', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).pass, true);
  const validGate = runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(validGate.status, 0, validGate.stderr);
  assert.equal(JSON.parse(validGate.stdout).pass, true);
});

test('compound indexes only after harness verify passes', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  const verify = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);
  assert.equal(verify.status, 0, verify.stderr);

  const result = runHarness([
    'compound',
    '--plan',
    plan,
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.ok(body.indexed);
  const usagePath = path.join(copilotHome, 'knowledge', 'skill-usage.yaml');
  assert.equal(fs.existsSync(usagePath), true);
  const usage = YAML.parse(fs.readFileSync(usagePath, 'utf8'));
  assert.equal(usage.skills.engineer.usage_count, 1);
  assert.equal(usage.skills.engineer.outcomes.passed, 1);
  assert.equal(readEvents(workspace).some((e) => e.type === 'compound'), true);
});

test('compound blocks when passed harness evidence is absent', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const result = runHarness(['compound', '--plan', plan, '--workspace', workspace, '--json']);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.exitCode, 2);
});

test('compound preserves malformed telemetry and still records session state', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  const verify = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);
  assert.equal(verify.status, 0, verify.stderr);

  const knowledge = path.join(copilotHome, 'knowledge');
  const usagePath = path.join(knowledge, 'skill-usage.yaml');
  fs.mkdirSync(knowledge, { recursive: true });
  fs.writeFileSync(usagePath, 'skills: [unterminated', 'utf8');

  const result = runHarness([
    'compound',
    '--plan',
    plan,
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.deepEqual(body.telemetry.updated, []);
  assert.match(body.telemetry.error, /invalid skill usage telemetry/i);
  assert.equal(fs.readFileSync(usagePath, 'utf8'), 'skills: [unterminated');
  assert.ok(JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8')).lastCompoundAt);
});

test('gate and compound reject evidence after the plan or scoped workspace changes', () => {
  for (const mutation of ['plan', 'workspace']) {
    const workspace = tempDir('harness-workspace-');
    const copilotHome = tempDir('harness-copilot-');
    const plan = writeVersionedPlan(workspace);
    writeChecks(workspace, {
      'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
    });
    initGit(workspace);
    fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 2;\n');
    assert.equal(runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']).status, 0);

    const target = mutation === 'plan' ? path.join(workspace, plan) : path.join(workspace, 'src', 'example.js');
    fs.appendFileSync(target, `\n// ${mutation} changed after verification\n`, 'utf8');

    const gate = runHarness(['gate', '--phase', 'verify', '--plan', plan, '--workspace', workspace, '--json']);
    assert.equal(gate.status, 1, gate.stderr);
    assert.equal(JSON.parse(gate.stdout).pass, false);

    const compound = runHarness([
      'compound',
      '--plan',
      plan,
      '--workspace',
      workspace,
      '--copilot-home',
      copilotHome,
      '--json',
    ]);
    assert.notEqual(compound.status, 0, compound.stderr);
    assert.equal(JSON.parse(compound.stdout).pass, false);
  }
});

test('telemetry preserves malformed history instead of overwriting it', () => {
  const copilotHome = tempDir('harness-copilot-');
  const knowledge = path.join(copilotHome, 'knowledge');
  const usagePath = path.join(knowledge, 'skill-usage.yaml');
  fs.mkdirSync(knowledge, { recursive: true });
  fs.writeFileSync(usagePath, 'skills: [unterminated', 'utf8');

  const invalidYaml = recordSkillUsage({
    copilotHome,
    plan: { path: 'docs/plans/x.md', fm: { skills_used: ['engineer'] } },
    evidence: { outcome: 'passed' },
  });
  assert.deepEqual(invalidYaml.updated, []);
  assert.match(invalidYaml.error, /invalid skill usage telemetry/i);
  assert.equal(fs.readFileSync(usagePath, 'utf8'), 'skills: [unterminated');

  const malformedEntry = 'skills:\n  engineer:\n    usage_count: many\n    outcomes: passed\n';
  fs.writeFileSync(usagePath, malformedEntry, 'utf8');
  const invalidEntry = recordSkillUsage({
    copilotHome,
    plan: { path: 'docs/plans/x.md', fm: { skills_used: ['engineer'] } },
    evidence: { outcome: 'passed' },
  });
  assert.deepEqual(invalidEntry.updated, []);
  assert.match(invalidEntry.error, /invalid skill usage telemetry/i);
  assert.equal(fs.readFileSync(usagePath, 'utf8'), malformedEntry);
});

test('telemetry serializes concurrent updates without losing counts', async () => {
  const copilotHome = tempDir('harness-copilot-');
  const moduleUrl = pathToFileURL(path.join(packageRoot, 'lib', 'telemetry.mjs')).href;
  const script = `
    import { recordSkillUsage } from ${JSON.stringify(moduleUrl)};
    recordSkillUsage({
      copilotHome: process.argv[1],
      plan: { path: 'docs/plans/x.md', fm: { skills_used: ['engineer'] } },
      evidence: { outcome: 'passed' }
    });
  `;
  const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, copilotHome], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`))));
  }));

  await Promise.all(runs);
  const usagePath = path.join(copilotHome, 'knowledge', 'skill-usage.yaml');
  const usage = YAML.parse(fs.readFileSync(usagePath, 'utf8'));
  assert.equal(usage.skills.engineer.usage_count, 6);
  assert.equal(usage.skills.engineer.outcomes.passed, 6);
  assert.equal(fs.existsSync(`${usagePath}.lock`), false);
});

function writeKnowledgeSolution(copilotHome, {
  category = 'api',
  slug = 'orders-timeout',
  title = 'Orders API timeout',
  symptom = 'checkout requests hang after 30 seconds',
  module = 'orders-service',
  scope = 'global',
  tags = 'commerce, checkout',
  body = '## Problem\n\nCheckout requests hang after 30 seconds under load.',
} = {}) {
  const knowledgeRoot = path.join(copilotHome, 'knowledge');
  const solDir = path.join(knowledgeRoot, 'solutions', category);
  fs.mkdirSync(solDir, { recursive: true });
  fs.writeFileSync(
    path.join(solDir, `${slug}.md`),
    `---
title: "${title}"
category: ${category}
module: ${module}
symptom: ${symptom}
tags: ${tags}
date: 2026-05-01
---

${body}
`,
    'utf8'
  );
  fs.copyFileSync(
    path.join(packageRoot, '../../knowledge/collections.yaml'),
    path.join(knowledgeRoot, 'collections.yaml')
  );
  fs.copyFileSync(
    path.join(packageRoot, '../../knowledge/recall-synonyms.yaml'),
    path.join(knowledgeRoot, 'recall-synonyms.yaml')
  );
  return `${scope}-${category}-${slug}`;
}

function runIndex(workspace, copilotHome) {
  const result = runHarness(['index', '--workspace', workspace, '--copilot-home', copilotHome]);
  assert.equal(result.status, 0, result.stderr);
}

function writeProductSolution(workspace, {
  category = 'product',
  slug = 'local-fix',
  title = 'Local product fix',
  symptom = 'product-only symptom',
} = {}) {
  const solDir = path.join(workspace, 'docs', 'solutions', category);
  fs.mkdirSync(solDir, { recursive: true });
  fs.writeFileSync(
    path.join(solDir, `${slug}.md`),
    `---
title: "${title}"
category: ${category}
symptom: ${symptom}
date: 2026-05-10
---

## Problem

Product scoped solution.
`,
    'utf8'
  );
  return `product-${category}-${slug}`;
}

test('index writes enriched manifest fields and postings index', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome);

  const result = runHarness(['index', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(result.status, 0, result.stderr);

  const manifest = fs.readFileSync(path.join(copilotHome, 'knowledge', 'manifest.yaml'), 'utf8');
  assert.match(manifest, /symptom:/);
  assert.match(manifest, /module:/);
  assert.match(manifest, /excerpt:/);
  assert.match(manifest, /docid:/);
  assert.ok(fs.existsSync(path.join(copilotHome, 'knowledge', '.harness-index', 'postings.json')));
  assert.ok(fs.existsSync(path.join(copilotHome, 'knowledge', '.harness-index', 'meta.json')));
});

test('BM25 recall ranks symptom match above title-only match', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, {
    slug: 'orders-timeout',
    symptom: 'checkout requests hang after 30 seconds',
    title: 'Orders API timeout',
  });
  writeKnowledgeSolution(copilotHome, {
    category: 'misc',
    slug: 'unrelated',
    title: 'checkout dashboard',
    symptom: 'unrelated issue',
    body: '## Problem\n\nUnrelated content.',
  });
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'recall',
    'checkout hang',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.recall.length >= 1);
  assert.equal(body.recall[0].docid, 'global-api-orders-timeout');
  assert.equal(body.recall[0].ranker, 'bm25');
  assert.ok(body.recall[0].snippet.length > 0);
});

test('synonym expansion improves recall for aliased query', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, {
    symptom: 'requests hit deadline after 30 seconds',
    title: 'Deadline issue',
    tags: 'commerce, checkout',
  });
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'recall',
    'timeout',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.recall.length >= 1);
  assert.ok(body.recall[0].score > 0);
});

test('collection filter excludes non-matching scope', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, { slug: 'global-one', symptom: 'shared timeout symptom' });
  writeProductSolution(workspace, { slug: 'prod-one', symptom: 'shared timeout symptom' });
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'recall',
    'timeout symptom',
    '-c',
    'product',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.recall.length, 1);
  assert.match(body.recall[0].path, /docs\/solutions/);
});

test('min-score filters low-scoring recall hits', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, { symptom: 'very specific database deadlock symptom' });
  runIndex(workspace, copilotHome);

  const baseline = runHarness([
    'recall',
    'database',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);
  assert.equal(baseline.status, 0, baseline.stderr);
  const baselineBody = JSON.parse(baseline.stdout);
  assert.ok(baselineBody.recall.length > 0, 'baseline recall should return hits');
  const hitScore = baselineBody.recall[0].score;

  const result = runHarness([
    'recall',
    'database',
    '--min-score',
    String(Math.min(hitScore + 0.001, 1)),
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).recall.length, 0);
});

test('get returns bounded excerpt by docid', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const docid = writeKnowledgeSolution(copilotHome);
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'get',
    '--docid',
    docid,
    '--lines',
    '10',
    '--max-bytes',
    '500',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.docid, docid);
  assert.ok(body.excerpt.includes('Problem'));
  assert.ok(body.bytes <= 500);
});

test('recall falls back to overlap ranker when postings index missing', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, { symptom: 'timeout on checkout path' });
  runIndex(workspace, copilotHome);
  fs.rmSync(path.join(copilotHome, 'knowledge', '.harness-index'), { recursive: true, force: true });

  const result = runHarness([
    'recall',
    'checkout timeout',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.recall.length >= 1);
  assert.equal(body.recall[0].ranker, 'overlap');
});

test('install creates global harness shim', () => {
  const copilotHome = tempDir('harness-copilot-');
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  installHarnessBin(packageRoot, copilotHome, { dryRun: false, verbose: false }, () => {});
  installGlobalHarnessShim(copilotHome, { dryRun: false, verbose: false }, () => {});
  const shim = globalHarnessShimPath(copilotHome);
  assert.ok(fs.existsSync(shim));
  const result = spawnSync(process.execPath, [shim, 'help'], {
    encoding: 'utf8',
    env: { ...process.env, COPILOT_HOME: copilotHome },
  });
  assert.equal(result.status, 0, result.stderr);
  const validate = spawnSync(
    process.execPath,
    [shim, 'validate-plan', '--plan', plan, '--workspace', workspace, '--json'],
    {
      encoding: 'utf8',
      env: { ...process.env, COPILOT_HOME: copilotHome },
    }
  );
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).pass, true);
});

test('resolve finds monorepo harness bin', () => {
  const repoRoot = path.resolve(packageRoot, '../..');
  const result = runHarness(['resolve', '--workspace', repoRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.bin);
  assert.ok(body.agentCommand);
});

test('init-repo creates harness runner', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-home-');
  const harnessHome = tempDir('harness-home-');
  const result = runHarness(['init-repo', '--workspace', workspace, '--copilot-home', copilotHome], {
    env: { HARNESS_HOME: harnessHome },
  });
  assert.equal(result.status, 0, result.stderr);
  const runner = path.join(workspace, '.harness', 'run.mjs');
  assert.ok(fs.existsSync(runner));
  assert.ok(fs.existsSync(path.join(workspace, '.github', 'harness', 'checks.yaml')));
  assert.ok(fs.existsSync(path.join(workspace, '.github', 'harness', 'policy.yaml')));
  const runResult = spawnSync(process.execPath, [runner, 'resolve', '--json'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HARNESS_BIN: binPath },
  });
  assert.equal(runResult.status, 0, runResult.stderr);
});

function writeChecks(workspace, checks) {
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'checks.yaml'),
    `version: 1\nchecks:\n${Object.entries(checks)
      .map(
        ([name, check]) => {
          const timeout = check.timeout_seconds === undefined ? '' : `\n    timeout_seconds: ${check.timeout_seconds}`;
          return `  ${name}:\n    command: ${JSON.stringify(check.command)}${timeout}`;
        }
      )
      .join('\n')}\n`,
    'utf8'
  );
}

function writeVersionedPlan(workspace, {
  name = '2026-07-13-feat-verify-plan.md',
  required = ['unit-tests'],
  criteria = { AC1: ['unit-tests'] },
  impacted = ['src/example.js'],
  extraFrontmatter = '',
  taskChecked = true,
  skillsUsed = ['engineer'],
  technicalNotes = 'No additional technical notes.',
  intent = 'Verify safely',
} = {}) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const rel = `docs/plans/${name}`;
  const criterionYaml = Object.entries(criteria)
    .map(([id, checks]) => `    ${id}: ${JSON.stringify(checks)}`)
    .join('\n');
  fs.writeFileSync(
    path.join(workspace, rel),
    `---
plan_schema: 1
title: "Verify example"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: ${JSON.stringify(intent)}
expected_outputs:
  - "verified change"
success_criteria:
  - "AC1 Example works"
verification:
  required: ${JSON.stringify(required)}
  criteria:
${criterionYaml}
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
skills_used: ${JSON.stringify(skillsUsed)}
${extraFrontmatter}---

# Verify example

## Overview

Verify the example.

## Intent Contract

- **Goal:** Verify safely.
- **Expected outputs:** verified change.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1 — Implement

- [${taskChecked ? 'x' : ' '}] Implement the example.

## Impacted Files

${impacted.map((file) => `- \`${file}\``).join('\n')}

## Technical Notes

${technicalNotes}

## Verification Plan

Run trusted named checks.

## Risk & Review Routing

No required specialist review.

## Review Findings

No open findings.

## Activity

- Work recorded.
`,
    'utf8'
  );
  return rel;
}


test('plan readiness surfaces configured-check errors instead of running named checks', async () => {
  const { validatePlanReadiness } = await import('../lib/plan-readiness.mjs');
  const { loadPlan } = await import('../lib/plan-parse.mjs');
  const workspace = tempDir('harness-readiness-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  const plan = loadPlan(workspace, 'docs/plans/2026-05-22-fix-example-plan.md');
  fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });

  fs.writeFileSync(path.join(workspace, '.github', 'harness', 'checks.yaml'), 'version: 2\nchecks: {}\n');
  const wrongVersion = validatePlanReadiness(workspace, plan);
  assert.equal(wrongVersion.pass, false);
  assert.ok(
    wrongVersion.checks.some((check) => !check.pass && /must declare version: 1/.test(check.message)),
    JSON.stringify(wrongVersion.checks)
  );

  fs.writeFileSync(path.join(workspace, '.github', 'harness', 'checks.yaml'), 'version: 1\nchecks: [not: {valid\n');
  const unparseable = validatePlanReadiness(workspace, plan);
  assert.equal(unparseable.pass, false);
  assert.ok(
    unparseable.checks.some((check) => !check.pass && /Invalid \.github\/harness\/checks\.yaml/.test(check.message)),
    JSON.stringify(unparseable.checks)
  );
});

function initGit(workspace) {
  const run = (args) =>
    spawnSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  assert.equal(run(['init', '-q']).status, 0);
  assert.equal(run(['config', 'user.email', 'harness@example.test']).status, 0);
  assert.equal(run(['config', 'user.name', 'Harness Test']).status, 0);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 1;\n');
  assert.equal(run(['add', '.']).status, 0);
  assert.equal(run(['commit', '-qm', 'baseline']).status, 0);
}

const primitiveAnalysis = `
- Primitive classification: modify the existing skill because it owns the workflow.
- Existing-capability overlap analysis: reuse the Existing /java skill and Existing /aws skill instead of duplicating them.
- Intended artifact structure: keep the procedure in SKILL.md and dense guidance in a reference.
- Trigger and negative-trigger implications: route migration delivery here; exclude one-off API questions.
- Verification expectations: run prompt, host, and built-asset contracts.
- Registry and documentation impact: update them only if a new skill is justified.
`.trim();

test('scope treats the active plan as governance metadata while enforcing product paths', () => {
  const workspace = tempDir('harness-workspace-');
  initGit(workspace);
  const planPath = writeVersionedPlan(workspace, { impacted: ['src/example.js'] });
  fs.appendFileSync(path.join(workspace, 'src', 'example.js'), 'export const changed = true;\n');
  const plan = loadPlan(workspace, planPath);

  const scope = validatePlanScope({ workspace, plan, base: 'HEAD' });

  assert.equal(scope.status, 'passed');
  assert.ok(scope.changedFiles.includes(planPath));
  assert.deepEqual(scope.violations, []);
});

test('implement gate requires create-primitive and plan analysis for primitive paths', () => {
  const workspace = tempDir('harness-workspace-');
  let plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
  });
  let result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 1, result.stderr);
  let body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'PR1')?.pass, false);

  plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
  });
  result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 1, result.stderr);
  body = JSON.parse(result.stdout);
  assert.ok(body.checks.some((check) => check.id.startsWith('PR') && !check.pass));

  plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: primitiveAnalysis,
  });
  result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 0, result.stderr);
  body = JSON.parse(result.stdout);
  assert.ok(body.checks.filter((check) => check.id.startsWith('PR')).every((check) => check.pass));
});

test('Java and AWS migration primitive plans explicitly compare the installed domain skills', () => {
  const workspace = tempDir('harness-workspace-');
  const withoutDomainComparison = primitiveAnalysis
    .replace('Existing /java skill', 'Java guidance')
    .replace('Existing /aws skill', 'AWS guidance');
  let plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: withoutDomainComparison,
    intent: 'Create a Java and AWS upgrade migration skill',
  });
  let result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 1, result.stderr);
  let body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'PR8')?.pass, false);
  assert.match(body.nextTools.join('\n'), /create-primitive\/SKILL\.md/i);

  plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: primitiveAnalysis,
    intent: 'Create a Java and AWS upgrade migration skill',
  });
  result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 0, result.stderr);
  body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'PR8')?.pass, true);
});

test('verification rejects nested skill changes without existing primitive evidence checks', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/references/guide.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: primitiveAnalysis,
    required: ['unit-tests'],
    criteria: { AC1: ['unit-tests'] },
  });
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
    'prompt-contracts': { command: [process.execPath, '-e', 'process.exit(0)'] },
    'host-contracts': { command: [process.execPath, '-e', 'process.exit(0)'] },
    'build-assets': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  const skill = path.join(workspace, '.github', 'skills', 'example', 'references', 'guide.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '# Guide\n');
  initGit(workspace);
  fs.appendFileSync(skill, '\nChanged guidance.\n');

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'primitive-evidence')?.status, 'failed');
  assert.match(body.checks.find((check) => check.id === 'primitive-evidence')?.message, /prompt-contracts|host-contracts|build-assets/);
});

test('product-local skill verification uses configured local evidence when standard primitive checks are absent', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: primitiveAnalysis,
    required: ['fixture-tests'],
    criteria: { AC1: ['fixture-tests'] },
  });
  writeChecks(workspace, {
    'fixture-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  const skill = path.join(workspace, '.github', 'skills', 'example', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '# Skill\n');
  initGit(workspace);
  fs.appendFileSync(skill, '\nChanged guidance.\n');

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  const primitive = body.checks.find((check) => check.id === 'primitive-evidence');
  assert.equal(primitive?.status, 'passed');
  assert.match(primitive?.message || '', /applicable named evidence/i);
});

test('plan parser uses YAML semantics for block arrays and nested mappings', () => {
  const fm = parsePlanFrontmatter(`---
plan_schema: 1
expected_outputs:
  - first output
  - second output
verification:
  required:
    - unit-tests
  criteria:
    AC1: [unit-tests]
---
`);

  assert.equal(fm.plan_schema, 1);
  assert.deepEqual(fm.expected_outputs, ['first output', 'second output']);
  assert.deepEqual(fm.verification.required, ['unit-tests']);
  assert.deepEqual(fm.verification.criteria.AC1, ['unit-tests']);
});

test('harness verify passes named checks, validates scope, and writes evidence', () => {
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
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'passed');
  assert.equal(body.plan, plan);
  assert.deepEqual(body.unverifiedCriteria, []);
  assert.deepEqual(body.scopeViolations, []);
  assert.deepEqual(body.openHardGaps, []);
  assert.deepEqual(body.requiredReviews, []);
  assert.ok(body.evidencePath);
  assert.equal(fs.existsSync(path.join(workspace, body.evidencePath)), true);

  // Human output ends with an actionable next command on success (AC30).
  const human = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace]);
  assert.match(human.stdout, /^\[ok\]\s+verify\s+passed/m);
  assert.match(human.stdout, /^-> harness compound/m);
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

test('harness verify --learnings drops empty csv entries into a clean array', () => {
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
    'a/b,,c/d,',
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

test('harness verify checks only tasks in the current plan phase', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8').replace(
      '## Impacted Files',
      '### Phase 2 — Follow-up\n\n- [ ] Future task that is not active.\n\n## Impacted Files'
    ),
    'utf8'
  );
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const phaseTasks = JSON.parse(result.stdout).checks.find((check) => check.id === 'phase-tasks');
  assert.equal(phaseTasks.status, 'passed');
  assert.deepEqual(phaseTasks.openTasks, []);
});

test('harness verify rejects array-shaped criterion mappings', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8').replace('  criteria:\n    AC1: ["unit-tests"]', '  criteria: ["unit-tests"]'),
    'utf8'
  );
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const planSchema = JSON.parse(result.stdout).checks.find((check) => check.id === 'plan-schema');
  assert.equal(planSchema.status, 'failed');
  assert.match(planSchema.message, /criterion mappings/i);
});

test('harness verify rejects empty named checks and duplicate acceptance IDs', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace, { required: [], criteria: {} });
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8').replace(
      '- [x] **AC1** Example works.',
      '- [x] **AC1** Example works.\n- [x] **AC1** Duplicate identifier.'
    ),
    'utf8'
  );
  writeChecks(workspace, {});
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const message = JSON.parse(result.stdout).checks.find((check) => check.id === 'plan-schema')?.message || '';
  assert.match(message, /non-empty|unique/i);
});

test('harness verify rejects empty intent arrays on locked plans', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8')
      .replace('expected_outputs:\n  - "verified change"', 'expected_outputs: []')
      .replace('success_criteria:\n  - "AC1 Example works"', 'success_criteria: []'),
    'utf8'
  );
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const message = JSON.parse(result.stdout).checks.find((check) => check.id === 'plan-schema')?.message || '';
  assert.match(message, /expected_outputs|success_criteria/i);
});

test('harness verify returns failed when a required named check fails', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(7)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'failed');
  assert.equal(body.checks.find((check) => check.id === 'unit-tests')?.status, 'failed');
});

test('harness verify returns inconclusive for timeout and records it', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': {
      command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
      timeout_seconds: 1,
    },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'inconclusive');
  assert.equal(body.checks.find((check) => check.id === 'unit-tests')?.status, 'timeout');
});

test('harness verify is inconclusive when plan selection is ambiguous', () => {
  const workspace = tempDir('harness-workspace-');
  writeVersionedPlan(workspace, { name: 'first-plan.md' });
  writeVersionedPlan(workspace, { name: 'second-plan.md' });
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });

  const result = runHarness(['verify', '--workspace', workspace, '--json']);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'inconclusive');
  assert.match(body.checks.find((check) => check.id === 'plan-selection')?.message, /ambiguous/i);
});

test('harness verify never executes commands authored in a plan', () => {
  const workspace = tempDir('harness-workspace-');
  const marker = path.join(workspace, 'plan-command-ran');
  const markerBase64 = Buffer.from(marker).toString('base64');
  const malicious = `${process.execPath} -e "require('fs').writeFileSync(Buffer.from('${markerBase64}', 'base64'), 'bad')"`;
  const plan = writeVersionedPlan(workspace, {
    extraFrontmatter: `verification_commands:\n  - ${JSON.stringify(malicious)}\n`,
  });
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, 'passed');
  assert.equal(fs.existsSync(marker), false);
});

test('gate honors an explicit plan instead of stale session state', () => {
  const workspace = tempDir('harness-workspace-');
  const first = writeVersionedPlan(workspace, { name: 'first-plan.md' });
  const second = writeVersionedPlan(workspace, { name: 'second-plan.md' });
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify({ activePlan: first }));

  const result = runHarness(['gate', '--plan', second, '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).plan.path, second);
});

test('automatic plan selection ignores terminal session state', () => {
  const workspace = tempDir('harness-workspace-');
  const stale = writeVersionedPlan(workspace, { name: 'a-stale-plan.md' });
  const active = writeVersionedPlan(workspace, { name: 'z-active-plan.md' });
  const stalePath = path.join(workspace, stale);
  fs.writeFileSync(stalePath, fs.readFileSync(stalePath, 'utf8').replace('status: in-progress', 'status: done'), 'utf8');
  const activePath = path.join(workspace, active);
  fs.writeFileSync(activePath, fs.readFileSync(activePath, 'utf8').replace('status: in-progress', 'status: review'), 'utf8');
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify({ activePlan: stale }), 'utf8');

  const result = runHarness(['validate-plan', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).plan.path, active);
});

test('plan loading rejects symlinks that escape docs/plans', () => {
  const workspace = tempDir('harness-workspace-');
  const outside = path.join(workspace, 'outside-plan.md');
  fs.writeFileSync(outside, '# outside\n', 'utf8');
  const plans = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plans, { recursive: true });
  fs.symlinkSync(outside, path.join(plans, 'escape.md'));

  assert.equal(loadPlan(workspace, 'docs/plans/escape.md'), null);

  fs.mkdirSync(path.join(plans, 'directory.md'));
  assert.equal(loadPlan(workspace, 'docs/plans/directory.md'), null);
});

test('harness verify fails files outside the plan-to-diff scope', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  fs.writeFileSync(path.join(workspace, 'outside.js'), 'export const outside = true;\n');

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'failed');
  assert.deepEqual(body.scopeViolations, ['outside.js']);
});

test('warn and observe enforcement preserve failed outcome without blocking rollout', () => {
  for (const enforcement of ['warn', 'observe']) {
    const workspace = tempDir('harness-workspace-');
    const plan = writeVersionedPlan(workspace);
    writeChecks(workspace, {
      'unit-tests': { command: [process.execPath, '-e', 'process.exit(9)'] },
    });
    initGit(workspace);

    const result = runHarness([
      'verify',
      '--plan',
      plan,
      '--base',
      'HEAD',
      '--enforcement',
      enforcement,
      '--workspace',
      workspace,
      '--json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.outcome, 'failed');
    assert.equal(body.enforcement, enforcement);
  }
});

test('warn and observe enforcement preserve gate and plan-validation failures without blocking rollout', () => {
  for (const enforcement of ['warn', 'observe']) {
    const workspace = tempDir('harness-workspace-');
    const gate = runHarness(['gate', '--enforcement', enforcement, '--workspace', workspace, '--json']);
    assert.equal(gate.status, 0, gate.stderr);
    const gateBody = JSON.parse(gate.stdout);
    assert.equal(gateBody.pass, false);
    assert.equal(gateBody.enforcement, enforcement);

    const validate = runHarness(['validate-plan', '--enforcement', enforcement, '--workspace', workspace, '--json']);
    assert.equal(validate.status, 0, validate.stderr);
    const validateBody = JSON.parse(validate.stdout);
    assert.equal(validateBody.pass, false);
    assert.equal(validateBody.enforcement, enforcement);
  }
});

function runHook(name, workspace, toolInput = {}) {
  return spawnSync(process.execPath, [path.join(packageRoot, '../../.github/hooks', name)], {
    cwd: workspace,
    input: JSON.stringify({ workspace, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });
}

function runHookWithPolicy(name, workspace, toolInput = {}) {
  const env = { ...process.env };
  delete env.HARNESS_ENFORCEMENT;
  return spawnSync(process.execPath, [path.join(packageRoot, '../../.github/hooks', name)], {
    cwd: workspace,
    input: JSON.stringify({ workspace, tool_input: toolInput }),
    encoding: 'utf8',
    env,
  });
}

function hookResponse(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

function assertHookBlocked(result, pattern) {
  const response = hookResponse(result);
  const hook = response.hookSpecificOutput || {};
  assert.ok(hook.permissionDecision === 'deny' || hook.decision === 'block', result.stdout);
  const reason = hook.permissionDecisionReason || hook.reason || response.reason || '';
  if (pattern) assert.match(reason, pattern);
  return response;
}

function recordSuccessfulEdit(workspace, toolInput) {
  return hookResponse(runHook('record-successful-edit.mjs', workspace, toolInput));
}

test('pre-edit hook fails closed on malformed input payloads', () => {
  const workspace = tempDir('harness-workspace-');
  const result = spawnSync(process.execPath, [path.join(packageRoot, '../../.github/hooks', 'require-plan-gate.mjs')], {
    cwd: workspace,
    input: '{not-json',
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });

  assertHookBlocked(result, /payload/i);
});

test('hooks honor repository enforcement and freshness policy', () => {
  const workspace = tempDir('harness-workspace-');
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'policy.yaml'),
    'version: 1\nenforcement: warn\ngate_ttl_minutes: 1\nevidence_ttl_hours: 1\n',
    'utf8'
  );

  const warning = runHookWithPolicy('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  const warningResponse = hookResponse(warning);
  assert.match(warningResponse.systemMessage, /missing-implement-gate/i);

  const plan = writeVersionedPlan(workspace);
  assert.equal(runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.lastGateAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  fs.writeFileSync(
    path.join(configDir, 'policy.yaml'),
    'version: 1\nenforcement: enforce\ngate_ttl_minutes: 1\nevidence_ttl_hours: 1\n',
    'utf8'
  );

  const stale = runHookWithPolicy('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  assertHookBlocked(stale, /stale/i);
});

test('pre-edit hook requires an explicit passed gate and planned scope', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const blocked = runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  assertHookBlocked(blocked, /missing-implement-gate/i);

  const gate = runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(gate.status, 0, gate.stderr);
  const allowed = runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  assert.equal(allowed.status, 0, allowed.stderr);
  const outside = runHook('require-plan-gate.mjs', workspace, { file_path: 'src/outside.js' });
  assertHookBlocked(outside, /outside the plan/i);

  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.lastGateAt = 'not-a-date';
  fs.writeFileSync(sessionPath, JSON.stringify(session), 'utf8');
  const invalidTimestamp = runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  assertHookBlocked(invalidTimestamp, /timestamp/i);
});

test('Bash file mutations require planned scope and create pending verification state', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const readOnly = runHook('require-plan-gate.mjs', workspace, { command: 'rg -n TODO src' });
  assert.equal(readOnly.status, 0, readOnly.stderr);

  const blocked = runHook('require-plan-gate.mjs', workspace, { command: 'printf changed > src/example.js' });
  assertHookBlocked(blocked, /missing-implement-gate/i);

  assert.equal(runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  const outside = runHook('require-plan-gate.mjs', workspace, { command: 'printf changed > src/outside.js' });
  assertHookBlocked(outside, /outside the plan/i);

  const hiddenOutside = runHook('require-plan-gate.mjs', workspace, {
    command: 'cp src/example.js src/outside.js > src/example.js',
  });
  assertHookBlocked(hiddenOutside, /src\/outside\.js/);

  for (const command of [
    'mv src/outside.js src/example.js',
    'ln src/outside.js src/example.js',
    'git -C . checkout -- src/outside.js',
    'sed --in-place s/old/new/ src/outside.js',
    'git reset --hard HEAD',
    'git stash pop',
  ]) {
    const scoped = runHook('require-plan-gate.mjs', workspace, { command });
    assertHookBlocked(scoped, /src\/outside\.js|target could not be resolved/i);
  }

  const allowed = runHook('require-plan-gate.mjs', workspace, { command: 'printf changed > src/example.js' });
  assert.equal(allowed.status, 0, allowed.stderr);
  recordSuccessfulEdit(workspace, { command: 'printf changed > src/example.js' });
  const pending = runHook('require-verification.mjs', workspace);
  assertHookBlocked(pending, /verify has not run/i);
});

test('completion hook bypasses read-only work and enforces each new recorded edit', () => {
  const readOnlyWorkspace = tempDir('harness-workspace-');
  assert.equal(runHook('require-verification.mjs', readOnlyWorkspace).status, 0);

  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  assert.equal(runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  assert.equal(runHook('require-verification.mjs', workspace).status, 0, 'a gated but unedited session is read-only');

  assert.equal(runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' }).status, 0);
  recordSuccessfulEdit(workspace, { file_path: 'src/example.js' });
  const unverified = runHook('require-verification.mjs', workspace);
  assertHookBlocked(unverified, /verify has not run/i);

  assert.equal(runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']).status, 0);
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  let session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const evidencePath = path.join(workspace, session.lastEvidencePath);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const originalVerifiedAt = evidence.verifiedAt;
  evidence.verifiedAt = new Date(Date.parse(session.lastEditAt) - 1000).toISOString();
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const evidenceBeforeEdit = runHook('require-verification.mjs', workspace);
  assertHookBlocked(evidenceBeforeEdit, /changed after/i);
  evidence.verifiedAt = originalVerifiedAt;
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));

  const originalLastVerifyAt = session.lastVerifyAt;
  session.lastVerifyAt = 'invalid';
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  const invalidSessionTimestamp = runHook('require-verification.mjs', workspace);
  assertHookBlocked(invalidSessionTimestamp, /timestamp.*invalid/i);
  session.lastVerifyAt = originalLastVerifyAt;
  fs.writeFileSync(sessionPath, JSON.stringify(session));

  assert.equal(runHook('require-verification.mjs', workspace).status, 0);
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(session.lastCompletedEditAt, session.lastEditAt);
  assert.equal(runHook('require-verification.mjs', workspace).status, 0, 'later read-only stops reuse the completed marker');

  assert.equal(runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' }).status, 0);
  recordSuccessfulEdit(workspace, { file_path: 'src/example.js' });
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.lastEditAt = new Date(Date.parse(session.lastCompletedEditAt) + 1000).toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  const changedAfter = runHook('require-verification.mjs', workspace);
  assertHookBlocked(changedAfter, /changed after/i);
});

test('completion hook rejects failed and inconclusive evidence for a pending edit', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(1)'] },
  });
  initGit(workspace);
  assert.equal(runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  assert.equal(runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' }).status, 0);
  recordSuccessfulEdit(workspace, { file_path: 'src/example.js' });
  assert.equal(runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']).status, 1);

  const failed = runHook('require-verification.mjs', workspace);
  assertHookBlocked(failed, /outcome is failed/i);

  const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  const evidencePath = path.join(workspace, session.lastEvidencePath);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  evidence.outcome = 'inconclusive';
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const inconclusive = runHook('require-verification.mjs', workspace);
  assertHookBlocked(inconclusive, /outcome is inconclusive/i);
});

test('completion hook normalizes Windows-style plan paths', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  assert.equal(runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  assert.equal(runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' }).status, 0);
  recordSuccessfulEdit(workspace, { file_path: 'src/example.js' });
  assert.equal(runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']).status, 0);

  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const evidencePath = path.join(workspace, session.lastEvidencePath);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  session.activePlan = session.activePlan.replace(/\//g, '\\');
  evidence.plan = evidence.plan.replace(/\//g, '\\');
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));

  const completion = runHook('require-verification.mjs', workspace);
  assert.equal(completion.status, 0, completion.stderr);
});

test('upgrade purges retired prompt wrappers and single-entry retirements from hydrated homes', async () => {
  const { loadRetired, applyRetired } = await import('../lib/sync.mjs');
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const retired = loadRetired(pkgRoot);
  for (const expected of ['prompts', 'skills/btw', 'skills/start', 'skills/work-on-task', 'agents/pipeline-navigator.agent.md']) {
    assert.ok(retired.includes(expected), `retired.json missing ${expected}`);
  }

  // Old hydrated home: wrappers + retired skill + retired agent present and lock-tracked.
  const home = tempDir('harness-old-home-');
  const oldFiles = ['prompts/engineer.prompt.md', 'skills/btw/SKILL.md', 'agents/pipeline-navigator.agent.md'];
  for (const rel of oldFiles) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'legacy\n');
  }
  const previousLock = { files: ['prompts', ...oldFiles, 'skills/btw', 'agents/pipeline-navigator.agent.md'] };
  const stats = applyRetired(home, retired, previousLock, {}, () => {});
  assert.ok(stats.removed >= 3, `expected purge, removed=${stats.removed}`);
  assert.equal(fs.existsSync(path.join(home, 'prompts')), false, 'hydrated prompts dir must be purged');
  assert.equal(fs.existsSync(path.join(home, 'skills', 'btw')), false);
  assert.equal(fs.existsSync(path.join(home, 'agents', 'pipeline-navigator.agent.md')), false);
});
