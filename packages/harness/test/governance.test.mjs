import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, storeDir, listLearnings, readGovernance, rewriteGovernance } from '../lib/knowledge/store.mjs';

/**
 * Milestone 4 Task 1: the governance ledger — primitives (readGovernance,
 * appendGovernance, rewriteGovernance in store.mjs) and every writer that
 * records a human's retire/dispute/confirm/promote decision. This is the
 * persistence half of the M3-review gap: a `consolidate --rebuild --yes`
 * wipes learnings but must never resurrect a human-RETIRED (or -disputed,
 * -confirmed, -promoted) claim's governance state. Reapplying that state
 * against a freshly regenerated corpus is Task 2 — this file only proves the
 * ledger is written correctly and survives every wipe path it should.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('gov-ws-'), home: tempDir('gov-home-'), harnessHome: tempDir('gov-hh-') });
const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

const EP = (over = {}) => ({
  path: 'docs/solutions/perf/x.md',
  sha256: 'a'.repeat(64),
  kind: 'fix',
  plan: 'docs/plans/p1.md',
  ...over,
});

const ADD = (over = {}) => ({
  op: 'ADD',
  domain: 'sql',
  slug: 'not-null-large-tables',
  trigger: 'adding NOT NULL columns to large hot tables',
  body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
  episodes: [EP()],
  ...over,
});

// Two learnings per the brief: `a` via a consolidate --apply ADD op,
// `b` via `remember` (human-direct, kind: human-teaching — qualifies for
// promote without any extra fixture work).
function seed(c) {
  const opsPath = writeOps(c.ws, [ADD()]);
  const applyRes = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);
  const aId = JSON.parse(applyRes.stdout).applied[0].id;

  const rememberRes = run(c, [
    'remember',
    'Use two-step default+backfill for NOT NULL adds; direct ALTER takes an exclusive lock.',
    '--trigger', 'adding NOT NULL columns to hot tables',
    '--domain', 'sql',
  ]);
  assert.equal(rememberRes.status, 0, rememberRes.stderr || rememberRes.stdout);
  const bId = JSON.parse(rememberRes.stdout).learningId;

  return { aId, bId };
}

// A real, repo-relative primitive path promote can point at.
function primitivePath(ws) {
  const rel = '.github/instructions/sql.instructions.md';
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '# sql instructions\n');
  return rel;
}

function commitCount(dir) {
  const res = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return parseInt(res.stdout.trim(), 10);
}

// (a) learning retire <a> --reason x → readGovernance has the entry, and the
// SAME commit as the retire carries governance.jsonl (never a follow-up commit).
test('learning retire <id> --reason x appends a governance retire entry in the same commit as the retire', () => {
  const c = ctx();
  const { aId } = seed(c);
  const dir = storeDir(c.ws, { home: c.harnessHome });
  const before = commitCount(dir);

  const res = run(c, ['learning', 'retire', aId, '--reason', 'x']);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  assert.equal(commitCount(dir), before + 1, 'retire must produce exactly one commit');
  const show = spawnSync('git', ['show', '--stat', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.match(show, /governance\.jsonl/, 'the single retire commit includes governance.jsonl');

  const gov = readGovernance(dir);
  const entry = gov.get(aId);
  assert.ok(entry, 'governance entry recorded for the retired id');
  assert.equal(entry.action, 'retire');
  assert.equal(entry.reason, 'x');
  assert.equal(entry.to, null);
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}$/);
});

// (b) dispute then confirm on the same id → latest entry (replay semantics) is the confirm.
test('learning dispute then learning confirm on the same id: readGovernance replay keeps the latest (confirm) entry', () => {
  const c = ctx();
  const { bId } = seed(c);
  const dir = storeDir(c.ws, { home: c.harnessHome });

  const disputeRes = run(c, ['learning', 'dispute', bId, '--reason', 'needs review']);
  assert.equal(disputeRes.status, 0, disputeRes.stderr || disputeRes.stdout);
  assert.equal(readGovernance(dir).get(bId).action, 'dispute');

  const confirmRes = run(c, ['learning', 'confirm', bId]);
  assert.equal(confirmRes.status, 0, confirmRes.stderr || confirmRes.stdout);

  const gov = readGovernance(dir);
  const entry = gov.get(bId);
  assert.equal(entry.action, 'confirm', 'latest-per-id replay must return the confirm, not the earlier dispute');
  assert.equal(entry.reason, null, 'confirm does not require --reason');
  assert.equal(entry.to, null);
});

// (c) promote <b> --to <path> → entry carries the normalized to.
test('learning promote <id> --to <path> records a governance promote entry carrying the normalized to path', () => {
  const c = ctx();
  const { bId } = seed(c);
  const dir = storeDir(c.ws, { home: c.harnessHome });
  const to = primitivePath(c.ws);

  const res = run(c, ['learning', 'promote', bId, '--to', to]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const gov = readGovernance(dir);
  const entry = gov.get(bId);
  assert.ok(entry, 'governance entry recorded for the promoted id');
  assert.equal(entry.action, 'promote');
  assert.equal(entry.to, to, 'promote records the normalized to path');
  assert.equal(entry.reason, null);
});

// (d) hand-delete a learning file + trigger absorb → retire record with the
// hand-deletion reason.
test('hand-deleting a learning file and absorbing it appends a governance retire entry with reason "hand deletion (absorbed)"', () => {
  const c = ctx();
  const { aId } = seed(c);
  const dir = storeDir(c.ws, { home: c.harnessHome });

  const learning = listLearnings(dir).find((l) => l.id === aId);
  assert.ok(learning, 'precondition: the learning exists in the store');
  fs.rmSync(learning.file, { force: true }); // human deletes the store file directly, bypassing the CLI entirely

  // Any mutation command absorbs the hand edit first (remember calls
  // absorbHandEdits before writing its own new learning).
  const another = run(c, ['remember', 'another claim body', '--trigger', 'another trigger']);
  assert.equal(another.status, 0, another.stderr || another.stdout);

  const gov = readGovernance(dir);
  const entry = gov.get(aId);
  assert.ok(entry, 'governance entry recorded for the hand-deleted id');
  assert.equal(entry.action, 'retire');
  assert.equal(entry.reason, 'hand deletion (absorbed)');
  assert.equal(entry.to, null);
});

// (e) consolidate --rebuild --yes → governance.jsonl SURVIVES with all entries.
test('consolidate --rebuild --yes wipes learnings but governance.jsonl survives with every entry intact', () => {
  const c = ctx();
  const { aId, bId } = seed(c);
  const dir = storeDir(c.ws, { home: c.harnessHome });

  assert.equal(run(c, ['learning', 'retire', aId, '--reason', 'x']).status, 0);
  assert.equal(run(c, ['learning', 'dispute', bId, '--reason', 'y']).status, 0);
  const govBefore = readGovernance(dir);
  assert.equal(govBefore.size, 2, 'precondition: both ids have governance records');

  const rebuild = run(c, ['consolidate', '--rebuild', '--yes']);
  assert.equal(rebuild.status, 0, rebuild.stderr || rebuild.stdout);
  assert.equal(listLearnings(dir).length, 0, 'precondition: rebuild wiped every learning');

  const govAfter = readGovernance(dir);
  assert.equal(govAfter.size, 2, 'governance.jsonl survives the rebuild wipe');
  assert.deepEqual(govAfter.get(aId), govBefore.get(aId));
  assert.deepEqual(govAfter.get(bId), govBefore.get(bId));
});

// (f) knowledge purge <sole episode of a> (cascade-deletes a) → a's record
// gone, b's intact.
test('knowledge purge <sole episode of a> cascade-deletes a and rewrites governance dropping a while keeping b', () => {
  const c = ctx();
  const { aId, bId } = seed(c);
  const dir = storeDir(c.ws, { home: c.harnessHome });

  // Give both ids a governance record first, so the rewrite below has
  // something to prove it drops selectively rather than emptying the file.
  assert.equal(run(c, ['learning', 'dispute', aId, '--reason', 'a-review']).status, 0);
  assert.equal(run(c, ['learning', 'dispute', bId, '--reason', 'b-review']).status, 0);
  const govBefore = readGovernance(dir);
  assert.ok(govBefore.has(aId) && govBefore.has(bId), 'precondition: both ids have governance records');

  const episodePath = 'docs/solutions/perf/x.md';
  fs.mkdirSync(path.join(c.ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, episodePath), 'sole evidence body\n');

  const purge = run(c, ['knowledge', 'purge', episodePath]);
  assert.equal(purge.status, 0, purge.stderr || purge.stdout);
  const out = JSON.parse(purge.stdout);
  assert.deepEqual(out.removed.learnings, [aId], 'a is the sole-evidence cascade-deleted learning');

  const govAfter = readGovernance(dir);
  assert.ok(!govAfter.has(aId), "a's governance record is dropped by the purge rewrite");
  assert.ok(govAfter.has(bId), "b's governance record survives");
  assert.deepEqual(govAfter.get(bId), govBefore.get(bId));
});

// (g) knowledge purge --all → governance.jsonl empty.
test('knowledge purge --all empties governance.jsonl', () => {
  const c = ctx();
  const { aId, bId } = seed(c);
  const dir = storeDir(c.ws, { home: c.harnessHome });

  assert.equal(run(c, ['learning', 'retire', aId, '--reason', 'x']).status, 0);
  assert.equal(run(c, ['learning', 'dispute', bId, '--reason', 'y']).status, 0);
  assert.equal(readGovernance(dir).size, 2, 'precondition: governance has entries for both ids');

  const purgeAll = run(c, ['knowledge', 'purge', '--all']);
  assert.equal(purgeAll.status, 0, purgeAll.stderr || purgeAll.stdout);

  assert.equal(readGovernance(dir).size, 0, 'purge --all empties governance.jsonl');
});

// (h) a torn trailing line is skipped by the reader.
test('readGovernance skips a torn trailing line without throwing', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const govPath = path.join(dir, 'governance.jsonl');
  const goodEntry = { id: 'sql/good', action: 'retire', reason: 'fine', to: null, at: '2026-07-20' };
  fs.writeFileSync(govPath, `${JSON.stringify(goodEntry)}\n{"id": "sql/torn", "action": "retire"`, 'utf8'); // no closing brace

  const gov = readGovernance(dir);
  assert.equal(gov.size, 1, 'only the well-formed line is kept');
  assert.deepEqual(gov.get('sql/good'), goodEntry);
  assert.ok(!gov.has('sql/torn'), 'the torn line never produces an entry');
});

test('readGovernance on a fresh store with no governance.jsonl returns an empty Map', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(readGovernance(dir).size, 0);
});

test('rewriteGovernance is a no-op when governance.jsonl is absent', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.doesNotThrow(() => rewriteGovernance(dir, () => true));
  assert.equal(fs.existsSync(path.join(dir, 'governance.jsonl')), false, 'rewriteGovernance must not create the file when absent');
});
