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

/**
 * Temporal contamination guard: a learning derived ONLY from a held-out
 * (post-cutoff) episode must never be surfaced or billed by any arm, even
 * when its trigger is engineered to dominate a held-out query's ranking.
 * 4 train episodes (same category, dated on/before the cutoff) + 2 held-out
 * episodes (post-cutoff); one clean learning linked only to a train episode,
 * one "leak" learning linked only to a held-out episode.
 */
function seedContaminationFixture() {
  const ws = tempDir('evalk-leak-ws-');
  const home = tempDir('evalk-leak-home-');

  const train1 = writeEpisode(ws, 'auth', 'auth-1', { title: 'Auth token refresh race condition', tags: ['auth', 'token'], date: '2026-01-01' });
  writeEpisode(ws, 'auth', 'auth-2', { title: 'Auth cookie domain mismatch', tags: ['auth', 'cookie'], date: '2026-01-02' });
  writeEpisode(ws, 'auth', 'auth-3', { title: 'Auth scope validation gap', tags: ['auth', 'scope'], date: '2026-01-03' });
  writeEpisode(ws, 'auth', 'auth-4', { title: 'Auth redirect allowlist bug', tags: ['auth', 'redirect'], date: '2026-01-04' });
  const heldOut1 = writeEpisode(ws, 'auth', 'auth-5', {
    title: 'Auth token refresh regression leak marker',
    tags: ['auth', 'token', 'leak', 'marker'],
    date: '2026-03-01',
  });
  writeEpisode(ws, 'auth', 'auth-6', { title: 'Auth billing rotation issue', tags: ['auth', 'rotation'], date: '2026-03-02' });

  ensureStore(ws, { home });
  const cleanTrigger = 'auth token refresh race condition';
  const cleanBody = 'Retry the token refresh exactly once behind a per-session lock.';
  // The leak trigger/body are engineered to overlap heavily with the
  // auth-5 held-out query and are padded (within the learning byte cap) so,
  // if it leaked into an arm's results, it would dominate that arm's
  // injected-token bill.
  const leakTrigger = `auth token refresh regression leak marker ${'padding '.repeat(60)}`.trim();
  const leakBody = 'This must never surface.';

  const opsPath = writeOps(ws, [
    {
      op: 'ADD',
      domain: 'auth',
      slug: 'token-refresh-clean',
      trigger: cleanTrigger,
      body: cleanBody,
      episodes: [{ path: train1.path, sha256: train1.sha256, kind: 'fix', plan: 'docs/plans/p1.md' }],
    },
    {
      op: 'ADD',
      domain: 'auth',
      slug: 'token-refresh-leak',
      trigger: leakTrigger,
      body: leakBody,
      episodes: [{ path: heldOut1.path, sha256: heldOut1.sha256, kind: 'fix', plan: 'docs/plans/p1.md' }],
    },
  ]);
  const applied = applyOps({ workspace: ws, opsPath, home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  return { ws, home, cleanTrigger };
}

test('evalKnowledge never surfaces or bills a learning linked only to a held-out episode', () => {
  const { ws, home, cleanTrigger } = seedContaminationFixture();
  const result = evalKnowledge({ workspace: ws, copilotHome: ws, home, negativeQueries: DEFAULT_NEGATIVE_QUERIES });

  assert.equal(result.pass, true);
  assert.equal(result.split.train, 4);
  assert.equal(result.split.heldOut, 2);

  // The clean, pre-cutoff learning still surfaces normally — the fix must
  // not collaterally suppress legitimate ranking.
  assert.equal(result.arms.bm25.hitRate, 1);
  assert.equal(result.arms.wholeIndex.hitRate, 1);

  // wholeIndex bills only the pre-cutoff learning's trigger bytes — the
  // leak learning's (much larger) trigger must contribute nothing.
  const expectedWholeIndexTokens = Math.ceil(Buffer.byteLength(cleanTrigger, 'utf8') / 4);
  assert.equal(result.arms.wholeIndex.injectedTokens, expectedWholeIndexTokens);

  // bm25's per-query byte bill stays small — if the leak learning (padded
  // to hundreds of bytes) had surfaced for even one held-out query, this
  // would blow well past a small bound.
  assert.ok(
    result.arms.bm25.injectedTokens < 60,
    `expected bm25 injectedTokens to reflect only the clean learning, got ${result.arms.bm25.injectedTokens}`
  );
});

test('evalKnowledge excludes a promoted learning from its arms (shares the production eligibility gate)', () => {
  const ws = tempDir('evalk-promoted-ws-');
  const home = tempDir('evalk-promoted-home-');

  const train1 = writeEpisode(ws, 'auth', 'auth-1', { title: 'Auth token refresh race condition', tags: ['auth', 'token'], date: '2026-01-01' });
  const train2 = writeEpisode(ws, 'auth', 'auth-2', { title: 'Auth cookie domain mismatch', tags: ['auth', 'cookie'], date: '2026-01-02' });
  writeEpisode(ws, 'auth', 'auth-3', { title: 'Auth scope validation gap', tags: ['auth', 'scope'], date: '2026-01-03' });
  writeEpisode(ws, 'auth', 'auth-4', { title: 'Auth redirect allowlist bug', tags: ['auth', 'redirect'], date: '2026-01-04' });
  writeEpisode(ws, 'auth', 'auth-5', { title: 'Auth token refresh regression', tags: ['auth', 'token'], date: '2026-03-01' });
  writeEpisode(ws, 'auth', 'auth-6', { title: 'Auth billing rotation issue', tags: ['auth', 'rotation'], date: '2026-03-02' });

  const cleanTrigger = 'auth token refresh race condition';
  // The promoted learning's trigger is padded (within the byte cap) so, if it
  // were counted, it would visibly dominate wholeIndex's token bill.
  const promotedTrigger = `auth token cookie session ${'padding '.repeat(50)}`.trim();

  const { dir } = ensureStore(ws, { home });
  const opsPath = writeOps(ws, [
    { op: 'ADD', domain: 'auth', slug: 'token-refresh-clean', trigger: cleanTrigger, body: 'Retry the token refresh exactly once behind a per-session lock.', episodes: [{ path: train1.path, sha256: train1.sha256, kind: 'fix', plan: 'docs/plans/p1.md' }] },
    { op: 'ADD', domain: 'auth', slug: 'cookie-promoted', trigger: promotedTrigger, body: 'This claim was promoted into a primitive.', episodes: [{ path: train2.path, sha256: train2.sha256, kind: 'fix', plan: 'docs/plans/p1.md' }] },
  ]);
  assert.equal(applyOps({ workspace: ws, opsPath, home }).exitCode, 0);

  // Record the second learning as promoted — production rankLearnings excludes
  // it, so the eval (sharing retrievalExclusion) must exclude it too.
  const promotedFile = path.join(dir, 'learnings', 'auth', 'cookie-promoted.md');
  const before = fs.readFileSync(promotedFile, 'utf8');
  fs.writeFileSync(promotedFile, before.replace(/^---\n/, '---\npromoted_to: auth/cookie-primitive\n'), 'utf8');

  const result = evalKnowledge({ workspace: ws, copilotHome: ws, home, negativeQueries: DEFAULT_NEGATIVE_QUERIES });
  assert.equal(result.pass, true);
  // wholeIndex bills only the non-promoted learning's trigger bytes.
  const expected = Math.ceil(Buffer.byteLength(cleanTrigger, 'utf8') / 4);
  assert.equal(result.arms.wholeIndex.injectedTokens, expected, 'a promoted learning must not be counted or billed by eval');
});

test('bm25 arm reports a nonzero falseSurfaceRate when a negative query genuinely overlaps a learning trigger', () => {
  const ws = tempDir('evalk-false-ws-');
  const home = tempDir('evalk-false-home-');

  const e1 = writeEpisode(ws, 'infra', 'infra-1', {
    title: 'Database connection pool exhaustion timeout',
    tags: ['infra', 'database'],
    date: '2026-01-01',
  });
  writeEpisode(ws, 'infra', 'infra-2', { title: 'Infra disk usage alert', tags: ['infra'], date: '2026-01-02' });
  writeEpisode(ws, 'infra', 'infra-3', { title: 'Infra log rotation gap', tags: ['infra'], date: '2026-01-03' });
  writeEpisode(ws, 'infra', 'infra-4', { title: 'Infra deploy rollback delay', tags: ['infra'], date: '2026-01-04' });

  ensureStore(ws, { home });
  const trigger = 'database connection pool exhaustion timeout';
  const opsPath = writeOps(ws, [
    {
      op: 'ADD',
      domain: 'infra',
      slug: 'connection-pool-exhaustion',
      trigger,
      body: 'Cap pool size and add a queue timeout so callers fail fast instead of piling up.',
      episodes: [{ path: e1.path, sha256: e1.sha256, kind: 'fix', plan: 'docs/plans/p1.md' }],
    },
  ]);
  const applied = applyOps({ workspace: ws, opsPath, home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  // Crafted to score well above MIN_SCORE (0.15): every token overlaps the
  // learning's own trigger, so this "unrelated topic" negative query is in
  // fact a genuine (if contrived) trigger match — the real scoring branch,
  // not a synthetic override.
  const negativeQuery = 'database connection pool exhaustion timeout';
  const result = evalKnowledge({ workspace: ws, copilotHome: ws, home, negativeQueries: [negativeQuery] });

  assert.equal(result.pass, true);
  assert.ok(result.arms.bm25.falseSurfaceRate > 0, JSON.stringify(result.arms));
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
  // P1.6: eval-knowledge is now dispatched through the shared command
  // registry, which brackets every registered command's dispatch with
  // command.start/command.result telemetry (uniform CLI observability) —
  // so events.jsonl now exists. `cmdEvalKnowledge`'s own business logic is
  // still exactly as read-only as before: it never calls writeEvent for a
  // dedicated 'eval-knowledge'-type lifecycle event, which is what this
  // assertion actually protects against.
  if (fs.existsSync(path.join(ws, '.harness', 'events.jsonl'))) {
    const types = fs
      .readFileSync(path.join(ws, '.harness', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).type);
    assert.ok(
      types.every((type) => type === 'command.start' || type === 'command.result'),
      `eval-knowledge must never write its own dedicated lifecycle event: ${types.join(', ')}`
    );
  }

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
