import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPerformancePilot } from './helpers/performance-pilot.mjs';

test('real CLI domain pilot links two perspectives, measurements and authoring/review context', { timeout: 60_000 }, () => {
  const receipt = runPerformancePilot();
  assert.equal(receipt.cleanup, true);
  assert.deepEqual([receipt.measurement.before, receipt.measurement.after], [12, 1]);
});
