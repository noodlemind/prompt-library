import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listLearnings, parseLearningFrontmatter, serializeLearning, storeDir } from '../lib/knowledge/store.mjs';
import { renderLearning } from '../lib/knowledge/apply.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const ctx = () => {
  const ws = trackWorkspaceSolutions(tempDir('correct-ws-'));
  return { ws, home: tempDir('correct-home-'), harnessHome: tempDir('correct-hh-') };
};

const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

const CLAIM = 'Wait for the lock before altering a hot table.';
const WHY = 'a direct alter takes an exclusive lock';
const APPLIES = 'a hot table with live traffic';
const DOES_NOT = 'a cold table with no readers';

function enable(c) {
  const res = run(c, ['knowledge', 'on']);
  assert.equal(res.status, 0, res.stderr + res.stdout);
}

function correctArgs({ authority = 'correction', domain = null, omit = null, dryRun = false } = {}) {
  const args = ['correct', CLAIM, '--trigger', 'altering a hot table', '--why', WHY, '--applies', APPLIES];
  if (omit !== 'does-not-apply') args.push('--does-not-apply', DOES_NOT);
  if (domain) args.push('--domain', domain);
  if (authority) args.push('--authority', authority);
  if (dryRun) args.push('--dry-run');
  return args;
}

function learnings(c) {
  return listLearnings(storeDir(c.ws, { home: c.harnessHome }));
}

function assertRecord(text, fm, { authority, status }) {
  assert.equal(fm.authority, authority);
  assert.equal(fm.why, WHY);
  assert.equal(fm.applies, APPLIES);
  assert.equal(fm.does_not_apply, DOES_NOT);
  assert.equal(fm.status, status);
  assert.match(text, new RegExp(`^authority: ${authority}$`, 'm'));
  assert.match(text, new RegExp(`^why: "${WHY}"$`, 'm'));
  assert.match(text, new RegExp(`^applies: "${APPLIES}"$`, 'm'));
  assert.match(text, new RegExp(`^does_not_apply: "${DOES_NOT}"$`, 'm'));
  assert.match(text, new RegExp(`^status: ${status}$`, 'm'));
}

test('correct --authority correction writes an active learning with the four fields', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ authority: 'correction', domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const id = JSON.parse(res.stdout).learningId;
  assert.equal(id, 'sql/altering-a-hot-table');
  const learning = learnings(c).find((l) => l.id === id);
  assert.ok(learning, 'learning file exists');
  const text = fs.readFileSync(learning.file, 'utf8');
  assertRecord(text, learning.fm, { authority: 'correction', status: 'active' });
});

test('correct --authority inference writes status provisional', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ authority: 'inference', domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const learning = learnings(c).find((l) => l.id === JSON.parse(res.stdout).learningId);
  const text = fs.readFileSync(learning.file, 'utf8');
  assertRecord(text, learning.fm, { authority: 'inference', status: 'provisional' });
});

test('correct --authority instruction writes status active', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ authority: 'instruction', domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const learning = learnings(c).find((l) => l.id === JSON.parse(res.stdout).learningId);
  const text = fs.readFileSync(learning.file, 'utf8');
  assertRecord(text, learning.fm, { authority: 'instruction', status: 'active' });
});

test('correct defaults --domain to general', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs());
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(JSON.parse(res.stdout).learningId, 'general/altering-a-hot-table');
});

test('correct without --does-not-apply exits non-zero and writes no learning', () => {
  const c = ctx();
  enable(c);
  const before = learnings(c).length;
  const res = run(c, correctArgs({ omit: 'does-not-apply' }));
  assert.notEqual(res.status, 0, res.stdout);
  assert.equal(learnings(c).length, before);
});

test('correct --authority guess exits non-zero and writes no learning', () => {
  const c = ctx();
  enable(c);
  const before = learnings(c).length;
  const res = run(c, correctArgs({ authority: 'guess' }));
  assert.notEqual(res.status, 0, res.stdout);
  assert.equal(learnings(c).length, before);
});

test('correct --dry-run writes no learning', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ dryRun: true, domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(JSON.parse(res.stdout).dryRun, true);
  assert.equal(learnings(c).length, 0);
});

test('renderLearning and serializeLearning keep the four fields and omit empty ones', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const learning = learnings(c).find((l) => l.id === JSON.parse(res.stdout).learningId);
  const { fm, body } = parseLearningFrontmatter(fs.readFileSync(learning.file, 'utf8'));
  const serialized = serializeLearning(fm, body);
  const rendered = renderLearning({
    trigger: fm.trigger,
    body,
    episodes: fm.episodes,
    origin: fm.origin || 'unknown',
    status: fm.status,
    source: fm.source,
    authority: fm.authority,
    why: fm.why,
    applies: fm.applies,
    does_not_apply: fm.does_not_apply,
  });
  for (const text of [serialized, rendered]) {
    assertRecord(text, parseLearningFrontmatter(text).fm, { authority: 'correction', status: 'active' });
  }
  const bare = serializeLearning(
    { trigger: 't', status: 'active', source: 'human', episodes: [], authority: '', why: '', applies: '', does_not_apply: '' },
    'body',
  );
  assert.doesNotMatch(bare, /^authority:/m);
  assert.doesNotMatch(bare, /^why:/m);
  assert.doesNotMatch(bare, /^applies:/m);
  assert.doesNotMatch(bare, /^does_not_apply:/m);
});
