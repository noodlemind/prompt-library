import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isProjectTrusted } from './trust.mjs';

const MODES = new Set(['observe', 'warn', 'enforce']);

export const CHECK_SEVERITIES = new Set(['advisory', 'warn', 'enforce']);
const POLICY_VERSIONS = new Set([1, 2]);

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

export function loadPolicy(workspace, override = null, { copilotHome = null } = {}) {
  const policyPath = path.join(workspace, '.github', 'harness', 'policy.yaml');
  const onDisk = fs.existsSync(policyPath);
  const trusted = copilotHome === null || isProjectTrusted({ workspace, copilotHome });
    let parsed = {};
  let policyError = null;
  const invalid = (message) => {
    if (trusted) throw new Error(message);
    policyError = message;
    parsed = {};
    return true;
  };

  let bailed = false;
  if (onDisk) {
    try {
      parsed = YAML.parse(fs.readFileSync(policyPath, 'utf8'), { maxAliasCount: 50 }) || {};
    } catch (error) {
      bailed = invalid(`Invalid harness policy ${policyPath}: ${error.message}`);
    }
  }
  if (!bailed && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    bailed = invalid(`Invalid harness policy ${policyPath}: expected a YAML mapping`);
  }
  if (!bailed && onDisk && !POLICY_VERSIONS.has(parsed.version)) {
    bailed = invalid(`Invalid harness policy ${policyPath}: expected version 1 or 2`);
  }
    let parsedSeverities = {};
  if (!bailed) {
    try {
      parsedSeverities = parseCheckSeverities(parsed, policyPath);
    } catch (error) {
      bailed = invalid(error.message);
    }
  }

  const applied = onDisk && trusted && !bailed;
  const policy = applied ? parsed : {};
  const requested = override ?? policy.enforcement ?? 'enforce';
  if (!MODES.has(requested)) {
    throw new Error(`Invalid enforcement mode: ${requested}. Expected observe, warn, or enforce`);
  }
  return {
    version: applied ? policy.version : null,
    enforcement: requested,
        projectPolicyIgnored: onDisk && !trusted,
        projectPolicyError: policyError,
    policyPath,
    gateTtlMinutes: Number.isFinite(policy.gate_ttl_minutes) ? policy.gate_ttl_minutes : 30,
    evidenceTtlHours: Number.isFinite(policy.evidence_ttl_hours) ? policy.evidence_ttl_hours : 24,
    exemptions: Array.isArray(policy.exemptions) ? policy.exemptions : [],
    waivers: Array.isArray(policy.waivers) ? policy.waivers : [],
    checkSeverities: applied ? parsedSeverities : {},
  };
}

export function checkSeverityFor(policy, id, defaultSeverity = 'enforce', planGatedIds = null) {
  const configured = policy?.checkSeverities;
  const severity = configured && Object.hasOwn(configured, id) ? configured[id] : defaultSeverity;
  if (severity === 'advisory' && planGatedIds?.has(id)) return defaultSeverity;
  return severity;
}

export function enforcementExitCode(outcome, enforcement) {
  if (enforcement !== 'enforce') return 0;
  return outcome === 'passed' ? 0 : outcome === 'failed' ? 1 : 2;
}
