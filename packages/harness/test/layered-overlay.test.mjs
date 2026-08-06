import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ensureStore, appendGovernance } from '../lib/knowledge/store.mjs';
import { loadLayeredLearnings, isProtectedFm, layerTieRank, listBuckets, bucketAncestryOk } from '../lib/knowledge/overlay.mjs';
import { rankLearnings, explainLearnings } from '../lib/knowledge/retrieve.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';
import { buildLearningsLines } from '../lib/context-pack.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function gitWorkspace(branch = 'feature/overlay') {
  const ws = tempDir('overlay-ws-');
  git(ws, ['init', '-q', '-b', branch]);
  git(ws, ['config', 'user.email', 'test@example.test']);
  git(ws, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed\n');
  git(ws, ['add', '.']);
  git(ws, ['commit', '-qm', 'seed']);
  return ws;
}

function head(ws) {
  return git(ws, ['rev-parse', 'HEAD']).stdout.trim();
}

function learningText({ trigger, body, status = 'active', source = 'auto', episodes = [] }) {
  const epLines = episodes.length
    ? ['episodes:', ...episodes.flatMap((e, i) => [
        `  - path: docs/solutions/perf/e${i}.md`,
        `    sha256: "${'a'.repeat(64)}"`,
        `    kind: ${e.kind || 'fix'}`,
        `    plan: docs/plans/p${i}.md`,
      ])]
    : ['episodes:'];
  return [
    '---',
    'schema: 1',
    `trigger: "${trigger}"`,
    `status: ${status}`,
    `source: ${source}`,
    ...epLines,
    'anchors: []',
    'superseded_by: null',
    'last_confirmed: null',
    'origin: test',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

function writeLearning(root, id, opts) {
  const [domain, slug] = id.split('/');
  const dir = path.join(root, 'learnings', domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), learningText(opts), 'utf8');
}

function writeBucket(dir, key, meta = {}) {
  const bucketDir = path.join(dir, 'branches', key);
  fs.mkdirSync(path.join(bucketDir, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(bucketDir, 'meta.json'), JSON.stringify({ branchKey: key, promotable: true, ...meta }) + '\n');
  return bucketDir;
}

test('with no branches/ directory the ranked output is byte-identical (no layer fields, no git calls)', () => {
  const ws = gitWorkspace();
  const home = tempDir('overlay-home-');
  const { dir } = ensureStore(ws, { home });
  writeLearning(dir, 'sql/golden-claim', { trigger: 'index scans on hot tables', body: 'Golden claim body.' });

  const before = JSON.stringify(rankLearnings({ workspace: ws, query: 'hot tables index', home }));
  assert.match(before, /golden-claim/);
  assert.doesNotMatch(before, /"layer"/);

  // An EMPTY branches/ dir (no bucket for this branch) must not change a byte.
  fs.mkdirSync(path.join(dir, 'branches'), { recursive: true });
  const after = JSON.stringify(rankLearnings({ workspace: ws, query: 'hot tables index', home }));
  assert.equal(after, before);
});

test('a branch-local learning shadows an unprotected golden claim with the same id', () => {
  const ws = gitWorkspace('feature/shadow');
  const home = tempDir('overlay-home2-');
  const { dir } = ensureStore(ws, { home });
  writeLearning(dir, 'sql/claim', { trigger: 'shared trigger tokens', body: 'Golden version.' });
  const bucketDir = writeBucket(dir, branchKeyFor('feature/shadow'), { branch: 'feature/shadow' });
  writeLearning(bucketDir, 'sql/claim', { trigger: 'shared trigger tokens', body: 'Branch version.' });

  const { learnings, layered } = loadLayeredLearnings({ workspace: ws, home });
  assert.equal(layered, true);
  assert.equal(learnings.length, 1);
  assert.equal(learnings[0].layer, 'branch');
  assert.match(learnings[0].body, /Branch version/);

  const ranked = rankLearnings({ workspace: ws, query: 'shared trigger tokens', home });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].layer, 'branch');
  assert.match(ranked[0].claimLine, /Branch version/);
});

test('a protected golden claim (>=3 fix links or source human) is never shadowed; the branch claim is subordinate', () => {
  const ws = gitWorkspace('feature/protected');
  const home = tempDir('overlay-home3-');
  const { dir } = ensureStore(ws, { home });
  writeLearning(dir, 'sql/vital', {
    trigger: 'protected trigger tokens',
    body: 'Golden protected version.',
    episodes: [{ kind: 'fix' }, { kind: 'fix' }, { kind: 'fix' }],
  });
  const bucketDir = writeBucket(dir, branchKeyFor('feature/protected'), { branch: 'feature/protected' });
  writeLearning(bucketDir, 'sql/vital', { trigger: 'protected trigger tokens', body: 'Branch challenger version.' });

  const { learnings } = loadLayeredLearnings({ workspace: ws, home });
  assert.equal(learnings.length, 2, 'protected golden stays AND branch claim rides along');
  const golden = learnings.find((l) => !l.layer);
  const branch = learnings.find((l) => l.layer === 'branch');
  assert.match(golden.body, /Golden protected/);
  assert.equal(branch.subordinate, true);
  assert.ok(isProtectedFm(golden.fm));

  // Equal-score tie between the pair: the protected golden outranks its
  // subordinate shadow (subordinate never wins the tie).
  const ranked = rankLearnings({ workspace: ws, query: 'protected trigger tokens', home });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].layer, undefined);
  assert.equal(ranked[1].subordinate, true);
  assert.match(ranked[0].claimLine, /Golden protected/);

  // source: human is equally protected.
  writeLearning(dir, 'sql/human', { trigger: 'human trigger', body: 'Human golden.', source: 'human' });
  writeLearning(bucketDir, 'sql/human', { trigger: 'human trigger', body: 'Branch challenger.' });
  const again = loadLayeredLearnings({ workspace: ws, home }).learnings;
  const humanBranch = again.find((l) => l.id === 'sql/human' && l.layer === 'branch');
  assert.equal(humanBranch.subordinate, true);
});

test('an id under a standing retire/dispute/promote decision is never surfaced from a bucket', () => {
  const ws = gitWorkspace('feature/governed');
  const home = tempDir('overlay-home4-');
  const { dir } = ensureStore(ws, { home });
  const bucketDir = writeBucket(dir, branchKeyFor('feature/governed'), { branch: 'feature/governed' });
  writeLearning(bucketDir, 'sql/banned', { trigger: 'governed trigger tokens', body: 'Escape attempt.' });
  writeLearning(bucketDir, 'sql/allowed', { trigger: 'governed trigger tokens', body: 'Allowed bucket claim.' });
  appendGovernance(dir, { id: 'sql/banned', action: 'retire', reason: 'human veto', to: null, at: new Date().toISOString() });

  const { learnings } = loadLayeredLearnings({ workspace: ws, home });
  assert.deepEqual(learnings.map((l) => l.id), ['sql/allowed']);

  // confirm is NOT an exclusion — only retire/dispute/promote bind.
  appendGovernance(dir, { id: 'sql/allowed', action: 'confirm', reason: null, to: null, at: new Date().toISOString() });
  assert.ok(loadLayeredLearnings({ workspace: ws, home }).learnings.some((l) => l.id === 'sql/allowed'));
});

test('branch-local wins an equal-score tie against a DIFFERENT golden id (layer tiebreak before id tiebreak)', () => {
  const ws = gitWorkspace('feature/tie');
  const home = tempDir('overlay-home5-');
  const { dir } = ensureStore(ws, { home });
  // 'aaa/...' sorts before 'zzz/...', so the id tiebreak ALONE would put the
  // golden claim first; the layer tiebreak must run first and flip it.
  writeLearning(dir, 'aaa/golden-tie', { trigger: 'tie trigger tokens', body: 'Golden tie.' });
  const bucketDir = writeBucket(dir, branchKeyFor('feature/tie'), { branch: 'feature/tie' });
  writeLearning(bucketDir, 'zzz/branch-tie', { trigger: 'tie trigger tokens', body: 'Branch tie.' });

  const ranked = rankLearnings({ workspace: ws, query: 'tie trigger tokens', home });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].score, ranked[1].score);
  assert.equal(ranked[0].id, 'zzz/branch-tie');
  assert.equal(ranked[0].layer, 'branch');
  assert.equal(layerTieRank(ranked[0]), 0);
  assert.equal(layerTieRank(ranked[1]), 1);
});

test('a bucket whose recorded baseSha is not an ancestor of HEAD is excluded whole (force-push name reuse)', () => {
  const ws = gitWorkspace('feature/reused');
  const home = tempDir('overlay-home6-');
  const { dir } = ensureStore(ws, { home });
  writeLearning(dir, 'sql/golden-only', { trigger: 'reuse trigger tokens', body: 'Golden survives.' });
  // A syntactically valid sha that this repo has never seen — provably not an ancestor.
  const foreignSha = 'd'.repeat(40);
  const bucketDir = writeBucket(dir, branchKeyFor('feature/reused'), { branch: 'feature/reused', baseSha: foreignSha });
  writeLearning(bucketDir, 'sql/imposter', { trigger: 'reuse trigger tokens', body: 'Unrelated history.' });

  assert.equal(bucketAncestryOk(ws, { baseSha: foreignSha }), false);
  assert.equal(bucketAncestryOk(ws, { baseSha: head(ws) }), true);
  assert.equal(bucketAncestryOk(ws, {}), null);

  const result = loadLayeredLearnings({ workspace: ws, home });
  assert.deepEqual(result.learnings.map((l) => l.id), ['sql/golden-only']);
  assert.deepEqual(result.excludedBucket, { key: branchKeyFor('feature/reused'), reason: 'ancestry' });

  // With a genuinely ancestral base the same bucket overlays normally.
  fs.writeFileSync(path.join(bucketDir, 'meta.json'), JSON.stringify({ branch: 'feature/reused', baseSha: head(ws) }) + '\n');
  const ok = loadLayeredLearnings({ workspace: ws, home });
  assert.ok(ok.learnings.some((l) => l.id === 'sql/imposter'));
});

test('explain decomposition and the context pack carry the branch-local marker', () => {
  const ws = gitWorkspace('feature/marker');
  const home = tempDir('overlay-home7-');
  const { dir } = ensureStore(ws, { home });
  const bucketDir = writeBucket(dir, branchKeyFor('feature/marker'), { branch: 'feature/marker' });
  writeLearning(bucketDir, 'sql/marked', { trigger: 'marker trigger tokens', body: 'Marked claim.' });

  const explain = explainLearnings({ workspace: ws, query: 'marker trigger tokens', home });
  const candidate = explain.candidates.find((c) => c.id === 'sql/marked');
  assert.equal(candidate.layer, 'branch');

  const ranked = rankLearnings({ workspace: ws, query: 'marker trigger tokens', home });
  const lines = buildLearningsLines(ranked).join('\n');
  assert.match(lines, /- \[sql\/marked\] \[branch-local\]/);

  // Golden-only lines never carry the marker (query tokens disjoint from the
  // bucket claim so only the golden learning surfaces).
  writeLearning(dir, 'sql/plain', { trigger: 'entirely disjoint golden words', body: 'Plain claim.' });
  const plain = buildLearningsLines(rankLearnings({ workspace: ws, query: 'entirely disjoint golden words', home })).join('\n');
  assert.doesNotMatch(plain, /\[branch-local\]/);
});

test('listBuckets enumerates bucket keys with meta', () => {
  const ws = gitWorkspace('feature/list');
  const home = tempDir('overlay-home8-');
  const { dir } = ensureStore(ws, { home });
  assert.deepEqual(listBuckets(dir), []);
  writeBucket(dir, 'bbb-11111111', { branch: 'bbb' });
  writeBucket(dir, 'aaa-22222222', { branch: 'aaa' });
  const buckets = listBuckets(dir);
  assert.deepEqual(buckets.map((b) => b.key), ['aaa-22222222', 'bbb-11111111']);
  assert.equal(buckets[0].meta.branch, 'aaa');
});
