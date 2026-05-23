import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idf, termScore, scoreDocuments, normalizeScores } from '../lib/bm25.mjs';

test('idf increases as document frequency decreases', () => {
  const rare = idf(100, 1);
  const common = idf(100, 50);
  assert.ok(rare > common);
});

test('termScore respects document length normalization', () => {
  const short = termScore(3, 10, 50, idf(10, 2));
  const long = termScore(3, 90, 50, idf(10, 2));
  assert.ok(short > long);
});

test('scoreDocuments ranks matching doc higher', () => {
  const index = {
    N: 2,
    avgdl: 5,
    docLengths: { a: 4, b: 6 },
    terms: {
      timeout: { a: 3, b: 0 },
      orders: { a: 2, b: 1 },
    },
  };
  const scores = normalizeScores(scoreDocuments(['timeout', 'orders'], index));
  assert.ok(scores.get('a') > scores.get('b'));
});

test('normalizeScores caps max at 1', () => {
  const scores = new Map([
    ['a', 2.5],
    ['b', 1.0],
  ]);
  const norm = normalizeScores(scores);
  assert.equal(norm.get('a'), 1);
  assert.equal(norm.get('b'), 0.4);
});
