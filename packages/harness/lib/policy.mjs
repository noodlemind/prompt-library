import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const MODES = new Set(['observe', 'warn', 'enforce']);

// Policy schema v2 adds an optional per-check `checks:` map. `enforce` is the
// v1 behavior (a failed check fails verification), `warn` degrades a failure
// to an inconclusive (warn-exit) outcome, and `advisory` reports without ever
// affecting outcome or exit code. Absent entry → the check's built-in default.
export const CHECK_SEVERITIES = new Set(['advisory', 'warn', 'enforce']);
const POLICY_VERSIONS = new Set([1, 2]);

function parseCheckSeverities(policy, policyPath) {
  if (policy.checks === undefined || policy.checks === null) return {};
  if (typeof policy.checks !== 'object' || Array.isArray(policy.checks)) {
    throw new Error(`Invalid harness policy ${policyPath}: checks must be a mapping of check id to settings`);
  }
  const severities = {};
  for (const [id, config] of Object.entries(policy.checks)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`Invalid harness policy ${policyPath}: checks.${id} must be a mapping`);
    }
    if (config.severity === undefined) continue;
    if (!CHECK_SEVERITIES.has(config.severity)) {
      throw new Error(
        `Invalid harness policy ${policyPath}: checks.${id}.severity must be advisory, warn, or enforce (got ${config.severity})`
      );
    }
    severities[id] = config.severity;
  }
  return severities;
}

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
  if (policyExists && !POLICY_VERSIONS.has(policy.version)) {
    throw new Error(`Invalid harness policy ${policyPath}: expected version 1 or 2`);
  }
  const requested = override ?? policy.enforcement ?? 'enforce';
  if (!MODES.has(requested)) {
    throw new Error(`Invalid enforcement mode: ${requested}. Expected observe, warn, or enforce`);
  }
  return {
    version: policyExists ? policy.version : null,
    enforcement: requested,
    gateTtlMinutes: Number.isFinite(policy.gate_ttl_minutes) ? policy.gate_ttl_minutes : 30,
    evidenceTtlHours: Number.isFinite(policy.evidence_ttl_hours) ? policy.evidence_ttl_hours : 24,
    exemptions: Array.isArray(policy.exemptions) ? policy.exemptions : [],
    waivers: Array.isArray(policy.waivers) ? policy.waivers : [],
    checkSeverities: parseCheckSeverities(policy, policyPath),
  };
}

/** Effective severity for a verify check: policy entry, else the check's built-in default. */
export function checkSeverityFor(policy, id, defaultSeverity = 'enforce') {
  return policy?.checkSeverities?.[id] ?? defaultSeverity;
}

export function enforcementExitCode(outcome, enforcement) {
  if (enforcement !== 'enforce') return 0;
  return outcome === 'passed' ? 0 : outcome === 'failed' ? 1 : 2;
}
