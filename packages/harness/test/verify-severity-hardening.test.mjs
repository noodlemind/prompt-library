import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadPolicy, NON_ADVISORY_CHECK_IDS } from '../lib/policy.mjs';
import { collectAdvisoryFailures, runVerify, sanitizeCheckPayload } from '../lib/verify.mjs';
import { readEvidence } from '../lib/evidence.mjs';
import { STRUCTURAL_CHECK_ID } from '../lib/structural/expectations.mjs';
import { approveProject } from '../lib/trust.mjs';
import { buildStructuralIndex } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'; // canonical \bAKIA[0-9A-Z]{16}\b shape
const CTRL = '\u0001'; // a raw control char, as a hostile symbol/expectation can carry
const CTRL_IN_JSON = '\\u0001'; // …and how JSON.stringify renders it if it survives

function policyWorkspace(yaml) {
  const ws = tempDir('vsh-ws-');
  const full = path.join(ws, '.github', 'harness', 'policy.yaml');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, yaml, 'utf8');
  return ws;
}

// --- end-to-end verify fixture (a real plan, real checks, a real git repo) ---

function git(workspace, args) {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeConfig(workspace, name, body) {
  const dir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, 'utf8');
}

function writeChecks(workspace, checks) {
  const body = Object.entries(checks)
    .map(([name, check]) => `  ${name}:\n    command: ${JSON.stringify(check.command)}`)
    .join('\n');
  writeConfig(workspace, 'checks.yaml', `version: 1\nchecks:\n${body}\n`);
}

/** A plan that passes every gating check on its own, so a single deliberately
 * broken input is the only thing that can move the outcome. */
function writeVerifiablePlan(workspace, { required = ['unit-tests'], criteria = { AC1: ['unit-tests'] }, extraFrontmatter = '' } = {}) {
  const rel = 'docs/plans/2026-08-06-feat-severity-plan.md';
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  const criterionYaml = Object.entries(criteria)
    .map(([id, checks]) => `    ${id}: ${JSON.stringify(checks)}`)
    .join('\n');
  fs.writeFileSync(
    path.join(workspace, rel),
    `---
plan_schema: 1
title: "Severity example"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Verify severity handling"
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
skills_used: ["engineer"]
${extraFrontmatter}---

# Severity example

## Overview

Verify the example.

## Intent Contract

- **Goal:** Verify severity handling.
- **Expected outputs:** verified change.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1 — Implement

- [x] Implement the example.

## Impacted Files

- \`src/example.js\`

## Technical Notes

No additional technical notes.

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

function verifiableWorkspace({ required, criteria, extraFrontmatter, checks, policy } = {}) {
  const workspace = tempDir('vsh-verify-');
  const home = tempDir('vsh-home-');
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.email', 'harness@example.test']);
  git(workspace, ['config', 'user.name', 'Harness Test']);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 1;\nexport function helper() { return value; }\n');
  const plan = writeVerifiablePlan(workspace, { required, criteria, extraFrontmatter });
  writeChecks(workspace, checks || { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  if (policy) writeConfig(workspace, 'policy.yaml', policy);
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-qm', 'baseline']);
    approveProject({ workspace, copilotHome: copilotHomeFor(home) });
  return { workspace, home, plan };
}

/** The isolated Copilot home that pairs with a fixture's HARNESS_HOME. Derived
 * rather than passed so every existing `withHome(home, ...)` call keeps working
 * unchanged while still resolving trust inside the fixture. */
function copilotHomeFor(home) {
  return path.join(home, 'copilot');
}

async function withHome(home, fn) {
  const previous = process.env.HARNESS_HOME;
  const previousCopilot = process.env.COPILOT_HOME;
  process.env.HARNESS_HOME = home;
  process.env.COPILOT_HOME = copilotHomeFor(home);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
    if (previousCopilot === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousCopilot;
  }
}

test('E: a policy downgrading a gating check to advisory is rejected by name', () => {
  for (const id of ['scope', 'criteria-evidence', 'plan-schema', 'plan-readiness', 'required-reviews', 'hard-gaps', 'critical-findings', 'workspace-stability']) {
    const ws = policyWorkspace(`version: 2\nenforcement: enforce\nchecks:\n  ${id}:\n    severity: advisory\n`);
    assert.throws(
      () => loadPolicy(ws),
      (err) => err.message.includes(id) && /cannot be advisory/.test(err.message),
      `checks.${id}.severity: advisory must be refused with a message naming ${id}`
    );
  }
});

test('E: a gating check may still be downgraded to warn, and a project-defined named check may be advisory', () => {
  const warned = policyWorkspace('version: 2\nenforcement: enforce\nchecks:\n  scope:\n    severity: warn\n');
  assert.equal(loadPolicy(warned).checkSeverities.scope, 'warn');

  const named = policyWorkspace('version: 2\nenforcement: enforce\nchecks:\n  team-lint:\n    severity: advisory\n');
  assert.equal(loadPolicy(named).checkSeverities['team-lint'], 'advisory');
});

test('E: the advisory-by-default structural check stays downgradable, and v1 policies load unchanged', () => {
  const structural = policyWorkspace(`version: 2\nenforcement: enforce\nchecks:\n  ${STRUCTURAL_CHECK_ID}:\n    severity: advisory\n`);
  assert.equal(loadPolicy(structural).checkSeverities[STRUCTURAL_CHECK_ID], 'advisory');
  assert.equal(
    NON_ADVISORY_CHECK_IDS.has(STRUCTURAL_CHECK_ID),
    false,
    'a check whose built-in default is advisory must never be in the non-downgradable set'
  );

  // A v1 policy — no checks map at all — must load byte-identically to before.
  const v1 = policyWorkspace('version: 1\nenforcement: warn\ngate_ttl_minutes: 15\nexemptions:\n  - docs/**\n');
  assert.deepEqual(loadPolicy(v1), {
    version: 1,
    enforcement: 'warn',
        projectPolicyIgnored: false,
        projectPolicyError: null,
    policyPath: path.join(v1, '.github', 'harness', 'policy.yaml'),
    gateTtlMinutes: 15,
    evidenceTtlHours: 24,
    exemptions: ['docs/**'],
    waivers: [],
    checkSeverities: {},
  });
    const v1Checks = policyWorkspace(`version: 1\nchecks:\n  ${STRUCTURAL_CHECK_ID}:\n    severity: warn\n`);
  assert.equal(loadPolicy(v1Checks).checkSeverities[STRUCTURAL_CHECK_ID], 'warn');
  const v1Gating = policyWorkspace('version: 1\nchecks:\n  scope:\n    severity: advisory\n');
  assert.throws(() => loadPolicy(v1Gating), /cannot be advisory/);
});

test('E: every built-in check verify.mjs pushes is either non-downgradable or advisory by default', () => {
  const src = fs.readFileSync(path.join(packageRoot, 'lib', 'verify.mjs'), 'utf8');
    const ids = new Set([...src.matchAll(/resultCheck\(\s*'([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(ids.size >= 10, `expected to find the built-in check ids in verify.mjs, found ${[...ids].join(', ')}`);
  const defaultAdvisory = new Set([STRUCTURAL_CHECK_ID]);
  for (const id of ids) {
    assert.ok(
      NON_ADVISORY_CHECK_IDS.has(id) || defaultAdvisory.has(id),
      `built-in check ${id} is neither gating-protected nor advisory by default — add it to NON_ADVISORY_CHECK_IDS`
    );
  }
});

test('E: a failed plan-required check cannot be downgraded to advisory — the run does not pass', async () => {
  const { workspace, home, plan } = verifiableWorkspace({
        required: ['unit-tests', 'team-lint'],
    criteria: { AC1: ['unit-tests'] },
    checks: {
      'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
      'team-lint': { command: [process.execPath, '-e', 'process.exit(1)'] },
    },
    policy: 'version: 2\nenforcement: enforce\nchecks:\n  team-lint:\n    severity: advisory\n',
  });

  const result = await withHome(home, () => runVerify({ workspace, flags: { plan, base: 'HEAD', dryRun: false } }));

  const teamLint = result.checks.find((check) => check.id === 'team-lint');
  assert.equal(teamLint.status, 'failed', JSON.stringify(result.checks, null, 2));
  assert.notEqual(teamLint.severity, 'advisory', 'a plan-required check is never advisory');
  assert.notEqual(teamLint.optional, true);

  // FAIL-BEFORE: `passed`, with the failure hidden in advisoryFailures.
  assert.equal(result.outcome, 'failed', JSON.stringify(result.checks, null, 2));
  assert.deepEqual(result.advisoryFailures, [], 'the failure is a real gating failure, not an advisory note');

  // The refusal is recorded loudly rather than applied silently.
  assert.deepEqual(result.refusedSeverityDowngrades, [
    { id: 'team-lint', requested: 'advisory', effective: 'enforce' },
  ]);

  // And the artifact `harness gate`/`harness compound` trust agrees.
  const evidence = readEvidence(workspace, plan);
  assert.equal(evidence.outcome, 'failed');
  assert.equal(evidence.checks.find((check) => check.id === 'team-lint').severity, 'enforce');
});

test('E: a check mapped under verification.criteria is protected the same way', async () => {
  const { workspace, home, plan } = verifiableWorkspace({
    required: ['unit-tests', 'team-lint'],
    criteria: { AC1: ['unit-tests', 'team-lint'] },
    checks: {
      'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
      'team-lint': { command: [process.execPath, '-e', 'process.exit(1)'] },
    },
    policy: 'version: 2\nenforcement: enforce\nchecks:\n  team-lint:\n    severity: advisory\n',
  });

  const result = await withHome(home, () => runVerify({ workspace, flags: { plan, base: 'HEAD', dryRun: false } }));

  assert.equal(result.checks.find((check) => check.id === 'team-lint').severity, 'enforce');
  assert.equal(result.outcome, 'failed');
});

test('E: a project-defined check the plan does NOT gate on stays freely downgradable, and warn still degrades', async () => {
    const advisory = verifiableWorkspace({
    required: ['unit-tests'],
    criteria: { AC1: ['unit-tests'] },
    checks: { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } },
    policy: `version: 2\nenforcement: enforce\nchecks:\n  ${STRUCTURAL_CHECK_ID}:\n    severity: advisory\n`,
  });
  const advisoryResult = await withHome(advisory.home, () =>
    runVerify({ workspace: advisory.workspace, flags: { plan: advisory.plan, base: 'HEAD', dryRun: false } })
  );
  assert.equal(advisoryResult.outcome, 'passed', JSON.stringify(advisoryResult.checks, null, 2));
  assert.equal(advisoryResult.checks.find((check) => check.id === STRUCTURAL_CHECK_ID).severity, 'advisory');
  assert.deepEqual(advisoryResult.refusedSeverityDowngrades, []);

    const warned = verifiableWorkspace({
    required: ['unit-tests', 'team-lint'],
    criteria: { AC1: ['unit-tests'] },
    checks: {
      'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
      'team-lint': { command: [process.execPath, '-e', 'process.exit(1)'] },
    },
    policy: 'version: 2\nenforcement: enforce\nchecks:\n  team-lint:\n    severity: warn\n',
  });
  const warnedResult = await withHome(warned.home, () =>
    runVerify({ workspace: warned.workspace, flags: { plan: warned.plan, base: 'HEAD', dryRun: false } })
  );
  assert.equal(warnedResult.checks.find((check) => check.id === 'team-lint').severity, 'warn');
  assert.equal(warnedResult.outcome, 'inconclusive');
  assert.deepEqual(warnedResult.refusedSeverityDowngrades, []);
});

function hostileCheck() {
  const huge = 'x'.repeat(200_000);
  return {
    id: STRUCTURAL_CHECK_ID,
    status: 'failed',
    severity: 'advisory',
    message: `2 structural findings\n${AWS_KEY}`,
    findings: [
      {
        type: 'unplanned-symbol-change',
        file: 'infra/main.tf',
        added: [`${huge}\nfake heading`, AWS_KEY],
        removed: [],
      },
      { type: 'removed-symbol-with-callers', file: 'a.ts', symbol: 'foo', callers: ['b.ts'] },
    ],
    informational: [{ type: 'tier-mismatch-skipped', file: 'a.ts', message: `skipped ${AWS_KEY}` }],
  };
}

for (const [surface, sanitize] of [
  ['the canonical check payload', (check) => sanitizeCheckPayload(check)],
  ['the advisory summary copy', (check) => collectAdvisoryFailures([check])[0]],
]) {
  test(`G: ${surface} is redacted, flattened to one line, and capped`, () => {
    const payload = sanitize(hostileCheck());

    assert.equal(payload.id, STRUCTURAL_CHECK_ID);
    const serialized = JSON.stringify(payload);
    assert.ok(serialized.length < 5_000, `payload must be bounded, got ${serialized.length} bytes`);
    assert.ok(!serialized.includes(AWS_KEY), 'secret-shaped repo text is redacted');
    assert.ok(!payload.message.includes('\n'), 'the message renders as one line');
    assert.equal(payload.findings[0].added[0].length, 240, 'an unbounded extracted symbol is capped');
    assert.ok(!payload.findings[0].added[0].includes('\n'), 'and flattened');
    assert.equal(payload.findings[1].symbol, 'foo', 'well-formed findings pass through intact');
    assert.deepEqual(payload.findings[1].callers, ['b.ts']);
  });
}

test('G: plan-derived details and openTasks are sanitized like every other list payload', () => {
  const payload = sanitizeCheckPayload({
    id: 'plan-schema',
    status: 'failed',
    severity: 'enforce',
    message: 'schema invalid',
    details: [{ pass: false, message: `bad field\n${AWS_KEY}` }],
    openTasks: [`ship it using ${AWS_KEY}`, 'x'.repeat(200_000)],
  });
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(AWS_KEY), 'plan-derived text is redacted');
  assert.ok(!payload.details[0].message.includes('\n'), 'details flatten to one line');
  assert.equal(payload.openTasks[1].length, 240, 'an unbounded task line is capped');
  assert.equal(payload.details[0].pass, false, 'well-formed structural fields pass through intact');
});

test('G: the canonical payload also sanitizes informational notes and keeps structural fields intact', () => {
  const check = sanitizeCheckPayload(hostileCheck());
  assert.ok(!JSON.stringify(check.informational).includes(AWS_KEY), 'informational notes are redacted');
  assert.ok(!JSON.stringify(check.informational).includes(CTRL_IN_JSON), 'and flattened');
  assert.equal(check.status, 'failed', 'status is a code-set token, untouched');
  assert.equal(check.severity, 'advisory', 'severity is a code-set token, untouched');
});

test('G: the shipped payload bounds the number of findings and the size of every nested list', () => {
  const check = {
    id: STRUCTURAL_CHECK_ID,
    status: 'failed',
    severity: 'advisory',
    message: 'many findings',
    findings: Array.from({ length: 500 }, (_, i) => ({
      type: 'unplanned-symbol-change',
      file: `f${i}.ts`,
      added: Array.from({ length: 500 }, (_, j) => `sym-${j}`),
    })),
  };
  for (const payload of [sanitizeCheckPayload(check), collectAdvisoryFailures([check])[0]]) {
    assert.equal(payload.findings.length, 50, 'findings are capped');
    assert.equal(payload.findings[0].added.length, 20, 'nested lists are capped');
  }
});

// End to end: the guarantee is only worth anything on the artifact that ships.
test('G: hostile check text never reaches the on-disk evidence artifact or the --json result', async () => {
  const { workspace, home, plan } = verifiableWorkspace({
        extraFrontmatter: [
      'structural_expectations:',
      '  - file: "src/example.js"',
      `    symbol: "${AWS_KEY}"`,
      '    change: "removed"',
      '    required: true',
      `  - "\\x01malformed ${AWS_KEY}"`,
      '',
    ].join('\n'),
  });
    await buildStructuralIndex({
    workspace,
    home,
    extractor: {
      counters: { parseFailures: 0, parsed: 0, errorFiles: 0 },
      tier: 'lexical',
      webTreeSitter: null,
      grammarVersions: {},
      missingGrammars: [],
      integrityFailures: [],
      extract: (rel, content) => lexicalV2(rel, content),
    },
  });
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 2;\nexport function helper() { return value; }\n');

  const result = await withHome(home, () => runVerify({ workspace, flags: { plan, base: 'HEAD', dryRun: false } }));

  const structural = result.checks.find((check) => check.id === STRUCTURAL_CHECK_ID);
  assert.equal(structural.status, 'failed', JSON.stringify(structural, null, 2));
  assert.ok(structural.findings.length > 0, 'the hostile expectation produced a finding');
    assert.equal(result.outcome, 'passed', JSON.stringify(result.checks, null, 2));

  // FAIL-BEFORE: both of these carried the raw key and the raw control char.
  const asJson = JSON.stringify(result);
  assert.ok(!asJson.includes(AWS_KEY), 'verify --json carries no raw secret-shaped repo text');
  assert.ok(!asJson.includes(CTRL_IN_JSON), 'verify --json carries no raw control characters');
  assert.match(asJson, /\[redacted:/, 'the redaction marker replaces it');

  const onDisk = fs.readFileSync(path.join(workspace, result.evidencePath), 'utf8');
  assert.ok(!onDisk.includes(AWS_KEY), 'the evidence artifact carries no raw secret-shaped repo text');
  assert.ok(!onDisk.includes(CTRL_IN_JSON), 'the evidence artifact carries no raw control characters');
});

test('G: a passing or skipped advisory check contributes nothing, and non-advisory checks are never collected', () => {
  assert.deepEqual(
    collectAdvisoryFailures([
      { id: STRUCTURAL_CHECK_ID, status: 'passed', severity: 'advisory', message: 'ok' },
      { id: STRUCTURAL_CHECK_ID, status: 'skipped', severity: 'advisory', message: 'skipped' },
      { id: 'scope', status: 'failed', severity: 'enforce', message: 'violations' },
    ]),
    []
  );
});
