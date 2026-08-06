import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ensureStore, listLearnings, readLedger, readGovernance, appendGovernance } from '../lib/knowledge/store.mjs';
import { purgeEpisode, purgeAll, rebuildStore } from '../lib/knowledge/admin.mjs';
import { ensureBucket } from '../lib/knowledge/layer.mjs';
import { bucketDirFor, readBucketMeta, listBuckets } from '../lib/knowledge/overlay.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

/** Commit fixture files in the store repo through the config-neutralized
 * git() helper (a developer's global gpgsign etc. must never leak in). */
function commitFixture(dir) {
  assert.equal(git(dir, ['add', '-A']).status, 0, 'fixture git add failed');
  const res = git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture']);
  assert.equal(res.status, 0, `fixture git commit failed: ${res.stderr}`);
}

function gitWorkspace(branch = 'main') {
  const ws = tempDir('lmaint-ws-');
  git(ws, ['init', '-q', '-b', branch]);
  git(ws, ['config', 'user.email', 't@example.test']);
  git(ws, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed\n');
  git(ws, ['add', '.']);
  git(ws, ['commit', '-qm', 'seed']);
  return ws;
}

function writeEpisodeFile(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `fix evidence for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function writeLearning(root, id, { episodes = [], body = 'Body.' } = {}) {
  const [domain, slug] = id.split('/');
  const dir = path.join(root, 'learnings', domain);
  fs.mkdirSync(dir, { recursive: true });
  const epLines = episodes.length
    ? ['episodes:', ...episodes.flatMap((e) => [
        `  - path: ${e.rel}`,
        `    sha256: "${e.sha256}"`,
        '    kind: fix',
        '    plan: docs/plans/p1.md',
      ])]
    : ['episodes:'];
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    ['---', 'schema: 1', `trigger: "t ${slug}"`, 'status: active', 'source: auto', ...epLines, 'anchors: []', 'superseded_by: null', 'last_confirmed: null', 'origin: t', '---', '', body, ''].join('\n'),
    'utf8'
  );
}

test('purge cascades across golden AND bucket layers: files, links, ledgers, and index rows all go', () => {
  const ws = gitWorkspace();
  const home = tempDir('lmaint-home-');
  const { dir } = ensureStore(ws, { home });
  const ep = writeEpisodeFile(ws, 'docs/solutions/perf/shared.md');
  const other = writeEpisodeFile(ws, 'docs/solutions/perf/other.md');

  // Golden: one learning solely backed by the episode, one multi-evidence.
  writeLearning(dir, 'sql/solely-golden', { episodes: [ep] });
  writeLearning(dir, 'sql/multi-golden', { episodes: [ep, other] });
  // Bucket: one learning solely backed by the same episode.
  const key = branchKeyFor('feature/purge');
  const bucketDir = ensureBucket(dir, { key, branch: 'feature/purge' });
  writeLearning(bucketDir, 'sql/solely-bucket', { episodes: [ep] });
  // Ledger entries in both layers.
  fs.appendFileSync(path.join(dir, 'consolidated.jsonl'), JSON.stringify({ path: ep.rel, sha256: ep.sha256, learning: 'sql/solely-golden', at: '2026-08-01' }) + '\n');
  fs.appendFileSync(path.join(bucketDir, 'consolidated.jsonl'), JSON.stringify({ path: ep.rel, sha256: ep.sha256, learning: 'sql/solely-bucket', at: '2026-08-01' }) + '\n');
  commitFixture(dir);

  const result = purgeEpisode({ workspace: ws, target: ep.rel, copilotHome: tempDir('lmaint-ch-'), home });
  assert.equal(result.pass, true, result.blockedReason);
  assert.deepEqual(result.removed.learnings.sort(), ['sql/solely-bucket', 'sql/solely-golden']);
  assert.deepEqual(result.removed.links, ['sql/multi-golden']);
  assert.equal(result.removed.ledger, 2, 'both layers ledger-cleaned');

  assert.ok(!fs.existsSync(path.join(ws, ep.rel)), 'episode file deleted');
  assert.deepEqual(listLearnings(dir).map((l) => l.id), ['sql/multi-golden']);
  assert.deepEqual(listLearnings(bucketDir), []);
  assert.equal(readLedger(dir).length, 0);
  assert.equal(readLedger(bucketDir).length, 0);
  const multi = listLearnings(dir)[0];
  assert.deepEqual(multi.fm.episodes.map((e) => e.path), [other.rel]);
});

test('purge keeps the governance record while the id survives in ANY layer, drops it only when fully gone', () => {
  const ws = gitWorkspace();
  const home = tempDir('lmaint-home2-');
  const { dir } = ensureStore(ws, { home });
  const ep = writeEpisodeFile(ws, 'docs/solutions/perf/gov.md');
  const goldenEp = writeEpisodeFile(ws, 'docs/solutions/perf/golden-own.md');

  // Same id in both layers: bucket copy backed solely by ep, golden by its own.
  writeLearning(dir, 'sql/dual', { episodes: [goldenEp] });
  const key = branchKeyFor('feature/gov');
  const bucketDir = ensureBucket(dir, { key, branch: 'feature/gov' });
  writeLearning(bucketDir, 'sql/dual', { episodes: [ep] });
  appendGovernance(dir, { id: 'sql/dual', action: 'dispute', reason: 'r', to: null, at: new Date().toISOString() });
  commitFixture(dir);

  // Purging ep removes only the bucket copy — the golden twin survives, so
  // the governance record must survive with it.
  const first = purgeEpisode({ workspace: ws, target: ep.rel, copilotHome: tempDir('lmaint-ch2-'), home });
  assert.equal(first.pass, true, first.blockedReason);
  assert.deepEqual(first.removed.learnings, ['sql/dual']);
  assert.ok(readGovernance(dir).has('sql/dual'), 'governance survives while the golden twin exists');

  // Purging the golden twin's own evidence removes the last copy — now the
  // governance record goes too.
  const second = purgeEpisode({ workspace: ws, target: goldenEp.rel, copilotHome: tempDir('lmaint-ch3-'), home });
  assert.equal(second.pass, true, second.blockedReason);
  assert.ok(!readGovernance(dir).has('sql/dual'), 'governance dropped once no layer holds the id');
});

test('purge --all wipes branches/ whole and counts bucket learnings', () => {
  const ws = gitWorkspace();
  const home = tempDir('lmaint-home3-');
  const { dir } = ensureStore(ws, { home });
  writeLearning(dir, 'sql/golden-claim');
  const bucketDir = ensureBucket(dir, { key: branchKeyFor('feature/wipe'), branch: 'feature/wipe' });
  writeLearning(bucketDir, 'sql/bucket-claim');
  commitFixture(dir);

  const result = purgeAll({ workspace: ws, home });
  assert.equal(result.pass, true, result.blockedReason);
  assert.equal(result.removed.learnings, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'branches')), 'branches/ wiped whole');
  assert.deepEqual(listLearnings(dir), []);
});

test('rebuild --yes wipes each bucket per layer but keeps bucket meta as the layer identity', () => {
  const ws = gitWorkspace();
  const home = tempDir('lmaint-home4-');
  const { dir } = ensureStore(ws, { home });
  writeLearning(dir, 'sql/golden-claim');
  const key = branchKeyFor('feature/rebuild');
  const bucketDir = ensureBucket(dir, { key, branch: 'feature/rebuild' });
  writeLearning(bucketDir, 'sql/bucket-claim');
  fs.appendFileSync(path.join(bucketDir, 'consolidated.jsonl'), JSON.stringify({ path: 'x.md', sha256: 'a'.repeat(64), learning: 'sql/bucket-claim', at: '2026-08-01' }) + '\n');
  commitFixture(dir);

  const result = rebuildStore({ workspace: ws, home, yes: true, copilotHome: tempDir('lmaint-ch4-') });
  assert.equal(result.pass, true, result.blockedReason);
  assert.equal(result.archived, 2, 'golden + bucket learnings both archived');
  assert.deepEqual(listLearnings(dir), []);
  assert.deepEqual(listLearnings(bucketDir), []);
  assert.equal(readLedger(bucketDir).length, 0, 'bucket ledger truncated');
  const meta = readBucketMeta(bucketDir);
  assert.equal(meta.branch, 'feature/rebuild', 'bucket meta survives as the layer identity');
  assert.deepEqual(listBuckets(dir).map((b) => b.key), [key]);
});
