import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { branchKeyFor } from '../lib/git-context.mjs';
import { ensureStore } from '../lib/knowledge/store.mjs';
import { rankLearnings } from '../lib/knowledge/retrieve.mjs';

function learningText({ trigger, body, applies, doesNotApply, source = 'auto' }) {
  return [
    '---',
    'schema: 1',
    `trigger: "${trigger}"`,
    'status: active',
    `source: ${source}`,
    'episodes:',
    'anchors: []',
    'superseded_by: null',
    'last_confirmed: null',
    'origin: test',
    `applies: "${applies}"`,
    `does_not_apply: "${doesNotApply}"`,
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

function removeTemps(t, ws, home) {
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
}

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function gitWorkspace(branch) {
  const ws = tempDir('retrieve-code-scope-ws-');
  git(ws, ['init', '-q', '-b', branch]);
  git(ws, ['config', 'user.email', 'test@example.test']);
  git(ws, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed\n');
  git(ws, ['add', '.']);
  git(ws, ['commit', '-qm', 'seed']);
  return ws;
}

function writeBucket(dir, key, meta = {}) {
  const bucketDir = path.join(dir, 'branches', key);
  fs.mkdirSync(path.join(bucketDir, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(bucketDir, 'meta.json'), JSON.stringify({ branchKey: key, promotable: true, ...meta }) + '\n');
  return bucketDir;
}

test('code signals prefer applies and still drop does_not_apply', (t) => {
  const ws = tempDir('retrieve-code-scope-');
  const home = tempDir('retrieve-code-scope-home-');
  removeTemps(t, ws, home);
  const { dir } = ensureStore(ws, { home });
  const trigger = 'schema migration';
  const body = 'Split the change into small steps.';
  writeLearning(dir, 'sql/alpha-plain', {
    trigger,
    body,
    applies: 'invoice export',
    doesNotApply: 'billing pdf',
  });
  writeLearning(dir, 'sql/beta-scoped', {
    trigger,
    body,
    applies: 'UserRepository',
    doesNotApply: 'billing pdf',
  });
  writeLearning(dir, 'sql/gamma-blocked', {
    trigger,
    body,
    applies: 'UserRepository',
    doesNotApply: 'UserRepository',
  });

  const rank = (signals) => rankLearnings({
    workspace: ws,
    query: 'schema',
    limit: 10,
    home,
    ...(signals === undefined ? {} : { signals }),
  });
  const ids = (rows) => rows.map((row) => row.id);
  const plain = rank();
  const empty = rank([]);
  const signaled = rank(['src/UserRepository.mjs']);

  assert.deepEqual(ids(plain), ['sql/alpha-plain', 'sql/beta-scoped', 'sql/gamma-blocked']);
  assert.deepEqual(ids(empty), ids(plain));
  assert.deepEqual(empty.map((row) => row.score), plain.map((row) => row.score));
  assert.deepEqual(ids(signaled), ['sql/beta-scoped', 'sql/alpha-plain']);
});

test('a protected golden stays ahead of a subordinate whose applies text matches the signal', (t) => {
  const branch = 'feature/signal';
  const ws = gitWorkspace(branch);
  const home = tempDir('retrieve-code-scope-home-');
  removeTemps(t, ws, home);
  const { dir } = ensureStore(ws, { home });
  const trigger = 'schema migration';
  const body = 'Split the change into small steps.';
  writeLearning(dir, 'sql/vital', {
    trigger,
    body,
    applies: 'invoice export',
    doesNotApply: 'billing pdf',
    source: 'human',
  });
  const bucketDir = writeBucket(dir, branchKeyFor(branch), { branch });
  writeLearning(bucketDir, 'sql/vital', {
    trigger,
    body,
    applies: 'UserRepository',
    doesNotApply: 'billing pdf',
  });

  const input = {
    workspace: ws,
    query: 'schema',
    home,
    signals: ['src/UserRepository.mjs'],
  };
  const ranked = rankLearnings({ ...input, limit: 2 });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].score, ranked[1].score);
  assert.equal(ranked[0].id, 'sql/vital');
  assert.equal(ranked[0].layer, undefined);
  assert.equal(ranked[1].subordinate, true);

  const top = rankLearnings({ ...input, limit: 1 });
  assert.deepEqual(top.map((row) => row.layer), [undefined]);
});

test('a higher trigger score stays ahead of a lower score with an applies match', (t) => {
  const ws = tempDir('retrieve-code-scope-');
  const home = tempDir('retrieve-code-scope-home-');
  removeTemps(t, ws, home);
  const { dir } = ensureStore(ws, { home });
  const body = 'Split the change into small steps.';
  writeLearning(dir, 'sql/zzz-high', {
    trigger: 'alpha beta gamma',
    body,
    applies: 'invoice export',
    doesNotApply: 'billing pdf',
  });
  writeLearning(dir, 'sql/aaa-low', {
    trigger: 'alpha',
    body,
    applies: 'UserRepository',
    doesNotApply: 'billing pdf',
  });

  const ranked = rankLearnings({
    workspace: ws,
    query: 'alpha beta gamma',
    limit: 2,
    home,
    signals: ['src/UserRepository.mjs'],
  });
  assert.deepEqual(ranked.map((row) => row.id), ['sql/zzz-high', 'sql/aaa-low']);
  assert.ok(ranked[0].score > ranked[1].score);
});
