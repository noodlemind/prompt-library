import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ensureStore, listLearnings, readLedger, STORE_SCHEMA } from '../lib/knowledge/store.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { resolveWriteLayer, ensureBucket, migrateRenamedBucket, episodeEligibleForLayer } from '../lib/knowledge/layer.mjs';
import { bucketDirFor, readBucketMeta, listBuckets } from '../lib/knowledge/overlay.mjs';
import { branchKeyFor, detachedKeyFor } from '../lib/git-context.mjs';
import { absorbHandEdits, mirrorLearnings } from '../lib/knowledge/admin.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { writeSession } from '../lib/session.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

/** Cloned workspace: origin/HEAD → main is resolvable, like a real checkout. */
function clonedWorkspace() {
  const origin = tempDir('route-origin-');
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 't@example.test']);
  git(origin, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(origin, 'seed.txt'), 'seed\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-qm', 'seed']);
  const ws = tempDir('route-ws-');
  git(ws, ['clone', '-q', origin, '.']);
  git(ws, ['config', 'user.email', 't@example.test']);
  git(ws, ['config', 'user.name', 'T']);
  return ws;
}

function head(ws) {
  return git(ws, ['rev-parse', 'HEAD']).stdout.trim();
}

function writeEpisode(ws, rel, { branch = null } = {}) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const fm = branch ? `---\ntitle: "${rel}"\ndate: 2026-07-01\nbranch: "${branch}"\n---\n\n` : '';
  const text = `${fm}fix evidence for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' };
}

function writeOps(ws, ops) {
  const p = path.join(ws, `ops-${crypto.randomUUID()}.json`);
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function addOp(ws, over = {}) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug: over.slug || 'routed-claim',
    trigger: 'routing trigger tokens',
    body: 'Routed claim body.',
    episodes: over.episodes || [writeEpisode(ws, `docs/solutions/perf/${over.slug || 'routed-claim'}.md`)],
    ...over,
  };
}

test('routing table: default branch → golden; feature branch → bucket; detached → detached bucket; --layer golden overrides', () => {
  const ws = clonedWorkspace();
  const home = tempDir('route-home-');

  // On main (the origin/HEAD default): golden.
  let routing = resolveWriteLayer({ workspace: ws, home });
  assert.equal(routing.layer, 'golden');
  assert.equal(routing.defaultBranch.name, 'main');

  // Feature branch: bucket, keyed deterministically.
  git(ws, ['checkout', '-qb', 'feature/route']);
  routing = resolveWriteLayer({ workspace: ws, home });
  assert.equal(routing.layer, 'branch');
  assert.equal(routing.bucketKey, branchKeyFor('feature/route'));
  assert.ok(!routing.failedClosed, 'resolvable default — routing is a plain feature-branch route, not fail-closed');

  // Explicit override: golden, flagged as an override.
  routing = resolveWriteLayer({ workspace: ws, home, layerOverride: 'golden' });
  assert.equal(routing.layer, 'golden');
  assert.equal(routing.override, true);

  // Detached HEAD: detached bucket.
  git(ws, ['checkout', '-q', '--detach']);
  routing = resolveWriteLayer({ workspace: ws, home });
  assert.equal(routing.layer, 'branch');
  assert.equal(routing.detached, true);
  assert.equal(routing.bucketKey, detachedKeyFor(head(ws)));
});

test('unresolvable default branch fails closed to branch-local, never golden', () => {
  const ws = tempDir('route-noremote-');
  git(ws, ['init', '-q', '-b', 'main']);
  git(ws, ['config', 'user.email', 't@example.test']);
  git(ws, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'a\n');
  git(ws, ['add', '.']);
  git(ws, ['commit', '-qm', 'a']);
  const routing = resolveWriteLayer({ workspace: ws, home: tempDir('route-home2-') });
  assert.equal(routing.layer, 'branch');
  assert.equal(routing.failedClosed, true);
});

test('a feature-branch apply lands in the bucket with meta.json, ledger, and INDEX — golden untouched', () => {
  const ws = clonedWorkspace();
  const home = tempDir('route-home3-');
  git(ws, ['checkout', '-qb', 'feature/bucket-write']);
  const mainTip = git(ws, ['rev-parse', 'origin/main']).stdout.trim();

  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws)]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  assert.equal(applied.layer, 'branch');
  const key = branchKeyFor('feature/bucket-write');
  assert.equal(applied.bucketKey, key);

  const { dir } = ensureStore(ws, { home });
  assert.equal(listLearnings(dir).length, 0, 'golden layer untouched');
  const bucketDir = bucketDirFor(dir, key);
  const bucketLearnings = listLearnings(bucketDir);
  assert.equal(bucketLearnings.length, 1);
  assert.equal(bucketLearnings[0].id, 'sql/routed-claim');
  assert.equal(readLedger(bucketDir).length, 1, 'episode consumed in the BUCKET ledger');
  assert.equal(readLedger(dir).length, 0, 'golden ledger untouched');
  assert.match(fs.readFileSync(path.join(bucketDir, 'INDEX.md'), 'utf8'), /routed-claim/);

  const meta = readBucketMeta(bucketDir);
  assert.equal(meta.branch, 'feature/bucket-write');
  assert.equal(meta.branchKey, key);
  assert.equal(meta.baseSha, mainTip);
  assert.equal(meta.promotable, true);
  assert.ok(meta.createdAt);

  // On the default branch the same episode is NOT golden-eligible (P4): its
  // provenance-less shape routes to branch review once buckets exist.
  git(ws, ['checkout', '-q', 'main']);
  const ep = writeEpisode(ws, 'docs/solutions/perf/foreign.md', { branch: 'feature/bucket-write' });
  const goldenAttempt = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, { slug: 'laundered', episodes: [ep] })]), home });
  assert.equal(goldenAttempt.exitCode, 1);
  assert.match(goldenAttempt.rejected[0].reason, /not a current unconsolidated candidate/);
});

test('golden lane accepts default-branch-provenance episodes; branch lane accepts own and provenance-less ones (P4)', () => {
  assert.equal(episodeEligibleForLayer('main', { layer: 'golden', currentBranch: 'main', defaultBranchName: 'main', storeHasBuckets: true }), true);
  assert.equal(episodeEligibleForLayer('feature/x', { layer: 'golden', currentBranch: 'main', defaultBranchName: 'main', storeHasBuckets: true }), false);
  assert.equal(episodeEligibleForLayer(null, { layer: 'golden', currentBranch: 'main', defaultBranchName: 'main', storeHasBuckets: true }), false, 'no provenance never silently golden');
  assert.equal(episodeEligibleForLayer(null, { layer: 'branch', currentBranch: 'feature/x', defaultBranchName: 'main', storeHasBuckets: true }), true);
  assert.equal(episodeEligibleForLayer('feature/x', { layer: 'branch', currentBranch: 'feature/x', defaultBranchName: 'main', storeHasBuckets: true }), true);
  assert.equal(episodeEligibleForLayer('feature/y', { layer: 'branch', currentBranch: 'feature/x', defaultBranchName: 'main', storeHasBuckets: true }), false);
  // Bucket-less store: pre-layer behavior, everything eligible.
  assert.equal(episodeEligibleForLayer(null, { layer: 'golden', currentBranch: null, defaultBranchName: null, storeHasBuckets: false }), true);
});

test('orient-recorded branch disagreement produces the advisory warning', () => {
  const ws = clonedWorkspace();
  const home = tempDir('route-home4-');
  writeSession(ws, { sessionId: 's1', gitBranch: 'main' });
  git(ws, ['checkout', '-qb', 'feature/drifted']);
  const warnings = [];
  const routing = resolveWriteLayer({ workspace: ws, home, log: (m) => warnings.push(m) });
  assert.equal(routing.layer, 'branch');
  assert.match(routing.branchWarning, /oriented on branch main but writing from feature\/drifted/);
  assert.ok(warnings.some((w) => /oriented on branch main/.test(w)));
});

test('commit-mode mirror stays golden-only: bucket learnings are never mirrored', () => {
  const ws = clonedWorkspace();
  const home = tempDir('route-home5-');
  const { dir } = ensureStore(ws, { home });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'on', commit: 'repo' }) + '\n');

  // Golden learning + bucket learning.
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'golden-claim.md'),
    `---\nschema: 1\ntrigger: "g"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: t\n---\n\nGolden.\n`
  );
  const bucketDir = ensureBucket(dir, { key: branchKeyFor('feature/m'), branch: 'feature/m' });
  fs.mkdirSync(path.join(bucketDir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(bucketDir, 'learnings', 'sql', 'bucket-claim.md'),
    `---\nschema: 1\ntrigger: "b"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: t\n---\n\nBucket.\n`
  );

  const result = mirrorLearnings({ workspace: ws, home });
  assert.equal(result.mirrored, 1);
  const mirrorRoot = path.join(ws, 'docs', 'knowledge', 'learnings');
  assert.ok(fs.existsSync(path.join(mirrorRoot, 'sql', 'golden-claim.md')));
  assert.ok(!fs.existsSync(path.join(mirrorRoot, 'sql', 'bucket-claim.md')), 'bucket learnings never mirrored');
  assert.doesNotMatch(fs.readFileSync(path.join(mirrorRoot, 'INDEX.md'), 'utf8'), /bucket-claim/);
});

test('a hand edit under branches/<key>/learnings/** is absorbed with the bucket recorded in the snapshot', () => {
  const ws = clonedWorkspace();
  const home = tempDir('route-home6-');
  git(ws, ['checkout', '-qb', 'feature/hand']);
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, { slug: 'hand-claim' })]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/hand');
  const bucketDir = bucketDirFor(dir, key);
  const learning = listLearnings(bucketDir).find((l) => l.id === 'sql/hand-claim');
  fs.writeFileSync(learning.file, fs.readFileSync(learning.file, 'utf8').replace('Routed claim body.', 'Hand-edited bucket body.'), 'utf8');

  const absorbed = absorbHandEdits({ workspace: ws, home });
  assert.deepEqual(absorbed.absorbed.map((a) => a.id), ['sql/hand-claim']);
  const after = listLearnings(bucketDir).find((l) => l.id === 'sql/hand-claim');
  assert.equal(after.fm.source, 'human');
  assert.match(after.body, /Hand-edited bucket body/);
  const snapshot = absorbed.absorbed[0].snapshot;
  assert.ok(snapshot, 'snapshot written');
  assert.match(fs.readFileSync(path.join(ws, snapshot), 'utf8'), new RegExp(`^bucket: "${key}"$`, 'm'));
});

test('a newer store schema makes this CLI refuse with an upgrade hint', () => {
  const ws = clonedWorkspace();
  const home = tempDir('route-home7-');
  const { dir } = ensureStore(ws, { home });
  const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
  assert.equal(recorded.schema, STORE_SCHEMA);

  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ schema: STORE_SCHEMA + 1 }) + '\n');
  const isSchemaRefusal = (err) =>
    err.code === 'E_STORE_SCHEMA' && /newer than this CLI supports/.test(err.message) && /@dev-kit\/harness/.test(err.hint);
  assert.throws(() => ensureStore(ws, { home }), isSchemaRefusal);
  assert.throws(() => applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, { slug: 'nope' })]), home }), isSchemaRefusal);
});

test('branch rename auto-migrates the bucket to the new key when unambiguous', () => {
  const ws = clonedWorkspace();
  const home = tempDir('route-home8-');
  git(ws, ['checkout', '-qb', 'feature/old-name']);
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, { slug: 'renamed-claim' })]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const { dir } = ensureStore(ws, { home });
  const oldKey = branchKeyFor('feature/old-name');
  assert.ok(fs.existsSync(bucketDirFor(dir, oldKey)));

  // Rename the branch: the old branch name no longer exists anywhere.
  git(ws, ['branch', '-m', 'feature/old-name', 'feature/new-name']);
  const context = { branch: 'feature/new-name', branchKey: branchKeyFor('feature/new-name') };
  const migrated = migrateRenamedBucket(dir, { workspace: ws, context });
  assert.deepEqual(migrated, { migrated: true, from: oldKey, to: context.branchKey });
  assert.ok(!fs.existsSync(bucketDirFor(dir, oldKey)));
  const meta = readBucketMeta(bucketDirFor(dir, context.branchKey));
  assert.equal(meta.branch, 'feature/new-name');
  assert.equal(meta.branchKey, context.branchKey);
  const moved = listLearnings(bucketDirFor(dir, context.branchKey));
  assert.ok(moved.some((l) => l.id === 'sql/renamed-claim'));
});

test('doctor K5 flags orphan buckets and K6 flags misrouted bucket contents', () => {
  const ws = clonedWorkspace();
  const home = tempDir('route-home9-');
  // Doctor reads the store via the UNSCOPED storeDir (HARNESS_HOME), so run
  // it with HARNESS_HOME pointed at this test's home.
  const { dir } = ensureStore(ws, { home });
  const orphanKey = branchKeyFor('feature/deleted-branch');
  const bucketDir = ensureBucket(dir, { key: orphanKey, branch: 'feature/deleted-branch' });
  fs.mkdirSync(path.join(bucketDir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(bucketDir, 'learnings', 'sql', 'misrouted.md'),
    `---\nschema: 1\ntrigger: "m"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: t\nbranch: "feature/some-other-branch"\n---\n\nMisrouted.\n`
  );

  const prevHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    const { checks } = runDoctor({
      copilotHome: tempDir('route-ch-'),
      assetsRoot: tempDir('route-assets-'),
      pkgRoot: null,
      flags: { workspace: ws },
      workspace: ws,
    });
    const k5 = checks.find((c) => c.id === 'K5');
    assert.ok(k5, 'K5 present');
    assert.equal(k5.pass, false);
    assert.match(k5.hint, /knowledge prune/);
    const k6 = checks.find((c) => c.id === 'K6');
    assert.ok(k6, 'K6 present');
    assert.equal(k6.pass, false);
    assert.match(k6.hint, new RegExp(`${orphanKey}:sql/misrouted`));
  } finally {
    if (prevHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = prevHome;
  }
});

test('listBuckets sees a routed bucket and consolidate status reports the branch lane', async () => {
  const ws = clonedWorkspace();
  const home = tempDir('route-home10-');
  git(ws, ['checkout', '-qb', 'feature/lane']);
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, { slug: 'lane-claim' })]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const { dir } = ensureStore(ws, { home });
  assert.deepEqual(listBuckets(dir).map((b) => b.key), [branchKeyFor('feature/lane')]);

  const { consolidateStatus } = await import('../lib/knowledge/consolidate.mjs');
  const status = consolidateStatus({ workspace: ws, home, copilotHome: tempDir('route-ch2-') });
  assert.equal(status.layer, 'branch');
  assert.equal(status.bucketKey, branchKeyFor('feature/lane'));
  assert.equal(status.debt, 0, 'the bucket ledger consumed the episode — no phantom debt');
});
