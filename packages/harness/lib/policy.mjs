import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const MODES = new Set(['observe', 'warn', 'enforce']);

// Policy schema v2 adds an optional per-check `checks:` map. `enforce` is the
// v1 behavior (a failed check fails verification), `warn` degrades a failure
// to an inconclusive (warn-exit) outcome, and `advisory` reports without ever
// affecting outcome or exit code. Absent entry → the check's built-in default.
// `checks:` is honored version-independently: a `version: 1` policy that adds
// a `checks:` map gets the same severity behavior — the version field records
// which schema the file was written against, not a feature gate.
export const CHECK_SEVERITIES = new Set(['advisory', 'warn', 'enforce']);
const POLICY_VERSIONS = new Set([1, 2]);

/**
 * The built-in verify checks that can never be downgraded to `advisory`
 * (human decision, recorded in docs/MEMORY-MODEL.md). `advisory` does not
 * merely soften a report: resolveOutcome (verify.mjs) filters advisory checks
 * OUT of the outcome entirely, so `outcome: passed` would be written into the
 * evidence artifact that `harness gate` and `harness compound` trust — a
 * policy marking `scope` advisory would open the gate on real scope
 * violations AND mint a "verified" fix episode from a run that never
 * verified. Every id verify.mjs pushes as a BUILT-IN check is listed here
 * except the ones whose built-in DEFAULT is already advisory
 * (`structural-expectations`) — those stay downgradable because advisory is
 * what they already are. Project-defined named checks (checks.yaml) are
 * deliberately NOT listed: a team's own command is theirs to mark advisory.
 * `warn` remains available for every check — it degrades a failure to
 * inconclusive (a non-zero exit under enforce), it does not erase it.
 */
export const NON_ADVISORY_CHECK_IDS = new Set([
  'plan-selection',
  'plan-schema',
  'plan-readiness',
  'plan-state',
  'phase-tasks',
  'criteria-evidence',
  'scope',
  'primitive-evidence',
  'required-reviews',
  'hard-gaps',
  'critical-findings',
  'workspace-stability',
]);

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
    if (config.severity === 'advisory' && NON_ADVISORY_CHECK_IDS.has(id)) {
      throw new Error(
        `Invalid harness policy ${policyPath}: checks.${id}.severity cannot be advisory — ${id} is a gating verify check whose failure must reach the evidence outcome; use warn to degrade it instead`
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

/** Effective severity for a verify check: policy entry, else the check's built-in default.
 * Own-property check only: ids like `constructor`/`toString` must fall through
 * to the default instead of resolving Object.prototype members. */
export function checkSeverityFor(policy, id, defaultSeverity = 'enforce') {
  const configured = policy?.checkSeverities;
  return configured && Object.hasOwn(configured, id) ? configured[id] : defaultSeverity;
}

export function enforcementExitCode(outcome, enforcement) {
  if (enforcement !== 'enforce') return 0;
  return outcome === 'passed' ? 0 : outcome === 'failed' ? 1 : 2;
}
