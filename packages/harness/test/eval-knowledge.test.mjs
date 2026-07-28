import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { evalKnowledge, DEFAULT_NEGATIVE_QUERIES } from '../lib/knowledge/eval.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { ensureStore } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function writeEpisode(ws, category, slug, { title, tags = [], date }) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `title: "${title}"`];
  if (tags.length) lines.push(`tags: ${tags.join(', ')}`);
  if (date) lines.push(`date: ${date}`);
  lines.push('---', '', `## Problem`, '', `${title} details.`, '');
  const text = lines.join('\n');
  fs.writeFileSync(path.join(dir, `${slug}.md`), text, 'utf8');
  return {
    path: `docs/solutions/${category}/${slug}.md`,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

function writeOps(ws, ops) {
  const p = path.join(ws, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

/**
 * 4 train + 2 held-out episodes across two categories, one learning
 * (auth) with a ledger-linked train episode — the other category (billing)
 * gets no learning, so its held-out episode is unscorable.
 */
function seedSplitFixture() {
  const ws = tempDir('evalk-ws-');
  const home = tempDir('evalk-home-');

  const auth1 = writeEpisode(ws, 'auth', 'auth-1', {
    title: 'Auth token refresh race condition',
    tags: ['auth', 'token', 'refresh'],
    date: '2026-01-01',
  });
  writeEpisode(ws, 'auth', 'auth-2', {
    title: 'Auth session expiry bug',
    tags: ['auth', 'session'],
    date: '2026-01-02',
  });
  writeEpisode(ws, 'billing', 'billing-1', {
    title: 'Billing invoice rounding error',
    tags: ['billing', 'invoice', 'rounding'],
    date: '2026-01-03',
  });
  writeEpisode(ws, 'billing', 'billing-2', {
    title: 'Billing webhook retry duplicate',
    tags: ['billing', 'webhook'],
    date: '2026-01-04',
  });
  writeEpisode(ws, 'auth', 'auth-3', {
    title: 'Auth token refresh regression',
    tags: ['auth', 'token'],
    date: '2026-03-01',
  });
  writeEpisode(ws, 'billing', 'billing-3', {
    title: 'Billing invoice rounding regression',
    tags: ['billing', 'invoice'],
    date: '2026-03-02',
  });

  ensureStore(ws, { home });
  const opsPath = writeOps(ws, [
    {
      op: 'ADD',
      domain: 'auth',
      slug: 'token-refresh-race',
      trigger: 'auth token refresh race condition',
      body: 'Serialize refresh calls behind a per-session lock so concurrent requests do not double-refresh the token.',
      episodes: [{ path: auth1.path, sha256: auth1.sha256, kind: 'fix', plan: 'docs/plans/p1.md' }],
    },
  ]);
  const applied = applyOps({ workspace: ws, opsPath, home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  return { ws, home };
}

test('evalKnowledge splits 4 train / 2 held-out, scores bm25 a clean hit, and stays false-surface free', () => {
  const { ws, home } = seedSplitFixture();
  const result = evalKnowledge({ workspace: ws, copilotHome: ws, home, negativeQueries: DEFAULT_NEGATIVE_QUERIES });

  assert.equal(result.pass, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.split.train, 4);
  assert.equal(result.split.heldOut, 2);
  assert.equal(result.split.undated, 0);
  // billing's held-out episode has no linked learning — unscorable; auth's does.
  assert.equal(result.split.unscorable, 1);

  assert.equal(result.arms.none.hitRate, 0);
  assert.equal(result.arms.none.falseSurfaceRate, 0);
  assert.equal(result.arms.none.injectedTokens, 0);

  assert.equal(result.arms.bm25.hitRate, 1);
  assert.equal(result.arms.bm25.falseSurfaceRate, 0);

  assert.ok(result.arms.wholeIndex.injectedTokens > 0);
  assert.equal(result.arms.wholeIndex.hitRate, 1);

  for (const arm of ['frontmatter', 'wholeIndex', 'bm25']) {
    assert.equal(result.arms[arm].falseSurfaceRate, 0, `${arm} should not false-surface on unrelated negative queries`);
  }

  assert.ok(['whole-index', 'bm25-top3'].includes(result.recommendation));
});

test('evalKnowledge blocks with exit 2 when fewer than 4 dated episodes exist', () => {
  const ws = tempDir('evalk-few-ws-');
  const home = tempDir('evalk-few-home-');
  writeEpisode(ws, 'auth', 'auth-1', { title: 'One dated episode', tags: ['auth'], date: '2026-01-01' });
  writeEpisode(ws, 'auth', 'auth-2', { title: 'Undated episode' });
  ensureStore(ws, { home });

  const result = evalKnowledge({ workspace: ws, copilotHome: ws, home, negativeQueries: DEFAULT_NEGATIVE_QUERIES });
  assert.equal(result.pass, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.blockedReason, 'need ≥4 dated episodes for a split');
});

test('evalKnowledge is read-only: a missing store blocks cleanly instead of creating one', () => {
  const ws = tempDir('evalk-nostore-ws-');
  const home = tempDir('evalk-nostore-home-');
  writeEpisode(ws, 'auth', 'a', { title: 'a', date: '2026-01-01' });
  writeEpisode(ws, 'auth', 'b', { title: 'b', date: '2026-01-02' });
  writeEpisode(ws, 'auth', 'c', { title: 'c', date: '2026-01-03' });
  writeEpisode(ws, 'auth', 'd', { title: 'd', date: '2026-01-04' });

  const result = evalKnowledge({ workspace: ws, copilotHome: ws, home, negativeQueries: DEFAULT_NEGATIVE_QUERIES });
  assert.equal(result.pass, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.blockedReason, 'no knowledge store — nothing to evaluate');
  assert.equal(fs.existsSync(path.join(home, 'knowledge')), false, 'a storeless eval must never create the store');
});

test('harness eval-knowledge CLI renders per-arm lines and a recommendation, and is read-only', () => {
  const { ws, home } = seedSplitFixture();
  const res = spawnSync(
    process.execPath,
    [binPath, 'eval-knowledge', '--workspace', ws, '--copilot-home', ws, '--json'],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: home } }
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, true);
  assert.ok(out.arms.bm25.hitRate >= 0.5);
  assert.ok(['whole-index', 'bm25-top3'].includes(out.recommendation));
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'events.jsonl')), false, 'read-only command must not write events');

  const human = spawnSync(process.execPath, [binPath, 'eval-knowledge', '--workspace', ws, '--copilot-home', ws], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: home },
  });
  assert.equal(human.status, 0, human.stderr || human.stdout);
  assert.match(human.stdout, /bm25/);
  assert.match(human.stdout, /recommendation/);
  assert.match(human.stdout, /proxy/i);
});

test('harness eval-knowledge CLI exits 2 with a blocked reason when there is no store', () => {
  const ws = tempDir('evalk-cli-nostore-ws-');
  const home = tempDir('evalk-cli-nostore-home-');
  const res = spawnSync(
    process.execPath,
    [binPath, 'eval-knowledge', '--workspace', ws, '--copilot-home', ws, '--json'],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: home } }
  );
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, false);
  assert.match(out.blockedReason, /no knowledge store/);
});
