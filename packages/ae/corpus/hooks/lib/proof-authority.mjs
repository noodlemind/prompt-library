import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { authorityBin } from './authority-bin.mjs';

export function callProofAuthority(workspace, args, { timeout = 2500, spawnFn = spawnSync } = {}) {
  const bin = authorityBin();
  const started = Date.now();
  const result = spawnFn(bin ? process.execPath : 'ae', [...(bin ? [bin] : []), 'status', ...args, '--json', '--no-events', '--workspace', workspace], {
    cwd: workspace, encoding: 'utf8', timeout, maxBuffer: 256 * 1024,
  });
  const failure = (reason, message) => {
    const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(value) ? value : null;
    const authority = { reason, timeoutMs: timeout, durationMs: Date.now() - started, exitCode: Number.isInteger(result.status) ? result.status : null,
      signalName: safeCode(result.signal), errorCode: safeCode(result.error?.code) };
    return { pass: false, message: `${message} (reason=${reason}, exit=${authority.exitCode}, signal=${authority.signalName}, error=${authority.errorCode}, duration=${authority.durationMs}ms)`, authority };
  };
  if (result.error?.code === 'ETIMEDOUT') return failure('timeout', `Installed Harness proof authority timed out after ${timeout}ms; retry completion`);
  if (result.error || result.status !== 0) return failure(result.error ? 'spawn-error' : 'exit-error', 'Installed Harness proof authority could not run; check the installation and retry');
  try { return JSON.parse(result.stdout); } catch {
    return failure('invalid-json', 'Installed Harness proof authority returned invalid JSON; upgrade and retry');
  }
}

export function currentPlanDigest(workspace, planPath) {
  return callProofAuthority(workspace, ['--contract-digest', '--plan', planPath])?.digest || null;
}

export function validateEvidenceBinding({ workspace, planPath, evidence, timeout }) {
  const result = callProofAuthority(workspace, ['--validate-evidence', '--plan', planPath], { timeout });
  if (!result) return 'Installed Harness proof authority is unavailable or incompatible; upgrade and reverify';
  if (!result.pass) return result.message;
  const identity = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  return identity === result.evidenceIdentity ? null : 'Verification artifact changed during validation; retry';
}
