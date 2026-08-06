import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadPolicy, NON_ADVISORY_CHECK_IDS } from '../lib/policy.mjs';
import { collectAdvisoryFailures } from '../lib/verify.mjs';
import { STRUCTURAL_CHECK_ID } from '../lib/structural/expectations.mjs';

/**
 * E — `advisory` is not a severity for a gating check. resolveOutcome
 * (verify.mjs) filters advisory checks OUT of the outcome, so downgrading
 * `scope` (or criteria/plan/review/gap checks) would write `outcome: passed`
 * into the evidence artifact `harness gate` and `harness compound` trust: the
 * gate opens on a real scope violation AND a "verified" fix episode is minted
 * from a run that never verified.
 *
 * G — advisory findings carry current-side repo text (a lexical extractor's
 * unbounded symbol names) and are copied verbatim into `.harness/evidence/*.json`
 * and `verify --json`. They must be redacted, flattened, and capped there.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function policyWorkspace(yaml) {
  const ws = tempDir('vsh-ws-');
  const full = path.join(ws, '.github', 'harness', 'policy.yaml');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, yaml, 'utf8');
  return ws;
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
    gateTtlMinutes: 15,
    evidenceTtlHours: 24,
    exemptions: ['docs/**'],
    waivers: [],
    checkSeverities: {},
  });
  // A v1 policy that DOES carry a checks map is still honored version-
  // independently — and still refused for a gating downgrade.
  const v1Checks = policyWorkspace(`version: 1\nchecks:\n  ${STRUCTURAL_CHECK_ID}:\n    severity: warn\n`);
  assert.equal(loadPolicy(v1Checks).checkSeverities[STRUCTURAL_CHECK_ID], 'warn');
  const v1Gating = policyWorkspace('version: 1\nchecks:\n  scope:\n    severity: advisory\n');
  assert.throws(() => loadPolicy(v1Gating), /cannot be advisory/);
});

test('E: every built-in check verify.mjs pushes is either non-downgradable or advisory by default', () => {
  const src = fs.readFileSync(path.join(packageRoot, 'lib', 'verify.mjs'), 'utf8');
  // Literal-id pushes only: `resultCheck(name, …)` (project-defined named
  // checks) and `resultCheck(STRUCTURAL_CHECK_ID, …)` carry no string literal
  // and are deliberately out of scope here.
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

test('G: advisory findings are redacted, flattened to one line, and capped before reaching the evidence payload', () => {
  const huge = 'x'.repeat(200_000);
  const [failure] = collectAdvisoryFailures([
    {
      id: STRUCTURAL_CHECK_ID,
      status: 'failed',
      severity: 'advisory',
      message: `2 structural findings\nAKIAIOSFODNN7EXAMPLE`,
      findings: [
        {
          type: 'unplanned-symbol-change',
          file: 'infra/main.tf',
          added: [`${huge}\nfake heading`, 'AKIAIOSFODNN7EXAMPLE'],
          removed: [],
        },
        { type: 'removed-symbol-with-callers', file: 'a.ts', symbol: 'foo', callers: ['b.ts'] },
      ],
    },
  ]);

  assert.equal(failure.id, STRUCTURAL_CHECK_ID);
  const serialized = JSON.stringify(failure);
  assert.ok(serialized.length < 5_000, `advisory payload must be bounded, got ${serialized.length} bytes`);
  assert.ok(!serialized.includes('AKIAIOSFODNN7EXAMPLE'), 'secret-shaped repo text is redacted');
  assert.ok(!failure.message.includes('\n'), 'the message renders as one line');
  assert.equal(failure.findings[0].added[0].length, 240, 'an unbounded extracted symbol is capped');
  assert.ok(!failure.findings[0].added[0].includes('\n'), 'and flattened');
  assert.equal(failure.findings[1].symbol, 'foo', 'well-formed findings pass through intact');
  assert.deepEqual(failure.findings[1].callers, ['b.ts']);
});

test('G: the advisory payload bounds the number of findings and the size of every nested list', () => {
  const [failure] = collectAdvisoryFailures([
    {
      id: STRUCTURAL_CHECK_ID,
      status: 'failed',
      severity: 'advisory',
      message: 'many findings',
      findings: Array.from({ length: 500 }, (_, i) => ({
        type: 'unplanned-symbol-change',
        file: `f${i}.ts`,
        added: Array.from({ length: 500 }, (_, j) => `sym-${j}`),
      })),
    },
  ]);
  assert.equal(failure.findings.length, 50, 'findings are capped');
  assert.equal(failure.findings[0].added.length, 20, 'nested lists are capped');
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
