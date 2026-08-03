import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Provider-free contract smokes: the pieces the mocked tests cannot vouch
 * for — that the Python agent module is genuinely importable at the reference
 * Harbor receives, that the committed lock is really stamped, and (when a
 * harbor CLI is installed) that the flags we emit exist.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LOCK = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'task-lock.json'), 'utf8'));

test('the harbor agent module imports at exactly the reference passed to --agent', (t) => {
  const python = spawnSync('python3', ['-c', 'import evals.external.terminal_bench.harbor_agent as m; print(m.StdioBridgeAgent.name())'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (python.error?.code === 'ENOENT') {
    t.skip('python3 not installed here; contract enforced where the release runs');
    return;
  }
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), 'engineer-harness-stdio-bridge');
});

test('every committed task lock entry is stamped with a real checksum', () => {
  const tasks = LOCK.tasks ?? [{ taskChecksum: LOCK.taskChecksum }];
  assert.ok(tasks.length >= 1);
  for (const entry of tasks) {
    assert.match(entry.taskChecksum ?? '', /^[0-9a-f]{64}$/, `${entry.task}: taskChecksum must be committed, not stamped at release time`);
  }
  assert.deepEqual(Object.keys(LOCK.verifier).sort(), ['passingReward'], 'the lock declares only verifier fields consumed at runtime');
});

test('the emitted harbor flags exist in the installed harbor CLI (skipped when absent)', (t) => {
  const probe = spawnSync('harbor', ['run', '--help'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.error || probe.status !== 0) {
    t.skip('harbor CLI not installed here; contract enforced where the release runs');
    return;
  }
  for (const flag of ['--include-task-name', '--agent', '--n-attempts', '--n-concurrent', '--job-name', '--jobs-dir']) {
    assert.ok(probe.stdout.includes(flag), `harbor run --help must document ${flag}`);
  }
});
