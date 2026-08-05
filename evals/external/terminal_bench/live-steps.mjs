/**
 * Live release steps: the callable implementation of the controlled A/B pair.
 *
 * `buildLiveSteps` returns the step functions `runRelease` schedules. The
 * flow per trial: verify the pinned task bytes (before any provider work),
 * write the condition file (with the trial ceiling capped by the pair's
 * remaining allowance), invoke `harbor run` with a deterministic job
 * identity and the mounted harness bundle, then read the official verifier
 * evidence and the bridge's done-file to build a schema-valid eval-run
 * document. The larger of pinned local and provider-reported cost is charged —
 * every child charge lands on the release-side budget chain.
 *
 * Everything external (harbor, filesystem layout, bundle prep) is injected
 * so the whole path is testable without a container or a provider.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createHost as createControlledHost } from '../../hosts/openrouter-controlled.mjs';
import { createHost as createKimiHost } from '../../hosts/openrouter-kimi.mjs';
import { createHost as createGemmaHost } from '../../hosts/ollama-gemma.mjs';
import {
  buildHarborIsolatedTrialArgs,
  buildHarborRunArgs,
  jobDirFor,
  runHarbor,
  verifyTaskAgainstLock,
  classifyFailure,
  tasksOf,
  readHostVerifierReward,
} from './harbor-adapter.mjs';
import { collectVerifierEvidence, hashTree, verdictFromReward } from './verifier.mjs';
import { buildGenericCondition } from './generic-condition.mjs';
import { buildHarnessCondition } from './harness-condition.mjs';
import { runtimeBridgeTools } from './agent.mjs';
import { createBudget } from '../../lib/budget.mjs';
import { billingProfileHash } from '../../lib/model-profiles.mjs';
import {
  evaluateProviderSpendEvidence,
  resolveProviderSpendPolicy,
} from '../../lib/provider-spend-policy.mjs';
import {
  ECONOMIC_PHASES,
  ECONOMIC_PHASE_FIELDS,
  SOURCE_USAGE_TO_ECONOMIC_FIELD,
  TASK_EXECUTION_ECONOMIC_PHASES,
  economicPhaseForContextSource,
} from '../../lib/economic-phases.mjs';
import { validatePromptComponentManifestStructure } from '../../lib/prompt-manifest.mjs';
import {
  CONDITION_INPUTS_FILE,
  prepareHarnessBundle,
  materializePrebuiltBundle,
  validatePrebuiltBundle,
} from './provision.mjs';

export const AGENT_REF = 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent';
export const SUPPORTED_HARBOR_VERSION = '0.20.0';

const HARBOR_ENV_ALLOWLIST = [
  'LANG', 'LC_ALL', 'TERM',
  'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
];
const DEFAULT_TOOL_PATH = process.platform === 'darwin'
  ? '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin'
  : '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin';
const MAX_HOST_EXECUTABLE_BYTES = 256 * 1024 * 1024;

function stableExecutableIdentity(executable, { expectedSha256 = null, label }) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const requested = path.resolve(executable);
  const requestedStat = fs.lstatSync(requested);
  if (requestedStat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const canonical = fs.realpathSync.native(requested);
  const handle = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(handle);
    if (!before.isFile() || before.size > MAX_HOST_EXECUTABLE_BYTES || (before.mode & 0o111) === 0 || (before.mode & 0o022) !== 0) {
      throw new Error(`${label} must be a protected executable regular file`);
    }
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const count = fs.readSync(handle, chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (count === 0) throw new Error(`${label} changed while being attested`);
      digest.update(chunk.subarray(0, count));
      position += count;
    }
    const after = fs.fstatSync(handle);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} changed while being attested`);
    }
    const sha256 = digest.digest('hex');
    if (expectedSha256 != null && sha256 !== String(expectedSha256).toLowerCase()) {
      throw new Error(`${label} digest does not match HARNESS_EVAL_HARBOR_SHA256`);
    }
    return { path: canonical, sha256 };
  } finally {
    fs.closeSync(handle);
  }
}

function defaultAttestHarborExecutable({ env }) {
  if (!/^[a-f0-9]{64}$/i.test(String(env.HARNESS_EVAL_HARBOR_SHA256 ?? ''))) {
    throw new Error('HARNESS_EVAL_HARBOR_SHA256 must pin the Harbor executable');
  }
  return stableExecutableIdentity(env.HARNESS_EVAL_HARBOR_BIN, {
    expectedSha256: env.HARNESS_EVAL_HARBOR_SHA256,
    label: 'Harbor executable',
  });
}

function defaultAttestHostNodeExecutable() {
  return stableExecutableIdentity(fs.realpathSync.native(process.execPath), {
    label: 'host Node executable',
  });
}

function defaultAttestSandboxImage({ sandbox, env, runtimeHome }) {
  if (!sandbox) return null;
  if (!/^[a-f0-9]{64}$/i.test(String(env.HARNESS_EVAL_DOCKER_SHA256 ?? ''))) {
    throw new Error('HARNESS_EVAL_DOCKER_SHA256 must pin the Docker executable');
  }
  const docker = stableExecutableIdentity(env.HARNESS_EVAL_DOCKER_BIN, {
    expectedSha256: env.HARNESS_EVAL_DOCKER_SHA256,
    label: 'Docker executable',
  });
  const inspectEnv = Object.fromEntries(
    ['LANG', 'LC_ALL', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
      .filter((name) => typeof env[name] === 'string')
      .map((name) => [name, env[name]])
  );
  inspectEnv.HOME = runtimeHome;
  inspectEnv.DOCKER_CONFIG = path.join(runtimeHome, 'docker');
  const result = spawnSync(docker.path, ['image', 'inspect', sandbox.immutableImage], {
    encoding: 'utf8',
    env: inspectEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`pinned sandbox image is unavailable: ${result.stderr || result.error?.message || result.status}`);
  let inspected;
  try {
    inspected = JSON.parse(result.stdout)?.[0];
  } catch {
    throw new Error('Docker image inspect returned invalid JSON');
  }
  const platform = `${inspected?.Os ?? ''}/${inspected?.Architecture ?? ''}`;
  if (inspected?.Id !== sandbox.imageId || platform !== sandbox.platform) {
    throw new Error(`sandbox image identity mismatch for ${sandbox.immutableImage}`);
  }
  const repoDigests = Array.isArray(inspected?.RepoDigests) ? inspected.RepoDigests : [];
  if (!repoDigests.includes(sandbox.immutableImage)) {
    throw new Error(`sandbox image repository digest is not present: ${sandbox.immutableImage}`);
  }
  return {
    ...sandbox,
    dockerExecutableHash: docker.sha256,
    observedImageId: inspected.Id,
    observedPlatform: platform,
    identityAttested: true,
  };
}

const harborSpawnEnv = ({
  ambientEnv = process.env,
  runtimeHome,
  trustedPythonPath = null,
  hostNode = null,
  hostNodeSha256 = null,
} = {}) => {
  const spawnEnv = Object.fromEntries(
    HARBOR_ENV_ALLOWLIST
      .filter((name) => typeof ambientEnv[name] === 'string')
      .map((name) => [name, ambientEnv[name]])
  );
  const toolPath = ambientEnv.HARNESS_EVAL_TOOL_PATH ?? DEFAULT_TOOL_PATH;
  if (String(toolPath).split(path.delimiter).some((entry) => !path.isAbsolute(entry))) {
    throw new Error('HARNESS_EVAL_TOOL_PATH must contain only absolute directories');
  }
  spawnEnv.PATH = toolPath;
  if (typeof runtimeHome !== 'string' || !path.isAbsolute(runtimeHome)) {
    throw new Error('Harbor runtime HOME must be an absolute runner-owned path');
  }
  spawnEnv.HOME = runtimeHome;
  spawnEnv.XDG_CONFIG_HOME = path.join(runtimeHome, 'xdg-config');
  spawnEnv.XDG_CACHE_HOME = path.join(runtimeHome, 'xdg-cache');
  spawnEnv.TMPDIR = path.join(runtimeHome, 'tmp');
  spawnEnv.DOCKER_CONFIG = path.join(runtimeHome, 'docker');
  if (trustedPythonPath != null) spawnEnv.PYTHONPATH = trustedPythonPath;
  spawnEnv.PYTHONNOUSERSITE = '1';
  spawnEnv.PYTHONSAFEPATH = '1';
  spawnEnv.PYTHONDONTWRITEBYTECODE = '1';
  if (hostNode != null) {
    if (!/^[a-f0-9]{64}$/i.test(String(hostNodeSha256 ?? ''))) {
      throw new Error('host Node executable requires its attested SHA-256 digest');
    }
    spawnEnv.HARNESS_EVAL_HOST_NODE = hostNode;
    spawnEnv.HARNESS_EVAL_HOST_NODE_SHA256 = String(hostNodeSha256).toLowerCase();
  }
  return spawnEnv;
};

// Harbor delivers the real instruction to the agent at runtime; the condition
// object still requires one for prompt assembly parity checks.
const INSTRUCTION_PLACEHOLDER = '(the task instruction is supplied by Harbor at runtime)';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const stableHash = (value) => sha256(JSON.stringify(value ?? null));
const shortHash = (value) => stableHash(value).slice(0, 24);

function diagnosticCode(raw, fallback = 'EXECUTION_INTEGRITY_FAILURE') {
  const message = String(raw ?? '');
  const mappings = [
    [/verified execution task snapshot drifted/i, 'TASK_SNAPSHOT_DRIFT'],
    [/bundle.*(?:digest|manifest|contents|drift|validation|identity)/i, 'BUNDLE_INTEGRITY_FAILURE'],
    [/sandbox image identity changed/i, 'SANDBOX_IDENTITY_DRIFT'],
    [/sandbox image/i, 'SANDBOX_ATTESTATION_FAILURE'],
    [/Harbor executable identity changed/i, 'HARBOR_EXECUTABLE_DRIFT'],
    [/Harbor executable/i, 'HARBOR_EXECUTABLE_ATTESTATION_FAILURE'],
    [/task snapshot/i, 'TASK_SNAPSHOT_FAILURE'],
    [/task download/i, 'TASK_DOWNLOAD_FAILURE'],
    [/provider.*(?:limit|key)/i, 'PROVIDER_PREFLIGHT_FAILURE'],
  ];
  return mappings.find(([pattern]) => pattern.test(message))?.[1] ?? fallback;
}

function failureDiagnostic(stage, code, raw = null, details = {}) {
  return {
    stage,
    code,
    reasonHash: raw == null ? null : sha256(String(raw)),
    ...details,
  };
}

function publicFailureReason(stage, code, raw = null) {
  const hash = raw == null ? null : sha256(String(raw)).slice(0, 16);
  return `${stage}: ${code}${hash ? ` (detail sha256:${hash})` : ''}`;
}

// Harbor 0.20.0 removes leading provenance-canary comment lines before it
// hands an instruction to an agent. Reproduce that pinned transformation
// independently so runtime prompt attestation compares with the bytes the
// bridge actually receives while taskHash still binds the untouched fixture.
export function instructionAsDeliveredByHarbor(rawInstruction) {
  const lines = String(rawInstruction).split('\n');
  const canaryLine = /^(<!--.*canary.*-->|#.*canary.*)$/i;
  let index = 0;
  while (index < lines.length && canaryLine.test(lines[index].trim())) index += 1;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  return lines.slice(index).join('\n');
}
const normalizeProviderName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const harborVersionOf = (probe) => {
  const text = `${probe?.stdout ?? ''}\n${probe?.stderr ?? ''}`;
  const versions = text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g) ?? [];
  return versions.length === 1 ? versions[0] : null;
};

const PROVIDER_EVENT_TYPES = new Set(['request', 'request_attempt', 'response', 'error', 'retry', 'completion_error', 'fallback', 'billing_uncertain']);
const TOOL_EVENT_TYPES = new Set(['tool_call', 'tool_result', 'tool_result_compacted', 'post_verify_tool_suppressed', 'tool_call_suppressed']);
const BRIDGE_INTEGRITY_STOP_REASONS = new Set([
  'protocol_error',
  'secret_reflection_blocked',
  'bridge_payload_exceeded',
  'done_persistence_failed',
  'bridge_error',
]);
const SHA256_HEX = /^[a-f0-9]{64}$/i;

function toolEventIdentity(event) {
  return typeof event?.requestId === 'string' && event.requestId.length > 0 &&
    typeof event?.toolCallId === 'string' && event.toolCallId.length > 0
    ? `${event.requestId}:${event.toolCallId}`
    : null;
}

function providerAttemptIdentity(event) {
  return typeof event?.requestId === 'string' && event.requestId.length > 0 &&
    typeof event?.attemptId === 'string' && event.attemptId.length > 0
    ? `${event.requestId}:${event.attemptId}`
    : null;
}

function identityCounts(events, identityOf = toolEventIdentity) {
  const counts = new Map();
  let invalid = 0;
  for (const event of events) {
    const key = identityOf(event);
    if (key == null) invalid += 1;
    else counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { counts, invalid };
}

const nonNegativeFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonEmptyString = (value) => typeof value === 'string' && value.length > 0;

function completeToolCallEvidence(event) {
  return toolEventIdentity(event) != null &&
    nonEmptyString(event.tool) &&
    nonEmptyString(event.category) &&
    nonNegativeFinite(event.monotonicMs) &&
    nonNegativeFinite(event.argsChars) &&
    SHA256_HEX.test(String(event.argsHash ?? '')) &&
    typeof event.immutableHarnessCli === 'boolean' &&
    typeof event.argumentsValid === 'boolean';
}

function completeToolResultEvidence(event) {
  return toolEventIdentity(event) != null &&
    nonEmptyString(event.tool) &&
    nonEmptyString(event.category) &&
    nonNegativeFinite(event.monotonicMs) &&
    Number.isInteger(event.exitCode) &&
    nonNegativeFinite(event.durationMs) &&
    nonNegativeFinite(event.stdoutChars) &&
    nonNegativeFinite(event.stderrChars) &&
    nonNegativeFinite(event.resultChars) &&
    SHA256_HEX.test(String(event.resultHash ?? '')) &&
    typeof event.compacted === 'boolean' &&
    typeof event.stdoutTruncated === 'boolean' &&
    typeof event.stderrTruncated === 'boolean' &&
    typeof event.timedOut === 'boolean' &&
    nonEmptyString(event.containmentMode) &&
    typeof event.containmentComplete === 'boolean';
}

function harnessExecutableCall(event) {
  return event?.immutableHarnessCli === true ||
    event?.program === 'harness' ||
    event?.program === 'harness-cli';
}

function trustedHarnessCliEvidence(toolEvents) {
  const calls = toolEvents.filter((event) =>
    event?.type === 'tool_call' && harnessExecutableCall(event) && completeToolCallEvidence(event)
  );
  const results = toolEvents.filter((event) => event?.type === 'tool_result' && completeToolResultEvidence(event));
  const resultCounts = identityCounts(results);
  const correlated = calls.flatMap((call) => {
    const identity = toolEventIdentity(call);
    if (identity == null || resultCounts.counts.get(identity) !== 1) return [];
    return results.filter((result) => toolEventIdentity(result) === identity).slice(0, 1);
  });
  return {
    invoked: correlated.length > 0,
    succeeded: correlated.some((result) => result.exitCode === 0),
  };
}

function numericEventTime(event) {
  return typeof event?.monotonicMs === 'number' && Number.isFinite(event.monotonicMs) ? event.monotonicMs : null;
}

function eventDelta(events, predicate, startedAt) {
  const match = events.find((event) => predicate(event));
  const startWallMs = Date.parse(startedAt ?? '');
  const matchWallMs = Date.parse(match?.timestamp ?? '');
  if (match && Number.isFinite(startWallMs) && Number.isFinite(matchWallMs)) {
    return Math.max(0, matchWallMs - startWallMs);
  }
  const times = events.map(numericEventTime).filter((value) => value != null);
  if (!times.length) return null;
  const monotonicMatch = events.find((event) => predicate(event) && numericEventTime(event) != null);
  return monotonicMatch ? Math.max(0, numericEventTime(monotonicMatch) - Math.min(...times)) : null;
}

function workspaceEvidenceOf(done) {
  const source = done?.workspaceEvidence;
  const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  const changedPaths = Array.isArray(source?.changedPaths)
    ? source.changedPaths.filter((value) => typeof value === 'string').slice(0, 200)
    : [];
  const changedPathCount = Number.isFinite(source?.changedPathCount) ? Math.max(0, source.changedPathCount) : changedPaths.length;
  const validDiffState = validHash(source?.diffHash) || (source?.diffHash == null && changedPathCount === 0);
  const requiresGitState = source?.collectionMode === 'bounded-typed-content-plus-git-state-v3';
  const validGitState = !requiresGitState || (
    source?.gitStateAvailable === true &&
    typeof source?.gitStatePresent === 'boolean' &&
    typeof source?.gitStateChanged === 'boolean' &&
    validHash(source?.beforeGitStateHash) &&
    validHash(source?.afterGitStateHash)
  );
  const available = Boolean(
    source &&
      source.available !== false &&
      validHash(source.beforeManifestHash) &&
      validHash(source.afterManifestHash) &&
      validDiffState &&
      validGitState
  );
  return {
    available,
    collectionMode: source?.collectionMode ?? null,
    containmentMode: ['descriptor-relative-procfs', 'identity-checked-path-fallback'].includes(source?.containmentMode)
      ? source.containmentMode
      : null,
    beforeManifestHash: available ? source.beforeManifestHash : null,
    afterManifestHash: available ? source.afterManifestHash : null,
    diffHash: available ? source.diffHash ?? null : null,
    changedPaths: available ? changedPaths : [],
    changedPathCount: available ? changedPathCount : 0,
    changedPathsTruncated: available ? source.changedPathsTruncated === true || changedPathCount > changedPaths.length : false,
    gitStateAvailable: requiresGitState ? source?.gitStateAvailable === true : null,
    gitStatePresent: requiresGitState && typeof source?.gitStatePresent === 'boolean' ? source.gitStatePresent : null,
    beforeGitStateHash: requiresGitState && validHash(source?.beforeGitStateHash) ? source.beforeGitStateHash : null,
    afterGitStateHash: requiresGitState && validHash(source?.afterGitStateHash) ? source.afterGitStateHash : null,
    gitStateChanged: requiresGitState && typeof source?.gitStateChanged === 'boolean' ? source.gitStateChanged : null,
    reason: available ? null : source?.reason ?? 'workspace-manifest-not-captured',
  };
}

function harnessEventsOf(done) {
  if (done?.harnessEventEvidence?.available === false) return null;
  const source = done?.harnessEvents ?? done?.evidence?.harnessEvents;
  const events = Array.isArray(source) ? source : Array.isArray(source?.events) ? source.events : null;
  return events ? events.filter((event) => event && typeof event === 'object').slice(-200) : null;
}

function harnessEventEvidenceOf(done, harnessEvents) {
  const source = done?.harnessEventEvidence;
  const available = typeof source?.available === 'boolean' ? source.available : Array.isArray(harnessEvents);
  const sourceTruncated = source?.sourceTruncated === true;
  const projectionRejectedEvents = Number.isFinite(source?.projectionRejectedEvents)
    ? Math.max(0, source.projectionRejectedEvents)
    : 0;
  const projectionRejectedChecks = Number.isFinite(source?.projectionRejectedChecks)
    ? Math.max(0, source.projectionRejectedChecks)
    : 0;
  const complete = typeof source?.complete === 'boolean'
    ? source.complete
    : available && !sourceTruncated && projectionRejectedEvents === 0 && projectionRejectedChecks === 0;
  return {
    available,
    complete,
    reason: source?.reason ?? (Array.isArray(harnessEvents) ? null : 'harness-events-not-captured'),
    retainedEvents: Number.isFinite(source?.retainedEvents) ? Math.max(0, source.retainedEvents) : harnessEvents?.length ?? 0,
    sourceTruncated,
    projectionRejectedEvents,
    projectionRejectedChecks,
  };
}

function deriveHarnessBehavior(condition, telemetryEvents, harnessEvents, harnessEventEvidence, done, telemetryLedgerPresent) {
  const empty = {
    orientInvoked: null,
    planCreatedOrSelected: null,
    gateAttempts: null,
    gateDenials: null,
    outOfScopeMutationAttempts: null,
    dangerousCommandAttempts: null,
    verificationAfterFinalMutation: null,
    prematureFinishAttempts: null,
    completionBlockedForVerification: null,
    reviewPerformed: null,
    policyBypassAttempted: null,
    policyBypassAchieved: null,
  };
  if (condition !== 'harness') return empty;

  // Sandbox Harness events are agent-writable. Positive events are useful
  // advisory evidence, but their absence can never establish that an action
  // did not occur. Trusted bridge tool calls/results remain authoritative for
  // counts and ordering that they can observe.
  const capturedHarnessEvents = Array.isArray(harnessEvents) && harnessEventEvidence?.complete === true;
  const capturedToolEvents = telemetryLedgerPresent;
  if (!capturedHarnessEvents && !capturedToolEvents) return empty;
  const events = capturedHarnessEvents ? harnessEvents : [];
  const toolCalls = telemetryEvents.filter((event) => event.type === 'tool_call');
  const toolResults = telemetryEvents.filter((event) => event.type === 'tool_result');
  const gateEvents = events.filter((event) => event.type === 'gate');
  const gateCalls = toolCalls.filter((event) => event.category === 'gate');
  const gateResults = toolResults.filter((event) => event.category === 'gate');
  const blocks = events.filter((event) => event.type === 'pre_tool' && (event.decision === 'block' || event.result === 'fail'));
  const reason = (event) => `${event.blockedReason ?? ''} ${(event.checks ?? []).map((check) => check.id).join(' ')}`.toLowerCase();

  let verificationAfterFinalMutation = null;
  const editResults = toolResults.filter((event) => event.category === 'edit' && event.exitCode === 0 && numericEventTime(event) != null);
  const verifyResults = toolResults.filter((event) => event.category === 'verify' && event.exitCode === 0 && numericEventTime(event) != null);
  if (editResults.length) {
    const finalMutation = Math.max(...editResults.map(numericEventTime));
    verificationAfterFinalMutation = verifyResults.some((event) => numericEventTime(event) > finalMutation);
  } else {
    const finalMutationIndex = events.findLastIndex((event) => event.type === 'post_tool' && event.mutation === true && event.result !== 'fail');
    if (finalMutationIndex >= 0) {
      verificationAfterFinalMutation = events.slice(finalMutationIndex + 1).some((event) => event.type === 'verify' && event.result === 'pass')
        ? true
        : null;
    }
  }

  const sessionBlocks = events.filter(
    (event) => event.type === 'session_end' && (event.decision === 'block' || event.result === 'fail' || event.blockedReason)
  );
  const advisoryCount = (matches) => matches.length > 0 ? matches.length : null;
  const trustedOrPositive = (trusted, positive) => trusted ? true : positive ? true : capturedToolEvents ? false : null;
  const eventGateDenials = gateEvents.filter(
    (event) => event.result === 'fail' || event.decision === 'block' || event.blockedReason
  );
  const outOfScopeBlocks = blocks.filter((event) => /out[- ]of[- ]scope|outside.*scope|scope/.test(reason(event)));
  const dangerousBlocks = blocks.filter((event) => /danger|destruct|unsafe|protected|secret/.test(reason(event)));
  return {
    orientInvoked: trustedOrPositive(
      toolCalls.some((event) => event.category === 'orient'),
      events.some((event) => event.type === 'orient')
    ),
    planCreatedOrSelected: trustedOrPositive(
      toolCalls.some((event) => event.category === 'plan'),
      events.some((event) => typeof event.plan === 'string' && event.plan.length > 0)
    ),
    gateAttempts: capturedToolEvents && gateCalls.length > 0
      ? Math.max(gateCalls.length, gateEvents.length)
      : advisoryCount(gateEvents),
    gateDenials: capturedToolEvents && gateCalls.length > 0
      ? Math.max(gateResults.filter((event) => event.exitCode !== 0).length, eventGateDenials.length)
      : advisoryCount(eventGateDenials),
    outOfScopeMutationAttempts: advisoryCount(outOfScopeBlocks),
    dangerousCommandAttempts: advisoryCount(dangerousBlocks),
    verificationAfterFinalMutation,
    prematureFinishAttempts: advisoryCount(sessionBlocks),
    completionBlockedForVerification: sessionBlocks.some((event) => /verif|evidence|completion/.test(reason(event))) ? true : null,
    // Harness v2 has no review event type. Leave this unsupported field null
    // rather than converting the absence of evidence into a false claim.
    reviewPerformed: null,
    policyBypassAttempted: blocks.length > 0 ? true : null,
    // No trusted channel can currently establish this either way: the done
    // payload crosses the sandbox boundary, so a forged `false` would mask a
    // real bypass and a forged `true` would weaponize the safety gate. Null
    // until a supervisor outside the sandbox can attest it.
    policyBypassAchieved: null,
  };
}

function enforcementFidelityOf(condition, done, harnessEvents, toolEvents) {
  // Harness event files live in the evaluated workspace and are therefore
  // agent-writable — and so is the probe's stdout that the bridge relays, so
  // `done.enforcement` cannot establish mechanical fidelity either. Clamp to
  // false until a trusted supervisor channel outside the sandbox exists; the
  // genuine probe hard-codes false, so any `true` arriving here is a forgery.
  const mechanicalHooksActive = false;
  const cliEvidence = condition === 'harness'
    ? trustedHarnessCliEvidence(toolEvents)
    : { invoked: false, succeeded: false };
  return {
    // If hooks unexpectedly appear in the control arm, report that
    // contamination instead of forcing the intended `none` label.
    mode: mechanicalHooksActive ? 'mechanical-hooks' : condition === 'generic' ? 'none' : 'prompt-and-cli',
    promptContractActive: condition === 'harness',
    // `prompt-and-cli` names treatment availability. Actual use is derived
    // only from a complete, correlated runner-owned tool call/result pair.
    cliActivated: cliEvidence.succeeded,
    cliInvoked: cliEvidence.invoked,
    cliSucceeded: cliEvidence.succeeded,
    mechanicalHooksActive,
    harnessEventsCaptured: Array.isArray(harnessEvents),
    evidenceSource: done?.enforcement?.source ?? (mechanicalHooksActive ? 'trusted-bridge' : condition === 'harness' ? 'condition-and-setup' : 'control-condition'),
  };
}

function phaseForToolCall(event) {
  return economicPhaseForContextSource(event?.contextSource ?? event?.category ?? 'unknown');
}

function freshPhase() {
  return {
    logicalRequests: 0,
    usageRecords: 0,
    ...Object.fromEntries(ECONOMIC_PHASE_FIELDS.flatMap((field) => [
      [field, 0],
      [`${field}Complete`, true],
    ])),
  };
}

function unavailablePhase(status) {
  const phase = freshPhase();
  closeEmptyPhaseFields(phase);
  phase.status = status;
  return phase;
}

function unavailablePhaseMatrix(status) {
  return Object.fromEntries(ECONOMIC_PHASES.map((phase) => [phase, unavailablePhase(status)]));
}

function taskExecutionRollup(phases, fallbackStatus = 'unavailable') {
  const selected = TASK_EXECUTION_ECONOMIC_PHASES.map((name) => phases[name]);
  const exercised = selected.filter((phase) => (phase?.logicalRequests ?? 0) > 0 || (phase?.usageRecords ?? 0) > 0);
  if (exercised.length === 0) {
    return { ...unavailablePhase(fallbackStatus), derivedFrom: [...TASK_EXECUTION_ECONOMIC_PHASES] };
  }
  const rollup = freshPhase();
  rollup.logicalRequests = selected.reduce((sum, phase) => sum + (phase?.logicalRequests ?? 0), 0);
  rollup.usageRecords = selected.reduce((sum, phase) => sum + (phase?.usageRecords ?? 0), 0);
  for (const target of ECONOMIC_PHASE_FIELDS) {
    const completeKey = `${target}Complete`;
    if (exercised.every((phase) => phase?.[completeKey] === true && typeof phase?.[target] === 'number')) {
      rollup[target] = exercised.reduce((sum, phase) => sum + phase[target], 0);
    } else {
      rollup[target] = null;
      rollup[completeKey] = false;
    }
  }
  rollup.status = exercised.every((phase) => phase?.status === 'measured') ? 'measured' : 'partial';
  rollup.derivedFrom = [...TASK_EXECUTION_ECONOMIC_PHASES];
  return rollup;
}

function addUsageToPhase(phase, usage) {
  phase.usageRecords += 1;
  for (const [source, target] of Object.entries(SOURCE_USAGE_TO_ECONOMIC_FIELD)) {
    const value = usage?.[source];
    const completeKey = `${target}Complete`;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && phase[completeKey] !== false) {
      phase[target] += value;
    } else {
      phase[target] = null;
      phase[completeKey] = false;
    }
  }
  if (usage?.cachedTokensComplete === false) {
    phase.cachedPromptTokens = null;
    phase.cachedPromptTokensComplete = false;
  }
  if (usage?.reasoningTokensComplete === false) {
    phase.reasoningTokens = null;
    phase.reasoningTokensComplete = false;
  }
}

function closeEmptyPhaseFields(phase) {
  if (phase.usageRecords > 0) return phase;
  for (const target of ECONOMIC_PHASE_FIELDS) {
    phase[target] = null;
    phase[`${target}Complete`] = false;
  }
  return phase;
}

function sameNumber(left, right) {
  return typeof left === 'number' && Number.isFinite(left) &&
    typeof right === 'number' && Number.isFinite(right) &&
    Math.abs(left - right) <= 1e-9;
}

const PROMPT_BUCKET_FIELDS = [
  ['baseSystem', 'baseSystemChars'],
  ['instruction', 'instructionChars'],
  ['durableState', 'durableStateChars'],
  ['assistantHistory', 'assistantHistoryChars'],
  ['toolResultHistory', 'toolResultHistoryChars'],
  ['otherMessages', 'otherMessageChars'],
  ['messageEnvelope', 'messageEnvelopeChars'],
  ['toolSchema', 'toolSchemaChars'],
  ['payloadEnvelope', 'payloadEnvelopeChars'],
];
const PROMPT_BUCKET_KEYS = new Set([
  ...PROMPT_BUCKET_FIELDS.map(([source]) => source),
  'toolResultHistoryBySource',
  'complete',
]);
function isPlainRecord(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeIntegerSum(values) {
  let total = 0;
  for (const value of values) {
    if (!nonnegativeSafeInteger(value) || total > Number.MAX_SAFE_INTEGER - value) return null;
    total += value;
  }
  return total;
}

function promptComponentManifestValid(manifest) {
  return validatePromptComponentManifestStructure(manifest).valid;
}

function promptBucketsValid(event) {
  const buckets = event?.promptBuckets;
  if (!nonnegativeSafeInteger(event?.payloadChars) ||
      !hasExactKeys(buckets, PROMPT_BUCKET_KEYS) ||
      buckets.complete !== true ||
      !PROMPT_BUCKET_FIELDS.every(([key]) => nonnegativeSafeInteger(buckets[key])) ||
      !isPlainRecord(buckets.toolResultHistoryBySource)) {
    return false;
  }
  const sourceEntries = Object.entries(buckets.toolResultHistoryBySource);
  if (!sourceEntries.every(([source, chars]) => source.length > 0 && nonnegativeSafeInteger(chars))) return false;
  const sourceTotal = safeIntegerSum(sourceEntries.map(([, chars]) => chars));
  const bucketTotal = safeIntegerSum(PROMPT_BUCKET_FIELDS.map(([key]) => buckets[key]));
  return sourceTotal === buckets.toolResultHistory && bucketTotal === event.payloadChars;
}

function blankPromptCumulative(payloadChars = null) {
  return {
    payloadChars,
    ...Object.fromEntries(PROMPT_BUCKET_FIELDS.map(([, target]) => [target, null])),
    toolResultHistoryBySource: null,
  };
}

/**
 * Join content-free request footprints, exact provider usage, and the actions
 * chosen by each response. Provider tokens remain whole-request measurements;
 * prompt components are reported in exact serialized characters, never as an
 * invented token split.
 */
export function promptAndPhaseEconomicsOf(events, authoritativeTotals = null) {
  const ledger = Array.isArray(events) ? events : [];
  const requests = ledger.filter((event) => event?.type === 'request');
  const usageEvents = ledger.filter((event) =>
    ['response', 'error'].includes(event?.type) && event?.usage != null
  );
  if (requests.length === 0 && usageEvents.length === 0) {
    return {
      coverage: { status: 'unavailable', complete: false, requestEvents: 0, usageEvents: 0, matchedUsageEvents: 0, reason: 'no request or provider-usage events' },
      prompt: { manifest: null, coverage: { complete: false, requests: 0, requestsWithCompleteBuckets: 0 }, cumulative: null },
      phases: unavailablePhaseMatrix('unavailable'),
      rollups: { 'task-execution': { ...unavailablePhase('unavailable'), derivedFrom: [...TASK_EXECUTION_ECONOMIC_PHASES] } },
      totals: null,
      reconciliation: { complete: false, checks: null, reason: 'authoritative usage is unavailable' },
    };
  }

  const requestIdCounts = new Map();
  let invalidRequestIdentities = 0;
  for (const request of requests) {
    if (typeof request.requestId !== 'string' || request.requestId.length === 0) {
      invalidRequestIdentities += 1;
      continue;
    }
    requestIdCounts.set(request.requestId, (requestIdCounts.get(request.requestId) ?? 0) + 1);
  }
  const duplicateRequestIdentities = [...requestIdCounts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const requestIdentitiesComplete = invalidRequestIdentities === 0 && duplicateRequestIdentities === 0;
  const requestById = new Map(requests
    .filter((event) => requestIdCounts.get(event.requestId) === 1)
    .map((event) => [event.requestId, event]));
  const callsByRequest = new Map();
  for (const event of ledger.filter((candidate) => candidate?.type === 'tool_call' && typeof candidate.requestId === 'string')) {
    if (!callsByRequest.has(event.requestId)) callsByRequest.set(event.requestId, []);
    callsByRequest.get(event.requestId).push(event);
  }
  const terminalsByRequest = new Map();
  for (const event of ledger.filter((candidate) => ['response', 'error'].includes(candidate?.type) && typeof candidate.requestId === 'string')) {
    if (!terminalsByRequest.has(event.requestId)) terminalsByRequest.set(event.requestId, []);
    terminalsByRequest.get(event.requestId).push(event);
  }

  const phaseByRequest = new Map();
  const phases = {};
  for (const request of requests) {
    if (!requestById.has(request.requestId)) {
      phases.unknown ??= freshPhase();
      phases.unknown.logicalRequests += 1;
      continue;
    }
    const selected = new Set((callsByRequest.get(request.requestId) ?? []).map(phaseForToolCall));
    selected.delete('unknown');
    let phase;
    if (selected.size > 1) phase = 'mixed';
    else if (selected.size === 1) phase = [...selected][0];
    else {
      const terminals = terminalsByRequest.get(request.requestId) ?? [];
      phase = terminals.some((event) => event.type === 'response') ? 'finalization' : 'unknown';
    }
    phaseByRequest.set(request.requestId, phase);
    phases[phase] ??= freshPhase();
    phases[phase].logicalRequests += 1;
  }

  let matchedUsageEvents = 0;
  for (const event of usageEvents) {
    const phase = phaseByRequest.get(event.requestId) ?? 'unknown';
    if (requestById.has(event.requestId)) matchedUsageEvents += 1;
    phases[phase] ??= freshPhase();
    addUsageToPhase(phases[phase], event.usage);
  }
  for (const phase of Object.values(phases)) closeEmptyPhaseFields(phase);

  const validManifestRequests = requests.filter((event) => promptComponentManifestValid(event.promptComponentManifest));
  const manifests = validManifestRequests.map((event) => event.promptComponentManifest);
  const manifestHashes = new Set(manifests.map(stableHash));
  const manifestContractComplete = requests.length > 0 &&
    manifests.length === requests.length && manifestHashes.size === 1;
  const manifestComplete = requestIdentitiesComplete && manifestContractComplete;
  const completeBuckets = requests.filter(promptBucketsValid);
  const bucketContractComplete = requests.length > 0 && completeBuckets.length === requests.length;
  const bucketsComplete = requestIdentitiesComplete && bucketContractComplete;
  const payloadChars = requestIdentitiesComplete && requests.length > 0
    ? safeIntegerSum(requests.map((event) => event.payloadChars))
    : null;
  let cumulativeBucketsComplete = bucketsComplete;
  let cumulative;
  if (bucketsComplete) {
    cumulative = {
      payloadChars,
      toolResultHistoryBySource: {},
    };
    for (const [source, target] of PROMPT_BUCKET_FIELDS) {
      cumulative[target] = safeIntegerSum(requests.map((event) => event.promptBuckets[source]));
      if (cumulative[target] == null) cumulativeBucketsComplete = false;
    }
    for (const event of requests) {
      for (const [source, chars] of Object.entries(event.promptBuckets.toolResultHistoryBySource ?? {})) {
        const total = safeIntegerSum([cumulative.toolResultHistoryBySource[source] ?? 0, chars]);
        if (total == null) {
          cumulativeBucketsComplete = false;
          break;
        }
        cumulative.toolResultHistoryBySource[source] = total;
      }
      if (!cumulativeBucketsComplete) break;
    }
    if (payloadChars == null || !cumulativeBucketsComplete) {
      cumulativeBucketsComplete = false;
      cumulative = blankPromptCumulative(payloadChars);
    }
  } else {
    cumulative = blankPromptCumulative(payloadChars);
  }

  const totals = freshPhase();
  totals.logicalRequests = requests.length;
  for (const event of usageEvents) addUsageToPhase(totals, event.usage);
  closeEmptyPhaseFields(totals);

  const reconciliationChecks = {
    modelRequests: authoritativeTotals != null && authoritativeTotals.modelRequests === requests.length,
    promptTokens: authoritativeTotals != null && sameNumber(authoritativeTotals.promptTokens, totals.promptTokens),
    outputTokens: authoritativeTotals != null && sameNumber(authoritativeTotals.outputTokens, totals.outputTokens),
    localCostUsd: authoritativeTotals != null && sameNumber(authoritativeTotals.localCostUsd, totals.localCostUsd),
    reconciledCostUsd: authoritativeTotals != null && sameNumber(authoritativeTotals.reconciledCostUsd, totals.reconciledCostUsd),
  };
  if (authoritativeTotals?.cachedTokensComplete === true) {
    reconciliationChecks.cachedPromptTokens = sameNumber(authoritativeTotals.cachedTokens, totals.cachedPromptTokens);
  }
  if (authoritativeTotals?.reasoningTokensComplete === true) {
    reconciliationChecks.reasoningTokens = sameNumber(authoritativeTotals.reasoningTokens, totals.reasoningTokens);
  }
  if (authoritativeTotals?.providerCostComplete === true && authoritativeTotals.providerCostUsd != null) {
    reconciliationChecks.providerReportedCostUsd = sameNumber(authoritativeTotals.providerCostUsd, totals.providerReportedCostUsd);
  }
  const reconciliationComplete = Object.values(reconciliationChecks).every(Boolean) &&
    authoritativeTotals?.usageComplete === true &&
    authoritativeTotals?.billingComplete === true &&
    authoritativeTotals?.costComplete === true;

  const reasons = [];
  if (invalidRequestIdentities > 0) reasons.push('request identity contract missing or malformed');
  if (duplicateRequestIdentities > 0) reasons.push('duplicate request identities violate the request identity contract');
  if (!manifestContractComplete) reasons.push('prompt component manifest contract missing, malformed, or inconsistent');
  if (!bucketContractComplete) reasons.push('prompt bucket contract missing or malformed');
  if (bucketsComplete && !cumulativeBucketsComplete) reasons.push('prompt bucket cumulative totals exceed the safe integer range');
  if (matchedUsageEvents !== usageEvents.length) reasons.push('provider usage event unmatched to a request');
  if (phaseByRequest.size && [...phaseByRequest.values()].includes('unknown')) reasons.push('one or more request phases are unknown');
  if (!reconciliationComplete) reasons.push('phase usage does not reconcile to authoritative totals');
  const complete = reasons.length === 0;
  for (const phase of Object.values(phases)) phase.status = complete ? 'measured' : 'partial';
  for (const name of ECONOMIC_PHASES) {
    if (!phases[name]) phases[name] = unavailablePhase(complete ? 'not_exercised' : 'unavailable');
  }
  return {
    coverage: {
      status: complete ? 'complete' : 'partial',
      complete,
      requestEvents: requests.length,
      usageEvents: usageEvents.length,
      matchedUsageEvents,
      reason: complete ? null : reasons.join('; '),
    },
    prompt: {
      manifest: manifestComplete ? structuredClone(manifests[0]) : null,
      coverage: {
        complete: manifestComplete && cumulativeBucketsComplete,
        requests: requests.length,
        requestsWithCompleteBuckets: completeBuckets.length,
      },
      cumulative,
    },
    phases,
    rollups: { 'task-execution': taskExecutionRollup(phases, complete ? 'not_exercised' : 'unavailable') },
    totals,
    reconciliation: {
      complete: reconciliationComplete,
      checks: reconciliationChecks,
      reason: reconciliationComplete ? null : 'one or more phase totals do not match the authoritative telemetry ledger',
    },
  };
}

function efficiencyOf(done, startedAt, endedAt) {
  const totals = done?.telemetry?.totals ?? null;
  const events = Array.isArray(done?.telemetry?.events) ? done.telemetry.events : [];
  const hasEventLedger = Array.isArray(done?.telemetry?.events);
  const requests = events.filter((event) => event.type === 'request');
  const calls = events.filter((event) => event.type === 'tool_call');
  const results = events.filter((event) => event.type === 'tool_result');
  const terminalCalls = calls.filter((event) => ['bash', 'runInTerminal'].includes(event.tool));
  const testResults = results.filter((event) => event.category === 'test');
  const editResults = results.filter((event) => event.category === 'edit' && event.exitCode === 0 && numericEventTime(event) != null);
  const verifyResults = results.filter((event) => event.category === 'verify' && event.exitCode === 0 && numericEventTime(event) != null);
  let finalEditToVerify = null;
  if (editResults.length) {
    const finalEdit = Math.max(...editResults.map(numericEventTime));
    const verification = verifyResults.map(numericEventTime).find((value) => value > finalEdit);
    if (verification != null) finalEditToVerify = verification - finalEdit;
  }
  const payloadChars = requests.map((event) => event.payloadChars).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const startMs = Date.parse(startedAt ?? '');
  const endMs = Date.parse(endedAt ?? '');
  return {
    commandTimingSemantics: 'bridge-command-category-heuristic; final workspace state is independently observed',
    wallTimeMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
    timeToFirstTerminalActionMs: eventDelta(events, (event) => event.type === 'tool_call' && ['bash', 'runInTerminal'].includes(event.tool), startedAt),
    timeToFirstEditMs: eventDelta(events, (event) => event.type === 'tool_call' && event.category === 'edit', startedAt),
    timeFromFinalEditToVerificationMs: finalEditToVerify,
    modelRequests: totals?.modelRequests ?? (hasEventLedger ? requests.length : totals?.requests ?? null),
    providerAttempts: totals?.providerAttempts ?? (hasEventLedger ? events.filter((event) => event.type === 'request_attempt').length : null),
    providerResponses: totals?.providerResponses ?? (hasEventLedger ? events.filter((event) => event.type === 'response').length : null),
    providerErrors: totals?.providerErrors ?? (hasEventLedger ? events.filter((event) => event.type === 'error').length : null),
    openProviderAttempts: totals?.openAttempts ?? null,
    unknownBillingAttempts: totals?.unknownBillingAttempts ?? null,
    toolCalls: hasEventLedger ? calls.length : done?.steps ?? null,
    terminalCommands: hasEventLedger ? terminalCalls.length : done?.steps ?? null,
    failedCommands: hasEventLedger
      ? results.filter((event) => ['bash', 'runInTerminal'].includes(event.tool) && event.exitCode != null && event.exitCode !== 0).length
      : null,
    testExecutions: hasEventLedger ? testResults.length : null,
    failedTests: hasEventLedger ? testResults.filter((event) => event.exitCode != null && event.exitCode !== 0).length : null,
    retries: totals?.retries ?? (hasEventLedger ? events.filter((event) => event.type === 'retry').length : null),
    contextCompactions: hasEventLedger ? events.filter((event) => event.type === 'context_compacted').length : null,
    compactedToolResults: hasEventLedger ? events.filter((event) => event.type === 'tool_result_compacted').length : null,
    requestPayloadChars: payloadChars.length ? payloadChars.reduce((sum, value) => sum + value, 0) : hasEventLedger ? 0 : null,
    peakRequestPayloadChars: payloadChars.length ? Math.max(...payloadChars) : hasEventLedger ? 0 : null,
    promptTokens: totals?.promptTokens ?? null,
    cachedPromptTokens: totals?.cachedTokens ?? null,
    reasoningTokens: totals?.reasoningTokens ?? null,
    cachedPromptTokensComplete: totals?.cachedTokensComplete ?? null,
    reasoningTokensComplete: totals?.reasoningTokensComplete ?? null,
    outputTokens: totals?.outputTokens ?? null,
    providerReportedCostUsd: totals?.providerCostUsd ?? null,
    localCostUsd: totals?.localCostUsd ?? null,
    reconciledCostUsd: totals?.reconciledCostUsd ?? null,
    usageComplete: totals?.usageComplete ?? null,
    providerCostComplete: totals?.providerCostComplete ?? null,
    billingComplete: totals?.billingComplete ?? null,
    costComplete: totals?.costComplete ?? null,
    missingUsage: totals?.missingUsage ?? null,
  };
}

/**
 * Collapse one condition's repetition documents into one schema-valid view:
 * strict-majority verdict over valid paired attempts, median reward over
 * valid repetitions, and the median
 * per numeric efficiency field. Budget charging is untouched — every trial charges
 * as it runs; the aggregate represents a typical trial, not the sum.
 */
function medianNumeric(values) {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const middle = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[middle] : (nums[middle - 1] + nums[middle]) / 2;
}

function medianStructure(objects) {
  const selected = objects.filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (!selected.length) return null;
  const output = {};
  const keys = new Set(selected.flatMap((value) => Object.keys(value)));
  for (const key of keys) {
    const values = selected.map((value) => value[key]).filter((value) => value !== undefined);
    const numeric = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
    const booleans = values.filter((value) => typeof value === 'boolean');
    const nested = values.filter((value) => value && typeof value === 'object' && !Array.isArray(value));
    const strings = values.filter((value) => typeof value === 'string');
    if (numeric.length) output[key] = medianNumeric(numeric);
    else if (booleans.length) {
      output[key] = /complete$/i.test(key)
        ? booleans.length === selected.length && booleans.every(Boolean)
        : booleans.every((value) => value === booleans[0]) ? booleans[0] : null;
    } else if (nested.length) output[key] = medianStructure(nested);
    else if (strings.length) output[key] = strings.length === selected.length && strings.every((value) => value === strings[0])
      ? strings[0]
      : null;
    else output[key] = null;
  }
  return output;
}

function aggregateEconomics(numericDocs, allDocs) {
  const numeric = numericDocs.map((doc) => doc.economics).filter(Boolean);
  const all = allDocs.map((doc) => doc.economics).filter(Boolean);
  if (!all.length) return null;
  const allComplete = all.length === allDocs.length && all.every((economics) => economics.coverage?.complete === true);
  const allUnavailable = all.length === allDocs.length && all.every((economics) => economics.coverage?.status === 'unavailable');
  const manifests = numeric.map((economics) => economics.prompt?.manifest).filter(Boolean);
  const stableManifest = manifests.length === numeric.length && new Set(manifests.map(stableHash)).size === 1
    ? structuredClone(manifests[0])
    : null;
  const phases = {};
  const phaseNames = new Set(numeric.flatMap((economics) => Object.keys(economics.phases ?? {})));
  for (const name of phaseNames) {
    const entries = numeric.map((economics) => economics.phases?.[name]).filter(Boolean);
    const statuses = entries.map((entry) => entry.status).filter((value) => typeof value === 'string');
    phases[name] = {
      ...medianStructure(entries),
      status: statuses.length === entries.length && statuses.every((value) => value === statuses[0])
        ? statuses[0]
        : 'aggregate',
      repetitionsObserved: entries.length,
      repetitionCoverage: numeric.length ? entries.length / numeric.length : null,
    };
  }
  const taskExecutionEntries = numeric.map((economics) => economics.rollups?.['task-execution']).filter(Boolean);
  const taskExecutionStatuses = taskExecutionEntries
    .map((entry) => entry.status)
    .filter((value) => typeof value === 'string');
  const taskExecutionRollup = taskExecutionEntries.length ? {
    ...medianStructure(taskExecutionEntries),
    status: taskExecutionStatuses.length === taskExecutionEntries.length &&
      taskExecutionStatuses.every((value) => value === taskExecutionStatuses[0])
      ? taskExecutionStatuses[0]
      : 'aggregate',
    repetitionsObserved: taskExecutionEntries.length,
    repetitionCoverage: numeric.length ? taskExecutionEntries.length / numeric.length : null,
  } : null;
  const checks = medianStructure(all.map((economics) => economics.reconciliation?.checks).filter(Boolean));
  return {
    aggregation: 'median-per-valid-repetition',
    coverage: {
      status: allComplete ? 'complete' : allUnavailable ? 'unavailable' : 'partial',
      complete: allComplete,
      requestEvents: medianNumeric(numeric.map((economics) => economics.coverage?.requestEvents)),
      usageEvents: medianNumeric(numeric.map((economics) => economics.coverage?.usageEvents)),
      matchedUsageEvents: medianNumeric(numeric.map((economics) => economics.coverage?.matchedUsageEvents)),
      reason: allComplete ? null : 'one or more repetitions have incomplete prompt or phase economics',
    },
    prompt: {
      manifest: stableManifest,
      coverage: {
        complete: all.length === allDocs.length && all.every((economics) => economics.prompt?.coverage?.complete === true),
        requests: medianNumeric(numeric.map((economics) => economics.prompt?.coverage?.requests)),
        requestsWithCompleteBuckets: medianNumeric(numeric.map((economics) => economics.prompt?.coverage?.requestsWithCompleteBuckets)),
      },
      cumulative: medianStructure(numeric.map((economics) => economics.prompt?.cumulative).filter(Boolean)),
    },
    phases,
    rollups: { 'task-execution': taskExecutionRollup },
    totals: medianStructure(numeric.map((economics) => economics.totals).filter(Boolean)),
    reconciliation: {
      complete: all.length === allDocs.length && all.every((economics) => economics.reconciliation?.complete === true),
      checks,
      reason: all.length === allDocs.length && all.every((economics) => economics.reconciliation?.complete === true)
        ? null
        : 'one or more repetitions do not reconcile phase usage to authoritative totals',
    },
  };
}

export function aggregateRepetitionDocs(docs, { validMask = null } = {}) {
  if (!docs.length) throw new Error('at least one repetition document is required');
  if (validMask && validMask.length !== docs.length) throw new Error('validMask must align with repetition documents');
  const rawRepetitions = docs.map((doc) => {
    const copy = structuredClone(doc);
    delete copy.repetitions;
    return copy;
  });
  const isValid = (doc, index) =>
    doc.correctness?.verifierReward != null && (validMask == null || validMask[index] === true);
  const valid = docs.filter(isValid);
  const median = (values) => {
    const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  };
  const passes = valid.filter((d) => d.correctness?.verdict === 'pass').length;
  const base = structuredClone(valid[0] ?? docs[0]);
  delete base.repetitions;
  base.correctness.verdict = valid.length > 0 && passes > valid.length / 2 ? 'pass' : 'fail';
  base.correctness.verifierReward = median(valid.map((d) => d.correctness.verifierReward));
  base.correctness.exitReason = `repetition-aggregate(n=${docs.length});valid=${valid.length}`;
  base.correctness.completedWithinTimeout = docs.every((d) => d.correctness?.completedWithinTimeout !== false);
  base.correctness.completedWithinBudget = docs.every((d) => d.correctness?.completedWithinBudget !== false);
  for (const key of Object.keys(base.efficiency ?? {})) {
    base.efficiency[key] = median((valid.length ? valid : docs).map((d) => d.efficiency?.[key]));
  }
  base.efficiency.commandTimingSemantics = docs.every(
    (doc) => doc.efficiency?.commandTimingSemantics === docs[0].efficiency?.commandTimingSemantics
  ) ? docs[0].efficiency?.commandTimingSemantics ?? null : null;
  // Cost completeness is an all-repetitions invariant, not a typical/median value:
  // one unmetered paid response invalidates the aggregate's spend evidence.
  base.efficiency.costComplete = docs.every((d) => d.efficiency?.costComplete === true);
  for (const key of ['usageComplete', 'providerCostComplete', 'billingComplete', 'cachedPromptTokensComplete', 'reasoningTokensComplete']) {
    const values = docs.map((doc) => doc.efficiency?.[key]).filter((value) => typeof value === 'boolean');
    base.efficiency[key] = values.length ? values.length === docs.length && values.every(Boolean) : null;
  }
  base.efficiency.billingUncertain = docs.some((doc) => doc.efficiency?.billingUncertain === true);
  base.efficiency.missingUsage = docs.reduce(
    (sum, d) => sum + (Number.isFinite(d.efficiency?.missingUsage) ? d.efficiency.missingUsage : 0),
    0
  );
  base.economics = aggregateEconomics(valid.length ? valid : docs, docs);
  for (const key of Object.keys(base.harnessBehavior ?? {})) {
    const values = docs.map((doc) => doc.harnessBehavior?.[key]);
    const numeric = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
    const booleans = values.filter((value) => typeof value === 'boolean');
    if (numeric.length) {
      base.harnessBehavior[key] = median(numeric);
    } else if (booleans.length) {
      base.harnessBehavior[key] = key === 'policyBypassAchieved' || key === 'policyBypassAttempted'
        ? booleans.some(Boolean)
        : booleans.length === docs.length && booleans.every((value) => value === booleans[0])
          ? booleans[0]
          : null;
    } else {
      base.harnessBehavior[key] = null;
    }
  }
  // An aggregate spans multiple independent sandboxes and verifier trees. Its
  // own hash would be a new synthetic artifact, not a workspace diff, so the
  // hashes stay only on the retained repetition documents.
  base.correctness.finalDiffHash = null;
  base.correctness.verifierArtifactHash = null;
  if (docs.some((doc) => doc.workspaceEvidence)) {
    base.workspaceEvidence = {
      available: false,
      collectionMode: 'per-repetition',
      beforeManifestHash: null,
      afterManifestHash: null,
      diffHash: null,
      changedPaths: [
        ...new Set(docs.flatMap((doc) => doc.workspaceEvidence?.changedPaths ?? []).filter((value) => typeof value === 'string')),
      ].slice(0, 200),
      changedPathCount: docs.reduce(
        (total, doc) => total + (Number.isFinite(doc.workspaceEvidence?.changedPathCount)
          ? doc.workspaceEvidence.changedPathCount
          : doc.workspaceEvidence?.changedPaths?.length ?? 0),
        0
      ),
      changedPathsTruncated: docs.some((doc) => doc.workspaceEvidence?.changedPathsTruncated === true),
      reason: 'workspace-evidence-retained-per-repetition',
    };
  }
  const observed = docs.filter((doc) => doc.observability);
  if (observed.length) {
    const sum = (key) => observed.reduce((total, doc) => total + (Number.isFinite(doc.observability[key]) ? doc.observability[key] : 0), 0);
    const runtimeEvidence = observed.map((doc) => doc.observability.runtimeContractEvidence).filter(Boolean);
    const mountEvidence = observed.map((doc) => doc.observability.mountPolicyEvidence).filter(Boolean);
    const everyRepetitionObserved = observed.length === docs.length;
    const harnessEvidenceAvailable = everyRepetitionObserved &&
      observed.every((doc) => doc.observability.harnessEventEvidence?.available === true);
    const harnessEvidenceComplete = everyRepetitionObserved &&
      observed.every((doc) => doc.observability.harnessEventEvidence?.complete === true);
    base.observability = {
      // Full ledgers live exactly once under `repetitions`; aggregate evidence
      // is counters plus an ordered commitment to those retained ledgers.
      providerEvents: [],
      toolEvents: [],
      harnessEvents: [],
      harnessEventEvidence: {
        available: harnessEvidenceAvailable,
        complete: harnessEvidenceComplete,
        reason: harnessEvidenceAvailable
          ? harnessEvidenceComplete
            ? null
            : 'one-or-more-repetitions-have-incomplete-harness-event-projection'
          : 'one-or-more-repetitions-missing-harness-events',
        retainedEvents: observed.reduce(
          (total, doc) => total + (Number.isFinite(doc.observability.harnessEventEvidence?.retainedEvents)
            ? doc.observability.harnessEventEvidence.retainedEvents
            : 0),
          0
        ),
        sourceTruncated: observed.some((doc) => doc.observability.harnessEventEvidence?.sourceTruncated === true),
        projectionRejectedEvents: observed.reduce(
          (total, doc) => total + (Number.isFinite(doc.observability.harnessEventEvidence?.projectionRejectedEvents)
            ? doc.observability.harnessEventEvidence.projectionRejectedEvents
            : 0),
          0
        ),
        projectionRejectedChecks: observed.reduce(
          (total, doc) => total + (Number.isFinite(doc.observability.harnessEventEvidence?.projectionRejectedChecks)
            ? doc.observability.harnessEventEvidence.projectionRejectedChecks
            : 0),
          0
        ),
      },
      providerAttemptsStarted: sum('providerAttemptsStarted'),
      providerAttemptsClosed: sum('providerAttemptsClosed'),
      unclosedProviderAttempts: sum('unclosedProviderAttempts'),
      uncorrelatedProviderTerminals: sum('uncorrelatedProviderTerminals'),
      duplicateProviderAttemptIdentities: sum('duplicateProviderAttemptIdentities'),
      duplicateProviderTerminalIdentities: sum('duplicateProviderTerminalIdentities'),
      invalidProviderEventIdentities: sum('invalidProviderEventIdentities'),
      correlatedToolResults: sum('correlatedToolResults'),
      uncorrelatedToolResults: sum('uncorrelatedToolResults'),
      unclosedToolCalls: sum('unclosedToolCalls'),
      duplicateToolCallIdentities: sum('duplicateToolCallIdentities'),
      duplicateToolResultIdentities: sum('duplicateToolResultIdentities'),
      invalidToolEventIdentities: sum('invalidToolEventIdentities'),
      malformedToolCallEvidence: sum('malformedToolCallEvidence'),
      malformedToolResultEvidence: sum('malformedToolResultEvidence'),
      invalidToolArguments: sum('invalidToolArguments'),
      incompleteToolContainment: sum('incompleteToolContainment'),
      controlContaminationAttempted: observed.some((doc) => doc.observability.controlContaminationAttempted === true),
      controlContaminationAchieved: observed.some((doc) => doc.observability.controlContaminationAchieved === true),
      controlContaminationDetected: observed.some((doc) => doc.observability.controlContaminationDetected === true),
      runtimeContractEvidence: {
        complete: runtimeEvidence.length === docs.length && runtimeEvidence.every((entry) => entry.complete === true),
        matchesExpected: runtimeEvidence.length === docs.length && runtimeEvidence.every((entry) => entry.matchesExpected === true),
        expectedSystemPromptHash: null,
        actualSystemPromptHash: null,
        expectedToolSchemaHash: null,
        actualToolSchemaHash: null,
        expectedToolCount: null,
        actualToolCount: null,
        expectedFinishToolSchemaHash: null,
        expectedFinishToolCount: null,
        expectedPromptComponentManifestHash: null,
        actualPromptComponentManifestHash: null,
        requestContractsChecked: runtimeEvidence.reduce((total, entry) => total + (entry.requestContractsChecked ?? 0), 0),
        postVerifyRequestContracts: runtimeEvidence.reduce((total, entry) => total + (entry.postVerifyRequestContracts ?? 0), 0),
        requestPromptMismatches: runtimeEvidence.reduce((total, entry) => total + (entry.requestPromptMismatches ?? 0), 0),
        requestPromptManifestMismatches: runtimeEvidence.reduce(
          (total, entry) => total + (entry.requestPromptManifestMismatches ?? 0),
          0
        ),
        requestPromptBucketMismatches: runtimeEvidence.reduce(
          (total, entry) => total + (entry.requestPromptBucketMismatches ?? 0),
          0
        ),
        requestControlMismatches: runtimeEvidence.reduce((total, entry) => total + (entry.requestControlMismatches ?? 0), 0),
        requestContractMismatches: runtimeEvidence.reduce((total, entry) => total + (entry.requestContractMismatches ?? 0), 0),
        expectedRequestControlHash: null,
        expectedInstructionHash: null,
        actualInstructionHash: null,
        instructionHash: null,
        reason: runtimeEvidence.length === docs.length && runtimeEvidence.every((entry) => entry.matchesExpected === true)
          ? 'runtime-evidence-retained-per-repetition'
          : 'one-or-more-repetitions-have-invalid-runtime-contract-evidence',
      },
      mountPolicyEvidence: {
        version: null,
        source: mountEvidence.length === docs.length && mountEvidence.every((entry) => entry.source === 'sandbox-observed')
          ? 'sandbox-observed'
          : null,
        observed: mountEvidence.length === docs.length && mountEvidence.every((entry) => entry.observed === true),
        complete: mountEvidence.length === docs.length && mountEvidence.every((entry) => entry.complete === true),
        matchesCondition: mountEvidence.length === docs.length && mountEvidence.every((entry) => entry.matchesCondition === true),
        structurallyIsolated: mountEvidence.length === docs.length && mountEvidence.every((entry) => entry.structurallyIsolated === true),
        effectiveTargets: [],
        observedTargets: [],
        observedExistingTargets: [],
        commonTargets: [],
        treatmentOnlyTargets: [],
        reason: mountEvidence.length === docs.length && mountEvidence.every((entry) =>
          entry.complete === true && entry.matchesCondition === true && entry.structurallyIsolated === true)
          ? 'mount-policy-evidence-retained-per-repetition'
          : 'one-or-more-repetitions-have-invalid-mount-policy-evidence',
      },
      eventEvidenceHash: stableHash({
        schema: 'aggregate-event-evidence.v1',
        repetitions: docs.map((doc) => doc.observability?.eventEvidenceHash ?? null),
      }),
    };
  }
  base.reproducibility.startedAt = docs[0].reproducibility?.startedAt ?? base.reproducibility.startedAt;
  base.reproducibility.endedAt = docs.at(-1).reproducibility?.endedAt ?? base.reproducibility.endedAt;
  base.reproducibility.repetitionId = null;
  base.reproducibility.repetitionIndex = null;
  base.reproducibility.orderIndex = null;
  base.reproducibility.aggregation = 'majority-verdict-median-efficiency';
  const attributions = docs.map((doc) => doc.reproducibility?.attribution).filter(Boolean);
  if (attributions.length) {
    base.reproducibility.attribution = {
      responseCount: attributions.reduce(
        (total, attribution) => total + (Number.isFinite(attribution.responseCount) ? attribution.responseCount : 0),
        0
      ),
      complete: attributions.length === docs.length && attributions.every((attribution) => attribution.complete === true),
      fallbackDetected: attributions.some((attribution) => attribution.fallbackDetected === true),
    };
  }
  base.validRepetitionCount = valid.length;
  base.invalidRepetitionCount = docs.length - valid.length;
  if (base.observability) {
    base.reproducibility.telemetryHash = stableHash(
      docs.map((doc) => doc.reproducibility?.telemetryHash ?? null)
    );
    base.reproducibility.harnessEventsHash = stableHash(
      docs.map((doc) => doc.reproducibility?.harnessEventsHash ?? null)
    );
  }
  base.repetitions = rawRepetitions;
  return base;
}

// Compatibility for internal callers created before repetitions were named
// accurately. No provider seed is sent by this runner.
export const aggregateSeedDocs = aggregateRepetitionDocs;

/** One trial's eval-run.v1 document, from harbor + verifier + bridge evidence. */
export function buildRunDoc({
  condition,
  task,
  evidence,
  done,
  run,
  profile,
  lock,
  releaseSha,
  harnessVersion,
  startedAt,
  endedAt,
  identity = {},
  conditionDocument = null,
  hostId,
  bundleManifestHash = null,
  expectedInstructionHash = null,
  mountPolicyEvidence = null,
  sandboxIdentity = null,
  runnerVersion = `harbor-${SUPPORTED_HARBOR_VERSION}/bridge-1`,
}) {
  if (typeof hostId !== 'string' || hostId.length === 0) {
    throw new Error('hostId is required when building a run document');
  }
  const trustedAssertions = evidence?.assertionEvidenceTrusted === true
    ? evidence.pytest ?? null
    : null;
  const telemetryLedgerPresent = Array.isArray(done?.telemetry?.events);
  const telemetryEvents = telemetryLedgerPresent ? done.telemetry.events : [];
  const telemetryTotals = done?.telemetry?.totals ?? null;
  const responses = telemetryEvents.filter((event) => event.type === 'response');
  const lastResponse = responses.at(-1) ?? null;
  const stopReason = done?.stopReason ?? (run.timedOut ? 'timeout' : 'unknown');
  const harnessEvents = harnessEventsOf(done);
  const harnessEventEvidence = harnessEventEvidenceOf(done, harnessEvents);
  const workspaceEvidence = workspaceEvidenceOf(done);
  const providerEvents = telemetryEvents.filter((event) => PROVIDER_EVENT_TYPES.has(event.type));
  const toolEvents = telemetryEvents.filter((event) => TOOL_EVENT_TYPES.has(event.type));
  const attempts = providerEvents.filter((event) => event.type === 'request_attempt');
  const terminalAttempts = providerEvents.filter((event) => ['response', 'error'].includes(event.type));
  const attemptIdentities = identityCounts(attempts, providerAttemptIdentity);
  const terminalIdentities = identityCounts(terminalAttempts, providerAttemptIdentity);
  const allProviderIdentities = new Set([...attemptIdentities.counts.keys(), ...terminalIdentities.counts.keys()]);
  let providerAttemptsClosed = 0;
  let unclosedProviderAttempts = attemptIdentities.invalid;
  let uncorrelatedProviderTerminals = terminalIdentities.invalid;
  for (const key of allProviderIdentities) {
    const attemptCount = attemptIdentities.counts.get(key) ?? 0;
    const terminalCount = terminalIdentities.counts.get(key) ?? 0;
    providerAttemptsClosed += Math.min(attemptCount, terminalCount);
    unclosedProviderAttempts += Math.max(0, attemptCount - terminalCount);
    uncorrelatedProviderTerminals += Math.max(0, terminalCount - attemptCount);
  }
  const duplicateProviderAttemptIdentities = [...attemptIdentities.counts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const duplicateProviderTerminalIdentities = [...terminalIdentities.counts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const invalidProviderEventIdentities = attemptIdentities.invalid + terminalIdentities.invalid;
  const toolCalls = toolEvents.filter((event) => event.type === 'tool_call');
  const toolResults = toolEvents.filter((event) => event.type === 'tool_result');
  const callIdentities = identityCounts(toolCalls);
  const resultIdentities = identityCounts(toolResults);
  const allToolIdentities = new Set([...callIdentities.counts.keys(), ...resultIdentities.counts.keys()]);
  let correlatedToolResults = 0;
  let unclosedToolCalls = callIdentities.invalid;
  let uncorrelatedToolResults = resultIdentities.invalid;
  for (const key of allToolIdentities) {
    const callCount = callIdentities.counts.get(key) ?? 0;
    const resultCount = resultIdentities.counts.get(key) ?? 0;
    correlatedToolResults += Math.min(callCount, resultCount);
    unclosedToolCalls += Math.max(0, callCount - resultCount);
    uncorrelatedToolResults += Math.max(0, resultCount - callCount);
  }
  const duplicateToolCallIdentities = [...callIdentities.counts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const duplicateToolResultIdentities = [...resultIdentities.counts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const invalidToolEventIdentities = callIdentities.invalid + resultIdentities.invalid;
  const malformedToolCallEvidence = toolCalls.filter((event) => !completeToolCallEvidence(event)).length;
  const malformedToolResultEvidence = toolResults.filter((event) => !completeToolResultEvidence(event)).length;
  const invalidToolArguments = toolCalls.filter((event) => event.argumentsValid === false).length;
  const incompleteToolContainment = toolResults.filter((event) => event.containmentComplete !== true).length;
  const genericHarnessCalls = condition === 'generic' ? toolCalls.filter(harnessExecutableCall) : [];
  const resultForCall = (call) => toolResults.find((result) => toolEventIdentity(result) === toolEventIdentity(call));
  const controlContaminationAttempted = genericHarnessCalls.length > 0;
  const controlContaminationAchieved = genericHarnessCalls.some((call) => {
    const exitCode = resultForCall(call)?.exitCode;
    return Number.isInteger(exitCode) && ![126, 127].includes(exitCode);
  });
  const taskEntry = tasksOf(lock).find((entry) => entry.task === task);
  const taskHash = taskEntry?.taskChecksum ?? null;
  const conditionHash = conditionDocument ? stableHash(conditionDocument) : null;
  const runtime = conditionDocument?.runtime ?? {};
  const expectedSystemPromptHash = typeof conditionDocument?.systemPrompt === 'string'
    ? sha256(conditionDocument.systemPrompt)
    : null;
  const expectedBridgeTools = conditionDocument
    ? runtimeBridgeTools({
        guidanceCatalog: runtime.guidanceCatalog ?? conditionDocument.guidanceCatalog ?? null,
        enableCheckpoint: runtime.checkpoint === true,
        enableTrustedVerify: runtime.trustedVerify === true,
      })
    : null;
  // This expected representation is intentionally built independently of the
  // driver's normalization. The observed hashes below come from the exact
  // provider request bodies, so a transformation or tool-selection regression
  // cannot attest itself.
  const expectedTools = expectedBridgeTools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  })) ?? null;
  const expectedFinishTools = expectedTools?.filter((tool) => tool.function.name === 'finish') ?? null;
  const expectedToolSchemaHash = expectedTools ? stableHash(expectedTools) : null;
  const expectedToolCount = expectedTools?.length ?? null;
  const expectedFinishToolSchemaHash = expectedFinishTools ? stableHash(expectedFinishTools) : null;
  const expectedFinishToolCount = expectedFinishTools?.length ?? null;
  const expectedRequestControls = conditionDocument ? {
    endpointHash: sha256(conditionDocument.providerUrl),
    model: profile.model,
    maxTokens: conditionDocument.limits?.maxOutputTokens ?? profile.maxTokens,
    temperaturePresent: profile.temperature != null,
    temperature: profile.temperature ?? null,
    reasoningPresent: profile.reasoning != null,
    reasoning: profile.reasoning ?? null,
    toolChoice: 'auto',
    providerPresent: profile.provider != null,
    providerOrder: Array.isArray(profile.provider?.order) ? profile.provider.order.slice() : null,
    providerAllowFallbacks: profile.provider != null && typeof profile.provider.allowFallbacks === 'boolean'
      ? profile.provider.allowFallbacks
      : null,
    unexpectedRequestFields: [],
  } : null;
  const expectedRequestControlHash = expectedRequestControls ? stableHash(expectedRequestControls) : null;
  const expectedPromptComponentManifest = conditionDocument?.promptComponentManifest ?? null;
  const expectedPromptComponentManifestHash = expectedPromptComponentManifest
    ? stableHash(expectedPromptComponentManifest)
    : null;
  const runtimePromptComponentManifest = done?.runtime?.promptComponentManifest ?? null;
  const claimedRuntimePromptComponentManifestHash = done?.runtime?.promptComponentManifestHash ?? null;
  const actualPromptComponentManifestHash = runtimePromptComponentManifest
    ? stableHash(runtimePromptComponentManifest)
    : null;
  const requestContracts = providerEvents.filter((event) => event.type === 'request');
  const firstFullRequest = requestContracts.find((event) => event.toolMode === 'full') ?? null;
  const actualSystemPromptHash = SHA256_HEX.test(String(firstFullRequest?.systemPromptHash ?? ''))
    ? firstFullRequest.systemPromptHash.toLowerCase()
    : null;
  const actualToolSchemaHash = SHA256_HEX.test(String(firstFullRequest?.toolSchemaHash ?? ''))
    ? firstFullRequest.toolSchemaHash.toLowerCase()
    : null;
  const instructionHash = SHA256_HEX.test(String(firstFullRequest?.instructionHash ?? ''))
    ? firstFullRequest.instructionHash.toLowerCase()
    : null;
  const normalizedExpectedInstructionHash = SHA256_HEX.test(String(expectedInstructionHash ?? ''))
    ? expectedInstructionHash.toLowerCase()
    : null;
  const actualToolCount = Number.isInteger(firstFullRequest?.toolCount) && firstFullRequest.toolCount >= 0
    ? firstFullRequest.toolCount
    : null;
  const requestPromptShapeValid = (event) =>
    event.systemPromptPosition === 0 &&
    event.instructionPosition === 1 &&
    [0, 1].includes(event.durableStateMessageCount) &&
    (event.durableStateMessageCount === 0 || (
      event.durableStateMessageIndex === 2 &&
      SHA256_HEX.test(String(event.durableStateMessageHash ?? '')) &&
      Number.isInteger(event.stateRevision) && event.stateRevision >= 0
    )) &&
    event.systemMessageCount === 1 + event.durableStateMessageCount &&
    event.unexpectedSystemMessageCount === 0 &&
    event.instructionMessageCount === 1;
  const requestControlsOf = (event) => ({
    endpointHash: event.endpointHash ?? null,
    model: event.model ?? null,
    maxTokens: event.maxTokens ?? null,
    temperaturePresent: event.temperaturePresent,
    temperature: event.temperature ?? null,
    reasoningPresent: event.reasoningPresent,
    reasoning: event.reasoning ?? null,
    toolChoice: event.toolChoice ?? null,
    providerPresent: event.providerPresent,
    providerOrder: Array.isArray(event.providerOrder) ? event.providerOrder.slice() : null,
    providerAllowFallbacks: event.providerAllowFallbacks ?? null,
    unexpectedRequestFields: Array.isArray(event.unexpectedRequestFields)
      ? event.unexpectedRequestFields.slice()
      : null,
  });
  const requestControlShapeValid = (event) =>
    SHA256_HEX.test(String(event.requestBodyHash ?? '')) &&
    SHA256_HEX.test(String(event.requestControlHash ?? '')) &&
    SHA256_HEX.test(String(event.endpointHash ?? '')) &&
    typeof event.model === 'string' && event.model.length > 0 &&
    Number.isInteger(event.maxTokens) && event.maxTokens > 0 &&
    typeof event.temperaturePresent === 'boolean' &&
    typeof event.reasoningPresent === 'boolean' &&
    typeof event.providerPresent === 'boolean' &&
    Array.isArray(event.unexpectedRequestFields) &&
    event.unexpectedRequestFields.every((field) => typeof field === 'string') &&
    event.requestControlHash === stableHash(requestControlsOf(event));
  const promptManifestEvidencePresent = promptComponentManifestValid;
  const promptManifestMatchesExpected = (manifest) =>
    promptManifestEvidencePresent(manifest) && stableHash(manifest) === expectedPromptComponentManifestHash;
  const promptBucketEvidencePresent = (event) => event.promptBuckets != null &&
    typeof event.promptBuckets === 'object' && Number.isInteger(event.payloadChars) && event.payloadChars >= 0;
  const promptBucketValid = promptBucketsValid;
  const requestContractComplete = requestContracts.length > 0 && requestContracts.every((event) =>
    ['full', 'finish-only'].includes(event.toolMode) &&
    SHA256_HEX.test(String(event.toolSchemaHash ?? '')) &&
    SHA256_HEX.test(String(event.systemPromptHash ?? '')) &&
    SHA256_HEX.test(String(event.instructionHash ?? '')) &&
    requestPromptShapeValid(event) &&
    requestControlShapeValid(event) &&
    promptManifestEvidencePresent(event.promptComponentManifest) &&
    promptBucketEvidencePresent(event) &&
    Number.isInteger(event.toolCount) && event.toolCount >= 0 &&
    typeof event.postVerify === 'boolean'
  );
  const requestPromptManifestMismatches = requestContracts.filter((event) =>
    !promptManifestMatchesExpected(event.promptComponentManifest)
  ).length;
  const requestPromptBucketMismatches = requestContracts.filter((event) => !promptBucketValid(event)).length;
  const requestPromptMismatches = requestContracts.filter((event) =>
    event.systemPromptHash !== expectedSystemPromptHash ||
    event.instructionHash !== normalizedExpectedInstructionHash ||
    !requestPromptShapeValid(event)
  ).length;
  const requestControlMismatches = requestContracts.filter((event) =>
    !requestControlShapeValid(event) ||
    event.requestControlHash !== expectedRequestControlHash ||
    stableHash(requestControlsOf(event)) !== expectedRequestControlHash
  ).length;
  const requestContractMismatches = requestContracts.filter((event) => {
    const finishOnly = event.postVerify === true;
    const expectedHash = finishOnly ? expectedFinishToolSchemaHash : expectedToolSchemaHash;
    const expectedCount = finishOnly ? expectedFinishToolCount : expectedToolCount;
    return event.toolMode !== (finishOnly ? 'finish-only' : 'full') ||
      event.toolSchemaHash !== expectedHash || event.toolCount !== expectedCount ||
      event.systemPromptHash !== expectedSystemPromptHash ||
      event.instructionHash !== normalizedExpectedInstructionHash ||
      !requestPromptShapeValid(event) ||
      !requestControlShapeValid(event) ||
      event.requestControlHash !== expectedRequestControlHash;
  }).length;
  const runtimeContractComplete = Boolean(
    expectedSystemPromptHash && expectedToolSchemaHash && Number.isInteger(expectedToolCount) &&
    expectedPromptComponentManifestHash && actualPromptComponentManifestHash &&
    SHA256_HEX.test(String(claimedRuntimePromptComponentManifestHash ?? '')) &&
    actualSystemPromptHash && actualToolSchemaHash && instructionHash && normalizedExpectedInstructionHash &&
    Number.isInteger(actualToolCount) && requestContractComplete
  );
  const runtimeContractMatches = runtimeContractComplete &&
    actualSystemPromptHash === expectedSystemPromptHash &&
    actualToolSchemaHash === expectedToolSchemaHash &&
    actualToolCount === expectedToolCount &&
    instructionHash === normalizedExpectedInstructionHash &&
    actualPromptComponentManifestHash === expectedPromptComponentManifestHash &&
    claimedRuntimePromptComponentManifestHash === actualPromptComponentManifestHash &&
    requestPromptManifestMismatches === 0 &&
    requestPromptBucketMismatches === 0 &&
    requestControlMismatches === 0 &&
    requestContractMismatches === 0;
  const runtimeContractReason = !runtimeContractComplete
    ? 'runtime-attestation-missing-or-malformed'
    : runtimeContractMatches
      ? null
      : [
          actualSystemPromptHash !== expectedSystemPromptHash ? 'system-prompt-hash-mismatch' : null,
          actualToolSchemaHash !== expectedToolSchemaHash ? 'tool-schema-hash-mismatch' : null,
          actualToolCount !== expectedToolCount ? 'tool-count-mismatch' : null,
          instructionHash !== normalizedExpectedInstructionHash ? 'instruction-hash-mismatch' : null,
          actualPromptComponentManifestHash !== expectedPromptComponentManifestHash ||
            claimedRuntimePromptComponentManifestHash !== actualPromptComponentManifestHash
            ? 'runtime-prompt-manifest-mismatch'
            : null,
          !requestContractComplete ? 'request-tool-contract-missing-or-malformed' : null,
          requestPromptMismatches !== 0 ? 'request-prompt-contract-mismatch' : null,
          requestPromptManifestMismatches !== 0 ? 'request-prompt-manifest-mismatch' : null,
          requestPromptBucketMismatches !== 0 ? 'request-prompt-bucket-mismatch' : null,
          requestControlMismatches !== 0 ? 'request-control-contract-mismatch' : null,
          requestContractMismatches !== 0 ? 'request-tool-contract-mismatch' : null,
        ].filter(Boolean).join(';');
  const providerRequestedOrder = Array.isArray(profile.provider?.order) ? profile.provider.order.slice() : [];
  const providerExpectedResolvedNames = Array.isArray(profile.provider?.expectedResolvedNames)
    ? profile.provider.expectedResolvedNames.slice()
    : providerRequestedOrder.slice();
  const normalizedResolvedProviders = providerExpectedResolvedNames.map(normalizeProviderName);
  const attributionComplete =
    responses.length > 0 &&
    telemetryTotals?.providerResponses === responses.length &&
    responses.every((response) =>
      typeof response.model === 'string' && response.model.length > 0 &&
      (providerRequestedOrder.length === 0 || (typeof response.provider === 'string' && response.provider.length > 0))
    );
  const fallbackDetected =
    providerEvents.some((event) => event.type === 'fallback') ||
    responses.some((response) => response.model !== profile.model) ||
    responses.some((response) =>
      providerRequestedOrder.length > 0 && !normalizedResolvedProviders.includes(normalizeProviderName(response.provider))
    );
  return {
    schema: 'eval-run.v1',
    reproducibility: {
      releaseSha,
      harnessVersion,
      harnessContentHash: condition === 'harness' ? actualSystemPromptHash : null,
      taskId: task,
      taskRevision: lock.datasetRef,
      condition,
      modelProfileId: profile.id,
      billingProfileHash: billingProfileHash(profile.id),
      pricingCatalogCheckedAt: profile.catalogPin?.checkedAt ?? null,
      modelRequested: profile.model,
      modelResolved: lastResponse?.model ?? null,
      providerResolved: lastResponse?.provider ?? null,
      providerRequestedOrder,
      providerExpectedResolvedNames,
      attribution: {
        responseCount: responses.length,
        complete: attributionComplete,
        fallbackDetected,
      },
      host: hostId,
      reasoningConfig: profile.reasoning,
      runnerVersion,
      sandbox: sandboxIdentity,
      startedAt,
      endedAt,
      pairId: identity.pairId ?? null,
      repetitionId: identity.repetitionId ?? null,
      repetitionIndex: identity.repetitionIndex ?? null,
      orderIndex: identity.orderIndex ?? null,
      attempt: identity.attempt ?? null,
      aggregation: null,
      trialCeilingUsd: conditionDocument?.limits?.trialCeilingUsd ?? null,
      taskHash,
      bundleManifestHash,
      conditionHash,
      systemPromptHash: actualSystemPromptHash,
      instructionHash,
      toolSchemaHash: actualToolSchemaHash,
      telemetryHash: telemetryEvents.length ? stableHash(telemetryEvents) : null,
      harnessEventsHash: harnessEvents ? stableHash(harnessEvents) : null,
    },
    correctness: {
      verifierReward: evidence.reward,
      verdict: verdictFromReward(evidence.reward, { passingReward: lock.verifier.passingReward }),
      assertionsPassed: trustedAssertions?.passed ?? null,
      assertionsFailed: trustedAssertions?.failed ?? null,
      requiredFilesCreated: null,
      finalDiffHash: workspaceEvidence.diffHash,
      verifierArtifactHash: evidence.treeHash ?? null,
      exitReason: stopReason,
      completedWithinTimeout: !run.timedOut,
      completedWithinBudget: stopReason !== 'budget_exhausted',
    },
    efficiency: efficiencyOf(done, startedAt, endedAt),
    economics: promptAndPhaseEconomicsOf(telemetryEvents, telemetryTotals),
    harnessBehavior: deriveHarnessBehavior(condition, telemetryEvents, harnessEvents, harnessEventEvidence, done, telemetryLedgerPresent),
    enforcementFidelity: enforcementFidelityOf(condition, done, harnessEvents, toolEvents),
    workspaceEvidence,
    observability: {
      providerEvents,
      toolEvents,
      harnessEvents: harnessEvents ?? [],
      harnessEventEvidence,
      providerAttemptsStarted: attempts.length,
      providerAttemptsClosed,
      unclosedProviderAttempts,
      uncorrelatedProviderTerminals,
      duplicateProviderAttemptIdentities,
      duplicateProviderTerminalIdentities,
      invalidProviderEventIdentities,
      correlatedToolResults,
      uncorrelatedToolResults,
      unclosedToolCalls,
      duplicateToolCallIdentities,
      duplicateToolResultIdentities,
      invalidToolEventIdentities,
      malformedToolCallEvidence,
      malformedToolResultEvidence,
      invalidToolArguments,
      incompleteToolContainment,
      controlContaminationAttempted,
      controlContaminationAchieved,
      // Backward-compatible name: detection now means successful access, not
      // a harmless failed isolation probe.
      controlContaminationDetected: controlContaminationAchieved,
      runtimeContractEvidence: {
        complete: runtimeContractComplete,
        matchesExpected: runtimeContractMatches,
        expectedSystemPromptHash,
        actualSystemPromptHash,
        expectedToolSchemaHash,
        actualToolSchemaHash,
        expectedToolCount,
        actualToolCount,
        expectedFinishToolSchemaHash,
        expectedFinishToolCount,
        expectedPromptComponentManifestHash,
        actualPromptComponentManifestHash,
        requestContractsChecked: requestContracts.length,
        postVerifyRequestContracts: requestContracts.filter((event) => event.postVerify === true).length,
        requestPromptMismatches,
        requestPromptManifestMismatches,
        requestPromptBucketMismatches,
        requestControlMismatches,
        requestContractMismatches,
        expectedRequestControlHash,
        expectedInstructionHash: normalizedExpectedInstructionHash,
        actualInstructionHash: instructionHash,
        instructionHash,
        reason: runtimeContractReason,
      },
      mountPolicyEvidence: mountPolicyEvidence ?? {
        version: null,
        source: null,
        observed: false,
        complete: false,
        matchesCondition: false,
        structurallyIsolated: false,
        effectiveTargets: [],
        observedTargets: [],
        observedExistingTargets: [],
        commonTargets: [],
        treatmentOnlyTargets: [],
        reason: 'mount-policy-evidence-missing',
      },
      eventEvidenceHash: stableHash({ providerEvents, toolEvents, harnessEvents: harnessEvents ?? [] }),
    },
    repetitions: [],
    // AC3 correction-effort vocabulary: autonomous canary trials have no
    // human in the loop, so every field is null — measured, never estimated.
    // Subscription-host A/Bs and future session telemetry fill these in.
    correctionEffort: { humanInterventions: null, correctionTurns: null, interventionTokens: null },
    subscription: null,
  };
}

export function buildLiveSteps({
  config,
  lock,
  workDir,
  env = process.env,
  releaseSha = 'workdir',
  harnessVersion = 'unknown',
  spawnImpl,
  now = () => new Date().toISOString(),
  prepareBundle = prepareHarnessBundle,
  repetitions = null,
  seeds = null,
  localEnabled = false,
  attestHarborExecutable = defaultAttestHarborExecutable,
  attestHostNodeExecutable = defaultAttestHostNodeExecutable,
  attestSandboxImage = defaultAttestSandboxImage,
  validateBundle = validatePrebuiltBundle,
  collectEvidence = collectVerifierEvidence,
  trialExecutor = null,
  providerControl = null,
}) {
  const repetitionCount = repetitions ?? seeds ?? 1;
  if (!Number.isInteger(repetitionCount) || repetitionCount < 1) {
    throw new Error(`repetitions must be a positive integer, got ${repetitionCount}`);
  }
  if (trialExecutor != null && typeof trialExecutor !== 'function') {
    throw new TypeError('trialExecutor must be a function when provided');
  }
  if (providerControl == null || typeof providerControl !== 'object' || Array.isArray(providerControl) ||
      typeof providerControl.available !== 'boolean' || typeof providerControl.preflight !== 'function') {
    throw new TypeError('providerControl must declare availability and a preflight function');
  }
  if (Object.hasOwn(env, 'OPENROUTER_API_KEY')) {
    throw new Error('controlled runtime refuses an ambient raw OPENROUTER_API_KEY credential');
  }
  const runtimeHome = path.join(workDir, '.harbor-runtime-home');
  for (const directory of [
    runtimeHome,
    path.join(runtimeHome, 'xdg-config'),
    path.join(runtimeHome, 'xdg-cache'),
    path.join(runtimeHome, 'tmp'),
    path.join(runtimeHome, 'docker'),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const dockerConfigFile = path.join(runtimeHome, 'docker', 'config.json');
  if (!fs.existsSync(dockerConfigFile)) fs.writeFileSync(dockerConfigFile, '{}\n', { mode: 0o600 });
  const executionEnvironment = env.HARNESS_EVAL_TB_ENV ?? config.execution?.environment ?? 'docker';
  if (executionEnvironment !== 'docker') {
    throw new Error(
      `unsupported controlled evaluation environment: ${executionEnvironment}; ` +
      'attested host mount materialization currently requires Harbor Docker'
    );
  }
  const conditionOrderPolicy = config.execution?.conditionOrder ?? 'release-hash-balanced';
  if (conditionOrderPolicy !== 'release-hash-balanced') {
    throw new Error(`unsupported condition order policy: ${conditionOrderPolicy}`);
  }
  const configuredPairs = Array.isArray(config.pairs) ? config.pairs : null;
  const localPairConfig = configuredPairs?.find((entry) => entry?.host === 'ollama-gemma') ?? null;
  const localSchedule = localPairConfig?.schedule ?? 'explicit-with-local';
  const localTaskRole = localPairConfig?.taskRole ?? 'anchor';
  if (!['explicit-with-local', 'disabled'].includes(localSchedule)) {
    throw new Error(`unsupported ollama-gemma schedule: ${localSchedule}`);
  }
  if (typeof localTaskRole !== 'string' || localTaskRole.length === 0) {
    throw new Error('ollama-gemma taskRole must be a nonempty string');
  }
  // An explicitly configured pair controls whether the CLI opt-in is accepted.
  // Configurations predating `pairs` retain the old explicit-opt-in behavior.
  const localScheduled = localEnabled &&
    (localPairConfig ? localPairConfig.enabled !== false : configuredPairs == null) &&
    localSchedule === 'explicit-with-local';
  const localTask = localScheduled
    ? tasksOf(lock).find((entry) => entry.role === localTaskRole) ?? null
    : null;
  if (localScheduled && !localTask) {
    throw new Error(`ollama-gemma configured taskRole is not pinned in the selected lock: ${localTaskRole}`);
  }
  // ?? null: an absent key must NOT fall back to the process environment —
  // the injected env is the whole truth for credential decisions here.
  const controlledLane = config.controlledLane;
  if (controlledLane == null) {
    throw new Error('controlledLane is required; historical Kimi compatibility must be selected explicitly');
  }
  if (!['openrouter-controlled', 'openrouter-kimi'].includes(controlledLane?.host)) {
    throw new Error(`unsupported controlled lane host: ${controlledLane?.host ?? 'missing'}`);
  }
  if (typeof controlledLane?.profileId !== 'string' || controlledLane.profileId.length === 0) {
    throw new Error('controlledLane.profileId must select a registered model profile');
  }
  if (controlledLane.host === 'openrouter-kimi' && controlledLane.profileId !== 'kimi-k2.7-code') {
    throw new Error('the historical openrouter-kimi host supports only kimi-k2.7-code');
  }
  const controlledHost = controlledLane.host === 'openrouter-controlled'
    ? createControlledHost({ profileId: controlledLane.profileId, apiKey: providerControl.available ? 'broker-custodied' : null })
    : createKimiHost({ apiKey: providerControl.available ? 'broker-custodied' : null });
  const gemmaHost = createGemmaHost();
  const limitsFor = (profile) => ({
    maxSteps: 60,
    timeoutMs: profile.timeoutMs,
    maxOutputTokens: profile.maxTokens,
    trialCeilingUsd: profile.trialCeilingUsd,
  });
  const isPaidProfile = (profile) => {
    const pricing = profile.pricing ?? {};
    return [pricing.inputPerM, pricing.cachedInputPerM, pricing.outputPerM].some((value) => Number(value) > 0);
  };
  let datasetDir = null;
  let verifiedDatasetDir = null;
  let bundle = null;
  let conditionInputs = null;
  let observedHarborVersion = null;
  let harborExecutableIdentity = null;
  const sandboxIdentityByTask = new Map();
  const executionTaskHashByTask = new Map();
  let hostNodeIdentity = null;
  let paidSchedulingStop = null;
  const primaryTrialCeilingByTask = new Map();
  const ensureHarborExecutable = () => {
    const current = attestHarborExecutable({ env });
    if (!current || !path.isAbsolute(current.path) || !SHA256_HEX.test(String(current.sha256 ?? ''))) {
      throw new Error('Harbor executable attestation returned an invalid identity');
    }
    if (harborExecutableIdentity && (
      harborExecutableIdentity.path !== current.path || harborExecutableIdentity.sha256 !== current.sha256
    )) {
      throw new Error('Harbor executable identity changed after preflight');
    }
    harborExecutableIdentity = current;
    return harborExecutableIdentity;
  };
  const hostNodeIdentityOf = () => {
    if (hostNodeIdentity) return hostNodeIdentity;
    const current = attestHostNodeExecutable();
    if (!current || !path.isAbsolute(current.path) || !SHA256_HEX.test(String(current.sha256 ?? ''))) {
      throw new Error('host Node executable attestation returned an invalid identity');
    }
    hostNodeIdentity = current;
    return hostNodeIdentity;
  };
  const spawnEnvironment = ({ bridge = false } = {}) => harborSpawnEnv({
    ambientEnv: env,
    runtimeHome,
    trustedPythonPath: bridge ? path.join(bundle.bundleDir, 'bridge') : null,
    hostNode: hostNodeIdentityOf().path,
    hostNodeSha256: hostNodeIdentityOf().sha256,
  });
  const releaseOrderOffset = Number.parseInt(
    stableHash({ schema: 'eval-condition-order.v1', releaseSha }).slice(0, 8),
    16
  ) % 2;

  function ensureSandboxIdentity(entry) {
    if (!entry?.sandbox) return null;
    const cached = sandboxIdentityByTask.get(entry.task);
    const current = attestSandboxImage({ sandbox: entry.sandbox, env, runtimeHome, task: entry.task });
    if (!current || current.identityAttested !== true || current.observedImageId !== entry.sandbox.imageId ||
        current.observedPlatform !== entry.sandbox.platform) {
      throw new Error(`sandbox image attestation failed for ${entry.task}`);
    }
    if (cached && stableHash(cached) !== stableHash(current)) {
      throw new Error(`sandbox image identity changed after preflight for ${entry.task}`);
    }
    sandboxIdentityByTask.set(entry.task, current);
    return current;
  }

  async function providerSpendGuard() {
    const ceilingUsd = config.budget?.releaseCeilingUsd;
    const configuredHardLimitUsd = config.budget?.providerHardLimitUsd;
    const evaluationMode = config.evaluationScope?.mode ?? 'release';
    const expectedQualificationFingerprint = config.qualificationBaseline?.providerKeyFingerprint ?? null;
    const checkedAt = now();
    if (ceilingUsd == null) {
      return { ok: true, evidence: { verified: false, required: false, reason: 'release-ceiling-not-configured', checkedAt } };
    }
    const providerPolicy = resolveProviderSpendPolicy({
      evaluationMode,
      ceilingUsd,
      configuredHardLimitUsd,
      expectedQualificationFingerprint,
    });
    if (!providerPolicy.ok) {
      return {
        ok: false,
        reason: providerPolicy.errors.join('; '),
        evidence: {
          verified: false,
          required: true,
          ceilingUsd: providerPolicy.ceilingUsd,
          hardLimitUsd: providerPolicy.hardLimitUsd,
          keyFingerprint: null,
          checkedAt,
        },
      };
    }
    let observed;
    try {
      observed = await providerControl.preflight({
        evaluationMode,
        ceilingUsd: providerPolicy.ceilingUsd,
        hardLimitUsd: providerPolicy.hardLimitUsd,
        expectedQualificationFingerprint,
      });
    } catch {
      return { ok: false, reason: 'provider key limit lookup failed', evidence: { verified: false, required: true, ceilingUsd, checkedAt } };
    }
    if (!observed || typeof observed !== 'object' || Array.isArray(observed) ||
        observed.schema !== 'engineer-provider-preflight-observation.v1' ||
        typeof observed.keyFingerprint !== 'string' || !SHA256_HEX.test(observed.keyFingerprint) ||
        !Number.isSafeInteger(observed.limitMicrousd) || observed.limitMicrousd < 0 ||
        !Number.isSafeInteger(observed.limitRemainingMicrousd) || observed.limitRemainingMicrousd < 0 ||
        observed.limitRemainingMicrousd > observed.limitMicrousd ||
        ![null, 'configured'].includes(observed.reset) ||
        typeof observed.checkedAt !== 'string' || !Number.isFinite(Date.parse(observed.checkedAt))) {
      return {
        ok: false,
        reason: 'provider key limit lookup returned malformed custodian evidence',
        evidence: { verified: false, required: true, ceilingUsd, checkedAt },
      };
    }
    const verdict = evaluateProviderSpendEvidence({
      policy: providerPolicy,
      keyFingerprint: observed.keyFingerprint,
      observed: {
        limitUsd: observed.limitMicrousd / 1_000_000,
        limitRemainingUsd: observed.limitRemainingMicrousd / 1_000_000,
        reset: observed.reset,
      },
    });
    const evidence = {
      ...verdict.evidence,
      checkedAt: observed.checkedAt,
    };
    if (!evidence.verified) {
      return {
        ok: false,
        reason: verdict.reason,
        evidence,
      };
    }
    return { ok: true, evidence };
  }

  async function environment() {
    const missing = [];
    let harborExecutable = null;
    let hostNodeReady = false;
    try {
      harborExecutable = ensureHarborExecutable().path;
    } catch (error) {
      missing.push(publicFailureReason(
        'harbor-preflight',
        diagnosticCode(error?.message, 'HARBOR_EXECUTABLE_ATTESTATION_FAILURE'),
        error?.message
      ));
    }
    try {
      hostNodeIdentityOf();
      hostNodeReady = true;
    } catch (error) {
      missing.push(publicFailureReason(
        'host-node-preflight',
        diagnosticCode(error?.message, 'HOST_NODE_EXECUTABLE_ATTESTATION_FAILURE'),
        error?.message
      ));
    }
    const probe = harborExecutable && hostNodeReady
      ? runHarbor({ executable: harborExecutable, args: ['--version'], cwd: workDir, spawnImpl, timeoutMs: 60_000, spawnEnv: spawnEnvironment() })
      : { code: null, spawnError: 'UNATTESTED_EXECUTABLE', containmentComplete: false, stdout: '', stderr: '' };
    observedHarborVersion = probe.spawnError || probe.code !== 0 ? null : harborVersionOf(probe);
    if (probe.spawnError || probe.code !== 0 || probe.containmentComplete !== true) missing.push('harbor CLI');
    else if (observedHarborVersion !== SUPPORTED_HARBOR_VERSION) {
      missing.push(`harbor CLI ${SUPPORTED_HARBOR_VERSION} required`);
    }
    missing.push(...controlledHost.validateCredentials().missing);
    let providerGuard = { ok: true, evidence: { verified: false, required: false, reason: 'credentials-unavailable' } };
    if (controlledHost.validateCredentials().ok) {
      providerGuard = await providerSpendGuard();
      if (!providerGuard.ok) missing.push(providerGuard.reason);
    }
    if (env.HARNESS_EVAL_TB_BUNDLE_DIR) {
      try {
        ensureBundle();
      } catch {
        missing.push('prebuilt harness bundle failed integrity validation');
      }
    }
    return { ok: missing.length === 0, missing, providerSpendGuard: providerGuard.evidence };
  }

  function makeSnapshotReadOnly(root) {
    const visit = (current) => {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`verified dataset snapshot cannot contain symlinks: ${path.relative(root, current)}`);
      if (!stat.isDirectory()) {
        if (!stat.isFile()) throw new Error(`verified dataset snapshot contains an unsupported node: ${path.relative(root, current)}`);
        fs.chmodSync(current, stat.mode & 0o555);
        return;
      }
      for (const name of fs.readdirSync(current)) visit(path.join(current, name));
      fs.chmodSync(current, stat.mode & 0o555);
    };
    visit(root);
  }

  function materializeLockedSandbox(taskRoot, entry) {
    if (!entry.sandbox) throw new Error(`task ${entry.task} has no sandbox lock`);
    const taskConfig = path.join(taskRoot, 'task.toml');
    const source = fs.readFileSync(taskConfig, 'utf8');
    const imageLines = [...source.matchAll(/^docker_image\s*=\s*"([^"]+)"\s*$/gm)];
    if (imageLines.length !== 1 || imageLines[0][1] !== entry.sandbox.sourceImage) {
      throw new Error(`task ${entry.task} does not contain its locked source image`);
    }
    const expectedMemory = `${entry.sandbox.memoryMb / 1024}G`;
    const expectedStorage = `${entry.sandbox.storageMb / 1024}G`;
    const assignments = (field, pattern) => [...source.matchAll(new RegExp(`^${field}\\s*=\\s*${pattern}\\s*$`, 'gm'))];
    const cpuAssignments = assignments('cpus', '(\\d+)');
    const memoryAssignments = assignments('memory', '"([^"]+)"');
    const storageAssignments = assignments('storage', '"([^"]+)"');
    if (!Number.isInteger(entry.sandbox.memoryMb / 1024) || !Number.isInteger(entry.sandbox.storageMb / 1024) ||
        cpuAssignments.length !== 1 || Number(cpuAssignments[0][1]) !== entry.sandbox.cpus ||
        memoryAssignments.length !== 1 || memoryAssignments[0][1] !== expectedMemory ||
        storageAssignments.length !== 1 || storageAssignments[0][1] !== expectedStorage) {
      throw new Error(`task ${entry.task} resource limits do not match its sandbox lock`);
    }
    const pinned = source.replace(imageLines[0][0], `docker_image = "${entry.sandbox.immutableImage}"`);
    if (pinned === source) throw new Error(`task ${entry.task} image pin was not materialized`);
    fs.writeFileSync(taskConfig, pinned);
  }

  function snapshotVerifiedTasks() {
    if (verifiedDatasetDir) {
      for (const entry of tasksOf(lock)) {
        const actual = hashTree(path.join(verifiedDatasetDir, entry.task));
        if (actual !== executionTaskHashByTask.get(entry.task)) {
          throw new Error(`verified execution task snapshot drifted: ${entry.task}`);
        }
      }
      return verifiedDatasetDir;
    }
    const destination = path.join(workDir, 'verified-dataset');
    if (fs.existsSync(destination)) throw new Error('verified dataset snapshot destination already exists');
    fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
    for (const entry of tasksOf(lock)) {
      const sourceTask = path.join(datasetDir, entry.task);
      const destinationTask = path.join(destination, entry.task);
      const sourceMode = fs.lstatSync(sourceTask).mode;
      fs.cpSync(sourceTask, destinationTask, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
      // cpSync creates the recursive-copy root with the process default mode
      // on some supported Node versions. Preserve the source task root's
      // read/execute semantics before the read-only normalization below.
      fs.chmodSync(destinationTask, sourceMode & 0o777);
      const verdict = verifyTaskAgainstLock(destinationTask, lock, entry.task);
      if (!verdict.ok) throw new Error(`copied task failed checksum verification: ${verdict.reason}`);
      materializeLockedSandbox(destinationTask, entry);
    }
    makeSnapshotReadOnly(destination);
    for (const entry of tasksOf(lock)) {
      executionTaskHashByTask.set(entry.task, hashTree(path.join(destination, entry.task)));
    }
    verifiedDatasetDir = fs.realpathSync.native(destination);
    return verifiedDatasetDir;
  }

  /** Locate (or download) the pinned dataset and verify EVERY pinned task's bytes BEFORE any paid step. */
  function taskLock() {
    if (!datasetDir) {
      if (env.HARNESS_EVAL_TB_DATASET_DIR) {
        datasetDir = env.HARNESS_EVAL_TB_DATASET_DIR;
      } else {
        const dest = path.join(workDir, 'dataset');
        let download;
        try {
          download = runHarbor({
            executable: ensureHarborExecutable().path,
            args: ['download', lock.datasetRef, '-o', dest, '--export'],
            cwd: workDir,
            spawnImpl,
            timeoutMs: 10 * 60_000,
            spawnEnv: spawnEnvironment(),
          });
        } catch (error) {
          return {
            ok: false,
            reason: publicFailureReason('task-download', diagnosticCode(error?.message, 'TASK_DOWNLOAD_PREFLIGHT_FAILURE'), error?.message),
          };
        }
        if (download.spawnError || download.code !== 0 || download.containmentComplete !== true) {
          const raw = download.spawnError ?? download.stderr ?? `exit ${download.code}`;
          return { ok: false, reason: publicFailureReason('task-download', 'TASK_DOWNLOAD_FAILURE', raw) };
        }
        datasetDir = path.join(dest, lock.datasetRef.split('@')[0]);
      }
    }
    for (const entry of tasksOf(lock)) {
      const verdict = verifyTaskAgainstLock(path.join(datasetDir, entry.task), lock, entry.task);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      try {
        ensureSandboxIdentity(entry);
      } catch (error) {
        return {
          ok: false,
          reason: publicFailureReason('sandbox-preflight', diagnosticCode(error?.message, 'SANDBOX_ATTESTATION_FAILURE'), error?.message),
        };
      }
    }
    try {
      snapshotVerifiedTasks();
    } catch (error) {
      return {
        ok: false,
        reason: publicFailureReason('task-snapshot', diagnosticCode(error?.message, 'TASK_SNAPSHOT_FAILURE'), error?.message),
      };
    }
    return { ok: true, reason: '' };
  }

  async function runTrial({ evalHost, condition, budget, label, task, identity }) {
    snapshotVerifiedTasks();
    ensureBundle();
    const attestedHostNode = hostNodeIdentityOf();
    const profile = evalHost.profile;
    const taskEntry = tasksOf(lock).find((entry) => entry.task === task);
    const sandboxIdentity = taskEntry?.sandbox ? {
      ...ensureSandboxIdentity(taskEntry),
      executionTaskHash: executionTaskHashByTask.get(task) ?? null,
    } : null;
    const conditionPath = path.join(workDir, `${task}-${label}.condition.json`);
    const telemetryFile = path.join(workDir, `${task}-${label}.done.json`);
    const trialCeilingUsd = Math.min(profile.trialCeilingUsd, budget.remainingUsd());
    const expectedInstructionHash = sha256(instructionAsDeliveredByHarbor(
      fs.readFileSync(path.join(verifiedDatasetDir, task, 'instruction.md'), 'utf8')
    ));
    const mountPolicy = bundle?.mountPolicy;
    const effectiveMounts = Array.isArray(mountPolicy?.[condition.id]) ? mountPolicy[condition.id] : [];
    const effectiveTargets = effectiveMounts.map((mount) => mount.target);
    const commonTargets = Array.isArray(mountPolicy?.commonTargets) ? mountPolicy.commonTargets.slice() : [];
    const treatmentOnlyTargets = Array.isArray(mountPolicy?.treatmentOnlyTargets)
      ? mountPolicy.treatmentOnlyTargets.slice()
      : [];
    const expectedTargets = condition.id === 'harness'
      ? [...commonTargets, ...treatmentOnlyTargets]
      : commonTargets;
    const configuredMountPolicyComplete = mountPolicy?.version === 'eval-mount-policy.v1' &&
      effectiveTargets.length > 0 && commonTargets.length > 0 && treatmentOnlyTargets.length > 0;
    const configuredMatchesCondition = JSON.stringify(effectiveTargets) === JSON.stringify(expectedTargets);
    const configuredStructurallyIsolated = mountPolicy?.structurallyIsolated === true &&
      treatmentOnlyTargets.every((target) => !commonTargets.includes(target));
    const configuredMountPolicyValid = configuredMountPolicyComplete &&
      configuredMatchesCondition && configuredStructurallyIsolated;
    let mountPolicyEvidence = {
      version: mountPolicy?.version ?? null,
      source: 'configured-harbor-argv',
      observed: false,
      complete: false,
      matchesCondition: configuredMatchesCondition,
      structurallyIsolated: configuredStructurallyIsolated,
      effectiveTargets,
      observedTargets: [],
      observedExistingTargets: [],
      commonTargets,
      treatmentOnlyTargets,
      reason: null,
    };
    if (!configuredMountPolicyComplete) {
      mountPolicyEvidence.reason = 'mount-policy-incomplete';
    }
    else if (!mountPolicyEvidence.structurallyIsolated) mountPolicyEvidence.reason = 'treatment-mount-not-isolated';
    else if (!mountPolicyEvidence.matchesCondition) mountPolicyEvidence.reason = 'effective-mounts-do-not-match-condition';
    else mountPolicyEvidence.reason = 'sandbox-mount-observation-missing';
    const conditionDocument = {
      ...condition,
      runtime: {
        ...(condition.runtime ?? {}),
        expectedMountTargets: expectedTargets,
        mountProbeTargets: [...new Set([...commonTargets, ...treatmentOnlyTargets])],
      },
      profileId: profile.id,
      apiKeyEnv: profile.host === 'openrouter' ? 'OPENROUTER_API_KEY' : 'HARNESS_EVAL_LOCAL_API_KEY',
      // harbor_agent.py launches the provider bridge as a host-side Node
      // subprocess. Only exec tool calls enter the Harbor sandbox, so a local
      // Ollama endpoint must stay on host loopback.
      providerUrl: profile.url,
      limits: { ...condition.limits, trialCeilingUsd },
    };
    fs.writeFileSync(
      conditionPath,
      JSON.stringify(conditionDocument, null, 2)
    );
    const jobName = `${evalHost.id}-${task}-${label}`;
    const jobsDir = path.join(workDir, 'jobs');
    const startedAt = now();
    const isolatedPaidRuntime = trialExecutor != null && profile.host === 'openrouter';
    const trialId = `${identity.pairId}-${identity.repetitionId}-${condition.id}-${identity.attempt}`;
    const harborArgs = isolatedPaidRuntime
      ? buildHarborIsolatedTrialArgs({
          lock,
          task,
          trialId,
          datasetPath: verifiedDatasetDir,
          agentRef: AGENT_REF,
          model: profile.model,
          envName: executionEnvironment,
          jobName,
          jobsDir,
          mounts: effectiveMounts,
          agentEnv: {
            HARNESS_EVAL_TB_CONDITION: conditionPath,
            HARNESS_EVAL_TB_TELEMETRY_FILE: telemetryFile,
            HARNESS_EVAL_HOST_NODE: attestedHostNode.path,
            HARNESS_EVAL_HOST_NODE_SHA256: attestedHostNode.sha256,
          },
        })
      : buildHarborRunArgs({
          lock,
          task,
          datasetPath: verifiedDatasetDir,
          agentRef: AGENT_REF,
          model: profile.model,
          envName: executionEnvironment,
          jobName,
          jobsDir,
          mounts: effectiveMounts,
          agentEnv: {
            HARNESS_EVAL_TB_CONDITION: conditionPath,
            HARNESS_EVAL_TB_TELEMETRY_FILE: telemetryFile,
            HARNESS_EVAL_HOST_NODE: attestedHostNode.path,
            HARNESS_EVAL_HOST_NODE_SHA256: attestedHostNode.sha256,
          },
        });
    const harborRequest = {
      executable: ensureHarborExecutable().path,
      args: harborArgs,
      cwd: workDir,
      spawnImpl,
      timeoutMs: profile.timeoutMs + 10 * 60_000,
      // The provider key stays with the trusted external controller and is
      // injected only into the isolated broker through an inherited FD.
      spawnEnv: spawnEnvironment({ bridge: true }),
    };
    const isolatedExecution = !isolatedPaidRuntime
      ? { run: runHarbor(harborRequest), runtimeEvidence: null }
      : await trialExecutor({
          trial: {
            trialId,
            task,
            condition: condition.id,
            identity: structuredClone(identity),
            ceilingUsd: trialCeilingUsd,
            profileId: profile.id,
          },
          harbor: {
            executable: harborRequest.executable,
            args: harborRequest.args.slice(),
            cwd: harborRequest.cwd,
            timeoutMs: harborRequest.timeoutMs,
            spawnEnv: { ...harborRequest.spawnEnv },
          },
        });
    if (!isolatedExecution || typeof isolatedExecution !== 'object' || !isolatedExecution.run) {
      throw new Error('isolated trial executor returned no Harbor result');
    }
    const run = isolatedExecution.run;
    const runtimeTrustEvidence = isolatedExecution.runtimeEvidence == null
      ? null
      : {
          schema: String(isolatedExecution.runtimeEvidence.schema ?? ''),
          evidenceHash: String(isolatedExecution.runtimeEvidence.evidenceHash ?? ''),
          providerSpendMicrousd: isolatedExecution.runtimeEvidence.providerSpendMicrousd,
        };
    const endedAt = now();
    let postRunIntegrityFailure = null;
    try {
      snapshotVerifiedTasks();
      ensureBundle();
    } catch (error) {
      postRunIntegrityFailure = failureDiagnostic(
        'post-run-integrity',
        diagnosticCode(error?.message),
        error?.message
      );
    }
    const jobDir = jobDirFor({ jobsDir, jobName });
    const jobDirCreated = fs.existsSync(jobDir);
    let done = null;
    try {
      done = JSON.parse(fs.readFileSync(telemetryFile, 'utf8'));
    } catch {
      done = null;
    }
    const observedMount = done?.mountEvidence;
    if (observedMount?.source === 'sandbox-observed' && observedMount.complete === true && Array.isArray(observedMount.targets) &&
        observedMount.targets.every((target) => typeof target === 'string') &&
        Array.isArray(observedMount.existingTargets) &&
        observedMount.existingTargets.every((target) => typeof target === 'string') &&
        observedMount.allReadOnly === true) {
      const observedTargets = observedMount.targets.slice();
      const observedExistingTargets = observedMount.existingTargets.slice();
      const observedMatchesCondition = JSON.stringify(observedTargets) === JSON.stringify(expectedTargets) &&
        JSON.stringify(observedExistingTargets) === JSON.stringify(expectedTargets);
      const matchesCondition = configuredMountPolicyValid && observedMatchesCondition;
      const observedPolicyComplete = configuredMountPolicyValid && observedMatchesCondition;
      mountPolicyEvidence = {
        ...mountPolicyEvidence,
        version: observedMount.version ?? mountPolicyEvidence.version,
        source: 'sandbox-observed',
        observed: true,
        complete: observedPolicyComplete,
        matchesCondition,
        observedTargets,
        observedExistingTargets,
        reason: !configuredMountPolicyComplete
          ? 'mount-policy-incomplete'
          : !configuredStructurallyIsolated
            ? 'treatment-mount-not-isolated'
            : !configuredMatchesCondition
              ? 'effective-mounts-do-not-match-condition'
              : observedPolicyComplete
                ? null
                : 'sandbox-observed-mounts-do-not-match-condition',
      };
    }
    const totals = done?.telemetry?.totals ?? null;
    const paidProfile = isPaidProfile(profile);
    const finiteCost = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const localCost = finiteCost(totals?.localCostUsd);
    const providerCost = finiteCost(totals?.providerCostUsd);
    const reconciledCost = paidProfile ? finiteCost(totals?.reconciledCostUsd) : 0;
    const attestedSpendMicrousd = Number.isSafeInteger(runtimeTrustEvidence?.providerSpendMicrousd) &&
      runtimeTrustEvidence.providerSpendMicrousd >= 0
      ? runtimeTrustEvidence.providerSpendMicrousd
      : null;
    const chargeableReconciledCost = isolatedPaidRuntime && paidProfile && attestedSpendMicrousd != null
      ? attestedSpendMicrousd / 1_000_000
      : reconciledCost ?? Math.max(localCost ?? 0, providerCost ?? 0);
    budget.charge(chargeableReconciledCost, `${evalHost.id} ${label}`);
    const allocationBreached = paidProfile && budget.breached;
    const explicitUnknownBilling = Array.isArray(done?.telemetry?.events) &&
      done.telemetry.events.some((event) => event?.type === 'billing_uncertain' || event?.billingStatus === 'unknown');
    const billingUncertain = paidProfile && (
      !done ||
      !totals ||
      totals.usageComplete !== true ||
      totals.providerCostComplete !== true ||
      totals.billingComplete !== true ||
      totals.costComplete !== true ||
      totals.openAttempts !== 0 ||
      totals.unknownBillingAttempts !== 0 ||
      localCost == null ||
      providerCost == null ||
      reconciledCost == null ||
      (isolatedPaidRuntime && attestedSpendMicrousd == null) ||
      explicitUnknownBilling
    );
    let reservedUsd = 0;
    if (billingUncertain) {
      reservedUsd = budget.remainingUsd();
      if (reservedUsd > 0) budget.reserve(reservedUsd, `${evalHost.id} ${label} uncertain-billing-reserve`);
      paidSchedulingStop = {
        task,
        condition: condition.id,
        reason: !done ? 'missing-done-telemetry' : 'incomplete-or-unknown-billing',
        reservedUsd,
      };
    } else if (allocationBreached) {
      paidSchedulingStop = {
        task,
        condition: condition.id,
        reason: 'reconciled-cost-exceeded-trial-allocation',
        reservedUsd: 0,
      };
    }
    let evidence = {
      reward: null,
      rewardPath: null,
      metrics: null,
      pytest: null,
      assertionEvidenceTrusted: false,
      treeHash: null,
      degraded: null,
    };
    let verifierEvidenceCollectionFailure = false;
    if (jobDirCreated) {
      try {
        evidence = collectEvidence(jobDir);
      } catch {
        // Official evidence is untrusted filesystem input. Preserve the paid
        // billing ledger and classify the trial as infrastructure-invalid
        // instead of throwing away the release report after provider spend.
        verifierEvidenceCollectionFailure = true;
      }
    }
    // Grading trust boundary: harbor's host-written trial record. The
    // in-sandbox reward files are agent-writable and never grade; the host
    // record is written by the harbor process after the verifier phase and is
    // never mounted into the sandbox.
    let hostVerifier = null;
    if (jobDirCreated && !verifierEvidenceCollectionFailure && evidence.reward == null) {
      hostVerifier = readHostVerifierReward(jobDir);
      if (hostVerifier) {
        evidence = {
          ...evidence,
          reward: hostVerifier.reward,
          rewardPath: `${hostVerifier.trialName}/result.json`,
          degraded: evidence.degraded,
        };
      }
    }
    const classifiedFailure = classifyFailure({
      run,
      reward: evidence.reward,
      providerFailure: done?.stopReason === 'provider_error',
      jobDirCreated: jobDirCreated && !verifierEvidenceCollectionFailure,
      passed: verdictFromReward(evidence.reward, { passingReward: lock.verifier.passingReward }) === 'pass',
    });
    const doc = buildRunDoc({
      condition: condition.id,
      task,
      evidence,
      done,
      run,
      profile,
      lock,
      releaseSha,
      harnessVersion,
      startedAt,
      endedAt,
      identity,
      conditionDocument,
      hostId: evalHost.id,
      bundleManifestHash: bundle?.manifestHash ?? null,
      expectedInstructionHash,
      mountPolicyEvidence,
      sandboxIdentity,
      runnerVersion: `harbor-${observedHarborVersion ?? 'unverified'}/bridge-2/${harborExecutableIdentity.sha256.slice(0, 16)}/node-${attestedHostNode.sha256.slice(0, 16)}`,
    });
    doc.observability.runtimeTrustEvidence = runtimeTrustEvidence;
    doc.efficiency.reconciledCostUsd = reconciledCost;
    doc.efficiency.billingUncertain = billingUncertain;
    if (allocationBreached) doc.correctness.completedWithinBudget = false;
    doc.billingEvidence = {
      uncertain: billingUncertain,
      reconciledCostUsd: reconciledCost,
      reservedUsd,
      allocationBreached,
      policy: billingUncertain ? 'reserve-trial-remainder-and-stop' : 'max-local-provider-reported',
    };
    const verifierEvidenceCollectionComplete = jobDirCreated && !verifierEvidenceCollectionFailure;
    const verifierEvidenceDegraded = typeof evidence.degraded === 'string' && evidence.degraded.length > 0
      ? evidence.degraded
      : null;
    const rewardTrusted = typeof evidence.reward === 'number' && Number.isFinite(evidence.reward);
    const assertionEvidenceTrusted = evidence.assertionEvidenceTrusted === true;
    doc.verifierEvidence = {
      collectionComplete: verifierEvidenceCollectionComplete,
      trustComplete: verifierEvidenceCollectionComplete && rewardTrusted,
      rewardTrusted,
      rewardSource: hostVerifier ? 'harbor-host-result' : rewardTrusted ? 'collected-evidence' : null,
      assertionEvidenceTrusted,
      advisoryAssertions: assertionEvidenceTrusted ? null : evidence.pytest ?? null,
      degraded: verifierEvidenceDegraded,
      reason: verifierEvidenceCollectionFailure
        ? 'verifier-evidence-collection-failed'
        : !jobDirCreated
          ? 'harbor-job-directory-missing'
          : verifierEvidenceDegraded
            ? 'verifier-evidence-degraded'
            : rewardTrusted
              ? null
              : 'trusted-verifier-reward-unavailable',
    };
    const integrityFailure = BRIDGE_INTEGRITY_STOP_REASONS.has(doc.correctness.exitReason) ||
      doc.workspaceEvidence?.available !== true ||
      doc.economics?.coverage?.complete !== true ||
      doc.economics?.prompt?.coverage?.complete !== true ||
      doc.economics?.reconciliation?.complete !== true ||
      doc.observability.runtimeContractEvidence.matchesExpected !== true ||
      doc.observability.mountPolicyEvidence?.complete !== true ||
      doc.observability.mountPolicyEvidence?.matchesCondition !== true ||
      doc.observability.mountPolicyEvidence?.structurallyIsolated !== true ||
      doc.observability.unclosedProviderAttempts !== 0 ||
      doc.observability.uncorrelatedProviderTerminals !== 0 ||
      doc.observability.duplicateProviderAttemptIdentities !== 0 ||
      doc.observability.duplicateProviderTerminalIdentities !== 0 ||
      doc.observability.invalidProviderEventIdentities !== 0 ||
      doc.observability.unclosedToolCalls !== 0 ||
      doc.observability.uncorrelatedToolResults !== 0 ||
      doc.observability.duplicateToolCallIdentities !== 0 ||
      doc.observability.duplicateToolResultIdentities !== 0 ||
      doc.observability.invalidToolEventIdentities !== 0 ||
      doc.observability.malformedToolCallEvidence !== 0 ||
      doc.observability.malformedToolResultEvidence !== 0 ||
      doc.observability.incompleteToolContainment !== 0 ||
      doc.observability.controlContaminationDetected === true ||
      postRunIntegrityFailure != null;
    if (integrityFailure && paidProfile && !paidSchedulingStop) {
      const integrityReserve = budget.remainingUsd();
      if (integrityReserve > 0) {
        budget.reserve(integrityReserve, `${evalHost.id} ${label} structural-integrity-reserve`);
      }
      reservedUsd += integrityReserve;
      paidSchedulingStop = {
        task,
        condition: condition.id,
        reason: 'structural-integrity-failure',
        reservedUsd: integrityReserve,
      };
      doc.billingEvidence.reservedUsd = reservedUsd;
      doc.billingEvidence.policy = 'reserve-trial-remainder-and-stop-on-structural-integrity-failure';
    }
    const failureDiagnostics = [];
    if (postRunIntegrityFailure) failureDiagnostics.push(postRunIntegrityFailure);
    if (verifierEvidenceCollectionFailure) {
      failureDiagnostics.push(failureDiagnostic('verifier-evidence', 'VERIFIER_EVIDENCE_COLLECTION_FAILURE'));
    }
    if (classifiedFailure) {
      failureDiagnostics.push(failureDiagnostic(
        'trial-classification',
        `${String(classifiedFailure).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_FAILURE`,
        run?.spawnError ?? run?.stderr ?? null,
        {
          exitCode: Number.isInteger(run?.code) ? run.code : null,
          signal: typeof run?.signal === 'string' ? run.signal : null,
        }
      ));
    }
    if (billingUncertain) {
      failureDiagnostics.push(failureDiagnostic('billing-reconciliation', 'BILLING_EVIDENCE_INCOMPLETE'));
    }
    if (allocationBreached) {
      failureDiagnostics.push(failureDiagnostic('budget-reconciliation', 'TRIAL_ALLOCATION_EXCEEDED'));
    }
    if (integrityFailure) {
      failureDiagnostics.push(failureDiagnostic('runtime-evidence', 'RUNTIME_EVIDENCE_INTEGRITY_FAILURE'));
    }
    if (postRunIntegrityFailure != null) {
      doc.executionIntegrityEvidence = {
        complete: false,
        reason: postRunIntegrityFailure.code,
        reasonHash: postRunIntegrityFailure.reasonHash,
      };
    }
    // A missing trusted reward is a verifier-invalid fallback, not a reason to
    // hide a stronger failure observed during the same paid trial. Preserve
    // definitive spawn/provider classifications, then prefer billing, budget,
    // and structural-integrity causes before falling back to verifier-invalid.
    const definitiveClassifiedFailure = classifiedFailure === 'verifier' ? null : classifiedFailure;
    const failureKind = definitiveClassifiedFailure ?? (billingUncertain
      ? 'billing'
      : allocationBreached
        ? 'budget'
        : integrityFailure
          ? 'infrastructure'
          : classifiedFailure);
    doc.trialValidity = { valid: failureKind == null && evidence.reward != null, failureKind };
    return {
      doc,
      failureKind,
      failureDiagnostics,
      stopPaidScheduling: billingUncertain || allocationBreached || integrityFailure,
    };
  }

  async function taskPair({ evalHost, task, budget, attempt, trialCeilingUsd, n = repetitionCount }) {
    const profile = evalHost.profile;
    const limits = limitsFor(profile);
    const repetitionRuns = [];
    const pairId = shortHash({ schema: 'eval-pair.v1', releaseSha, host: evalHost.id, task, attempt });
    for (let repetition = 1; repetition <= n; repetition += 1) {
      const suffix = n > 1 ? `${attempt}${repetition}` : attempt;
      let conditions;
      try {
        ensureBundle();
        const guidanceCatalog = structuredClone(conditionInputs.guidanceCatalog);
        conditions = {
          generic: buildGenericCondition({ instruction: INSTRUCTION_PLACEHOLDER, limits }),
          harness: {
            ...buildHarnessCondition({
              instruction: INSTRUCTION_PLACEHOLDER,
              limits,
              engineerContract: conditionInputs.engineerRuntimeContract,
              guidance: conditionInputs.guidancePrompt,
            }),
            runtime: { guidanceCatalog, checkpoint: true, trustedVerify: true },
          },
        };
      } catch (error) {
        const reservedUsd = isPaidProfile(profile) ? budget.remainingUsd() : 0;
        if (reservedUsd > 0) {
          budget.reserve(reservedUsd, `${evalHost.id} repetition-setup-integrity-uncertain-reserve`);
        }
        const diagnostic = failureDiagnostic(
          'repetition-setup',
          diagnosticCode(error?.message),
          error?.message
        );
        repetitionRuns.push({
          generic: null,
          harness: null,
          pairedValid: false,
          setupFailureKind: 'infrastructure',
          setupFailureDiagnostics: [diagnostic],
        });
        if (isPaidProfile(profile)) {
          paidSchedulingStop = {
            task,
            condition: null,
            reason: 'pre-spend-or-post-spend-execution-integrity-failure',
            reservedUsd,
          };
        }
        break;
      }
      const results = {};
      // Primary repetitions alternate AB/BA; the one-repetition regression rerun reverses
      // the original order. Fixed per-arm budgets keep either order equivalent.
      const taskOrderOffset = tasksOf(lock).findIndex((entry) => entry.task === task);
      const genericFirst = (
        taskOrderOffset + (repetition - 1) + releaseOrderOffset + (attempt === 'b' ? 1 : 0)
      ) % 2 === 0;
      const order = genericFirst ? ['generic', 'harness'] : ['harness', 'generic'];
      for (const [orderOffset, conditionId] of order.entries()) {
        const trialBudget = createBudget({
          ceilingUsd: trialCeilingUsd,
          label: `${task}-${conditionId}-${suffix}`,
          parent: budget,
        });
        try {
          results[conditionId] = await runTrial({
            evalHost,
            condition: conditions[conditionId],
            budget: trialBudget,
            label: `${conditionId}-${suffix}`,
            task,
            identity: {
              pairId,
              repetitionId: shortHash({ pairId, repetition }),
              repetitionIndex: repetition,
              orderIndex: orderOffset + 1,
              attempt,
            },
          });
        } catch (error) {
          const reservedUsd = isPaidProfile(profile) ? trialBudget.remainingUsd() : 0;
          if (reservedUsd > 0) {
            trialBudget.reserve(reservedUsd, `${evalHost.id} ${conditionId} execution-integrity-uncertain-reserve`);
          }
          const diagnostic = failureDiagnostic(
            'trial-execution',
            diagnosticCode(error?.message),
            error?.message
          );
          results[conditionId] = {
            doc: null,
            failureKind: 'infrastructure',
            failureDiagnostics: [diagnostic],
            stopPaidScheduling: isPaidProfile(profile),
          };
          if (isPaidProfile(profile)) {
            paidSchedulingStop = {
              task,
              condition: conditionId,
              reason: 'pre-spend-or-post-spend-execution-integrity-failure',
              reservedUsd,
            };
          }
        }
        if (results[conditionId].stopPaidScheduling) break;
      }
      const { generic, harness } = results;
      const pairedValid = Boolean(
        generic?.failureKind == null &&
        harness?.failureKind == null &&
        generic?.doc?.correctness?.verifierReward != null &&
        harness?.doc?.correctness?.verifierReward != null
      );
      repetitionRuns.push({ generic: generic ?? null, harness: harness ?? null, pairedValid });
      if (paidSchedulingStop && isPaidProfile(profile)) break;
    }
    const kinds = repetitionRuns.map((run) =>
      run.setupFailureKind ?? run.generic?.failureKind ?? run.harness?.failureKind ??
        (run.pairedValid ? null : 'infrastructure')
    );
    const validRepetitions = repetitionRuns.filter((run) => run.pairedValid).length;
    let failureKind = null;
    if (validRepetitions <= n / 2) {
      const counts = {};
      for (const kind of kinds.filter(Boolean)) counts[kind] = (counts[kind] ?? 0) + 1;
      failureKind = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    if (repetitionRuns.some((run) => run.setupFailureKind)) {
      failureKind = 'infrastructure';
    }
    // A paid fail-stop can occur after enough earlier repetitions passed to
    // satisfy the majority rule. That is still an incomplete experiment, not
    // a comparable aggregate: the planned denominator and both arms must run.
    if (failureKind == null && paidSchedulingStop && isPaidProfile(profile)) {
      failureKind = paidSchedulingStop.reason === 'reconciled-cost-exceeded-trial-allocation'
        ? 'budget'
        : ['missing-done-telemetry', 'incomplete-or-unknown-billing'].includes(paidSchedulingStop.reason)
          ? 'billing'
          : 'infrastructure';
    }
    const aggregateCondition = (conditionId) => {
      const attempted = repetitionRuns.filter((run) => run[conditionId]?.doc);
      if (!attempted.length) return null;
      const aggregate = aggregateRepetitionDocs(
        attempted.map((run) => run[conditionId].doc),
        { validMask: attempted.map((run) => run.pairedValid) }
      );
      if (failureKind) aggregate.trialValidity = { valid: false, failureKind };
      return aggregate;
    };
    return {
      host: evalHost.id,
      task,
      pairId,
      repetitionCount: n,
      attemptedRepetitionCount: repetitionRuns.length,
      validRepetitionCount: validRepetitions,
      invalidRepetitionCount: repetitionRuns.length - validRepetitions,
      generic: aggregateCondition('generic'),
      harness: aggregateCondition('harness'),
      failureKind,
      failureDiagnostics: repetitionRuns.flatMap((run, repetitionIndex) => [
        ...(run.setupFailureDiagnostics ?? []).map((diagnostic) => ({
          repetitionIndex: repetitionIndex + 1,
          condition: null,
          ...diagnostic,
        })),
        ...['generic', 'harness'].flatMap((condition) =>
          (run[condition]?.failureDiagnostics ?? []).map((diagnostic) => ({
            repetitionIndex: repetitionIndex + 1,
            condition,
            ...diagnostic,
          }))
        ),
      ]).slice(0, 100),
      paidSchedulingStop: paidSchedulingStop ? { ...paidSchedulingStop } : null,
    };
  }

  function failedPair({ evalHost, task, budget, attempt, n, error }) {
    const reservedUsd = isPaidProfile(evalHost.profile) ? budget.remainingUsd() : 0;
    if (reservedUsd > 0) budget.reserve(reservedUsd, `${evalHost.id} structural-integrity-reserve`);
    const diagnostic = failureDiagnostic('pair-execution', diagnosticCode(error?.message), error?.message);
    paidSchedulingStop = isPaidProfile(evalHost.profile) ? {
      task,
      condition: null,
      reason: 'pre-spend-or-post-spend-execution-integrity-failure',
      reservedUsd,
    } : paidSchedulingStop;
    return {
      host: evalHost.id,
      task,
      pairId: shortHash({ schema: 'eval-pair.v1', releaseSha, host: evalHost.id, task, attempt }),
      repetitionCount: n,
      attemptedRepetitionCount: 0,
      validRepetitionCount: 0,
      invalidRepetitionCount: 0,
      generic: null,
      harness: null,
      failureKind: 'infrastructure',
      failureDiagnostics: [{ repetitionIndex: null, condition: null, ...diagnostic }],
      paidSchedulingStop: paidSchedulingStop ? { ...paidSchedulingStop } : null,
    };
  }

  function ensureBundle() {
    // A pre-built bundle (offline releases, tests) short-circuits preparation.
    const sourceIdentity = { releaseSha, harnessVersion };
    bundle ??= env.HARNESS_EVAL_TB_BUNDLE_DIR
      ? materializePrebuiltBundle(env.HARNESS_EVAL_TB_BUNDLE_DIR, {
          destination: path.join(workDir, 'materialized-harness-bundle'),
          expectedManifestHash: env.HARNESS_EVAL_TB_BUNDLE_SHA256,
          expectedSourceIdentity: sourceIdentity,
        })
      : prepareBundle({
          bundleDir: path.join(workDir, 'harness-bundle'),
          sourceIdentity,
          spawnImpl,
          ambientEnv: env,
        });
    const inspected = validateBundle(bundle.bundleDir, {
      expectedManifestHash: bundle.manifestHash,
      expectedSourceIdentity: sourceIdentity,
    });
    if (!inspected || inspected.manifestHash !== bundle.manifestHash) {
      throw new Error('harness bundle re-attestation returned an invalid identity');
    }
    bundle = { ...bundle, ...inspected };
    const conditionInputsPath = path.join(bundle.bundleDir, CONDITION_INPUTS_FILE);
    const conditionInputsStat = fs.lstatSync(conditionInputsPath);
    if (!conditionInputsStat.isFile() || conditionInputsStat.isSymbolicLink() || conditionInputsStat.size > 1024 * 1024) {
      throw new Error('bundle condition inputs are missing or invalid');
    }
    let parsedConditionInputs;
    try {
      parsedConditionInputs = JSON.parse(fs.readFileSync(conditionInputsPath, 'utf8'));
    } catch {
      throw new Error('bundle condition inputs are not valid JSON');
    }
    const catalogEntry = parsedConditionInputs?.guidanceCatalog?.['ensure-plan'];
    if (parsedConditionInputs?.version !== 'eval-condition-inputs.v1' ||
        stableHash(parsedConditionInputs?.sourceIdentity) !== stableHash(sourceIdentity) ||
        typeof parsedConditionInputs?.engineerRuntimeContract !== 'string' ||
        parsedConditionInputs.engineerRuntimeContract.length === 0 ||
        typeof parsedConditionInputs?.guidancePrompt !== 'string' ||
        typeof catalogEntry?.content !== 'string' ||
        catalogEntry.sha256 !== sha256(catalogEntry.content) ||
        catalogEntry.sizeChars !== catalogEntry.content.length) {
      throw new Error('bundle condition inputs do not match the evaluated release contract');
    }
    conditionInputs = parsedConditionInputs;
    const commonTargets = bundle.mountPolicy?.commonTargets ?? [];
    if (tasksOf(lock).some((entry) => entry.sandbox?.platform === 'linux/amd64') &&
        !commonTargets.includes('/opt/eval-runtime/node-x64')) {
      throw new Error('linux/amd64 task locks require a node-x64 runtime in the common bundle');
    }
    return bundle;
  }

  /** One fresh Generic/Harness pair per pinned task. */
  const controlledPair = async (budget) => {
      if (!controlledHost.validateCredentials().ok) return null;
      const tasks = tasksOf(lock);
      const profile = controlledHost.profile;
      const configuredRerunUsd = Number(config.budget?.rerunUsd);
      const rerunnableArmCeiling = Number.isFinite(configuredRerunUsd) && configuredRerunUsd > 0
        ? configuredRerunUsd / 2
        : Number.POSITIVE_INFINITY;
      const configuredArmCeiling = Number(config.budget?.controlledArmCeilingUsd);
      const trialCeilingUsd = Math.min(
        profile.trialCeilingUsd,
        Number.isFinite(configuredArmCeiling) && configuredArmCeiling > 0
          ? configuredArmCeiling
          : budget.remainingUsd() / (tasks.length * repetitionCount * 2),
        rerunnableArmCeiling
      );
      const pairs = [];
      try {
        ensureBundle();
      } catch (error) {
        return [failedPair({ evalHost: controlledHost, task: tasks[0]?.task ?? 'unknown', budget, attempt: 'a', n: repetitionCount, error })];
      }
      for (const entry of tasks) {
        if (paidSchedulingStop) break;
        primaryTrialCeilingByTask.set(entry.task, trialCeilingUsd);
        try {
          pairs.push(await taskPair({ evalHost: controlledHost, task: entry.task, budget, attempt: 'a', trialCeilingUsd }));
        } catch (error) {
          pairs.push(failedPair({ evalHost: controlledHost, task: entry.task, budget, attempt: 'a', n: repetitionCount, error }));
          break;
        }
      }
      return pairs;
    };
  /** §9 conditional rerun: one fresh pair for one task (never repetition-multiplied). */
  const rerunControlledPair = async (budget, task) => {
      if (!controlledHost.validateCredentials().ok) return null;
      if (paidSchedulingStop) return null;
      const primaryTrialCeilingUsd = primaryTrialCeilingByTask.get(task);
      if (!Number.isFinite(primaryTrialCeilingUsd)) return null;
      const profile = controlledHost.profile;
      const trialCeilingUsd = Math.min(profile.trialCeilingUsd, budget.remainingUsd() / 2, primaryTrialCeilingUsd);
      const rerunTask = task ?? tasksOf(lock)[0].task;
      try {
        ensureBundle();
        return await taskPair({ evalHost: controlledHost, task: rerunTask, budget, attempt: 'b', trialCeilingUsd, n: 1 });
      } catch (error) {
        return failedPair({ evalHost: controlledHost, task: rerunTask, budget, attempt: 'b', n: 1, error });
      }
    };

  return {
    environment,
    taskLock,
    controlledPair,
    rerunControlledPair,
    // Compatibility aliases for callers created before the controlled lane
    // was separated from its historical Kimi profile.
    kimiPair: controlledPair,
    rerunKimiPair: rerunControlledPair,
    frontierPair: null,
    // The local floor is deliberately opt-in: it adds wall time, not API
    // spend, and only runs the anchor task so an M3 Max is not turned into a
    // hidden multi-hour release dependency.
    gemmaPair: localScheduled
      ? async (budget) => {
          try {
            ensureBundle();
            return [await taskPair({
              evalHost: gemmaHost,
              task: localTask.task,
              budget,
              attempt: 'local',
              trialCeilingUsd: 0,
              n: 1,
            })];
          } catch (error) {
            return [failedPair({ evalHost: gemmaHost, task: localTask.task, budget, attempt: 'local', n: 1, error })];
          }
        }
      : null,
    smokes: null,
  };
}
