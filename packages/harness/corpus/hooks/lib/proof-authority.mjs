import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function callProofAuthority(workspace, args) {
  const sourceBin = fileURLToPath(new URL('../../../bin/harness.mjs', import.meta.url));
  const bin = process.env.HARNESS_BIN || (fs.existsSync(sourceBin) ? sourceBin : null);
  const result = spawnSync(bin ? process.execPath : 'harness', [...(bin ? [bin] : []), 'status', ...args, '--json', '--no-events', '--workspace', workspace], {
    cwd: workspace, encoding: 'utf8', timeout: 2500, maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

export function currentPlanDigest(workspace, planPath) {
  return callProofAuthority(workspace, ['--contract-digest', '--plan', planPath])?.digest || null;
}

export function validateEvidenceBinding({ workspace, planPath, evidence }) {
  const result = callProofAuthority(workspace, ['--validate-evidence', '--plan', planPath]);
  if (!result) return 'Installed Harness proof authority is unavailable or incompatible; upgrade and reverify';
  if (!result.pass) return result.message;
  const identity = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  return identity === result.evidenceIdentity ? null : 'Verification artifact changed during validation; retry';
}
