import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { storeDir, listLearnings, readLedger } from '../lib/knowledge/store.mjs';
import { rankLearnings } from '../lib/knowledge/retrieve.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('pr-ws-'), home: tempDir('pr-home-'), harnessHome: tempDir('pr-hh-') });
const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome },
  });

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

// Three fix-kind episode links across two distinct plans — promotion-eligible
// (verified >= 3 && plans >= 2), the same fixture shape learnings-listing.test.mjs uses.
const ADD_PROMOTABLE = {
  op: 'ADD',
  domain: 'sql',
  slug: 'not-null-large-tables',
  trigger: 'adding NOT NULL columns to large hot tables',
  body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
  episodes: [
    { path: 'docs/solutions/perf/x.md', sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' },
    { path: 'docs/solutions/perf/y.md', sha256: 'b'.repeat(64), kind: 'fix', plan: 'docs/plans/p2.md' },
    { path: 'docs/solutions/perf/z.md', sha256: 'c'.repeat(64), kind: 'fix', plan: 'docs/plans/p2.md' },
  ],
};

// Zero fix/human-teaching episode links — must never promote (design §10).
const ADD_INSIGHT_ONLY = {
  op: 'ADD',
  domain: 'sql',
  slug: 'insight-only-claim',
  trigger: 'observing a slow query plan',
  body: 'Sequential scans on a large table are often a missing index, not a query bug.',
  episodes: [{ path: 'docs/solutions/perf/insight.md', sha256: 'd'.repeat(64), kind: 'insight', plan: '' }],
};

function seedPromotable(c) {
  const applyRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD_PROMOTABLE])]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);
  return JSON.parse(applyRes.stdout).applied[0].id;
}

function seedInsightOnly(c) {
  const applyRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [ADD_INSIGHT_ONLY])]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);
  return JSON.parse(applyRes.stdout).applied[0].id;
}

// A real, repo-relative primitive path the promote command can point at —
// created inside the temp workspace so the "target must exist" check passes.
function primitivePath(ws) {
  const rel = '.github/instructions/sql.instructions.md';
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '# sql instructions\n');
  return rel;
}

test('learning promote <id> without --to exits 2', () => {
  const c = ctx();
  const id = seedPromotable(c);

  const res = run(c, ['learning', 'promote', id]);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /--to/);
});

test('learning promote <id> --to <path> records promoted_to, commits, and retires the learning from every active surface', () => {
  const c = ctx();
  const id = seedPromotable(c);
  const to = primitivePath(c.ws);

  const res = run(c, ['learning', 'promote', id, '--to', to]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.id, id);
  assert.equal(out.status, 'promoted');

  const dir = storeDir(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.equal(learning.fm.promoted_to, to);
  assert.equal(learning.fm.status, 'provisional', 'promote never touches status');

  const head = spawnSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.match(head, new RegExp(`promote ${id}: `));

  // rankLearnings (orient's engine) drops it.
  const ranked = rankLearnings({
    workspace: c.ws, query: 'adding NOT NULL columns to large hot tables', limit: 10, home: c.harnessHome,
  });
  assert.ok(!ranked.some((r) => r.id === id), 'promoted learning must not rank');

  // INDEX.md drops it.
  const index = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
  assert.ok(!index.includes(id), 'INDEX.md must drop the promoted learning');

  // learnings --json: status promoted, counts.active excludes it.
  const listRes = run(c, ['learnings']);
  assert.equal(listRes.status, 0, listRes.stderr || listRes.stdout);
  const listOut = JSON.parse(listRes.stdout);
  const row = listOut.learnings.find((l) => l.id === id);
  assert.equal(row.status, 'promoted');
  assert.equal(listOut.counts.active, 0);

  // --why shows promotedTo.
  const whyRes = run(c, ['learnings', '--why', id]);
  assert.equal(whyRes.status, 0, whyRes.stderr || whyRes.stdout);
  const whyOut = JSON.parse(whyRes.stdout);
  assert.equal(whyOut.promotedTo, to);
  assert.equal(whyOut.status, 'promoted');

  // consolidate --status --json: promotionCandidates no longer lists it.
  const statusRes = run(c, ['consolidate', '--status']);
  assert.equal(statusRes.status, 0, statusRes.stderr || statusRes.stdout);
  const statusOut = JSON.parse(statusRes.stdout);
  assert.ok(
    !statusOut.promotionCandidates.some((p) => p.id === id),
    'promoted learning must drop out of promotionCandidates'
  );
});

test('insight-only learning promote exits 2 with a never-promote reason', () => {
  const c = ctx();
  const id = seedInsightOnly(c);
  const to = primitivePath(c.ws);

  const res = run(c, ['learning', 'promote', id, '--to', to]);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /never promote/);
});

test('learning promote on a missing id exits 1 with E_TARGET', () => {
  const c = ctx();
  seedPromotable(c);
  const to = primitivePath(c.ws);

  const res = run(c, ['learning', 'promote', 'missing/id', '--to', to]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  assert.match(res.stdout + res.stderr, /E_TARGET/);
});

test('learning promote --to a primitive path that does not exist exits 1 with E_TARGET', () => {
  const c = ctx();
  const id = seedPromotable(c);

  const res = run(c, ['learning', 'promote', id, '--to', '.github/instructions/does-not-exist.instructions.md']);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  assert.match(res.stdout + res.stderr, /E_TARGET/);
});

test('a model-lane same-id SUPERSEDE against a promoted learning is rejected, promoted_to survives, ranking stays empty, and no strike is recorded', () => {
  const c = ctx();
  const id = seedPromotable(c);
  const to = primitivePath(c.ws);

  const promoteRes = run(c, ['learning', 'promote', id, '--to', to]);
  assert.equal(promoteRes.status, 0, promoteRes.stderr || promoteRes.stdout);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  const ledgerBefore = readLedger(dir).length;

  // A model-lane re-derivation: same domain/slug (in-place SUPERSEDE shape),
  // fresh fix-kind episodes, no human-teaching assertion at all.
  const supersedeOp = {
    op: 'SUPERSEDE',
    target: id,
    domain: 'sql',
    slug: 'not-null-large-tables',
    trigger: 'adding NOT NULL columns to large hot tables, revised',
    body: 'A model-proposed rewrite of the same claim.',
    episodes: [{ path: 'docs/solutions/perf/w.md', sha256: 'e'.repeat(64), kind: 'fix', plan: 'docs/plans/p3.md' }],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [supersedeOp])]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.rejected[0].reason, /is promoted/);
  assert.match(out.rejected[0].reason, new RegExp(escapeRe(to)));
  assert.equal(out.rejected[0].code, 'E_TARGET');

  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.equal(learning.fm.promoted_to, to, 'promoted_to must survive the rejected SUPERSEDE');
  assert.equal(learning.body.trim(), 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.', 'body untouched');

  const ranked = rankLearnings({
    workspace: c.ws, query: 'adding NOT NULL columns to large hot tables', limit: 10, home: c.harnessHome,
  });
  assert.ok(!ranked.some((r) => r.id === id), 'still absent from ranking after the rejected SUPERSEDE');

  assert.equal(readLedger(dir).length, ledgerBefore, 'rejecting a promoted target must record no quarantine strike');
});

test('learning promote then remember with the same trigger/domain exits 2 with the primitive-path message and writes no episode file', () => {
  const c = ctx();
  const rememberRes = run(c, [
    'remember',
    'Use two-step default+backfill for NOT NULL adds; direct ALTER takes an exclusive lock.',
    '--trigger', 'adding NOT NULL columns to hot tables',
    '--domain', 'sql',
  ]);
  assert.equal(rememberRes.status, 0, rememberRes.stderr || rememberRes.stdout);
  const learningId = JSON.parse(rememberRes.stdout).learningId;

  const to = primitivePath(c.ws);
  const promoteRes = run(c, ['learning', 'promote', learningId, '--to', to]);
  assert.equal(promoteRes.status, 0, promoteRes.stderr || promoteRes.stdout);

  const teachDir = path.join(c.ws, 'docs', 'solutions', 'teachings');
  const before = fs.existsSync(teachDir) ? fs.readdirSync(teachDir).sort() : [];

  const reteachRes = run(c, [
    'remember',
    'A refined claim about NOT NULL adds.',
    '--trigger', 'adding NOT NULL columns to hot tables',
    '--domain', 'sql',
  ]);
  assert.equal(reteachRes.status, 2, reteachRes.stderr || reteachRes.stdout);
  const out = JSON.parse(reteachRes.stdout);
  assert.match(out.blockedReason || '', /this claim was promoted to/);
  assert.match(out.blockedReason || '', new RegExp(escapeRe(to)));

  const after = fs.existsSync(teachDir) ? fs.readdirSync(teachDir).sort() : [];
  assert.deepEqual(after, before, 'no new episode file written for the blocked re-teach');
});

test('a STRENGTHEN targeting a promoted learning is rejected and records no strike', () => {
  const c = ctx();
  const id = seedPromotable(c);
  const to = primitivePath(c.ws);

  const promoteRes = run(c, ['learning', 'promote', id, '--to', to]);
  assert.equal(promoteRes.status, 0, promoteRes.stderr || promoteRes.stdout);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  const ledgerBefore = readLedger(dir).length;

  const strengthenOp = {
    op: 'STRENGTHEN',
    target: id,
    episodes: [{ path: 'docs/solutions/perf/v.md', sha256: 'f'.repeat(64), kind: 'fix', plan: 'docs/plans/p4.md' }],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [strengthenOp])]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.rejected[0].reason, /is promoted/);
  assert.equal(out.rejected[0].code, 'E_TARGET');

  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.equal(learning.fm.promoted_to, to);
  assert.equal(learning.fm.episodes.length, 3, 'STRENGTHEN must not have added the new episode');

  assert.equal(readLedger(dir).length, ledgerBefore, 'rejecting a promoted STRENGTHEN target must record no quarantine strike');
});
