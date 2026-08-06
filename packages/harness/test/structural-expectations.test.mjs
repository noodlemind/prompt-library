// Phase 4 — per-check severity (policy v2) and the advisory
// `structural-expectations` verify check.
//
// FIXTURE DISCIPLINE: the baseline index under test is written by the REAL
// builder (`buildStructuralIndex`) from the fixture workspace, so every
// assertion here pins the contract against a shape the builder actually emits.
// Hand-written index JSON is reserved for the reader's own malformed-input
// tests below, where the point IS an off-contract file on disk.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { loadPolicy, checkSeverityFor, enforcementExitCode } from '../lib/policy.mjs';
import { structuralDir, readStructuralIndex, STRUCTURAL_SHAPE_VERSION } from '../lib/structural/shape.mjs';
import { runStructuralExpectations, STRUCTURAL_CHECK_ID } from '../lib/structural/expectations.mjs';
import { buildStructuralIndex } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';
import { runVerify } from '../lib/verify.mjs';
import { readEvidence } from '../lib/evidence.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(workspace, args) {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function initGitWorkspace(workspace) {
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.email', 'harness@example.test']);
  git(workspace, ['config', 'user.name', 'Harness Test']);
}

function commitAll(workspace, message) {
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-q', '-m', message]);
  return git(workspace, ['rev-parse', 'HEAD']);
}

function writePolicy(workspace, yaml) {
  const dir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.yaml'), yaml, 'utf8');
}

function writeChecks(workspace, checks) {
  const dir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(dir, { recursive: true });
  const body = Object.entries(checks)
    .map(([name, check]) => `  ${name}:\n    command: ${JSON.stringify(check.command)}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, 'checks.yaml'), `version: 1\nchecks:\n${body}\n`, 'utf8');
}

function writeVerifiablePlan(workspace, { impacted = ['src/example.js'], extraFrontmatter = '' } = {}) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const rel = 'docs/plans/2026-08-06-feat-structural-plan.md';
  fs.writeFileSync(
    path.join(workspace, rel),
    `---
plan_schema: 1
title: "Structural example"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Verify structurally"
expected_outputs:
  - "verified change"
success_criteria:
  - "AC1 Example works"
verification:
  required: ["unit-tests"]
  criteria:
    AC1: ["unit-tests"]
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
skills_used: ["engineer"]
${extraFrontmatter}---

# Structural example

## Overview

Verify the example.

## Intent Contract

- **Goal:** Verify structurally.
- **Expected outputs:** verified change.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1 — Implement

- [x] Implement the example.

## Impacted Files

${impacted.map((file) => `- \`${file}\``).join('\n')}

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

/** An injectable extractor in the builder's own shape. `tier: 'treesitter'`
 * stamps the per-file tier the AST tier emits — the builder's real output for
 * a grammar-parsed file — without needing the optional grammars installed. */
function extractorFor(tier = 'lexical') {
  return {
    counters: { parseFailures: 0, parsed: 0, errorFiles: 0 },
    tier,
    webTreeSitter: null,
    grammarVersions: {},
    missingGrammars: [],
    integrityFailures: [],
    extract: (rel, content) => (tier === 'lexical' ? lexicalV2(rel, content) : { ...lexicalV2(rel, content), tier }),
  };
}

/** Baseline written by the REAL builder from the fixture workspace:
 * src/example.js exports `value` and `helper`; src/consumer.js imports
 * `value`, so the tables carry the export flags and the caller edge. */
function buildBaseline(workspace, home, { tier = 'lexical' } = {}) {
  return buildStructuralIndex({ workspace, home, extractor: extractorFor(tier) });
}

/** Hand-written index for the READER's malformed/off-contract cases only. */
function writeStructuralIndex(workspace, home, { sha, files, symbols, graph, extractorTier = 'lexical' } = {}) {
  const dir = structuralDir(workspace, { home });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'files.json'),
    JSON.stringify({ version: STRUCTURAL_SHAPE_VERSION, files: files ?? {} }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'symbols.json'),
    JSON.stringify({ version: STRUCTURAL_SHAPE_VERSION, symbols: symbols ?? [] }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'graph.json'),
    JSON.stringify(
      { version: STRUCTURAL_SHAPE_VERSION, calls: graph?.calls ?? [], modules: graph?.modules ?? [], unresolved: graph?.unresolved ?? [] },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      {
        version: STRUCTURAL_SHAPE_VERSION,
        sha,
        branch: 'main',
        baseSha: sha,
        generatedAt: new Date().toISOString(),
        extractorTier,
        grammarVersions: {},
      },
      null,
      2
    )
  );
  return dir;
}

/** A LEGACY on-disk index: wrapper form, no per-file `tier` anywhere. Kept
 * hand-written on purpose — the point of its one test is an index shape the
 * current builder no longer emits. */
function legacyUntieredBaseline(sha) {
  return {
    sha,
    files: {
      'src/example.js': { hash: 'a'.repeat(64), mtime: 0, size: 60, symbols: ['value', 'helper'], imports: [], complexity: 1 },
      'src/consumer.js': { hash: 'b'.repeat(64), mtime: 0, size: 90, symbols: ['main'], imports: ['./example.js'], complexity: 1 },
    },
    symbols: [
      { name: 'value', file: 'src/example.js', kind: 'const', exported: true, def: { line: 1 }, refs: [{ file: 'src/consumer.js', line: 2 }] },
      { name: 'helper', file: 'src/example.js', kind: 'function', exported: true, def: { line: 2 }, refs: [] },
      { name: 'main', file: 'src/consumer.js', kind: 'function', exported: true, def: { line: 2 }, refs: [] },
    ],
    graph: {
      calls: [{ from: 'src/consumer.js#main', to: 'src/example.js#value' }],
      modules: [{ from: 'src/consumer.js', to: 'src/example.js' }],
      unresolved: [],
    },
  };
}

/** Committed fixture repo: exporting module + surviving consumer. The policy
 * (when given) is committed with the baseline so it never trips the scope check. */
function structuralWorkspace({ policy = null } = {}) {
  const workspace = tempDir('structural-ws-');
  const home = tempDir('structural-home-');
  initGitWorkspace(workspace);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'src', 'example.js'),
    'export const value = 1;\nexport function helper() { return value; }\n'
  );
  fs.writeFileSync(
    path.join(workspace, 'src', 'consumer.js'),
    "import { value } from './example.js';\nexport function main() { return value; }\n"
  );
  const plan = writeVerifiablePlan(workspace);
  writeChecks(workspace, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  if (policy) writePolicy(workspace, policy);
  const sha = commitAll(workspace, 'baseline');
  return { workspace, home, plan, sha };
}

function minimalPlan(impacted, fm = {}) {
  return {
    path: 'docs/plans/x.md',
    fm,
    sections: { impactedFiles: impacted.map((file) => `- \`${file}\``).join('\n') },
  };
}

function withHome(home, fn) {
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
  }
}

// --- policy schema v2 ---

test('v1 policy without checks parses exactly as before, with an empty severity map', () => {
  const workspace = tempDir('policy-v1-');
  writePolicy(workspace, 'version: 1\nenforcement: warn\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\nexemptions: []\nwaivers: []\n');
  const policy = loadPolicy(workspace);
  assert.equal(policy.version, 1);
  assert.equal(policy.enforcement, 'warn');
  assert.equal(policy.gateTtlMinutes, 30);
  assert.equal(policy.evidenceTtlHours, 24);
  assert.deepEqual(policy.exemptions, []);
  assert.deepEqual(policy.waivers, []);
  assert.deepEqual(policy.checkSeverities, {});
  assert.equal(checkSeverityFor(policy, 'scope'), 'enforce');
});

test('v2 policy parses per-check severities', () => {
  const workspace = tempDir('policy-v2-');
  writePolicy(
    workspace,
    'version: 2\nenforcement: enforce\nchecks:\n  structural-expectations:\n    severity: warn\n  scope:\n    severity: enforce\n'
  );
  const policy = loadPolicy(workspace);
  assert.equal(policy.version, 2);
  assert.deepEqual(policy.checkSeverities, { 'structural-expectations': 'warn', scope: 'enforce' });
  assert.equal(checkSeverityFor(policy, 'structural-expectations', 'advisory'), 'warn');
  assert.equal(checkSeverityFor(policy, 'unlisted', 'advisory'), 'advisory');
});

test('unknown check severity is rejected with a clear error', () => {
  const workspace = tempDir('policy-bad-severity-');
  writePolicy(workspace, 'version: 2\nchecks:\n  structural-expectations:\n    severity: fatal\n');
  assert.throws(() => loadPolicy(workspace), /checks\.structural-expectations\.severity must be advisory, warn, or enforce \(got fatal\)/);
});

test('non-mapping checks entries are rejected', () => {
  const workspace = tempDir('policy-bad-checks-');
  writePolicy(workspace, 'version: 2\nchecks:\n  - structural-expectations\n');
  assert.throws(() => loadPolicy(workspace), /checks must be a mapping/);
  writePolicy(workspace, 'version: 2\nchecks:\n  structural-expectations: advisory\n');
  assert.throws(() => loadPolicy(workspace), /checks\.structural-expectations must be a mapping/);
});

test('policy versions other than 1 and 2 are rejected', () => {
  const workspace = tempDir('policy-bad-version-');
  writePolicy(workspace, 'version: 3\nenforcement: enforce\n');
  assert.throws(() => loadPolicy(workspace), /expected version 1 or 2/);
});

// --- shape module ---

test('structuralDir honors HARNESS_HOME and readStructuralIndex reports absence', () => {
  const workspace = tempDir('shape-ws-');
  const home = tempDir('shape-home-');
  initGitWorkspace(workspace);
  const dir = structuralDir(workspace, { home });
  assert.ok(dir.startsWith(path.join(home, 'index')), dir);
  assert.ok(dir.endsWith(path.join('structural')), dir);
  const index = readStructuralIndex(workspace, { home });
  assert.equal(index.present, false);
  assert.match(index.reason, /not found/);
});

test('readStructuralIndex requires meta.json with a valid sha and skips on malformed JSON', () => {
  const workspace = tempDir('shape-ws-');
  const home = tempDir('shape-home-');
  initGitWorkspace(workspace);
  const dir = structuralDir(workspace, { home });
  fs.mkdirSync(dir, { recursive: true });
  assert.match(readStructuralIndex(workspace, { home }).reason, /no meta\.json/);

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, sha: 'not-a-sha' }));
  assert.match(readStructuralIndex(workspace, { home }).reason, /no valid baseline sha/);

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, sha: 'a'.repeat(40) }));
  fs.writeFileSync(path.join(dir, 'files.json'), '{ broken');
  assert.match(readStructuralIndex(workspace, { home }).reason, /unreadable structural index/);

  fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify({ version: 1, files: {} }));
  const index = readStructuralIndex(workspace, { home });
  assert.equal(index.present, true);
  assert.deepEqual(index.symbols, []);
  assert.deepEqual(index.graph.calls, []);
});

// --- structural-expectations check unit behavior ---

test('missing structural index reports skipped, never fails', () => {
  const { workspace, home } = structuralWorkspace();
  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /skipped/i);
  assert.deepEqual(result.findings, []);
});

test('stale baseline (meta.sha not an ancestor of HEAD) warns and skips', async () => {
  const { workspace, home } = structuralWorkspace();
  // A commit on a side branch is not an ancestor of the restored main HEAD —
  // the index is built there, so meta.sha is genuinely off-history.
  git(workspace, ['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(workspace, 'src', 'side.js'), 'export const side = 1;\n');
  commitAll(workspace, 'side work');
  await buildBaseline(workspace, home);
  git(workspace, ['checkout', '-q', '-']);

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /not an ancestor of HEAD/);
  assert.match(result.message, /harness index --structural/);
});

test('removed exported symbol with a surviving caller is flagged', async () => {
  const { workspace, home, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  // Remove `value` while the untouched consumer still calls it.
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(result.status, 'failed');
  const removed = result.findings.filter((finding) => finding.type === 'removed-symbol-with-callers');
  assert.ok(removed.some((finding) => finding.symbol === 'value' && finding.callers.includes('src/consumer.js')), JSON.stringify(result.findings));
  // `helper` was also removed, but it has no callers outside the change.
  assert.ok(!removed.some((finding) => finding.symbol === 'helper'), JSON.stringify(removed));
});

test('a treesitter-tier baseline is never diffed against the lexical current side — skipped, not passed', async () => {
  const { workspace, home } = structuralWorkspace();
  // The whole baseline is written by the builder at the treesitter tier; the
  // check's current side is always lexical, so any diff would be unsound.
  await buildBaseline(workspace, home, { tier: 'treesitter' });
  // Without the tier gate this removal fabricates removed-symbol findings.
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js'], {
      structural_expectations: [{ file: 'src/example.js', symbol: 'other', change: 'added', required: true }],
    }),
    changedFiles: ['src/example.js'],
    home,
  });
  // Nothing was compared, so this is a SKIP, not a green gate over an empty
  // comparison (which an `enforce` opt-in would read as a pass).
  assert.equal(result.status, 'skipped', JSON.stringify(result.findings));
  assert.deepEqual(result.findings, []);
  const notes = result.informational.filter((note) => note.type === 'tier-mismatch-skipped');
  assert.ok(notes.some((note) => note.file === 'src/example.js' && note.tier === 'treesitter'), JSON.stringify(result.informational));
  // A required expectation on the tier-skipped file is unverifiable — it must
  // surface informationally, never as a fabricated unmet-required failure.
  assert.ok(notes.some((note) => note.symbol === 'other'), JSON.stringify(result.informational));
  assert.match(result.message, /compared nothing/);
});

test('an untiered file entry inherits meta.extractorTier — treesitter index never diffs against lexical', () => {
  const { workspace, home, sha } = structuralWorkspace();
  // No per-file tier anywhere (a legacy index), but the index-wide meta
  // declares treesitter: the untiered entry must inherit that tier and be
  // skipped, not diffed as lexical (which would fabricate findings here).
  writeStructuralIndex(workspace, home, { ...legacyUntieredBaseline(sha), extractorTier: 'treesitter' });
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(result.status, 'skipped', JSON.stringify(result.findings));
  assert.deepEqual(result.findings, []);
  const notes = result.informational.filter((note) => note.type === 'tier-mismatch-skipped');
  assert.ok(notes.some((note) => note.file === 'src/example.js' && note.tier === 'treesitter'), JSON.stringify(result.informational));
});

test('callers that changed in the same diff do not count as surviving', async () => {
  const { workspace, home, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');
  fs.writeFileSync(path.join(workspace, 'src', 'consumer.js'), "import { other } from './example.js';\nexport function main() { return other; }\n");

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js', 'src/consumer.js']),
    changedFiles: ['src/example.js', 'src/consumer.js'],
    home,
  });
  assert.ok(!result.findings.some((finding) => finding.type === 'removed-symbol-with-callers'), JSON.stringify(result.findings));
});

test('changed exported symbols outside Impacted Files are flagged; planned ones are not', async () => {
  const { workspace, home, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  // Added symbol in a planned file: fine. New file with symbols outside the plan: flagged.
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 1;\nexport function helper() { return value; }\nexport const added = 3;\n');
  fs.writeFileSync(path.join(workspace, 'src', 'unplanned.js'), 'export const rogue = 9;\n');

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/example.js', 'src/unplanned.js'],
    home,
  });
  assert.equal(result.status, 'failed');
  const unplanned = result.findings.filter((finding) => finding.type === 'unplanned-symbol-change');
  assert.deepEqual(unplanned.map((finding) => finding.file), ['src/unplanned.js']);
  assert.deepEqual(unplanned[0].added, ['rogue']);
});

test('unplanned-symbol-change reports EXPORTED changes only — a local addition is not a public change', async () => {
  const { workspace, home } = structuralWorkspace();
  await buildBaseline(workspace, home);
  // Unplanned file whose only new symbol is module-private: nothing about the
  // module surface changed, so the contract ("changed exported symbols outside
  // Impacted Files") must not fire.
  fs.writeFileSync(path.join(workspace, 'src', 'private.js'), 'function Hidden() { return 1; }\nHidden();\n');

  const quiet = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/private.js'],
    home,
  });
  assert.deepEqual(quiet.findings, [], JSON.stringify(quiet.findings));

  // The same file gaining an EXPORT is a public change and does fire.
  fs.writeFileSync(path.join(workspace, 'src', 'private.js'), 'export function Hidden() { return 1; }\n');
  const loud = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/private.js'],
    home,
  });
  const unplanned = loud.findings.filter((finding) => finding.type === 'unplanned-symbol-change');
  assert.deepEqual(unplanned.map((finding) => finding.added), [['Hidden']], JSON.stringify(loud.findings));
});

test('a changed file the check cannot evaluate never fails a required expectation', async () => {
  const { workspace, home } = structuralWorkspace();
  await buildBaseline(workspace, home);
  // .go is not a language the lexical extractor reads and has no baseline
  // entry: the check cannot say anything about it, so a required expectation
  // on it is informational — not a hard finding regardless of the change.
  fs.writeFileSync(path.join(workspace, 'src', 'thing.go'), 'package main\nfunc Thing() {}\n');

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/thing.go'], {
      structural_expectations: [{ file: 'src/thing.go', symbol: 'Thing', change: 'added', required: true }],
    }),
    changedFiles: ['src/thing.go'],
    home,
  });
  assert.deepEqual(result.findings, [], JSON.stringify(result.findings));
  assert.equal(result.status, 'skipped', result.message);
  assert.ok(
    result.informational.some((note) => note.type === 'expectation-not-evaluated' && note.file === 'src/thing.go'),
    JSON.stringify(result.informational)
  );
  assert.ok(
    result.informational.some((note) => note.type === 'file-not-evaluated' && note.file === 'src/thing.go'),
    JSON.stringify(result.informational)
  );
});

test('a truncated baseline table degrades findings to informational instead of asserting them', async () => {
  const { workspace, home } = structuralWorkspace();
  // A build that hits MAX_SYMBOL_TABLE: past the cap the symbol table is
  // incomplete, so "removed symbol with callers" cannot be asserted from it.
  const build = await buildStructuralIndex({
    workspace,
    home,
    extractor: {
      ...extractorFor('lexical'),
      extract: (rel, content) => {
        const base = lexicalV2(rel, content);
        if (rel !== 'src/example.js') return base;
        const filler = Array.from({ length: 20_000 }, (_, i) => ({ name: `filler${i}`, kind: 'symbol', line: 1, exported: false }));
        return { ...base, defs: [...base.defs, ...filler] };
      },
    },
  });
  assert.equal(build.meta.symbolsTruncated, true, 'the build must record that it hit the cap');

  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');
  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.deepEqual(result.findings, [], JSON.stringify(result.findings));
  assert.ok(
    result.informational.some((note) => note.type === 'removed-symbol-with-callers-informational' && /build cap/.test(note.message)),
    JSON.stringify(result.informational)
  );
});

test('a clean structural diff passes with an examined-files summary', async () => {
  const { workspace, home, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 11;\nexport function helper() { return value; }\n');

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(result.status, 'passed');
  assert.match(result.message, /1 file examined/);
  assert.equal(result.baseline.sha, sha);
});

test('deleted files count every baseline exported symbol as removed', async () => {
  const { workspace, home, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  fs.rmSync(path.join(workspace, 'src', 'example.js'));

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.findings.some((finding) => finding.type === 'removed-symbol-with-callers' && finding.symbol === 'value'));
});

// --- structural_expectations plan frontmatter (stretch hook) ---

test('required structural expectations fail the check when unmet; optional ones stay informational', async () => {
  const { workspace, home, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 11;\nexport function helper() { return value; }\n');

  const fm = {
    structural_expectations: [
      { file: 'src/example.js', symbol: 'brandNew', change: 'added', required: true },
      { file: 'src/example.js', symbol: 'alsoNew', change: 'added' },
    ],
  };
  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js'], fm),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.findings.map((finding) => finding.type),
    ['unmet-required-expectation']
  );
  assert.equal(result.findings[0].symbol, 'brandNew');
  assert.ok(result.informational.some((entry) => entry.type === 'unmet-expectation' && entry.symbol === 'alsoNew'));
});

test('met structural expectations pass and an absent block skips cleanly', async () => {
  const { workspace, home, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 11;\nexport function helper() { return value; }\nexport const added = 3;\n');

  const met = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js'], {
      structural_expectations: [
        { file: 'src/example.js', symbol: 'added', change: 'added', required: true },
        { file: 'src/example.js', symbol: 'value', change: 'modified', required: true },
      ],
    }),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(met.status, 'passed', JSON.stringify(met.findings));

  const absent = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js']),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(absent.status, 'passed');
  assert.deepEqual(absent.informational, []);
});

test('malformed expectation entries are reported informationally, never fail', async () => {
  const { workspace, home, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 11;\nexport function helper() { return value; }\n');

  const result = runStructuralExpectations({
    workspace,
    plan: minimalPlan(['src/example.js'], { structural_expectations: [{ symbol: 'x', change: 'exploded' }, 'nonsense'] }),
    changedFiles: ['src/example.js'],
    home,
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.informational.filter((entry) => entry.type === 'malformed-expectation').length, 2);
});

// --- verify integration: severity routing and evidence payload ---

function verifyFlags(plan, overrides = {}) {
  return { plan, base: 'HEAD', dryRun: false, ...overrides };
}

test('advisory structural failure does not flip a passing verify outcome', async () => {
  const { workspace, home, plan, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');

  const result = withHome(home, () => runVerify({ workspace, flags: verifyFlags(plan) }));
  assert.equal(result.outcome, 'passed', JSON.stringify(result.checks, null, 2));
  assert.equal(enforcementExitCode(result.outcome, 'enforce'), 0);

  const structural = result.checks.find((check) => check.id === STRUCTURAL_CHECK_ID);
  assert.equal(structural.status, 'failed');
  assert.equal(structural.severity, 'advisory');
  assert.equal(structural.optional, true);
  assert.ok(structural.findings.length > 0);

  // Nothing silently lost: the advisory failure lands in its own field.
  assert.equal(result.advisoryFailures.length, 1);
  assert.equal(result.advisoryFailures[0].id, STRUCTURAL_CHECK_ID);
  assert.equal(result.advisoryFailures[0].status, 'failed');
  assert.ok(Array.isArray(result.advisoryFailures[0].findings));
});

test('policy warn severity degrades a structural failure to inconclusive (exit 2 under enforce)', async () => {
  const { workspace, home, plan, sha } = structuralWorkspace({
    policy: 'version: 2\nenforcement: enforce\nchecks:\n  structural-expectations:\n    severity: warn\n',
  });
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');

  const result = withHome(home, () => runVerify({ workspace, flags: verifyFlags(plan) }));
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(enforcementExitCode(result.outcome, result.enforcement), 2);
  const structural = result.checks.find((check) => check.id === STRUCTURAL_CHECK_ID);
  assert.equal(structural.severity, 'warn');
  assert.deepEqual(result.advisoryFailures, []);
});

test('policy enforce severity makes a structural failure fail verification (exit 1)', async () => {
  const { workspace, home, plan, sha } = structuralWorkspace({
    policy: 'version: 2\nenforcement: enforce\nchecks:\n  structural-expectations:\n    severity: enforce\n',
  });
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');

  const result = withHome(home, () => runVerify({ workspace, flags: verifyFlags(plan) }));
  assert.equal(result.outcome, 'failed');
  assert.equal(enforcementExitCode(result.outcome, result.enforcement), 1);
  // The only failed check is the structural one — the failure is genuinely its doing.
  const failed = result.checks.filter((check) => check.status === 'failed');
  assert.deepEqual(failed.map((check) => check.id), [STRUCTURAL_CHECK_ID]);
});

test('global observe enforcement never gates the exit code, but per-check enforce severity still routes the outcome', async () => {
  const { workspace, home, plan, sha } = structuralWorkspace({
    policy: 'version: 2\nenforcement: observe\nchecks:\n  structural-expectations:\n    severity: enforce\n',
  });
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');

  const result = withHome(home, () => runVerify({ workspace, flags: verifyFlags(plan) }));
  assert.equal(result.outcome, 'failed', 'per-check enforce severity still fails the outcome');
  assert.equal(result.enforcement, 'observe');
  assert.equal(enforcementExitCode(result.outcome, result.enforcement), 0, 'observe mode reports without gating the exit code');
});

test('a passing verify run with no structural index behaves as before (v1 compatibility round-trip)', () => {
  // No structural index written; v1 policy file present.
  const { workspace, home, plan } = structuralWorkspace({
    policy: 'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\nexemptions: []\nwaivers: []\n',
  });

  const result = withHome(home, () => runVerify({ workspace, flags: verifyFlags(plan) }));
  assert.equal(result.outcome, 'passed', JSON.stringify(result.checks, null, 2));
  const structural = result.checks.find((check) => check.id === STRUCTURAL_CHECK_ID);
  assert.equal(structural.status, 'skipped');
  assert.deepEqual(result.advisoryFailures, []);
  // Every non-advisory check carries the v1-equivalent enforce severity.
  for (const check of result.checks) {
    if (check.id === STRUCTURAL_CHECK_ID) assert.equal(check.severity, 'advisory');
    else assert.equal(check.severity, 'enforce');
  }
});

test('a hard check failure still fails verification regardless of advisory checks', async () => {
  const { workspace, home, plan, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  // Scope violation: change a file the plan does not allow.
  fs.writeFileSync(path.join(workspace, 'src', 'rogue.js'), 'export const rogue = 1;\n');

  const result = withHome(home, () => runVerify({ workspace, flags: verifyFlags(plan) }));
  assert.equal(result.outcome, 'failed');
  const scope = result.checks.find((check) => check.id === 'scope');
  assert.equal(scope.status, 'failed');
  assert.equal(scope.severity, 'enforce');
});

test('evidence payload records per-check severity and advisory failures', async () => {
  const { workspace, home, plan, sha } = structuralWorkspace();
  await buildBaseline(workspace, home);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const other = 2;\n');

  const result = withHome(home, () => runVerify({ workspace, flags: verifyFlags(plan) }));
  const evidence = readEvidence(workspace, result.plan);
  assert.ok(evidence, 'evidence artifact must exist');
  assert.equal(evidence.outcome, 'passed');
  assert.ok(evidence.checks.every((check) => ['advisory', 'warn', 'enforce'].includes(check.severity)));
  const structural = evidence.checks.find((check) => check.id === STRUCTURAL_CHECK_ID);
  assert.equal(structural.severity, 'advisory');
  assert.equal(structural.status, 'failed');
  assert.equal(evidence.advisoryFailures.length, 1);
  assert.equal(evidence.advisoryFailures[0].id, STRUCTURAL_CHECK_ID);
  assert.ok(evidence.advisoryFailures[0].findings.some((finding) => finding.type === 'removed-symbol-with-callers'));
});
