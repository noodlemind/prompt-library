import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUNG_IDS, runLadder } from '../eval/adaptive/ladder.mjs';

test('adaptive ladder drives the harness CLI through trust, orient, verify, and the implementer loop', { timeout: 180_000 }, () => {
  const report = runLadder();
  const failed = report.results.filter((row) => !row.ok);
  assert.deepEqual(report.results.map((row) => row.id), RUNG_IDS);
  assert.equal(
    failed.length,
    0,
    failed.map((row) => `${row.id}\n${row.evidence.error}`).join('\n\n'),
  );
  const gaps = Object.fromEntries(report.results.map((row) => [row.id, row.evidence.gap]));
  assert.equal(gaps['verify-omission-stays-passed'], 'omission-stays-passed');
  assert.equal(gaps['verify-instruction-stays-passed'], 'instruction-is-not-a-diff-predicate');
});
