import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nodeAuthority } from './authority-bin.mjs';
import { PROOF_AUTHORITY_TIMEOUT_MS } from './proof-authority.mjs';
import { harnessHome, projectStoreDir } from './external-plans.mjs';
import { policySourceBinding, snapshotRel, validPolicySnapshot, readPolicySource } from './policy-snapshot.mjs';

import { selectProjectAuthority } from './project-authority.mjs';

function sourceBinding(workspace, home) {
  return policySourceBinding(workspace, home, process.env.HARNESS_ENFORCEMENT, selectProjectAuthority(workspace, projectStoreDir(workspace, { home }), { home }));
}

export function loadHookPolicy(workspace, { ttlKey = 'gate_ttl_minutes', ttlDefault = 30, rule = 'plan' } = {}) {
  const safe = { enforcement: 'enforce', baseEnforcement: 'enforce', ttl: ttlDefault, source: 'safe-default', refreshFailed: true };
  const home = harnessHome();
  let binding;
  let snapshot;
  try {
    binding = sourceBinding(workspace, home);
    const full = path.join(home, snapshotRel(workspace));
    if (fs.lstatSync(path.dirname(full)).isSymbolicLink() || fs.lstatSync(full).isSymbolicLink()) return safe;
    snapshot = JSON.parse(readPolicySource(full)?.toString('utf8') || 'null');
  } catch { /* A cold or invalid cache must be refreshed by the authority. */ }
  if (!validPolicySnapshot(snapshot, binding)) {
    const node = nodeAuthority();
    if (!node) return safe;
    const result = spawnSync(node.command, [...node.args, 'status', '--effective-policy', '--json', '--no-events', '--workspace', workspace], {
      cwd: workspace, encoding: 'utf8', timeout: PROOF_AUTHORITY_TIMEOUT_MS, maxBuffer: 128 * 1024,
    });
    if (result.error || result.status !== 0) return safe;
    try {
      snapshot = JSON.parse(result.stdout);
      binding = sourceBinding(workspace, home);
    } catch { return safe; }
    if (!validPolicySnapshot(snapshot, binding)) return safe;
  }
  const policy = snapshot.policy;
  return { enforcement: policy.rules[rule], baseEnforcement: policy.enforcement, ttl: ttlKey === 'evidence_ttl_hours' ? policy.evidenceTtlHours : policy.gateTtlMinutes, source: policy.enforcementSource, refreshFailed: false };
}

export function enforcementExitCode(enforcement) {
  return enforcement === 'enforce' ? 2 : 0;
}

export function projectTrustIsCurrent(workspace) {
  const node = nodeAuthority();
  if (!node) return false;
  const result = spawnSync(node.command, [...node.args, 'trust', 'status', '--json', '--no-events', '--workspace', workspace], {
    cwd: workspace, encoding: 'utf8', timeout: PROOF_AUTHORITY_TIMEOUT_MS, maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) return false;
  try {
    const status = JSON.parse(result.stdout);
    return status.trusted === true && status.state === 'trusted' && status.project === fs.realpathSync.native(workspace);
  } catch { return false; }
}
