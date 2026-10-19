import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SOURCES,
  SCORE_PRECISION,
  createRetrievalResult,
  normalizeSourceScores,
  compareResults,
  resultIdentity,
  encodeCursor,
  decodeCursor,
  federate,
} from '../lib/retrieval/kernel.mjs';

const r = (source, id, score, extra = {}) => createRetrievalResult({ source, id, score, ...extra });

test('createRetrievalResult rejects a result that cannot be identified', () => {
  assert.throws(() => createRetrievalResult({ source: 'nope', id: 'a' }), /unknown source/);
  assert.throws(() => createRetrievalResult({ source: 'code', id: '' }), /id \(non-empty string\) is required/);
  assert.throws(() => createRetrievalResult({ source: 'code', id: 'a', score: NaN }), /finite number/);
});

test('createRetrievalResult redacts free-text fields but leaves code-set tokens alone', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const out = createRetrievalResult({
    source: 'knowledge',
    scope: 'product',
    id: `doc-${secret}`,
    location: `/tmp/${secret}`,
    title: `title ${secret}`,
    snippet: `snippet ${secret}`,
    reason: `matched ${secret}`,
    kind: 'solution',
    score: 1,
    generation: 'gen-1',
  });
  for (const field of ['id', 'location', 'title', 'snippet', 'reason']) {
    assert.doesNotMatch(out[field], /ghp_abcdefghij/, `${field} must be redacted at the data boundary`);
  }
  assert.equal(out.scope, 'product', 'scope is a code-set enum, not free text');
  assert.equal(out.kind, 'solution');
  assert.equal(out.generation, 'gen-1');
});

test('source and scope are independent axes', () => {
  const out = r('knowledge', 'a', 1, { scope: 'global' });
  assert.equal(out.source, 'knowledge', 'source is the corpus');
  assert.equal(out.scope, 'global', 'scope stays the knowledge-root qualifier');
});

test('normalizeSourceScores is max-relative and survives an all-zero source', () => {
  const scored = normalizeSourceScores([r('code', 'a', 4), r('code', 'b', 2), r('code', 'c', 1)]);
  assert.deepEqual(scored.map((x) => x.score), [1, 0.5, 0.25], 'best hit anchors at 1, spread preserved');
  assert.deepEqual(scored.map((x) => x.sourceScore), [4, 2, 1], 'the native score is retained for --explain');

  const zeros = normalizeSourceScores([r('code', 'a', 0), r('code', 'b', 0)]);
  assert.deepEqual(zeros.map((x) => x.score), [0, 0], 'a zero max must not divide by zero');
});

test('compareResults is a total order — score, then source rank, then id', () => {
  const a = { score: 0.5, source: 'code', id: 'x' };
  const b = { score: 0.5, source: 'knowledge', id: 'a' };
  assert.ok(compareResults(a, b) < 0, 'equal scores fall to source rank, and code precedes knowledge');

  const c = { score: 0.5, source: 'code', id: 'a' };
  assert.ok(compareResults(a, c) > 0, 'same score and source fall to id');
  assert.equal(compareResults(a, { ...a }), 0, 'identical positions compare equal');
});

test('federate is deterministic: the same input yields byte-identical output', () => {
  const build = () => ({
    sources: [
      { source: 'knowledge', generation: 'g1', results: [r('knowledge', 'k1', 3), r('knowledge', 'k2', 3)] },
      { source: 'code', generation: 'g2', results: [r('code', 'c1', 9), r('code', 'c2', 3)] },
      { source: 'plans', generation: null, results: [r('plans', 'p1', 1)] },
    ],
    limit: 10,
  });
  const first = JSON.stringify(federate(build()));
  const second = JSON.stringify(federate(build()));
  assert.equal(first, second, 'same query + same generation must be byte-identical');

  // And the ordering is the documented one, not incidental.
  const { results } = federate(build());
  assert.deepEqual(
    results.map((x) => `${x.source}:${x.id}`),
    ['code:c1', 'knowledge:k1', 'knowledge:k2', 'plans:p1', 'code:c2'],
    'top hit per source normalizes to 1.0; ties break by source rank then id',
  );
});

test('federate dedupes on (source, id) and leaves distinct sources sharing an id alone', () => {
  const out = federate({
    sources: [
      { source: 'code', results: [r('code', 'same', 5), r('code', 'same', 1)] },
      { source: 'plans', results: [r('plans', 'same', 5)] },
    ],
  });
  assert.equal(out.results.filter((x) => x.source === 'code').length, 1, 'a repeated (source,id) collapses');
  assert.equal(out.results.length, 2, 'the same id in a different corpus is a different entity');
    const [a, b] = [r('code', 'x y'), r('code', 'x')];
  assert.notEqual(resultIdentity(a), resultIdentity(b));
  assert.ok(resultIdentity(a).startsWith('code'));
  assert.ok(resultIdentity(a).endsWith('x y'));
});

test('federate reports a failed source instead of dropping it', () => {
  const out = federate({
    sources: [
      { source: 'code', results: [r('code', 'c1', 1)] },
      { source: 'learnings', status: 'failed', reason: 'store unreadable' },
      { source: 'plans', status: 'skipped', reason: 'no plans directory' },
    ],
  });
  assert.equal(out.partial, true, 'a failed source makes the result set explicitly partial');
  const failed = out.sources.find((s) => s.source === 'learnings');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'store unreadable');
  const skipped = out.sources.find((s) => s.source === 'plans');
  assert.equal(skipped.status, 'skipped');
  assert.equal(out.results.length, 1, 'only the healthy source contributes rows');
});

test('federate rejects an unknown source or status rather than guessing', () => {
  assert.throws(() => federate({ sources: [{ source: 'wat', results: [] }] }), /unknown source/);
  assert.throws(() => federate({ sources: [{ source: 'code', status: 'maybe' }] }), /unknown status/);
});

test('cursors page without repeating or skipping a row', () => {
  const sources = () => [
    { source: 'code', generation: 'g1', results: [r('code', 'a', 5), r('code', 'b', 4), r('code', 'c', 3)] },
    { source: 'plans', generation: 'g2', results: [r('plans', 'd', 5), r('plans', 'e', 1)] },
  ];
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const out = federate({ sources: sources(), limit: 2, cursor });
    seen.push(...out.results.map((x) => `${x.source}:${x.id}`));
    cursor = out.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, new Set(seen).size, 'no row is served twice');
  assert.equal(seen.length, 5, 'every row is served exactly once');

  const all = federate({ sources: sources(), limit: 100 });
  assert.deepEqual(seen, all.results.map((x) => `${x.source}:${x.id}`), 'paging preserves the unpaged order');
});

test('a cursor carries the generations it was issued against', () => {
  const out = federate({
    sources: [{ source: 'code', generation: 'gen-abc', results: [r('code', 'a', 1), r('code', 'b', 1)] }],
    limit: 1,
  });
  assert.deepEqual(decodeCursor(out.nextCursor).generations, { code: 'gen-abc' });
  assert.deepEqual(out.generations, { code: 'gen-abc' }, 'the response states what it was read at');
});

test('a malformed cursor is a usage error, never a silent restart from the top', () => {
  for (const bad of ['not-base64!!', Buffer.from('{"v":999}', 'utf8').toString('base64url')]) {
    assert.throws(() => federate({ sources: [], cursor: bad }), (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /invalid --cursor/);
      return true;
    });
  }
  assert.equal(decodeCursor(null), null, 'no cursor is not an error');
});

test('a cursor pointing past every remaining row yields an empty page, not a restart', () => {
  const cursor = encodeCursor({ score: 0, source: 'plans', id: 'zzz', generations: {} });
  const out = federate({ sources: [{ source: 'code', results: [r('code', 'a', 1)] }], cursor });
  assert.deepEqual(out.results, [], 'nothing is re-served');
  assert.equal(out.nextCursor, null);
});

test('an empty federation is a valid empty result set, not an error', () => {
  const out = federate({ sources: [] });
  assert.deepEqual(out.results, []);
  assert.equal(out.total, 0);
  assert.equal(out.partial, false);
  assert.equal(out.nextCursor, null);
});

test('SOURCES order is the published tie-break contract', () => {
  assert.deepEqual([...SOURCES], ['code', 'knowledge', 'learnings', 'plans']);
  assert.equal(SCORE_PRECISION, 6);
});
