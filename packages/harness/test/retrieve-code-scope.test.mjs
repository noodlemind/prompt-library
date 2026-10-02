import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureStore } from '../lib/knowledge/store.mjs';
import { rankLearnings } from '../lib/knowledge/retrieve.mjs';

function learningText({ trigger, body, applies, doesNotApply }) {
  return [
    '---',
    'schema: 1',
    `trigger: "${trigger}"`,
    'status: active',
    'source: auto',
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

test('code signals prefer applies and still drop does_not_apply', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieve-code-scope-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieve-code-scope-home-'));
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
