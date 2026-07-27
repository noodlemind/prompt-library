import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  repoId,
  storeDir,
  ensureStore,
  readLedger,
  appendLedger,
  listLearnings,
  commitStore,
  normalizeSlug,
} from '../lib/knowledge/store.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function gitWorkspace(remote) {
  const ws = tempDir('kstore-ws-');
  git(ws, ['init', '-q']);
  if (remote) git(ws, ['remote', 'add', 'origin', remote]);
  return ws;
}

test('repoId normalizes ssh and https forms of the same remote to one id', () => {
  const a = gitWorkspace('git@github.com:noodlemind/prompt-library.git');
  const b = gitWorkspace('https://github.com/noodlemind/prompt-library.git');
  assert.equal(repoId(a), repoId(b));
  assert.match(repoId(a), /^github\.com-noodlemind-prompt-library$/);
});

test('repoId falls back to a stable path-keyed id without a remote', () => {
  const ws = gitWorkspace(null);
  const id = repoId(ws);
  assert.match(id, /^local-[0-9a-f]{12}$/);
  assert.equal(id, repoId(ws));
});

test('ensureStore creates a git-backed store with learnings, INDEX.md, and ledger', () => {
  const home = tempDir('kstore-home-');
  const ws = gitWorkspace('https://github.com/x/y.git');
  const { dir, created } = ensureStore(ws, { home });
  assert.ok(dir.startsWith(home));
  assert.ok(created);
  assert.ok(fs.existsSync(path.join(dir, 'learnings')));
  assert.ok(fs.existsSync(path.join(dir, 'INDEX.md')));
  assert.ok(fs.existsSync(path.join(dir, 'consolidated.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  const again = ensureStore(ws, { home });
  assert.equal(again.created, false);
});

test('ledger round-trips entries and tolerates a torn tail line', () => {
  const home = tempDir('kstore-ledger-');
  const ws = gitWorkspace('https://github.com/x/ledger.git');
  const { dir } = ensureStore(ws, { home });
  appendLedger(dir, [
    { path: 'docs/solutions/a.md', sha256: 'aa', learning: 'sql/x', at: '2026-07-27' },
    { path: 'docs/solutions/b.md', sha256: 'bb', learning: null, at: '2026-07-27' },
  ]);
  fs.appendFileSync(path.join(dir, 'consolidated.jsonl'), '{"torn');
  const entries = readLedger(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].learning, 'sql/x');
});

test('listLearnings parses frontmatter including structured episodes', () => {
  const home = tempDir('kstore-list-');
  const ws = gitWorkspace('https://github.com/x/list.git');
  const { dir } = ensureStore(ws, { home });
  const lDir = path.join(dir, 'learnings', 'sql');
  fs.mkdirSync(lDir, { recursive: true });
  fs.writeFileSync(
    path.join(lDir, 'not-null-large-tables.md'),
    `---
schema: 1
trigger: "adding NOT NULL columns to large tables"
status: active
source: auto
episodes:
  - path: docs/solutions/perf/x.md
    sha256: "abc123"
    kind: fix
    plan: docs/plans/p1.md
  - path: docs/solutions/perf/y.md
    sha256: "def456"
    kind: insight
    plan: ""
superseded_by: null
last_confirmed: 2026-07-20
origin: github.com-x-list
---

Use two-step default+backfill; a direct ALTER takes an exclusive lock.
`
  );
  const learnings = listLearnings(dir);
  assert.equal(learnings.length, 1);
  const l = learnings[0];
  assert.equal(l.id, 'sql/not-null-large-tables');
  assert.equal(l.fm.trigger, 'adding NOT NULL columns to large tables');
  assert.equal(l.fm.status, 'active');
  assert.equal(l.fm.episodes.length, 2);
  assert.equal(l.fm.episodes[0].kind, 'fix');
  assert.equal(l.fm.episodes[0].plan, 'docs/plans/p1.md');
  assert.match(l.body, /two-step default\+backfill/);
  assert.ok(l.bytes > 0);
});

test('commitStore commits changes and reports clean trees', () => {
  const home = tempDir('kstore-commit-');
  const ws = gitWorkspace('https://github.com/x/commit.git');
  const { dir } = ensureStore(ws, { home });
  const first = commitStore(dir, 'consolidate: seed');
  assert.equal(first.committed, true);
  const second = commitStore(dir, 'consolidate: nothing');
  assert.equal(second.committed, false);
});

test('normalizeSlug lowercases, strips, and NFC-normalizes', () => {
  assert.equal(normalizeSlug('NOT NULL Cols!'), 'not-null-cols');
  assert.equal(normalizeSlug('Café Münü'), 'cafe-munu');
  assert.equal(normalizeSlug('--x--'), 'x');
});
