import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, listLearnings, readLedger } from '../lib/knowledge/store.mjs';
import { rebuildIndex } from '../lib/knowledge/apply.mjs';

/**
 * Milestone 3, Task 4 (design §9): a domain at DOMAIN_ACTIVE_CAP (25) active
 * learnings blocks a plain ADD/SUPERSEDE(-new-id) with a run-level
 * E_DOMAIN_CAP rejection (never a content-failure strike — cap pressure is
 * not an episode defect). MERGE consolidates >=2 existing active learnings
 * into one new id, tombstoning every target, and is itself exempt from the
 * cap since it can only ever reduce a domain's active count.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function ctx() {
  const ws = tempDir('domcap-ws-');
  const home = tempDir('domcap-home-');
  const harnessHome = tempDir('domcap-hh-');
  return { ws, home, harnessHome };
}

function run({ ws, home, harnessHome }, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });
}

function runPlain({ ws, home, harnessHome }, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });
}

function writeOps(dir, ops) {
  const p = path.join(dir, `ops-${Math.random().toString(36).slice(2)}.json`);
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
  trigger: 'adding NOT NULL columns to large/hot tables',
  body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
  episodes: [EP()],
  ...over,
});

// Direct-write fixture: seeding 25 active learnings through 5 real
// `consolidate --apply` runs (the delta contract caps a run at 5
// file-touches) would take 5 separate CLI invocations per test just to reach
// the cap. Writing the learning files straight to the store — in the exact
// shape `renderLearning` produces — plus a `rebuildIndex` call is equivalent
// end state and keeps these tests fast and focused on the cap/MERGE logic
// itself, not on re-proving the delta contract (already covered elsewhere).
function seedLearning(dir, domain, slug, over = {}) {
  const status = over.status || 'active';
  const source = over.source || 'auto';
  const fixCount = over.fixCount ?? 1;
  const supersededBy = over.supersededBy || 'null';
  const lines = ['---', 'schema: 1', `trigger: "seed trigger for ${slug}"`, `status: ${status}`, `source: ${source}`, 'episodes:'];
  for (let i = 0; i < fixCount; i++) {
    lines.push(`  - path: docs/solutions/perf/${slug}-${i}.md`);
    lines.push(`    sha256: "${'a'.repeat(64)}"`);
    lines.push('    kind: fix');
    lines.push('    plan: docs/plans/seed.md');
  }
  lines.push('anchors: []');
  lines.push(`superseded_by: ${supersededBy}`);
  lines.push('last_confirmed: 2026-07-01');
  lines.push('origin: unknown');
  lines.push('---', '', `Seed body for ${slug}.`, '');
  const file = path.join(dir, 'learnings', domain, `${slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

function seedDomainAtCap(c, domain, count = 25) {
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  for (let i = 0; i < count; i++) seedLearning(dir, domain, `seed-${i}`);
  rebuildIndex(dir);
  return dir;
}

// (a) ADD #26 into an at-cap domain rejects E_DOMAIN_CAP, no strike recorded.
test('an ADD into a domain at 25 active learnings is rejected with E_DOMAIN_CAP and records no strike', () => {
  const c = ctx();
  const dir = seedDomainAtCap(c, 'perf', 25);
  assert.equal(listLearnings(dir).length, 25);

  const op = ADD({ domain: 'perf', slug: 'twenty-sixth', episodes: [EP()] });
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [op])]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_DOMAIN_CAP');
  assert.match(out.rejected[0].reason, /domain perf at cap \(25 active\)/);

  assert.equal(listLearnings(dir).length, 25, 'no new learning written');
  assert.equal(readLedger(dir).length, 0, 'E_DOMAIN_CAP is a plain fail — cap pressure is not an episode defect, no strike');
});

// (b) MERGE of two active learnings: merged_from, both targets tombstoned,
// domain active count drops by one net, INDEX reflects the swap.
test('a MERGE writes merged_from, tombstones both targets, and nets the domain active count down by one', () => {
  const c = ctx();
  const dir = seedDomainAtCap(c, 'perf', 25);

  const mergeOp = {
    op: 'MERGE',
    targets: ['perf/seed-0', 'perf/seed-1'],
    domain: 'perf',
    slug: 'merged-claim',
    trigger: 'a merged trigger restating seed-0 and seed-1',
    body: 'Re-derived merged claim body from both targets episodes.',
    episodes: [EP({ path: 'docs/solutions/perf/merge-evidence.md', sha256: 'b'.repeat(64) })],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(out.applied.some((a) => a.op === 'MERGE' && a.id === 'perf/merged-claim'));

  const byId = Object.fromEntries(listLearnings(dir).map((l) => [l.id, l]));
  assert.ok(byId['perf/merged-claim'], 'new merged learning written');
  assert.match(byId['perf/merged-claim'].fm.merged_from, /perf\/seed-0/);
  assert.match(byId['perf/merged-claim'].fm.merged_from, /perf\/seed-1/);
  assert.equal(byId['perf/seed-0'].fm.superseded_by, 'perf/merged-claim');
  assert.equal(byId['perf/seed-1'].fm.superseded_by, 'perf/merged-claim');

  const activeCount = listLearnings(dir).filter(
    (l) => !l.fm.superseded_by && !['retired', 'disputed'].includes(l.fm.status)
  ).length;
  assert.equal(activeCount, 24, '25 - 2 tombstoned + 1 new = 24');

  const index = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
  assert.match(index, /perf\/merged-claim/);
  assert.doesNotMatch(index, /perf\/seed-0\]/);
  assert.doesNotMatch(index, /perf\/seed-1\]/);
});

// (c) MERGE with a source: human target lands disputed for that target only.
test('a MERGE with a source: human target lands disputed for that target, no new file written', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  seedLearning(dir, 'sql', 'human-taught', { source: 'human', fixCount: 0 });
  seedLearning(dir, 'sql', 'auto-claim', { source: 'auto', fixCount: 1 });
  rebuildIndex(dir);

  const mergeOp = {
    op: 'MERGE',
    targets: ['sql/human-taught', 'sql/auto-claim'],
    domain: 'sql',
    slug: 'attempted-merge',
    trigger: 'attempted merge trigger',
    body: 'attempted merge body text.',
    episodes: [EP({ path: 'docs/solutions/perf/attempt.md', sha256: 'c'.repeat(64) })],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_DISPUTED');
  assert.equal(out.rejected[0].reason, 'disputed-pending-human');
  assert.equal(out.rejected[0].target, 'sql/human-taught');

  const byId = Object.fromEntries(listLearnings(dir).map((l) => [l.id, l]));
  assert.equal(byId['sql/human-taught'].fm.status, 'disputed');
  assert.equal(byId['sql/auto-claim'].fm.status, 'active', 'the non-offending target is untouched');
  assert.ok(!byId['sql/attempted-merge'], 'no new learning written for a disputed MERGE');
});

// (d) MERGE onto an existing id rejects E_EXISTS.
test('a MERGE whose new id already exists is rejected with E_EXISTS, targets untouched', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  seedLearning(dir, 'sql', 'target-a');
  seedLearning(dir, 'sql', 'target-b');
  seedLearning(dir, 'sql', 'already-exists');
  rebuildIndex(dir);

  const mergeOp = {
    op: 'MERGE',
    targets: ['sql/target-a', 'sql/target-b'],
    domain: 'sql',
    slug: 'already-exists',
    trigger: 'a merge trying to land on a taken id',
    body: 'body text for the merge that collides.',
    episodes: [EP()],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp])]);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /E_EXISTS/);

  const byId = Object.fromEntries(listLearnings(dir).map((l) => [l.id, l]));
  assert.equal(byId['sql/target-a'].fm.superseded_by, null, 'targets untouched after a rejected MERGE');
  assert.equal(byId['sql/target-b'].fm.superseded_by, null);
});

// (e) MERGE weight (1 + targets.length) toward MAX_OPS_PER_RUN.
test('a 4-target MERGE (5 file touches) alone passes the delta contract but combined with an ADD fails it', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  for (const slug of ['t1', 't2', 't3', 't4']) seedLearning(dir, 'sql', slug);
  rebuildIndex(dir);

  const mergeOp = {
    op: 'MERGE',
    targets: ['sql/t1', 'sql/t2', 'sql/t3', 'sql/t4'],
    domain: 'sql',
    slug: 'big-merge',
    trigger: 'a merge consolidating four restatements',
    body: 'big merge body re-deriving the shared claim.',
    episodes: [EP()],
  };
  const addOp = ADD({ domain: 'sql', slug: 'extra-add' });

  // Combined: MERGE (weight 5) + ADD (weight 1) = 6 > MAX_OPS_PER_RUN (5).
  const combinedRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp, addOp])]);
  assert.equal(combinedRes.status, 1);
  assert.match(combinedRes.stdout + combinedRes.stderr, /E_DELTA_CONTRACT/);
  assert.equal(listLearnings(dir).length, 4, 'a rejected delta-contract run touches nothing');

  // Alone: MERGE (weight 5) passes the delta contract and applies.
  const aloneRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp])]);
  assert.equal(aloneRes.status, 0, aloneRes.stderr || aloneRes.stdout);
  assert.ok(listLearnings(dir).some((l) => l.id === 'sql/big-merge'));
});

// (f) --candidates reports domain cap pressure before any merge happens.
test('--candidates --json reports a domain at cap, and the plain-text status note flags it', () => {
  const c = ctx();
  seedDomainAtCap(c, 'java', 25);

  const res = run(c, ['consolidate', '--candidates']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.contract.domainCap, 25);
  const javaDomain = out.domains.find((d) => d.domain === 'java');
  assert.ok(javaDomain, 'java domain reported in candidates packet');
  assert.equal(javaDomain.active, 25);
  assert.equal(javaDomain.cap, 25);
  assert.equal(javaDomain.atCap, true);

  const plain = runPlain(c, ['consolidate']);
  assert.match(plain.stdout, /java at cap/);
});
