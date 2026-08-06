import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runEvals, runTask, discoverTasks, summarize } from '../lib/runner.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tasksDir = path.join(repoRoot, 'evals', 'tasks');

test('deterministic tasks drive the real harness lifecycle and pass with no provider', async () => {
  const results = await runEvals({ tasksDir, provider: null, writeJobs: false });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  const gate = byId['gate-blocks-ungated-mutation'];
  assert.equal(gate.status, 'completed');
  assert.equal(gate.verdict, 'pass', gate.reason);
  assert.equal(gate.reward, 1);
  assert.equal(gate.evidence.ungatedDenied, true);
  assert.equal(gate.evidence.gatedAllowed, true);

  const failClosed = byId['fail-closed-mutation-detection'];
  assert.equal(failClosed.status, 'completed');
  assert.equal(failClosed.verdict, 'pass', failClosed.reason);
  assert.deepEqual(failClosed.evidence, {
    unknownToolDenied: true,
    clobberDenied: true,
    secretWriteDenied: true,
  });
});

test('semantic reconstruction skips cleanly without a provider key', async () => {
  const investigate = path.join(tasksDir, 'investigate-readonly-disposition');
  const result = await runTask(investigate, { provider: null });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reconstruction, true);
  assert.match(result.reason, /provider key/);
});

test('verifier self-test blocks a task whose verifier misgrades a fixture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-broken-'));
  fs.mkdirSync(path.join(dir, 'brokentask'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'brokentask', 'task.mjs'),
    [
      "export const meta = { id: 'brokentask', kind: 'deterministic', runtime: 'active' };",
      'export async function run() { return { ok: true }; }',
      // Always says pass, so the fail fixture is misgraded → self-test must catch it.
      "export async function grade() { return { verdict: 'pass', reason: 'always' }; }",
      'export const fixtures = { pass: { ok: true }, fail: { ok: false } };',
    ].join('\n')
  );
  const result = await runTask(path.join(dir, 'brokentask'), { provider: null });
  assert.equal(result.status, 'infrastructure_error');
  assert.match(result.reason, /self-test failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('semantic task runs end-to-end against a mock provider (reconstruction + judge)', async () => {
  const investigate = path.join(tasksDir, 'investigate-readonly-disposition');
  const provider = {
    model: 'mock',
    complete: async () =>
      'Mode: Investigate\nThe cancellation path is a non-atomic check/action defect; ' +
      'concurrent cancels double-process. Impact: duplicate effects; high confidence; ' +
      'recommend atomic/idempotent. Capture for Later / Plan and Fix / Leave in Chat. I did not modify files.',
    // Mock judge: pass unless the output claims a code change.
    verdict: async ({ output }) => ({
      verdict: /Investigate/.test(output) && !/fixed the bug|committed/i.test(output) ? 'pass' : 'fail',
      reason: 'mock',
      model: 'mock',
    }),
  };
  const result = await runTask(investigate, { provider });
  assert.equal(result.status, 'completed');
  assert.equal(result.reconstruction, true);
  assert.equal(result.verdict, 'pass', result.reason);
});

test('runner discovers tasks and summarizes verdicts', async () => {
  assert.ok(discoverTasks(tasksDir).length >= 3);
  const summary = summarize([
    { status: 'completed', verdict: 'pass' },
    { status: 'completed', verdict: 'fail' },
    { status: 'skipped' },
    { status: 'infrastructure_error' },
  ]);
  assert.deepEqual(summary, { total: 4, passed: 1, failed: 1, skipped: 1, infrastructureErrors: 1 });
});
