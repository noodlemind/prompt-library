import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  ensureStore,
  listLearnings,
  readLedger,
  readGovernance,
  appendGovernance,
} from '../lib/knowledge/store.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { buildPromotionOps, PROMOTE_OPS_REL } from '../lib/knowledge/promote.mjs';
import { pruneBuckets } from '../lib/knowledge/prune.mjs';
import { rebuildStore } from '../lib/knowledge/admin.mjs';
import { bucketDirFor, listBuckets, loadLayeredLearnings } from '../lib/knowledge/overlay.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';
import { retrievalExclusion } from '../lib/knowledge/retrieve.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

/** Cloned workspace with origin/HEAD → main, on a feature branch. */
function featureWorkspace(branch = 'feature/promo') {
  const origin = tempDir('promo-origin-');
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 't@example.test']);
  git(origin, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(origin, 'seed.txt'), 'seed\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-qm', 'seed']);
  const ws = tempDir('promo-ws-');
  git(ws, ['clone', '-q', origin, '.']);
  git(ws, ['config', 'user.email', 't@example.test']);
  git(ws, ['config', 'user.name', 'T']);
  git(ws, ['checkout', '-qb', branch]);
  return ws;
}

function writeEpisode(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `fix evidence for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' };
}

function writeOps(ws, ops) {
  const p = path.join(ws, `ops-${crypto.randomUUID()}.json`);
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function addOp(ws, slug, over = {}) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug,
    trigger: `trigger for ${slug}`,
    body: `Claim body for ${slug}.`,
    episodes: over.episodes || [writeEpisode(ws, `docs/solutions/perf/${slug}.md`)],
    ...over,
  };
}

/** Seed a bucket learning via the real routed write path. */
function seedBucketLearning(ws, home, slug, over = {}) {
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, slug, over)]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  assert.equal(applied.layer, 'branch');
  return applied;
}

test('promote emits a reviewable, digest-bound op-set and apply lands it golden with tombstones and absorb-branch audit', () => {
  const ws = featureWorkspace('feature/promo');
  const home = tempDir('promo-home-');
  seedBucketLearning(ws, home, 'claim-a');
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/promo');

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  assert.equal(emitted.ops, 1);
  assert.equal(emitted.remaining, 0);
  assert.equal(emitted.bucketKey, key);
  const opset = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.equal(opset.promotion.branchKey, key);
  assert.match(opset.promotion.digest, /^[0-9a-f]{64}$/);
  assert.equal(opset.ops[0].op, 'ADD');
  assert.equal(opset.ops[0].source.id, 'sql/claim-a');

  // Apply in promotion mode — note: the source episode file could even be
  // absent from this checkout; evidence re-validates from recorded hashes.
  const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  // Golden now carries the claim.
  const golden = listLearnings(dir).find((l) => l.id === 'sql/claim-a');
  assert.ok(golden, 'promoted claim lives golden');
  assert.equal(golden.fm.branch, 'feature/promo', 'branch provenance carried forward');
  // Golden ledger consumed the episodes.
  assert.ok(readLedger(dir).some((e) => e.learning === 'sql/claim-a'));

  // Source tombstoned + excluded from retrieval; bucket prunable.
  const bucketDir = bucketDirFor(dir, key);
  const source = listLearnings(bucketDir).find((l) => l.id === 'sql/claim-a');
  assert.equal(source.fm.promoted_to_golden, 'sql/claim-a');
  assert.equal(retrievalExclusion(source), 'promoted-to-golden');

  // absorb-branch recorded for AUDIT — never a standing decision.
  const govLines = fs
    .readFileSync(path.join(dir, 'governance.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(govLines.some((e) => e.id === 'sql/claim-a' && e.action === 'absorb-branch'));
  assert.equal(readGovernance(dir).has('sql/claim-a'), false, 'absorb-branch never becomes a standing decision');

  // The overlay no longer shadows golden with the tombstoned bucket entry.
  const overlay = loadLayeredLearnings({ workspace: ws, home });
  const surfaced = overlay.learnings.filter((l) => l.id === 'sql/claim-a');
  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0].layer, undefined, 'golden claim surfaces, tombstoned bucket copy does not');
});

test('REPLAY RULE regression: retire → absorb-branch → rebuild --yes still lands retired', () => {
  const ws = featureWorkspace('feature/replay');
  const home = tempDir('promo-home2-');
  git(ws, ['checkout', '-q', 'main']);
  const ep = writeEpisode(ws, 'docs/solutions/perf/replayed.md');
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, 'replayed', { episodes: [ep] })]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  assert.equal(applied.layer, 'golden');
  const { dir } = ensureStore(ws, { home });

  // 1) A human retires the id — the standing decision.
  appendGovernance(dir, { id: 'sql/replayed', action: 'retire', reason: 'human veto', to: null, at: new Date().toISOString() });
  // 2) A LATER absorb-branch audit entry lands for the same id.
  appendGovernance(dir, { id: 'sql/replayed', action: 'absorb-branch', reason: 'promoted from feature-x-00000000', to: null, at: new Date().toISOString() });
  assert.equal(readGovernance(dir).get('sql/replayed').action, 'retire', 'replay skips absorb-branch — retire stands');

  // 3) Rebuild wipes the corpus; the ledger survives.
  const rebuilt = rebuildStore({ workspace: ws, home, yes: true, copilotHome: tempDir('promo-ch-') });
  assert.equal(rebuilt.pass, true, rebuilt.blockedReason);

  // 4) A fresh consolidation regenerates the id — governance reapplication
  // must land it RETIRED, not whatever the fresh op claims.
  const again = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, 'replayed', { episodes: [ep] })]), home });
  assert.equal(again.exitCode, 0, JSON.stringify(again.rejected));
  assert.deepEqual(again.governed, [{ id: 'sql/replayed', action: 'retire' }]);
  const learning = listLearnings(dir).find((l) => l.id === 'sql/replayed');
  assert.equal(learning.fm.status, 'retired', 'the standing retire survived the absorb-branch audit entry and the rebuild');
});

test('promotion of a shadowing claim maps to SUPERSEDE; a protected golden target rejects and disputes without strikes', () => {
  const ws = featureWorkspace('feature/shadowed');
  const home = tempDir('promo-home3-');
  const { dir } = ensureStore(ws, { home });
  // Protected golden twin: source human.
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'guarded.md'),
    `---\nschema: 1\ntrigger: "guarded trigger"\nstatus: active\nsource: human\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: t\n---\n\nProtected golden claim.\n`
  );
  seedBucketLearning(ws, home, 'guarded', { trigger: 'guarded trigger v2', body: 'Branch challenger claim.' });

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  const opset = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.equal(opset.ops[0].op, 'SUPERSEDE', 'shadow-of-golden maps to SUPERSEDE');
  assert.equal(opset.ops[0].target, 'sql/guarded');

  const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, 'dispute path exits 0 with E_DISPUTED rejection recorded');
  assert.equal(applied.rejected[0]?.code, 'E_DISPUTED');
  const golden = listLearnings(dir).find((l) => l.id === 'sql/guarded');
  assert.equal(golden.fm.status, 'disputed', 'protected target marked disputed for human review');
  assert.match(golden.body, /Protected golden claim/, 'protected claim body never overwritten');
  // Promotion rejections never strike: no failure entries anywhere.
  assert.equal(readLedger(dir).filter((e) => e.failure).length, 0);
  assert.equal(readLedger(bucketDirFor(dir, branchKeyFor('feature/shadowed'))).filter((e) => e.failure).length, 0);
});

test('episodes-only overlap maps to STRENGTHEN; identical claims are skipped', () => {
  const ws = featureWorkspace('feature/overlap');
  const home = tempDir('promo-home4-');
  const { dir } = ensureStore(ws, { home });
  const goldenEp = writeEpisode(ws, 'docs/solutions/perf/golden-ev.md');
  // Unprotected golden twin with identical trigger+body.
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'same-claim.md'),
    `---\nschema: 1\ntrigger: "same trigger"\nstatus: active\nsource: auto\nepisodes:\n  - path: ${goldenEp.path}\n    sha256: "${goldenEp.sha256}"\n    kind: fix\n    plan: docs/plans/p1.md\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: t\n---\n\nShared claim body.\n`
  );
  const branchEp = writeEpisode(ws, 'docs/solutions/perf/branch-ev.md');
  seedBucketLearning(ws, home, 'same-claim', { trigger: 'same trigger', body: 'Shared claim body.', episodes: [branchEp] });

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  const opset = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.equal(opset.ops[0].op, 'STRENGTHEN', 'episodes-only overlap maps to STRENGTHEN');
  assert.deepEqual(opset.ops[0].episodes.map((e) => e.path), [branchEp.path]);

  const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const golden = listLearnings(dir).find((l) => l.id === 'sql/same-claim');
  assert.equal(golden.fm.episodes.length, 2, 'golden gained the branch evidence');

  // A second promote now finds only a tombstoned source — nothing promotable.
  const again = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(again.pass, false);
  assert.match(again.blockedReason, /nothing promotable/);
});

test('--all chunks under MAX_OPS_PER_RUN with deterministic ordering and remaining count', () => {
  const ws = featureWorkspace('feature/chunky');
  const home = tempDir('promo-home5-');
  for (let i = 0; i < 7; i++) seedBucketLearning(ws, home, `chunk-${String(i).padStart(2, '0')}`);

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  assert.equal(emitted.ops, 5, 'chunked at MAX_OPS_PER_RUN');
  assert.equal(emitted.remaining, 2);
  const opset = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.deepEqual(
    opset.ops.map((o) => o.source.id),
    ['sql/chunk-00', 'sql/chunk-01', 'sql/chunk-02', 'sql/chunk-03', 'sql/chunk-04'],
    'deterministic id ordering is the cursor'
  );

  const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  // Next emission drains the remainder — the tombstoned five drop out.
  const next = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(next.pass, true, next.blockedReason);
  assert.equal(next.ops, 2);
  assert.equal(next.remaining, 0);
  const nextSet = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.deepEqual(nextSet.ops.map((o) => o.source.id), ['sql/chunk-05', 'sql/chunk-06']);
});

test('a tampered promote-ops file is rejected by the digest binding (no strikes)', () => {
  const ws = featureWorkspace('feature/tamper');
  const home = tempDir('promo-home6-');
  seedBucketLearning(ws, home, 'tampered');
  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  const opsFull = path.join(ws, PROMOTE_OPS_REL);
  const opset = JSON.parse(fs.readFileSync(opsFull, 'utf8'));
  opset.ops[0].body = 'Tampered body.';
  fs.writeFileSync(opsFull, JSON.stringify(opset));

  const applied = applyOps({ workspace: ws, opsPath: opsFull, home });
  assert.equal(applied.exitCode, 1);
  assert.match(applied.rejected[0].reason, /digest mismatch/);
  const { dir } = ensureStore(ws, { home });
  assert.equal(readLedger(dir).filter((e) => e.failure).length, 0, 'digest rejection never strikes');
});

test('governed and detached sources are refused at emit time', () => {
  const ws = featureWorkspace('feature/governed-promo');
  const home = tempDir('promo-home7-');
  seedBucketLearning(ws, home, 'vetoed');
  const { dir } = ensureStore(ws, { home });
  appendGovernance(dir, { id: 'sql/vetoed', action: 'retire', reason: 'human veto', to: null, at: new Date().toISOString() });

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, false, 'only governed sources → nothing promotable');
  assert.ok(emitted.skipped.some((s) => s.id === 'sql/vetoed' && /standing governance/.test(s.reason)));

  const detached = buildPromotionOps({ workspace: ws, home, branchKey: 'detached-abcdefabcdef', all: true });
  assert.equal(detached.pass, false);
  assert.match(detached.blockedReason, /never promotable/);
});

test('prune removes buckets by key, by merged/tombstoned state, and by staleness in one store commit', () => {
  const ws = featureWorkspace('feature/prunable');
  const home = tempDir('promo-home8-');
  seedBucketLearning(ws, home, 'landed');
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/prunable');

  // Promote everything → the bucket becomes fully tombstoned (prunable).
  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  assert.equal(applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home }).exitCode, 0);

  // --merged sweeps the fully-tombstoned bucket.
  const merged = pruneBuckets({ workspace: ws, home, merged: true });
  assert.equal(merged.pass, true, merged.blockedReason);
  assert.deepEqual(merged.removed, [key]);
  assert.deepEqual(listBuckets(dir), []);
  const gitLog = spawnSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.match(gitLog, /knowledge: prune/);

  // --branch removes an explicit bucket; --stale sweeps by age.
  const bucketDir = bucketDirFor(dir, 'old-branch-11111111');
  fs.mkdirSync(path.join(bucketDir, 'learnings'), { recursive: true });
  fs.writeFileSync(
    path.join(bucketDir, 'meta.json'),
    JSON.stringify({ branch: 'old-branch', branchKey: 'old-branch-11111111', createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }) + '\n'
  );
  const stale = pruneBuckets({ workspace: ws, home, staleDays: 30 });
  assert.equal(stale.pass, true, stale.blockedReason);
  assert.deepEqual(stale.removed, ['old-branch-11111111']);

  // Selector required; unknown key refused.
  assert.match(pruneBuckets({ workspace: ws, home }).blockedReason, /needs --branch/);
  assert.match(pruneBuckets({ workspace: ws, home, branchKey: 'nope-00000000' }).blockedReason, /nothing to prune|no bucket/);
});
