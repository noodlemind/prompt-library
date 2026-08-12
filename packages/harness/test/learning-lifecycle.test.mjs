import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, storeDir, listLearnings } from '../lib/knowledge/store.mjs';
import { rankLearnings } from '../lib/knowledge/retrieve.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('lc-ws-'), home: tempDir('lc-home-'), harnessHome: tempDir('lc-hh-') });
const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome },
  });

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function writeRealEpisode(ws, rel, content) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = content ?? `episode body for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

const ADD = (over = {}) => ({
  op: 'ADD',
  domain: 'sql',
  slug: 'not-null-large-tables',
  trigger: 'adding NOT NULL columns to large/hot tables',
  body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
  ...over,
});

function seed(c) {
  // Auto learning via a Task-1-style consolidate --apply ops file.
  const ep = writeRealEpisode(c.ws, 'docs/solutions/perf/x.md');
  const opsPath = writeOps(c.ws, [ADD({ episodes: [{ ...ep, kind: 'fix', plan: 'docs/plans/p1.md' }] })]);
  const applyRes = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);
  const autoId = JSON.parse(applyRes.stdout).applied[0].id;

  // Human learning via Task-1 `remember`.
  const rememberRes = run(c, ['remember', 'Use two-step default+backfill for NOT NULL adds; direct ALTER takes an exclusive lock.',
    '--trigger', 'adding NOT NULL columns to hot tables', '--domain', 'sql']);
  assert.equal(rememberRes.status, 0, rememberRes.stderr || rememberRes.stdout);
  const humanId = JSON.parse(rememberRes.stdout).learningId;

  return { autoId, humanId };
}

test('learning retire marks an auto learning retired, commits, and drops it from ranking', () => {
  const c = ctx();
  const { autoId } = seed(c);

  const res = run(c, ['learning', 'retire', autoId, '--reason', 'wrong']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.id, autoId);
  assert.equal(out.status, 'retired');

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === autoId);
  assert.equal(learning.fm.status, 'retired');

  const head = spawnSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.match(head, /retire sql\/not-null-large-tables: wrong$/);

  const ranked = rankLearnings({ workspace: c.ws, query: 'adding NOT NULL columns to large hot tables', limit: 10, home: c.harnessHome });
  assert.ok(!ranked.some((r) => r.id === autoId), 'retired learning must not rank');
});

test('rankLearnings honors an optional include predicate, applied after status/stale filtering', () => {
  const c = ctx();
  const { autoId, humanId } = seed(c);

  const unfiltered = rankLearnings({
    workspace: c.ws, query: 'adding NOT NULL columns to hot tables', limit: 10, home: c.harnessHome,
  });
  assert.ok(unfiltered.some((r) => r.id === autoId), JSON.stringify(unfiltered));
  assert.ok(unfiltered.some((r) => r.id === humanId), JSON.stringify(unfiltered));

  const filtered = rankLearnings({
    workspace: c.ws, query: 'adding NOT NULL columns to hot tables', limit: 10, home: c.harnessHome,
    include: (l) => l.id !== autoId,
  });
  assert.ok(!filtered.some((r) => r.id === autoId), 'include predicate must exclude the filtered id');
  assert.ok(filtered.some((r) => r.id === humanId), 'include predicate must not affect other ids');

    const noPredicate = rankLearnings({
    workspace: c.ws, query: 'adding NOT NULL columns to hot tables', limit: 10, home: c.harnessHome, include: undefined,
  });
  assert.deepEqual(noPredicate.map((r) => r.id).sort(), unfiltered.map((r) => r.id).sort());
});

test('learning dispute requires --reason', () => {
  const c = ctx();
  const { humanId } = seed(c);

  const res = run(c, ['learning', 'dispute', humanId]);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /requires --reason/);
});

test('learning confirm reactivates a disputed learning and stamps last_confirmed', () => {
  const c = ctx();
  const { humanId } = seed(c);

  const disputeRes = run(c, ['learning', 'dispute', humanId, '--reason', 'needs review']);
  assert.equal(disputeRes.status, 0, disputeRes.stderr || disputeRes.stdout);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(listLearnings(dir).find((l) => l.id === humanId).fm.status, 'disputed');

  const confirmRes = run(c, ['learning', 'confirm', humanId]);
  assert.equal(confirmRes.status, 0, confirmRes.stderr || confirmRes.stdout);
  const out = JSON.parse(confirmRes.stdout);
  assert.equal(out.status, 'active');

  const learning = listLearnings(dir).find((l) => l.id === humanId);
  assert.equal(learning.fm.status, 'active');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(learning.fm.last_confirmed, today);
});

test('learning retire on an unknown id exits 1 with an E_TARGET error', () => {
  const c = ctx();
  seed(c);

  const res = run(c, ['learning', 'retire', 'missing/id', '--reason', 'x']);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /E_TARGET/);
});

test('learning retire --reason x <id> (flag before the id positional) yields a usage error, not a confusing E_TARGET', () => {
  const c = ctx();
  const { autoId } = seed(c);

  const res = run(c, ['learning', 'retire', '--reason', 'x', autoId]);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /usage: harness learning <retire\|dispute\|confirm\|promote>/);
});

test('learning explode some/id --reason x exits usage for an unknown action', () => {
  const c = ctx();

  const res = run(c, ['learning', 'explode', 'some/id', '--reason', 'x']);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /usage: harness learning <retire\|dispute\|confirm\|promote>/);
});

test('learning retire on a storeless workspace exits 1 with E_TARGET and never materializes the store', () => {
  const c = ctx();
  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

  const res = run(c, ['learning', 'retire', 'missing/id', '--reason', 'x']);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /E_TARGET/);

  assert.equal(fs.existsSync(dir), false, 'harness learning retire must not materialize a knowledge store');
});
