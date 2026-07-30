import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, listLearnings, storeDir } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function ctx() {
  return { ws: tempDir('anchor-ws-'), home: tempDir('anchor-home-'), harnessHome: tempDir('anchor-hh-') };
}

function run({ ws, home, harnessHome }, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });
}

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function writeFile(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
}

function sha256Of(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const TRIGGER = 'orders endpoint timing out under load';

function seedAnchoredLearning(c) {
  // The anchor target: a real source file the episode doc talks about.
  writeFile(c.ws, 'src/orders.mjs', 'export function listOrders() {}\n');
  // The episode doc (the evidence file cited by the op) mentions that path.
  const episodeBody =
    '---\ntitle: "orders endpoint timing out"\ndate: 2026-07-27\n---\n\n## Problem\n\nFixed by adding an index; see src/orders.mjs for the query.\n';
  writeFile(c.ws, 'docs/solutions/perf/orders-fix.md', episodeBody);
  const op = {
    op: 'ADD',
    domain: 'perf',
    slug: 'orders-endpoint',
    trigger: TRIGGER,
    body: 'Add a covering index for the orders query; see src/orders.mjs.',
    episodes: [{ path: 'docs/solutions/perf/orders-fix.md', sha256: sha256Of(episodeBody), kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [op])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return 'perf/orders-endpoint';
}

function orientLearningIds(c, query) {
  const res = run(c, ['orient', '--query', query]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  return (out.learnings || []).map((l) => l.id);
}

test('(a) consolidate --apply writes anchors extracted from episode text', () => {
  const c = ctx();
  const id = seedAnchoredLearning(c);
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.ok(learning, 'learning materialized');
  assert.deepEqual(learning.fm.anchors, ['src/orders.mjs']);
  const raw = fs.readFileSync(learning.file, 'utf8');
  assert.match(raw, /^anchors:\n {2}- src\/orders\.mjs$/m);
});

test('(b) orient surfaces a freshly anchored learning', () => {
  const c = ctx();
  seedAnchoredLearning(c);
  const ids = orientLearningIds(c, TRIGGER);
  assert.ok(ids.includes('perf/orders-endpoint'), JSON.stringify(ids));
});

test('(c) deleting an anchor target excludes the learning at the next index', () => {
  const c = ctx();
  seedAnchoredLearning(c);
  fs.rmSync(path.join(c.ws, 'src/orders.mjs'), { force: true });

  const idx = run(c, ['index']);
  assert.equal(idx.status, 0, idx.stderr || idx.stdout);
  const idxOut = JSON.parse(idx.stdout);
  assert.equal(idxOut.staleLearnings, 1);

  const ids = orientLearningIds(c, TRIGGER);
  assert.ok(!ids.includes('perf/orders-endpoint'), JSON.stringify(ids));
});

test('(d) restoring the anchor target re-includes the learning at the next index', () => {
  const c = ctx();
  seedAnchoredLearning(c);
  const target = path.join(c.ws, 'src/orders.mjs');
  fs.rmSync(target, { force: true });
  assert.equal(JSON.parse(run(c, ['index']).stdout).staleLearnings, 1);
  assert.ok(!orientLearningIds(c, TRIGGER).includes('perf/orders-endpoint'));

  fs.writeFileSync(target, 'export function listOrders() {}\n', 'utf8');
  const idx = run(c, ['index']);
  assert.equal(idx.status, 0, idx.stderr || idx.stdout);
  assert.equal(JSON.parse(idx.stdout).staleLearnings, 0);

  const ids = orientLearningIds(c, TRIGGER);
  assert.ok(ids.includes('perf/orders-endpoint'), JSON.stringify(ids));
});

test('(e) a learning with anchors: [] is never excluded, even after unrelated files disappear', () => {
  const c = ctx();
  const otherTrigger = 'plain claim without file references';
  const plainBody = '---\ntitle: "plain"\ndate: 2026-07-27\n---\n\n## Problem\n\nJust prose, no paths.\n';
  writeFile(c.ws, 'docs/solutions/perf/plain.md', plainBody);
  const op = {
    op: 'ADD',
    domain: 'perf',
    slug: 'plain-claim',
    trigger: otherTrigger,
    body: 'A claim with no file anchors at all.',
    episodes: [{ path: 'docs/solutions/perf/plain.md', sha256: sha256Of(plainBody), kind: 'fix', plan: '' }],
  };
  assert.equal(run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [op])]).status, 0);

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === 'perf/plain-claim');
  assert.deepEqual(learning.fm.anchors, []);

  // Deleting an unrelated file (not an anchor of anything) must not exclude it.
  fs.rmSync(path.join(c.ws, 'docs/solutions/perf/plain.md'), { force: true });
  const idx = run(c, ['index']);
  assert.equal(idx.status, 0, idx.stderr || idx.stdout);
  assert.equal(JSON.parse(idx.stdout).staleLearnings, 0);
  assert.ok(orientLearningIds(c, otherTrigger).includes('perf/plain-claim'));
});

// P3 (anchor traversal): anchors are only ever workspace-relative pointers
// written by extractAnchors, but a hand-edited learning can carry a `..`
// anchor — the old `existsSync(path.join(workspace, a))` resolved and
// statted it OUTSIDE the workspace, and an outside file that happened to
// exist kept the learning included. An escaping anchor is now rejected
// before any stat and treated as unresolvable (stale).
test('(f) an anchor escaping the workspace via `..` is treated as stale — the learning is excluded even though the outside file exists', () => {
  const c = ctx();
  const id = seedAnchoredLearning(c);

  // A REAL file outside the workspace at exactly where the escaping anchor
  // points — under the old join+existsSync scan this "resolved", so the
  // learning stayed included; unique name so parallel tmpdir tests never collide.
  const outsideName = `outside-anchor-${path.basename(c.ws)}.md`;
  fs.writeFileSync(path.join(c.ws, '..', outsideName), 'outside the workspace\n');

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);
  const raw = fs.readFileSync(learning.file, 'utf8');
  const edited = raw.replace(/^anchors:\n {2}- src\/orders\.mjs$/m, `anchors:\n  - ../${outsideName}`);
  assert.notEqual(edited, raw, 'precondition: the anchors block was rewritten to the escaping path');
  fs.writeFileSync(learning.file, edited, 'utf8');

  const idx = run(c, ['index']);
  assert.equal(idx.status, 0, idx.stderr || idx.stdout);
  assert.equal(JSON.parse(idx.stdout).staleLearnings, 1, 'the escaping anchor counts as stale');
  assert.ok(!orientLearningIds(c, TRIGGER).includes(id), 'the learning is excluded from retrieval');

  fs.rmSync(path.join(c.ws, '..', outsideName), { force: true });
});

test('index on a workspace with no knowledge store yet stays store-read-only', () => {
  const c = ctx();
  // No consolidate/remember has ever run here — the learnings store must not
  // exist yet under this HARNESS_HOME.
  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

  const idx = run(c, ['index']);
  assert.equal(idx.status, 0, idx.stderr || idx.stdout);
  const out = JSON.parse(idx.stdout);
  assert.equal('staleLearnings' in out, false, 'no store to recompute stale exclusions from');

  assert.equal(fs.existsSync(dir), false, 'harness index must not materialize a knowledge store');
});
