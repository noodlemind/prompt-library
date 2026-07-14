import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const MODES = new Set(['observe', 'warn', 'enforce']);

export function loadPolicy(workspace, override = null) {
  const policyPath = path.join(workspace, '.github', 'harness', 'policy.yaml');
  let policy = {};
  if (fs.existsSync(policyPath)) {
    try {
      policy = YAML.parse(fs.readFileSync(policyPath, 'utf8'), { maxAliasCount: 50 }) || {};
    } catch {
      policy = {};
    }
  }
  const requested = override || policy.enforcement || 'enforce';
  const enforcement = MODES.has(requested) ? requested : 'enforce';
  return {
    version: policy.version === 1 ? 1 : null,
    enforcement,
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
