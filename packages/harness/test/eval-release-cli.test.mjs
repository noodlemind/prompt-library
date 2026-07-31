import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stampTaskLock } from '../../../evals/external/terminal_bench/harbor-adapter.mjs';

/**
 * True end-to-end: `node evals/release.mjs` in release-candidate mode against
 * a fake harbor CLI on PATH. No injected steps — this exercises main(), flag
 * parsing, live-step wiring, task verification, budget accounting, and the
 * gate, exactly as an operator would run it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASE_LOCK = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'task-lock.json'), 'utf8'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-'));
}

function setupFixture() {
  const taskDir = tmpdir();
  fs.writeFileSync(path.join(taskDir, 'instruction.md'), 'Modernize the COBOL program.');
  const lockFile = path.join(tmpdir(), 'lock.json');
  fs.writeFileSync(lockFile, JSON.stringify(stampTaskLock(taskDir, BASE_LOCK)));

  const binDir = tmpdir();
  const fakeHarbor = path.join(binDir, 'fake-harbor.mjs');
  fs.writeFileSync(
    fakeHarbor,
    `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.20.0'); process.exit(0); }
if (args[0] !== 'run') process.exit(0);
const jobsDir = args[args.indexOf('--jobs-dir') + 1];
const jobName = args[args.indexOf('--job-name') + 1];
const agentEnv = {};
args.forEach((a, i) => { if (a === '--ae') { const [k, ...r] = args[i + 1].split('='); agentEnv[k] = r.join('='); } });
const verifierDir = path.join(jobsDir, jobName, 'trial-0', 'artifacts', 'logs', 'verifier');
fs.mkdirSync(verifierDir, { recursive: true });
fs.writeFileSync(path.join(verifierDir, 'reward.json'), '{"reward": 1}');
fs.writeFileSync(agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE, JSON.stringify({
  type: 'done', answer: 'ok', stopReason: 'model_finish', steps: 6,
  telemetry: {
    totals: { requests: 4, missingUsage: 0, promptTokens: 3000, cachedTokens: 500, reasoningTokens: 0, outputTokens: 700, localCostUsd: 0.015, providerCostUsd: 0.02, costComplete: true },
    events: [{ seq: 0, type: 'response', model: 'moonshotai/kimi-k2.7-code', provider: 'Moonshot AI', generationId: 'g1' }],
  },
}));
process.exit(0);
`
  );
  fs.writeFileSync(path.join(binDir, 'harbor'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeHarbor)} "$@"\n`, { mode: 0o755 });
  return { taskDir, lockFile, binDir, bundleDir: tmpdir() };
}

function runCli({ taskDir, lockFile, binDir, bundleDir, withKey = true }) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    HARNESS_EVAL_TB_TASK_DIR: taskDir,
    HARNESS_EVAL_TB_BUNDLE_DIR: bundleDir,
  };
  if (withKey) env.OPENROUTER_API_KEY = 'test-key';
  else delete env.OPENROUTER_API_KEY;
  return spawnSync(process.execPath, ['evals/release.mjs', '--profile', 'release-canary', '--json', '--lock-file', lockFile], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 600_000,
  });
}

test('release-candidate mode runs a live kimi pair end to end through the CLI', () => {
  const fixture = setupFixture();
  const result = runCli(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const kimi = report.pairs.find((p) => p.host === 'openrouter-kimi');
  assert.equal(kimi.result, 'parity');
  assert.equal(kimi.generic.correctness.verdict, 'pass');
  assert.equal(kimi.harness.correctness.verdict, 'pass');
  assert.equal(kimi.generic.efficiency.promptTokens, 3000, 'live docs carry real metered telemetry');
  assert.ok(Math.abs(report.budget.spentUsd - 0.04) < 1e-12, 'provider-reported spend reaches the release ledger');
  assert.equal(report.gate.block, false);
});

test('release-candidate mode without credentials blocks instead of greening', () => {
  const fixture = setupFixture();
  const result = runCli({ ...fixture, withKey: false });
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.gate.reasons.some((r) => /dependencies or credentials/i.test(r)));
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-kimi').result, 'skipped');
});
