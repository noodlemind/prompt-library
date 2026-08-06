import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, listLearnings, readLedger, commitStore } from '../lib/knowledge/store.mjs';
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

// Writes a REAL file into the test workspace and returns an episode object
// whose sha256 is the genuine hash of that exact content —
// verifyAdmittedEpisodeKinds (lib/knowledge/apply.mjs) now disk-verifies
// every fix/insight-kind episode an admitted op offers, so a fabricated
// sha256 pointing at a file that was never written is rejected with
// E_SCHEMA before any of this file's own scenarios (domain cap, MERGE,
// composition) are ever reached.
function realEpisode(ws, over = {}) {
  const rel = over.path || 'docs/solutions/perf/x.md';
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `real evidence for ${rel}\n`;
  fs.writeFileSync(full, text, 'utf8');
  return {
    path: rel,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    kind: over.kind || 'fix',
    plan: over.plan || 'docs/plans/p1.md',
  };
}

const ADD = (ws, over = {}) => ({
  op: 'ADD',
  domain: 'sql',
  slug: 'not-null-large-tables',
  trigger: 'adding NOT NULL columns to large/hot tables',
  body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
  episodes: [realEpisode(ws)],
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

/**
 * Finish a direct-write fixture the way the CLI itself always leaves the
 * store: index rebuilt AND committed. Committing matters — an UNCOMMITTED
 * learning file in the store is a hand edit (planted or modified), and
 * absorbHandEdits (admin.mjs) now captures those through its validating path
 * and stamps them `source: human`, which is exactly right for a person
 * editing the store but would silently re-label these fixtures' "pre-existing
 * auto-sourced store state" as human-taught.
 */
function finalizeSeed(dir) {
  rebuildIndex(dir);
  commitStore(dir, 'seed: pre-existing store state');
}

function seedDomainAtCap(c, domain, count = 25) {
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  for (let i = 0; i < count; i++) seedLearning(dir, domain, `seed-${i}`);
  finalizeSeed(dir);
  return dir;
}

// Active count read straight off disk, independent of anything applyOps
// tracks in memory — the ground truth every scenario below asserts against.
function activeCount(dir) {
  return listLearnings(dir).filter((l) => !l.fm.superseded_by && !['retired', 'disputed'].includes(l.fm.status)).length;
}

// Per-domain version of the same ground truth — needed once scenarios span
// more than one domain (a MERGE's targets in domain A/B landing in domain C).
function domainActiveCount(dir, domain) {
  return listLearnings(dir).filter(
    (l) => l.domain === domain && !l.fm.superseded_by && !['retired', 'disputed'].includes(l.fm.status)
  ).length;
}

// (a) ADD #26 into an at-cap domain rejects E_DOMAIN_CAP, no strike recorded.
test('an ADD into a domain at 25 active learnings is rejected with E_DOMAIN_CAP and records no strike', () => {
  const c = ctx();
  const dir = seedDomainAtCap(c, 'perf', 25);
  assert.equal(listLearnings(dir).length, 25);

  const op = ADD(c.ws, { domain: 'perf', slug: 'twenty-sixth', episodes: [realEpisode(c.ws)] });
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
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/merge-evidence.md' })],
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
  finalizeSeed(dir);

  const mergeOp = {
    op: 'MERGE',
    targets: ['sql/human-taught', 'sql/auto-claim'],
    domain: 'sql',
    slug: 'attempted-merge',
    trigger: 'attempted merge trigger',
    body: 'attempted merge body text.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/attempt.md' })],
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
  finalizeSeed(dir);

  const mergeOp = {
    op: 'MERGE',
    targets: ['sql/target-a', 'sql/target-b'],
    domain: 'sql',
    slug: 'already-exists',
    trigger: 'a merge trying to land on a taken id',
    body: 'body text for the merge that collides.',
    episodes: [realEpisode(c.ws)],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp])]);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /E_EXISTS/);

  const byId = Object.fromEntries(listLearnings(dir).map((l) => [l.id, l]));
  assert.equal(byId['sql/target-a'].fm.superseded_by, null, 'targets untouched after a rejected MERGE');
  assert.equal(byId['sql/target-b'].fm.superseded_by, null);
});

// Milestone 4 Task 5 item 7(b): MERGE already checks each target for
// promoted_to BEFORE the consumedTargets/active checks (apply.mjs) — a MERGE
// naming a promoted target must reject with the promoted E_TARGET rejection,
// write nothing, and record no strike. Pins this hand-verified behavior.
test('a MERGE targeting a promoted learning is rejected with the promoted E_TARGET rejection, nothing written, no strike', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  seedLearning(dir, 'sql', 'promoted-target');
  seedLearning(dir, 'sql', 'active-target');
  finalizeSeed(dir);

  // Promote one target directly on disk — same field `learning promote`
  // itself writes (serializeLearning's promoted_to line).
  const promotedFile = path.join(dir, 'learnings', 'sql', 'promoted-target.md');
  const text = fs.readFileSync(promotedFile, 'utf8');
  fs.writeFileSync(
    promotedFile,
    text.replace('superseded_by: null', 'superseded_by: null\npromoted_to: .github/instructions/sql.instructions.md'),
    'utf8'
  );
  finalizeSeed(dir);

  const ledgerBefore = readLedger(dir).length;
  const mergeOp = {
    op: 'MERGE',
    targets: ['sql/promoted-target', 'sql/active-target'],
    domain: 'sql',
    slug: 'attempted-merge-promoted',
    trigger: 'a merge trying to consume a promoted target',
    body: 'attempted merge body text.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/attempt-promoted.md' })],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp])]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_TARGET');
  assert.match(out.rejected[0].reason, /is promoted/);

  assert.equal(readLedger(dir).length, ledgerBefore, 'a promoted-target rejection records no strike');
  const byId = Object.fromEntries(listLearnings(dir).map((l) => [l.id, l]));
  assert.equal(byId['sql/promoted-target'].fm.superseded_by, null, 'target untouched');
  assert.equal(byId['sql/active-target'].fm.superseded_by, null, 'target untouched');
  assert.ok(!byId['sql/attempted-merge-promoted'], 'no new learning written');
});

// M4 whole-milestone review, item 2: a MERGE naming a target already
// disputed/retired/superseded ON DISK from a PRIOR run must be the same
// never-strike class as the STRENGTHEN/SUPERSEDE inactive-target checks
// (consolidate-apply.test.mjs) — plain fail, never rejectOp. The op's own
// episodes aren't defective; its choice of an already-inactive target is —
// recording a strike here would quarantine innocent episodes on a
// retry-after-dispute.
test('a MERGE naming an already-disputed target (prior run) is rejected E_TARGET (not active), ledger unchanged', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  seedLearning(dir, 'sql', 'disputed-merge-target', { status: 'disputed' });
  seedLearning(dir, 'sql', 'active-merge-target');
  finalizeSeed(dir);

  const ledgerBefore = readLedger(dir).length;
  const mergeOp = {
    op: 'MERGE',
    targets: ['sql/disputed-merge-target', 'sql/active-merge-target'],
    domain: 'sql',
    slug: 'attempted-merge-inactive',
    trigger: 'a merge trying to consume an already-disputed target',
    body: 'attempted merge body text.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/attempt-inactive.md' })],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp])]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_TARGET');
  assert.match(out.rejected[0].reason, /is not active/);

  assert.equal(readLedger(dir).length, ledgerBefore, 'inactive-target rejection records no strike — ledger unchanged');
  const byId = Object.fromEntries(listLearnings(dir).map((l) => [l.id, l]));
  assert.equal(byId['sql/disputed-merge-target'].fm.status, 'disputed', 'target untouched');
  assert.equal(byId['sql/active-merge-target'].fm.superseded_by, null, 'the active target is untouched — whole run rejected');
  assert.ok(!byId['sql/attempted-merge-inactive'], 'no new learning written');
});

// (e) MERGE weight (1 + targets.length) toward MAX_OPS_PER_RUN.
test('a 4-target MERGE (5 file touches) alone passes the delta contract but combined with an ADD fails it', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  for (const slug of ['t1', 't2', 't3', 't4']) seedLearning(dir, 'sql', slug);
  finalizeSeed(dir);

  const mergeOp = {
    op: 'MERGE',
    targets: ['sql/t1', 'sql/t2', 'sql/t3', 'sql/t4'],
    domain: 'sql',
    slug: 'big-merge',
    trigger: 'a merge consolidating four restatements',
    body: 'big merge body re-deriving the shared claim.',
    episodes: [realEpisode(c.ws)],
  };
  const addOp = ADD(c.ws, { domain: 'sql', slug: 'extra-add' });

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

/**
 * Regression coverage: the cap check must project a RUNNING per-domain
 * count as ops are planned in file order, not check each op independently
 * against the static pre-run snapshot. A per-op check against the snapshot
 * alone lets N ops each pass a test that is true individually but false
 * collectively (e.g. three same-domain ADDs from 23 active: each one checked
 * against a snapshot of 23 would pass, but the domain would land at 26).
 */

// (a) The reproduced bug: three same-domain ADDs in one run from 23 active
// must be rejected as a whole — the third one is the one that actually
// crosses the cap once the first two are accounted for.
test('three same-domain ADDs in one run stack against the running cap and reject as a whole (regression)', () => {
  const c = ctx();
  const dir = seedDomainAtCap(c, 'perf', 23);
  const ops = [
    ADD(c.ws, { domain: 'perf', slug: 'stack-1', episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/stack-1.md' })] }),
    ADD(c.ws, { domain: 'perf', slug: 'stack-2', episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/stack-2.md' })] }),
    ADD(c.ws, { domain: 'perf', slug: 'stack-3', episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/stack-3.md' })] }),
  ];
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, ops)]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_DOMAIN_CAP');

  assert.equal(listLearnings(dir).length, 23, 'all-or-nothing: nothing from the rejected run is written');
  assert.equal(activeCount(dir), 23, 'final state unchanged, well under the cap');
});

// (b) The non-overflowing sibling of (a): two same-domain ADDs from 23
// active land exactly at the cap and the whole run applies.
test('two same-domain ADDs in one run from 23 active land exactly at the cap and apply', () => {
  const c = ctx();
  const dir = seedDomainAtCap(c, 'perf', 23);
  const ops = [
    ADD(c.ws, { domain: 'perf', slug: 'fit-1', episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/fit-1.md' })] }),
    ADD(c.ws, { domain: 'perf', slug: 'fit-2', episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/fit-2.md' })] }),
  ];
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, ops)]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  assert.ok(listLearnings(dir).some((l) => l.id === 'perf/fit-1'));
  assert.ok(listLearnings(dir).some((l) => l.id === 'perf/fit-2'));
  assert.equal(activeCount(dir), 25, 'lands exactly at the cap');
});

// (c) Order-dependence sanity: a MERGE (2 targets, same domain) followed by
// two ADDs, all in one run against a domain already at 25 active.
//
// Ops are evaluated in file order: MERGE first frees a net 1 slot in the
// running projection (25 - 2 + 1 = 24); the running projection then admits
// exactly one more ADD (24 -> 25) but not a second one (25 -> would be 26).
// So this exact 3-op combination must be rejected as a whole — the naive
// "MERGE always frees room" read undercounts by exactly the merge's own new
// learning, which correctly still occupies a slot in the domain it lands in.
test('a MERGE plus two ADDs against a 25-active domain rejects — the merge frees only a net one slot, not two', () => {
  const c = ctx();
  const dir = seedDomainAtCap(c, 'perf', 25);
  const mergeOp = {
    op: 'MERGE',
    targets: ['perf/seed-0', 'perf/seed-1'],
    domain: 'perf',
    slug: 'order-merge',
    trigger: 'a merge for the order-dependence regression case',
    body: 'Re-derived merged claim body from both targets episodes.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/order-merge-evidence.md' })],
  };
  const addA = ADD(c.ws, { domain: 'perf', slug: 'order-add-a', episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/order-a.md' })] });
  const addB = ADD(c.ws, { domain: 'perf', slug: 'order-add-b', episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/order-b.md' })] });

  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp, addA, addB])]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_DOMAIN_CAP');

  // All-or-nothing: the rejected run (merge included) leaves the domain
  // completely unchanged — the invariant that must hold for every accepted
  // OR rejected run is that the final active count never exceeds the cap.
  assert.equal(activeCount(dir), 25, 'final state never exceeds the cap');
  assert.ok(!listLearnings(dir).some((l) => l.id === 'perf/order-merge'), 'no partial write from the rejected run');
  assert.equal(
    listLearnings(dir).find((l) => l.id === 'perf/seed-0').fm.superseded_by,
    null,
    'the merge itself did not partially apply either'
  );
});

// (d) The non-overflowing sibling of (c): a MERGE plus exactly ONE ADD
// (not two) against the same 25-active domain applies — proving the merge's
// own +1 is what's being correctly counted against the running projection,
// not double-subtracted or ignored.
test('a MERGE plus exactly one ADD against a 25-active domain applies — the merge\'s own +1 counts for the following op', () => {
  const c = ctx();
  const dir = seedDomainAtCap(c, 'perf', 25);
  const mergeOp = {
    op: 'MERGE',
    targets: ['perf/seed-2', 'perf/seed-3'],
    domain: 'perf',
    slug: 'order-merge-fits',
    trigger: 'a merge for the positive order-dependence case',
    body: 'Re-derived merged claim body from both targets episodes.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/order-merge-fits-evidence.md' })],
  };
  const addOnly = ADD(c.ws, {
    domain: 'perf',
    slug: 'order-add-only',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/order-add-only.md' })],
  });

  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp, addOnly])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  assert.ok(listLearnings(dir).some((l) => l.id === 'perf/order-merge-fits'));
  assert.ok(listLearnings(dir).some((l) => l.id === 'perf/order-add-only'));
  assert.equal(activeCount(dir), 25, '25 - 2 (merged targets) + 1 (merge) + 1 (add) = 25, exactly at cap');
});

/**
 * Round 2 regression coverage — two more ways the cap was breached, both
 * present since the domain-cap feature landed:
 *
 * Gap 1: the MERGE branch bumped its destination domain's projection by +1
 * but never compared it to DOMAIN_ACTIVE_CAP (ADD and SUPERSEDE-new-id both
 * did). A merge whose targets live in OTHER domains than the destination
 * gave the destination a bare, uncredited +1 that could push it over the
 * cap undetected.
 *
 * Gap 2: validation only ever read the static `existing` snapshot, so a
 * later op in the same run could still target a learning an EARLIER op in
 * that same run had already tombstoned (or introduce an id an earlier op
 * had already claimed) — silently overwriting it at write time and
 * double-crediting the domain projection along the way.
 */

// Gap 1, reproduced verbatim: a merge whose targets live in domains OTHER
// than its destination must still respect the destination's own cap.
test('Gap 1: a MERGE whose targets live in other domains still respects its destination domain cap', () => {
  const c = ctx();
  const dir = seedDomainAtCap(c, 'gamma', 25);
  seedLearning(dir, 'alpha', 'a1');
  seedLearning(dir, 'beta', 'b1');
  finalizeSeed(dir);

  const mergeOp = {
    op: 'MERGE',
    targets: ['alpha/a1', 'beta/b1'],
    domain: 'gamma',
    slug: 'merged',
    trigger: 'a cross-domain merge landing in an already at-cap domain',
    body: 'Re-derived merged claim body from both cross-domain targets.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/gap1-evidence.md' })],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp])]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_DOMAIN_CAP');
  assert.match(out.rejected[0].reason, /domain gamma at cap \(25 active\)/);

  // All-or-nothing: the rejected run leaves every domain involved unchanged.
  assert.equal(domainActiveCount(dir, 'gamma'), 25, 'destination domain unchanged');
  const byId = Object.fromEntries(listLearnings(dir).map((l) => [l.id, l]));
  assert.equal(byId['alpha/a1'].fm.superseded_by, null, 'target untouched by the rejected merge');
  assert.equal(byId['beta/b1'].fm.superseded_by, null, 'target untouched by the rejected merge');
  assert.ok(!listLearnings(dir).some((l) => l.id === 'gamma/merged'), 'no new learning written');
});

// Gap 2, reproduced verbatim: a later SUPERSEDE targeting a learning an
// earlier MERGE in the same run already consumed must be rejected, not
// silently overwrite the merge's own tombstone stamp.
test('Gap 2: a later SUPERSEDE targeting a learning an earlier MERGE already consumed this run is rejected', () => {
  const c = ctx();
  const dir = seedDomainAtCap(c, 'perf', 25);

  const mergeOp = {
    op: 'MERGE',
    targets: ['perf/seed-0', 'perf/seed-1'],
    domain: 'perf',
    slug: 'merged-ab',
    trigger: 'a merge for the same-run consumption regression',
    body: 'Re-derived merged claim body from both targets episodes.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/gap2-merge-evidence.md' })],
  };
  const supersedeOp = {
    op: 'SUPERSEDE',
    target: 'perf/seed-0',
    domain: 'perf',
    slug: 'a-renamed',
    trigger: 'a supersede trying to reuse an already-merged target',
    body: 'a replacement body for the already-consumed target.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/gap2-supersede-evidence.md' })],
  };
  const addOp = ADD(c.ws, {
    domain: 'perf',
    slug: 'gap2-new',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/gap2-add-evidence.md' })],
  });

  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp, supersedeOp, addOp])]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_TARGET');
  assert.match(out.rejected[0].reason, /perf\/seed-0 already consumed by an earlier op in this run/);

  // All-or-nothing: nothing from this run is written — not even the MERGE
  // that would otherwise have been perfectly fine on its own.
  assert.equal(domainActiveCount(dir, 'perf'), 25, 'unchanged — the whole run rejected');
  const byId = Object.fromEntries(listLearnings(dir).map((l) => [l.id, l]));
  assert.equal(byId['perf/seed-0'].fm.superseded_by, null);
  assert.equal(byId['perf/seed-1'].fm.superseded_by, null);
  assert.ok(!listLearnings(dir).some((l) => l.id === 'perf/merged-ab'));
  assert.ok(!listLearnings(dir).some((l) => l.id === 'perf/a-renamed'));
  assert.ok(!listLearnings(dir).some((l) => l.id === 'perf/gap2-new'));
  // Composition rejection (a SIBLING op's MERGE already consumed this
  // target, not a defect in the SUPERSEDE op's own episodes) — no strike
  // recorded for the rejected SUPERSEDE's episode.
  assert.equal(readLedger(dir).length, 0, 'same-run composition rejection records no strike');
});

// Same-run consumption also closes the plain two-ADDs-same-id case: without
// plannedIds tracking, both would pass independently and the second write
// would silently clobber the first at the same file path. Reproduced per the
// milestone review: retried 3x, this must never quarantine the second op's
// perfectly valid episode — the defect is the op-SET (two ops raced for the
// same id), not either op's episodes.
test('two ADDs writing the same id in one run are rejected with E_EXISTS (silent-overwrite regression), and the ledger stays empty even retried 3x', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  for (let attempt = 0; attempt < 3; attempt++) {
    const ops = [
      ADD(c.ws, {
        domain: 'sql',
        slug: 'dup-id',
        body: 'first body for the duplicate id.',
        episodes: [realEpisode(c.ws, { path: `docs/solutions/perf/dup-1-${attempt}.md` })],
      }),
      ADD(c.ws, {
        domain: 'sql',
        slug: 'dup-id',
        body: 'second, different body for the same duplicate id.',
        episodes: [realEpisode(c.ws, { path: `docs/solutions/perf/dup-2-${attempt}.md` })],
      }),
    ];
    const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, ops)]);
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const out = JSON.parse(res.stdout);
    assert.equal(out.rejected[0].code, 'E_EXISTS');
    assert.match(out.rejected[0].reason, /already introduced by an earlier op in this run/);
  }

  assert.equal(listLearnings(dir).length, 0, 'nothing written — no silent overwrite');
  // The reviewer's reproduction: 3 retries of a same-run collision must
  // never accumulate strikes against the second op's (perfectly valid, on
  // its own) episode — the ledger must stay completely empty, not just
  // under the 3-strike quarantine threshold.
  assert.equal(readLedger(dir).length, 0, 'same-run composition rejections record no strikes across repeated attempts');
});

// A MERGE reusing a target an earlier op in the same run already consumed
// (via MERGE's OWN consumedTargets loop, distinct from Gap 2's
// STRENGTHEN/SUPERSEDE branch) is the same composition defect — no strike
// against the MERGE's own (perfectly valid) episode. A rename-shape
// SUPERSEDE consumes sql/t1 first (weight 1); the MERGE (weight 1+2=3) stays
// within the 5-file-touch delta contract at a combined weight of 4.
test('a MERGE reusing a target an earlier SUPERSEDE already consumed this run is rejected with no strike', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  seedLearning(dir, 'sql', 't1');
  seedLearning(dir, 'sql', 't2');
  finalizeSeed(dir);

  const supersedeOp = {
    op: 'SUPERSEDE',
    target: 'sql/t1',
    domain: 'sql',
    slug: 'renamed-t1',
    trigger: 'a rename supersede consuming t1 first',
    body: 'body text for the renaming supersede.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/supersede-t1.md' })],
  };
  const mergeOp = {
    op: 'MERGE',
    targets: ['sql/t1', 'sql/t2'],
    domain: 'sql',
    slug: 'merged-attempt',
    trigger: 'a merge trying to reuse the already-consumed t1',
    body: 'body text for the merge that collides.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/merge-attempt.md' })],
  };
  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [supersedeOp, mergeOp])]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected[0].code, 'E_TARGET');
  assert.match(out.rejected[0].reason, /sql\/t1 already consumed by an earlier op in this run/);

  assert.equal(listLearnings(dir).length, 2, 'all-or-nothing — nothing new written');
  assert.equal(readLedger(dir).length, 0, 'same-run composition rejection records no strike');
});

// A legitimate multi-op run must still apply cleanly: a same-domain MERGE
// plus an unrelated ADD in a totally different domain, neither anywhere
// near the cap. Every domain's final count is asserted to stay <= cap.
test('a legitimate MERGE plus an unrelated ADD in a different domain both apply, final counts stay at or under the cap', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  seedLearning(dir, 'alpha', 'a1');
  seedLearning(dir, 'alpha', 'a2');
  seedLearning(dir, 'delta', 'd1');
  finalizeSeed(dir);

  const mergeOp = {
    op: 'MERGE',
    targets: ['alpha/a1', 'alpha/a2'],
    domain: 'alpha',
    slug: 'alpha-merged',
    trigger: 'a legitimate same-domain merge',
    body: 'Re-derived merged claim body from both targets episodes.',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/legit-merge-evidence.md' })],
  };
  const addOp = ADD(c.ws, {
    domain: 'delta',
    slug: 'delta-new',
    episodes: [realEpisode(c.ws, { path: 'docs/solutions/perf/legit-add-evidence.md' })],
  });

  const res = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergeOp, addOp])]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  assert.ok(domainActiveCount(dir, 'alpha') <= 25);
  assert.ok(domainActiveCount(dir, 'delta') <= 25);
  assert.equal(domainActiveCount(dir, 'alpha'), 1, '2 targets tombstoned + 1 merged = 1');
  assert.equal(domainActiveCount(dir, 'delta'), 2, '1 pre-existing + 1 added = 2');
  assert.ok(listLearnings(dir).some((l) => l.id === 'alpha/alpha-merged'));
  assert.ok(listLearnings(dir).some((l) => l.id === 'delta/delta-new'));
});
