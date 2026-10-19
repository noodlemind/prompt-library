/**
 * Search ledger display: no raw --cursor, compact skips, numbered hits.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSearchLedger, SEARCH_LEDGER_PREVIEW } from '../lib/retrieval/search-cmd.mjs';

function sampleResult(overrides = {}) {
  const results = Array.from({ length: 12 }, (_, i) => ({
    source: 'code',
    location: `lib/file${i}.mjs:${i + 1}`,
    title: `file${i}.mjs`,
    id: `id-${i}`,
    score: 1 - i * 0.01,
  }));
  return {
    total: 30,
    match: 'ranked',
    results,
    truncated: true,
    nextCursor: 'eyJ2IjoiMSIsImV4cCI6ImZha2UifQ',
    sources: [
      { source: 'code', status: 'ok' },
      { source: 'learnings', status: 'skipped', reason: 'no knowledge store for this workspace' },
      { source: 'plans', status: 'skipped', reason: 'no docs/plans directory in this workspace' },
    ],
    ...overrides,
  };
}

test('formatSearchLedger never prints raw --cursor tokens by default', () => {
  const lines = formatSearchLedger(sampleResult(), { compact: true });
  const text = JSON.stringify(lines);
  assert.doesNotMatch(text, /--cursor/);
  assert.doesNotMatch(text, /eyJ2Ijo/);
  assert.ok(lines.some((l) => l.key === 'more'));
  assert.match(lines.find((l) => l.key === 'more').value, /next page/i);
});

test('formatSearchLedger collapses skipped sources into one line', () => {
  const lines = formatSearchLedger(sampleResult(), { compact: true });
  const skips = lines.filter((l) => l.key === 'skipped');
  assert.equal(skips.length, 1);
  assert.match(skips[0].value, /learnings/);
  assert.match(skips[0].value, /plans/);
  assert.ok(!lines.some((l) => l.key === 'learnings' || l.key === 'plans'));
});

test('formatSearchLedger numbers hits and caps the compact page', () => {
  const lines = formatSearchLedger(sampleResult(), { compact: true, preview: SEARCH_LEDGER_PREVIEW });
  const hits = lines.filter((l) => /^\d+$/.test(l.key));
  assert.equal(hits.length, SEARCH_LEDGER_PREVIEW);
  assert.equal(hits[0].key, '1');
  assert.ok(lines.some((l) => l.key === 'shown'));
});

test('formatSearchLedger verbose still can show cursor without --cursor flag soup as the primary value', () => {
  const lines = formatSearchLedger(sampleResult(), { verbose: true, compact: false });
  const more = lines.find((l) => l.key === 'more');
  assert.ok(more);
  assert.doesNotMatch(more.value, /^--cursor/);
  const cursor = lines.find((l) => l.key === 'cursor');
  assert.ok(cursor, 'verbose may expose the token on its own key for power users');
});
