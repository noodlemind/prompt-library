import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { storeDir, listLearnings, readLedger, readGovernance, ensureStore, commitStore } from '../lib/knowledge/store.mjs';
import { rankLearnings } from '../lib/knowledge/retrieve.mjs';
import { rebuildIndex } from '../lib/knowledge/apply.mjs';
import { isActiveFm } from '../lib/knowledge/consolidate.mjs';

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

function writeFixEpisode(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `episode body for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function writeInsightEpisode(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `---\ntitle: "${rel}"\nkind: insight\ndate: 2026-07-01\n---\n\nepisode body for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function buildAddPromotable(ws) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug: 'not-null-large-tables',
    trigger: 'adding NOT NULL columns to large hot tables',
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
    episodes: [
      { ...writeFixEpisode(ws, 'docs/solutions/perf/x.md'), kind: 'fix', plan: 'docs/plans/p1.md' },
      { ...writeFixEpisode(ws, 'docs/solutions/perf/y.md'), kind: 'fix', plan: 'docs/plans/p2.md' },
      { ...writeFixEpisode(ws, 'docs/solutions/perf/z.md'), kind: 'fix', plan: 'docs/plans/p2.md' },
    ],
  };
}

// Zero fix/human-teaching episode links — must never promote (design §10).
function buildAddInsightOnly(ws) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug: 'insight-only-claim',
    trigger: 'observing a slow query plan',
    body: 'Sequential scans on a large table are often a missing index, not a query bug.',
    episodes: [{ ...writeInsightEpisode(ws, 'docs/solutions/perf/insight.md'), kind: 'insight', plan: '' }],
  };
}

function seedPromotable(c) {
  const applyRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [buildAddPromotable(c.ws)])]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);
  return JSON.parse(applyRes.stdout).applied[0].id;
}

function seedInsightOnly(c) {
  const applyRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [buildAddInsightOnly(c.ws)])]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);
  return JSON.parse(applyRes.stdout).applied[0].id;
}

function primitivePath(ws) {
  const rel = '.github/instructions/sql.instructions.md';
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '# sql instructions\n');
  return rel;
}

function seedActiveLearning(dir, domain, slug) {
  const lines = [
    '---', 'schema: 1', `trigger: "seed trigger for ${slug}"`, 'status: active', 'source: auto', 'episodes:',
    `  - path: docs/solutions/perf/${slug}-0.md`,
    `    sha256: "${'a'.repeat(64)}"`,
    '    kind: fix',
    '    plan: docs/plans/seed.md',
    'anchors: []', 'superseded_by: null', 'last_confirmed: 2026-07-01', 'origin: unknown',
    '---', '', `Seed body for ${slug}.`, '',
  ];
  const file = path.join(dir, 'learnings', domain, `${slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

test('cap-after-promote: promoting one of 25 active learnings frees room for a new ADD (final active <= 25)', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  for (let i = 0; i < 25; i++) seedActiveLearning(dir, 'sql', `cap-fill-${i}`);
  rebuildIndex(dir);
    commitStore(dir, 'seed: pre-existing store state');
  assert.equal(listLearnings(dir).filter((l) => isActiveFm(l.fm)).length, 25, 'precondition: domain at cap');

  const to = primitivePath(c.ws);
  const promoteRes = run(c, ['learning', 'promote', 'sql/cap-fill-0', '--to', to]);
  assert.equal(promoteRes.status, 0, promoteRes.stderr || promoteRes.stdout);
  assert.equal(listLearnings(dir).filter((l) => isActiveFm(l.fm)).length, 24, 'promotion frees exactly one slot');

  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'cap-fill-new',
    trigger: 'a new claim after promoting one out of the domain',
    body: 'A fresh claim that should fit now that promotion freed a slot.',
    episodes: [{ ...writeFixEpisode(c.ws, 'docs/solutions/perf/cap-fill-new.md'), kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const addRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [op])]);
  assert.equal(addRes.status, 0, addRes.stderr || addRes.stdout);

  const finalActive = listLearnings(dir).filter((l) => isActiveFm(l.fm)).length;
  assert.ok(finalActive <= 25, `final active count ${finalActive} must not exceed the domain cap`);
  assert.equal(finalActive, 25, '24 remaining + 1 new = exactly at the cap');
});

function seedPathlessFixOnly(c) {
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const domainDir = path.join(dir, 'learnings', 'sql');
  fs.mkdirSync(domainDir, { recursive: true });
  const slug = 'pathless-fix-only';
  const file = path.join(domainDir, `${slug}.md`);
  fs.writeFileSync(
    file,
    `---
schema: 1
trigger: "a trigger backed only by a pathless fix episode"
status: provisional
source: auto
episodes:
  - sha256: "${'a'.repeat(64)}"
    kind: fix
    plan: docs/plans/p1.md
anchors: []
superseded_by: null
last_confirmed: 2026-07-01
origin: test-origin
---

A claim whose only qualifying-kind episode lacks a path.
`,
    'utf8'
  );
    commitStore(dir, 'seed: stale on-disk record');
  return `sql/${slug}`;
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
    assert.equal(row.promotionEligible, false);

  // --why shows promotedTo.
  const whyRes = run(c, ['learnings', '--why', id]);
  assert.equal(whyRes.status, 0, whyRes.stderr || whyRes.stdout);
  const whyOut = JSON.parse(whyRes.stdout);
  assert.equal(whyOut.promotedTo, to);
  assert.equal(whyOut.status, 'promoted');
    assert.equal(whyOut.promotionEligible, false);

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

test('learning promote is rejected when the only qualifying-kind episode is pathless — evidence that would vanish on re-render', () => {
  const c = ctx();
  const id = seedPathlessFixOnly(c);
  const to = primitivePath(c.ws);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  const before = fs.readFileSync(listLearnings(dir).find((l) => l.id === id).file, 'utf8');

  const res = run(c, ['learning', 'promote', id, '--to', to]);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /never promote/);

  const after = fs.readFileSync(listLearnings(dir).find((l) => l.id === id).file, 'utf8');
  assert.equal(after, before, 'a rejected promote must never mutate the learning file');
});

test('learning promote on a missing id exits 1 with E_TARGET', () => {
  const c = ctx();
  seedPromotable(c);
  const to = primitivePath(c.ws);

  const res = run(c, ['learning', 'promote', 'missing/id', '--to', to]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  assert.match(res.stdout + res.stderr, /E_TARGET/);
});

test('learning promote --to ../outside.md (relative escape) exits 2, learning untouched', () => {
  const c = ctx();
  const id = seedPromotable(c);

  const res = run(c, ['learning', 'promote', id, '--to', '../outside.md']);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /escapes the workspace/);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.equal(learning.fm.promoted_to, undefined, 'a rejected --to must never be recorded');
  assert.equal(learning.fm.status, 'provisional', 'a rejected promote must not touch status either');
});

test('learning promote --to an absolute path outside the workspace exits 2', () => {
  const c = ctx();
  const id = seedPromotable(c);
  const outsideDir = tempDir('pr-outside-');
  const outsideFile = path.join(outsideDir, 'outside.md');
  fs.writeFileSync(outsideFile, '# outside\n');

  const res = run(c, ['learning', 'promote', id, '--to', outsideFile]);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /escapes the workspace/);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.equal(learning.fm.promoted_to, undefined);
});

test('learning promote --to a ./-prefixed relative path normalizes to a clean workspace-relative POSIX path', () => {
  const c = ctx();
  const id = seedPromotable(c);
  const rel = '.github/instructions/sql.instructions.md';
  const full = path.join(c.ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '# sql instructions\n');

  const res = run(c, ['learning', 'promote', id, '--to', `./${rel}`]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === id);
  assert.equal(learning.fm.promoted_to, rel, 'promoted_to is normalized — no leading ./ noise, POSIX separators');
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

    const supersedeOp = {
    op: 'SUPERSEDE',
    target: id,
    domain: 'sql',
    slug: 'not-null-large-tables',
    trigger: 'adding NOT NULL columns to large hot tables, revised',
    body: 'A model-proposed rewrite of the same claim.',
    episodes: [{ ...writeFixEpisode(c.ws, 'docs/solutions/perf/w.md'), kind: 'fix', plan: 'docs/plans/p3.md' }],
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
    episodes: [{ ...writeFixEpisode(c.ws, 'docs/solutions/perf/v.md'), kind: 'fix', plan: 'docs/plans/p4.md' }],
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

test('confirm/retire/dispute on a promoted learning all exit 2, promotion survives, and no governance entry is appended', () => {
  const c = ctx();
  const id = seedPromotable(c);
  const to = primitivePath(c.ws);

  const promoteRes = run(c, ['learning', 'promote', id, '--to', to]);
  assert.equal(promoteRes.status, 0, promoteRes.stderr || promoteRes.stdout);

  const dir = storeDir(c.ws, { home: c.harnessHome });
  const fileBefore = fs.readFileSync(listLearnings(dir).find((l) => l.id === id).file, 'utf8');
  const governanceBefore = [...readGovernance(dir).values()];
  assert.equal(governanceBefore.length, 1, 'precondition: only the promote record exists');
  assert.equal(governanceBefore[0].action, 'promote');

  for (const [action, extraArgs] of [
    ['confirm', []],
    ['retire', ['--reason', 'x']],
    ['dispute', ['--reason', 'x']],
  ]) {
    const res = run(c, ['learning', action, id, ...extraArgs]);
    assert.equal(res.status, 2, `${action}: ${res.stderr || res.stdout}`);
    const out = JSON.parse(res.stdout);
    assert.match(out.blockedReason || '', /is promoted/);
    assert.match(out.blockedReason || '', new RegExp(escapeRe(to)));
    assert.match(out.blockedReason || '', /lifecycle actions don't apply/);
  }

  const fileAfter = fs.readFileSync(listLearnings(dir).find((l) => l.id === id).file, 'utf8');
  assert.equal(fileAfter, fileBefore, 'promotion, status, and body must be byte-for-byte untouched');

  const governanceAfter = [...readGovernance(dir).values()];
  assert.equal(governanceAfter.length, 1, 'no confirm/retire/dispute record was appended');
  assert.equal(governanceAfter[0].action, 'promote');
});
