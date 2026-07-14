import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const MODES = new Set(['observe', 'warn', 'enforce']);

export function loadPolicy(workspace, override = null) {
  const policyPath = path.join(workspace, '.github', 'harness', 'policy.yaml');
  const policyExists = fs.existsSync(policyPath);
  let policy = {};
  if (policyExists) {
    try {
      policy = YAML.parse(fs.readFileSync(policyPath, 'utf8'), { maxAliasCount: 50 }) || {};
    } catch (error) {
      throw new Error(`Invalid harness policy ${policyPath}: ${error.message}`);
    }
  }
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`Invalid harness policy ${policyPath}: expected a YAML mapping`);
  }
  if (policyExists && policy.version !== 1) {
    throw new Error(`Invalid harness policy ${policyPath}: expected version 1`);
  }
  const requested = override ?? policy.enforcement ?? 'enforce';
  if (!MODES.has(requested)) {
    throw new Error(`Invalid enforcement mode: ${requested}. Expected observe, warn, or enforce`);
  }
  return {
    version: policy.version === 1 ? 1 : null,
    enforcement: requested,
    gateTtlMinutes: Number.isFinite(policy.gate_ttl_minutes) ? policy.gate_ttl_minutes : 30,
    evidenceTtlHours: Number.isFinite(policy.evidence_ttl_hours) ? policy.evidence_ttl_hours : 24,
    exemptions: Array.isArray(policy.exemptions) ? policy.exemptions : [],
    waivers: Array.isArray(policy.waivers) ? policy.waivers : [],
  };
}

export function enforcementExitCode(outcome, enforcement) {
  if (enforcement !== 'enforce') return 0;
  return outcome === 'passed' ? 0 : outcome === 'failed' ? 1 : 2;
}
