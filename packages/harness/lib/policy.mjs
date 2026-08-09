import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isProjectTrusted } from './trust.mjs';

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
 * deliberately NOT listed: a team's own command is theirs to mark advisory —
 * UNTIL the active plan gates on it, which is a per-run fact this static set
 * cannot know. That half of the rule lives in checkSeverityFor's
 * `planGatedIds` argument below.
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

/**
 * P3AC6 — trust gates project policy loading.
 *
 * A project's `policy.yaml` can only ever make verification LOOSER: it
 * downgrades check severity and picks the enforcement mode. That is authority,
 * and it is authority carried by a file that arrives with a clone. An untrusted
 * project therefore falls back to built-in enforcement, which is the strict
 * direction — the failure mode is "checks were stricter than the repo asked
 * for", never "a repository nobody read turned its own gates off".
 *
 * `copilotHome` is where the trust record lives, so supplying it is what turns
 * the gate on. Omitting it means "no user scope was resolved" and keeps the
 * pre-trust behavior — which every fixture-driven test relies on. That default
 * is a silent bypass if a production caller ever forgets, so it is not left to
 * convention: `test/policy-trust.test.mjs` asserts that every `loadPolicy` call
 * under `lib/` passes it.
 */
export function loadPolicy(workspace, override = null, { copilotHome = null } = {}) {
  const policyPath = path.join(workspace, '.github', 'harness', 'policy.yaml');
  const onDisk = fs.existsSync(policyPath);
  const trusted = copilotHome === null || isProjectTrusted({ workspace, copilotHome });
  // PARSED AND VALIDATED whether or not the project is trusted; only APPLIED
  // when it is. A broken policy file is a broken policy file, and staying quiet
  // about it because the project happens to be unapproved would leave an
  // operator with a file they believe is in force, a syntax error nobody
  // reports, and no way to connect the two. Trust decides whose values win, not
  // whether mistakes are worth mentioning.
  let parsed = {};
  if (onDisk) {
    try {
      parsed = YAML.parse(fs.readFileSync(policyPath, 'utf8'), { maxAliasCount: 50 }) || {};
    } catch (error) {
      throw new Error(`Invalid harness policy ${policyPath}: ${error.message}`);
    }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid harness policy ${policyPath}: expected a YAML mapping`);
  }
  if (onDisk && !POLICY_VERSIONS.has(parsed.version)) {
    throw new Error(`Invalid harness policy ${policyPath}: expected version 1 or 2`);
  }
  // Validate the severity map even when it will not be applied, for the same
  // reason — then drop it along with every other value if the project is not
  // trusted.
  const parsedSeverities = parseCheckSeverities(parsed, policyPath);

  const applied = onDisk && trusted;
  const policy = applied ? parsed : {};
  const requested = override ?? policy.enforcement ?? 'enforce';
  if (!MODES.has(requested)) {
    throw new Error(`Invalid enforcement mode: ${requested}. Expected observe, warn, or enforce`);
  }
  return {
    version: applied ? policy.version : null,
    enforcement: requested,
    // Surfaced, never silent: an operator whose enforcement mode flipped from
    // `warn` to `enforce` because a policy file was ignored needs to be able to
    // learn that from the run, not deduce it.
    projectPolicyIgnored: onDisk && !trusted,
    policyPath,
    gateTtlMinutes: Number.isFinite(policy.gate_ttl_minutes) ? policy.gate_ttl_minutes : 30,
    evidenceTtlHours: Number.isFinite(policy.evidence_ttl_hours) ? policy.evidence_ttl_hours : 24,
    exemptions: Array.isArray(policy.exemptions) ? policy.exemptions : [],
    waivers: Array.isArray(policy.waivers) ? policy.waivers : [],
    checkSeverities: applied ? parsedSeverities : {},
  };
}

/** Effective severity for a verify check: policy entry, else the check's built-in default.
 * Own-property check only: ids like `constructor`/`toString` must fall through
 * to the default instead of resolving Object.prototype members.
 *
 * `planGatedIds` closes the half of the advisory rule the static id list above
 * cannot see. NON_ADVISORY_CHECK_IDS protects the BUILT-IN checks, but a
 * PROJECT-DEFINED named check becomes just as gating the moment the ACTIVE
 * PLAN lists it under `verification.required` (or maps it under
 * `verification.criteria`) — and an advisory downgrade would filter its
 * failure out of resolveOutcome exactly the same way, minting `outcome:
 * passed` evidence from a run whose own required check failed. loadPolicy
 * cannot refuse that at parse time: one policy file serves every plan in the
 * repo and knows none of them. So the rule lands HERE, where the plan and the
 * policy meet.
 *
 * DECISION (documented in docs/MEMORY-MODEL.md): the downgrade is IGNORED for
 * that run rather than refused outright — the check falls back to its built-in
 * default and verify reports the refusal in `refusedSeverityDowngrades` (and
 * loudly on the CLI). Refusing would throw before any evidence is written,
 * which fails OPEN for the agent (no artifact at all); ignoring fails CLOSED,
 * which is what a gate is for. */
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
