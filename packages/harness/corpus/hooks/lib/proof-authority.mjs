import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { authorityBin } from './authority-bin.mjs';

export function callProofAuthority(workspace, args, { timeout = 2500 } = {}) {
  const bin = authorityBin();
  const result = spawnSync(bin ? process.execPath : 'harness', [...(bin ? [bin] : []), 'status', ...args, '--json', '--no-events', '--workspace', workspace], {
    cwd: workspace, encoding: 'utf8', timeout, maxBuffer: 256 * 1024,
  });
  if (result.error?.code === 'ETIMEDOUT') return { pass: false, message: `Installed Harness proof authority timed out after ${timeout}ms; retry completion` };
  if (result.error || result.status !== 0) return { pass: false, message: 'Installed Harness proof authority could not run; check the installation and retry' };
  try { return JSON.parse(result.stdout); } catch {
    return { pass: false, message: 'Installed Harness proof authority returned invalid JSON; upgrade and retry' };
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
