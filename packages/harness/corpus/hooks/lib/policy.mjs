import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { authorityBin } from './authority-bin.mjs';
import { harnessHome } from './external-plans.mjs';
import { policySourceBinding, snapshotRel, validPolicySnapshot, readPolicySource } from './policy-snapshot.mjs';

export function loadHookPolicy(workspace, { ttlKey = 'gate_ttl_minutes', ttlDefault = 30, rule = 'plan' } = {}) {
  const safe = { enforcement: 'enforce', baseEnforcement: 'enforce', ttl: ttlDefault, source: 'safe-default', refreshFailed: true };
  const home = harnessHome();
  let binding;
  let snapshot;
  try {
    binding = policySourceBinding(workspace, home);
    const full = path.join(home, snapshotRel(workspace));
    if (fs.lstatSync(path.dirname(full)).isSymbolicLink() || fs.lstatSync(full).isSymbolicLink()) return safe;
    snapshot = JSON.parse(readPolicySource(full)?.toString('utf8') || 'null');
  } catch { /* A cold or invalid cache must be refreshed by the authority. */ }
  if (!validPolicySnapshot(snapshot, binding)) {
    const bin = authorityBin();
    const result = spawnSync(bin ? process.execPath : 'harness', [...(bin ? [bin] : []), 'status', '--effective-policy', '--json', '--no-events', '--workspace', workspace], {
      cwd: workspace, encoding: 'utf8', timeout: 2500, maxBuffer: 128 * 1024,
    });
    if (result.error || result.status !== 0) return safe;
    try {
      snapshot = JSON.parse(result.stdout);
      binding = policySourceBinding(workspace, home);
    } catch { return safe; }
    if (!validPolicySnapshot(snapshot, binding)) return safe;
  }
  const policy = snapshot.policy;
  return { enforcement: policy.rules[rule], baseEnforcement: policy.enforcement, ttl: ttlKey === 'evidence_ttl_hours' ? policy.evidenceTtlHours : policy.gateTtlMinutes, source: policy.enforcementSource, refreshFailed: false };
}

export function enforcementExitCode(enforcement) {
  return enforcement === 'enforce' ? 2 : 0;
}
