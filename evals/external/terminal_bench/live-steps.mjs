/**
 * Live release steps: the callable implementation of the Kimi A/B pair.
 *
 * `buildLiveSteps` returns the step functions `runRelease` schedules. The
 * flow per trial: verify the pinned task bytes (before any provider work),
 * write the condition file (with the trial ceiling capped by the pair's
 * remaining allowance), invoke `harbor run` with a deterministic job
 * identity and the mounted harness bundle, then read the official verifier
 * evidence and the bridge's done-file to build a schema-valid eval-run
 * document. Provider-reported cost is the ledger of record — every child
 * charge lands on the release-side budget chain.
 *
 * Everything external (harbor, filesystem layout, bundle prep) is injected
 * so the whole path is testable without a container or a provider.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHost as createKimiHost } from '../../hosts/openrouter-kimi.mjs';
import { buildHarborRunArgs, jobDirFor, runHarbor, verifyTaskAgainstLock, classifyFailure, tasksOf } from './harbor-adapter.mjs';
import { collectVerifierEvidence, verdictFromReward } from './verifier.mjs';
import { buildGenericCondition } from './generic-condition.mjs';
import { buildHarnessCondition } from './harness-condition.mjs';
import { runtimeBridgeTools } from './agent.mjs';
import { engineerRuntimeContract, buildGuidance, buildGuidanceCatalog } from '../../lib/scenario.mjs';
import { createBudget } from '../../lib/budget.mjs';
import { prepareHarnessBundle, bundleMount } from './provision.mjs';

export const AGENT_REF = 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent';

// harbor resolves --agent with plain importlib: the repo root must be on
// PYTHONPATH for evals.external.terminal_bench.harbor_agent to import.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const harborSpawnEnv = (apiKey) => {
  const spawnEnv = {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${repoRoot}${path.delimiter}${process.env.PYTHONPATH}` : repoRoot,
  };
  // The key belongs only to the host-side Harbor/Python/Node bridge process.
  // Passing it through --ae would also scope it into every sandbox exec.
  if (apiKey == null) delete spawnEnv.OPENROUTER_API_KEY;
  else spawnEnv.OPENROUTER_API_KEY = apiKey;
  return spawnEnv;
};

// Harbor delivers the real instruction to the agent at runtime; the condition
// object still requires one for prompt assembly parity checks.
const INSTRUCTION_PLACEHOLDER = '(the task instruction is supplied by Harbor at runtime)';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const stableHash = (value) => sha256(JSON.stringify(value ?? null));
const shortHash = (value) => stableHash(value).slice(0, 24);

const PROVIDER_EVENT_TYPES = new Set(['request', 'request_attempt', 'response', 'error', 'retry', 'completion_error', 'fallback']);
const TOOL_EVENT_TYPES = new Set(['tool_call', 'tool_result', 'tool_result_compacted', 'post_verify_tool_suppressed']);

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
  const available = Boolean(
    source &&
      source.available !== false &&
      validHash(source.beforeManifestHash) &&
      validHash(source.afterManifestHash) &&
      validDiffState
  );
  return {
    available,
    collectionMode: source?.collectionMode ?? null,
    beforeManifestHash: available ? source.beforeManifestHash : null,
    afterManifestHash: available ? source.afterManifestHash : null,
    diffHash: available ? source.diffHash ?? null : null,
    changedPaths: available ? changedPaths : [],
    changedPathCount: available ? changedPathCount : 0,
    changedPathsTruncated: available ? source.changedPathsTruncated === true || changedPathCount > changedPaths.length : false,
    reason: available ? null : source?.reason ?? 'workspace-manifest-not-captured',
  };
}

function harnessEventsOf(done) {
  const source = done?.harnessEvents ?? done?.evidence?.harnessEvents;
  const events = Array.isArray(source) ? source : Array.isArray(source?.events) ? source.events : null;
  return events ? events.filter((event) => event && typeof event === 'object').slice(-200) : null;
}

function deriveHarnessBehavior(condition, telemetryEvents, harnessEvents, done, telemetryLedgerPresent) {
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

  const capturedHarnessEvents = Array.isArray(harnessEvents);
  const capturedToolEvents = telemetryLedgerPresent;
  if (!capturedHarnessEvents && !capturedToolEvents) return empty;
  const events = harnessEvents ?? [];
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
      verificationAfterFinalMutation = events.slice(finalMutationIndex + 1).some((event) => event.type === 'verify' && event.result === 'pass');
    }
  }

  const sessionBlocks = events.filter(
    (event) => event.type === 'session_end' && (event.decision === 'block' || event.result === 'fail' || event.blockedReason)
  );
  const explicitBypass = done?.enforcement?.policyBypassAchieved;
  return {
    orientInvoked: events.some((event) => event.type === 'orient') || toolCalls.some((event) => event.category === 'orient'),
    planCreatedOrSelected:
      events.some((event) => typeof event.plan === 'string' && event.plan.length > 0) ||
      toolCalls.some((event) => event.category === 'plan'),
    gateAttempts: capturedHarnessEvents ? gateEvents.length : gateCalls.length,
    gateDenials: capturedHarnessEvents
      ? gateEvents.filter((event) => event.result === 'fail' || event.decision === 'block' || event.blockedReason).length
      : gateResults.filter((event) => event.exitCode !== 0).length,
    outOfScopeMutationAttempts: capturedHarnessEvents ? blocks.filter((event) => /out[- ]of[- ]scope|outside.*scope|scope/.test(reason(event))).length : null,
    dangerousCommandAttempts: capturedHarnessEvents ? blocks.filter((event) => /danger|destruct|unsafe|protected|secret/.test(reason(event))).length : null,
    verificationAfterFinalMutation,
    prematureFinishAttempts: capturedHarnessEvents ? sessionBlocks.length : null,
    completionBlockedForVerification: capturedHarnessEvents
      ? sessionBlocks.some((event) => /verif|evidence|completion/.test(reason(event)))
      : null,
    // Harness v2 has no review event type. Leave this unsupported field null
    // rather than converting the absence of evidence into a false claim.
    reviewPerformed: null,
    policyBypassAttempted: capturedHarnessEvents ? blocks.length > 0 : null,
    policyBypassAchieved: typeof explicitBypass === 'boolean' ? explicitBypass : null,
  };
}

function enforcementFidelityOf(condition, done, harnessEvents) {
  const mechanicalHooksActive = Boolean(
    done?.enforcement?.hooksActive === true ||
      harnessEvents?.some((event) => ['pre_tool', 'post_tool', 'session_end'].includes(event.type))
  );
  return {
    // If hooks unexpectedly appear in the control arm, report that
    // contamination instead of forcing the intended `none` label.
    mode: mechanicalHooksActive ? 'mechanical-hooks' : condition === 'generic' ? 'none' : 'prompt-and-cli',
    promptContractActive: condition === 'harness',
    cliActivated: condition === 'harness' ? Boolean(done) : false,
    mechanicalHooksActive,
    harnessEventsCaptured: Array.isArray(harnessEvents),
    evidenceSource: mechanicalHooksActive ? 'exported-harness-events' : condition === 'harness' ? 'condition-and-setup' : 'control-condition',
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
    outputTokens: totals?.outputTokens ?? null,
    providerReportedCostUsd: totals?.providerCostUsd ?? null,
    localCostUsd: totals?.localCostUsd ?? null,
    usageComplete: totals?.usageComplete ?? null,
    providerCostComplete: totals?.providerCostComplete ?? null,
    billingComplete: totals?.billingComplete ?? null,
    costComplete: totals?.costComplete ?? null,
    missingUsage: totals?.missingUsage ?? null,
  };
}

/**
 * Collapse one condition's seed documents into a single schema-valid document:
 * majority verdict over ALL attempted seeds (a null-reward seed can never
 * count toward a pass), median reward over valid seeds, median per numeric
 * efficiency field. Budget charging is untouched — every seed trial charges
 * as it runs; the aggregate represents a typical trial, not the sum.
 */
export function aggregateSeedDocs(docs) {
  if (!docs.length) throw new Error('at least one repetition document is required');
  const rawRepetitions = docs.map((doc) => {
    const copy = structuredClone(doc);
    delete copy.repetitions;
    return copy;
  });
  if (docs.length === 1) {
    const only = structuredClone(docs[0]);
    only.repetitions = rawRepetitions;
    return only;
  }
  const median = (values) => {
    const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  };
  const valid = docs.filter((d) => d.correctness?.verifierReward != null);
  const passes = docs.filter((d) => d.correctness?.verdict === 'pass').length;
  const base = structuredClone(valid[0] ?? docs[0]);
  delete base.repetitions;
  base.correctness.verdict = passes >= Math.ceil(docs.length / 2) ? 'pass' : 'fail';
  base.correctness.verifierReward = median(valid.map((d) => d.correctness.verifierReward));
  base.correctness.exitReason = `seed-aggregate(n=${docs.length})`;
  base.correctness.completedWithinTimeout = docs.every((d) => d.correctness?.completedWithinTimeout !== false);
  base.correctness.completedWithinBudget = docs.every((d) => d.correctness?.completedWithinBudget !== false);
  for (const key of Object.keys(base.efficiency ?? {})) {
    base.efficiency[key] = median(docs.map((d) => d.efficiency?.[key]));
  }
  // Cost completeness is an all-seeds invariant, not a typical/median value:
  // one unmetered paid response invalidates the aggregate's spend evidence.
  base.efficiency.costComplete = docs.every((d) => d.efficiency?.costComplete === true);
  for (const key of ['usageComplete', 'providerCostComplete', 'billingComplete']) {
    const values = docs.map((doc) => doc.efficiency?.[key]).filter((value) => typeof value === 'boolean');
    base.efficiency[key] = values.length ? values.length === docs.length && values.every(Boolean) : null;
  }
  base.efficiency.missingUsage = docs.reduce(
    (sum, d) => sum + (Number.isFinite(d.efficiency?.missingUsage) ? d.efficiency.missingUsage : 0),
    0
  );
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
    const tagged = (key) => observed.flatMap((doc) =>
      (doc.observability[key] ?? []).map((event) => ({
        ...structuredClone(event),
        repetitionId: doc.reproducibility?.repetitionId ?? null,
      }))
    );
    const providerEvents = tagged('providerEvents');
    const toolEvents = tagged('toolEvents');
    const harnessEvents = tagged('harnessEvents');
    const sum = (key) => observed.reduce((total, doc) => total + (Number.isFinite(doc.observability[key]) ? doc.observability[key] : 0), 0);
    base.observability = {
      providerEvents,
      toolEvents,
      harnessEvents,
      providerAttemptsStarted: sum('providerAttemptsStarted'),
      providerAttemptsClosed: sum('providerAttemptsClosed'),
      unclosedProviderAttempts: sum('unclosedProviderAttempts'),
      correlatedToolResults: sum('correlatedToolResults'),
      uncorrelatedToolResults: sum('uncorrelatedToolResults'),
      eventEvidenceHash: stableHash({ providerEvents, toolEvents, harnessEvents }),
    };
  }
  base.reproducibility.startedAt = docs[0].reproducibility?.startedAt ?? base.reproducibility.startedAt;
  base.reproducibility.endedAt = docs.at(-1).reproducibility?.endedAt ?? base.reproducibility.endedAt;
  base.reproducibility.repetitionId = null;
  base.reproducibility.repetitionIndex = null;
  base.reproducibility.orderIndex = null;
  base.reproducibility.aggregation = 'majority-verdict-median-efficiency';
  if (base.observability) {
    base.reproducibility.telemetryHash = stableHash([...base.observability.providerEvents, ...base.observability.toolEvents]);
    base.reproducibility.harnessEventsHash = stableHash(base.observability.harnessEvents);
  }
  base.repetitions = rawRepetitions;
  return base;
}

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
}) {
  const telemetryLedgerPresent = Array.isArray(done?.telemetry?.events);
  const telemetryEvents = telemetryLedgerPresent ? done.telemetry.events : [];
  const lastResponse = telemetryEvents.filter((e) => e.type === 'response').at(-1) ?? null;
  const stopReason = done?.stopReason ?? (run.timedOut ? 'timeout' : 'unknown');
  const harnessEvents = harnessEventsOf(done);
  const workspaceEvidence = workspaceEvidenceOf(done);
  const providerEvents = telemetryEvents.filter((event) => PROVIDER_EVENT_TYPES.has(event.type));
  const toolEvents = telemetryEvents.filter((event) => TOOL_EVENT_TYPES.has(event.type));
  const attempts = providerEvents.filter((event) => event.type === 'request_attempt');
  const terminalAttempts = providerEvents.filter((event) => ['response', 'error'].includes(event.type));
  const terminalAttemptIds = new Set(terminalAttempts.map((event) => event.attemptId).filter(Boolean));
  const toolCallKeys = new Set(
    toolEvents
      .filter((event) => event.type === 'tool_call')
      .map((event) => `${event.requestId ?? ''}:${event.toolCallId ?? ''}`)
  );
  const toolResults = toolEvents.filter((event) => event.type === 'tool_result');
  const taskEntry = tasksOf(lock).find((entry) => entry.task === task);
  const taskHash = taskEntry?.taskChecksum ?? null;
  const conditionHash = conditionDocument ? stableHash(conditionDocument) : null;
  const systemPromptHash = typeof conditionDocument?.systemPrompt === 'string' ? sha256(conditionDocument.systemPrompt) : null;
  const runtime = conditionDocument?.runtime ?? {};
  const toolSchemaHash = conditionDocument
    ? stableHash(
        runtimeBridgeTools({
          guidanceCatalog: runtime.guidanceCatalog ?? conditionDocument.guidanceCatalog ?? null,
          enableCheckpoint: runtime.checkpoint === true,
        })
      )
    : done?.runtime?.toolSchemaHash ?? null;
  return {
    schema: 'eval-run.v1',
    reproducibility: {
      releaseSha,
      harnessVersion,
      harnessContentHash: condition === 'harness' ? systemPromptHash : null,
      taskId: task,
      taskRevision: lock.datasetRef,
      condition,
      modelRequested: profile.model,
      modelResolved: lastResponse?.model ?? null,
      providerResolved: lastResponse?.provider ?? null,
      host: 'openrouter-kimi',
      reasoningConfig: profile.reasoning,
      runnerVersion: '1',
      sandbox: null,
      startedAt,
      endedAt,
      pairId: identity.pairId ?? null,
      repetitionId: identity.repetitionId ?? null,
      repetitionIndex: identity.repetitionIndex ?? null,
      orderIndex: identity.orderIndex ?? null,
      attempt: identity.attempt ?? null,
      taskHash,
      conditionHash,
      systemPromptHash,
      toolSchemaHash,
      telemetryHash: telemetryEvents.length ? stableHash(telemetryEvents) : null,
      harnessEventsHash: harnessEvents ? stableHash(harnessEvents) : null,
    },
    correctness: {
      verifierReward: evidence.reward,
      verdict: verdictFromReward(evidence.reward, { passingReward: lock.verifier.passingReward }),
      assertionsPassed: evidence.pytest?.passed ?? null,
      assertionsFailed: evidence.pytest?.failed ?? null,
      requiredFilesCreated: null,
      finalDiffHash: workspaceEvidence.diffHash,
      verifierArtifactHash: evidence.treeHash ?? null,
      exitReason: stopReason,
      completedWithinTimeout: !run.timedOut,
      completedWithinBudget: stopReason !== 'budget_exhausted',
    },
    efficiency: efficiencyOf(done, startedAt, endedAt),
    harnessBehavior: deriveHarnessBehavior(condition, telemetryEvents, harnessEvents, done, telemetryLedgerPresent),
    enforcementFidelity: enforcementFidelityOf(condition, done, harnessEvents),
    workspaceEvidence,
    observability: {
      providerEvents,
      toolEvents,
      harnessEvents: harnessEvents ?? [],
      providerAttemptsStarted: attempts.length,
      providerAttemptsClosed: attempts.filter((event) => terminalAttemptIds.has(event.attemptId)).length,
      unclosedProviderAttempts: attempts.filter((event) => !terminalAttemptIds.has(event.attemptId)).length,
      correlatedToolResults: toolResults.filter((event) => toolCallKeys.has(`${event.requestId ?? ''}:${event.toolCallId ?? ''}`)).length,
      uncorrelatedToolResults: toolResults.filter((event) => !toolCallKeys.has(`${event.requestId ?? ''}:${event.toolCallId ?? ''}`)).length,
      eventEvidenceHash: stableHash({ providerEvents, toolEvents, harnessEvents: harnessEvents ?? [] }),
    },
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
  seeds = 1,
}) {
  // ?? null: an absent key must NOT fall back to the process environment —
  // the injected env is the whole truth for credential decisions here.
  const host = createKimiHost({ apiKey: env.OPENROUTER_API_KEY ?? null });
  const profile = host.profile;
  const limits = {
    maxSteps: 60,
    timeoutMs: profile.timeoutMs,
    maxOutputTokens: profile.maxTokens,
    trialCeilingUsd: profile.trialCeilingUsd,
  };
  let datasetDir = null;
  let bundle = null;

  function environment() {
    const missing = [];
    const probe = runHarbor({ args: ['--version'], cwd: workDir, spawnImpl, timeoutMs: 60_000, spawnEnv: harborSpawnEnv(null) });
    if (probe.spawnError || probe.code !== 0) missing.push('harbor CLI');
    missing.push(...host.validateCredentials().missing);
    return { ok: missing.length === 0, missing };
  }

  /** Locate (or download) the pinned dataset and verify EVERY pinned task's bytes BEFORE any paid step. */
  function taskLock() {
    if (!datasetDir) {
      if (env.HARNESS_EVAL_TB_DATASET_DIR) {
        datasetDir = env.HARNESS_EVAL_TB_DATASET_DIR;
      } else {
        const dest = path.join(workDir, 'dataset');
        const download = runHarbor({
          args: ['download', lock.datasetRef, '-o', dest, '--export'],
          cwd: workDir,
          spawnImpl,
          timeoutMs: 10 * 60_000,
          spawnEnv: harborSpawnEnv(null),
        });
        if (download.spawnError || download.code !== 0) {
          return { ok: false, reason: `task download failed: ${download.spawnError ?? download.stderr}` };
        }
        datasetDir = path.join(dest, lock.datasetRef.split('@')[0]);
      }
    }
    for (const entry of tasksOf(lock)) {
      const verdict = verifyTaskAgainstLock(path.join(datasetDir, entry.task), lock, entry.task);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
    }
    return { ok: true, reason: '' };
  }

  function runTrial({ condition, budget, label, task, identity }) {
    const conditionPath = path.join(workDir, `${task}-${label}.condition.json`);
    const telemetryFile = path.join(workDir, `${task}-${label}.done.json`);
    const trialCeilingUsd = Math.min(profile.trialCeilingUsd, budget.remainingUsd());
    const conditionDocument = {
      ...condition,
      profileId: profile.id,
      apiKeyEnv: 'OPENROUTER_API_KEY',
      limits: { ...condition.limits, trialCeilingUsd },
    };
    fs.writeFileSync(
      conditionPath,
      JSON.stringify(conditionDocument, null, 2)
    );
    const jobName = `kimi-${task}-${label}`;
    const jobsDir = path.join(workDir, 'jobs');
    const startedAt = now();
    const run = runHarbor({
      args: buildHarborRunArgs({
        lock,
        task,
        agentRef: AGENT_REF,
        model: profile.model,
        envName: env.HARNESS_EVAL_TB_ENV ?? config.execution?.environment ?? 'docker',
        jobName,
        jobsDir,
        mounts: [bundle.mount],
        agentEnv: {
          HARNESS_EVAL_TB_CONDITION: conditionPath,
          HARNESS_EVAL_TB_TELEMETRY_FILE: telemetryFile,
        },
      }),
      cwd: workDir,
      spawnImpl,
      timeoutMs: profile.timeoutMs + 10 * 60_000,
      spawnEnv: harborSpawnEnv(env.OPENROUTER_API_KEY),
    });
    const endedAt = now();
    const jobDir = jobDirFor({ jobsDir, jobName });
    const jobDirCreated = fs.existsSync(jobDir);
    const evidence = jobDirCreated
      ? collectVerifierEvidence(jobDir)
      : { reward: null, rewardPath: null, metrics: null, pytest: null, treeHash: null };
    let done = null;
    try {
      done = JSON.parse(fs.readFileSync(telemetryFile, 'utf8'));
    } catch {
      done = null;
    }
    const totals = done?.telemetry?.totals ?? null;
    // Provider-reported spend is the ledger of record; locally calculated
    // cost is the fallback. A missing ledger charges nothing and instead
    // fails the release through the metered-telemetry gate.
    const reconciledCost = totals?.providerCostComplete === true && totals?.providerCostUsd != null
      ? totals.providerCostUsd
      : totals?.localCostUsd ?? null;
    budget.charge(reconciledCost, `kimi ${label}`);
    const failureKind = classifyFailure({
      run,
      reward: evidence.reward,
      providerFailure: done?.stopReason === 'provider_error',
      jobDirCreated,
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
    });
    return { doc, failureKind };
  }

  function taskPair({ task, budget, attempt, trialCeilingUsd, n = seeds }) {
    const seedRuns = [];
    const pairId = shortHash({ schema: 'eval-pair.v1', releaseSha, host: host.id, task, attempt });
    for (let seed = 1; seed <= n; seed += 1) {
      const suffix = n > 1 ? `${attempt}${seed}` : attempt;
      const guidanceCatalog = buildGuidanceCatalog();
      const conditions = {
        generic: buildGenericCondition({ instruction: INSTRUCTION_PLACEHOLDER, limits }),
        harness: {
          ...buildHarnessCondition({
            instruction: INSTRUCTION_PLACEHOLDER,
            limits,
            engineerContract: engineerRuntimeContract,
            guidance: buildGuidance(),
          }),
          runtime: { guidanceCatalog, checkpoint: true },
        },
      };
      const results = {};
      // Primary seeds alternate AB/BA; the one-seed regression rerun reverses
      // the original order. Fixed per-arm budgets keep either order equivalent.
      const genericFirst = (seed + (attempt === 'b' ? 1 : 0)) % 2 === 1;
      const order = genericFirst ? ['generic', 'harness'] : ['harness', 'generic'];
      for (const [orderOffset, conditionId] of order.entries()) {
        const trialBudget = createBudget({
          ceilingUsd: trialCeilingUsd,
          label: `${task}-${conditionId}-${suffix}`,
          parent: budget,
        });
        results[conditionId] = runTrial({
          condition: conditions[conditionId],
          budget: trialBudget,
          label: `${conditionId}-${suffix}`,
          task,
          identity: {
            pairId,
            repetitionId: shortHash({ pairId, seed }),
            repetitionIndex: seed,
            orderIndex: orderOffset + 1,
            attempt,
          },
        });
      }
      const { generic, harness } = results;
      seedRuns.push({ generic, harness });
    }
    // A pair is invalid only when a majority of its seeds failed to produce a
    // valid trial; otherwise the surviving seeds carry the verdict.
    const kinds = seedRuns.map((r) => r.generic.failureKind ?? r.harness.failureKind);
    const validSeeds = kinds.filter((k) => !k).length;
    let failureKind = null;
    if (validSeeds < Math.ceil(kinds.length / 2)) {
      const counts = {};
      for (const kind of kinds.filter(Boolean)) counts[kind] = (counts[kind] ?? 0) + 1;
      failureKind = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    return {
      host: host.id,
      task,
      pairId,
      seedCount: n,
      generic: aggregateSeedDocs(seedRuns.map((r) => r.generic.doc)),
      harness: aggregateSeedDocs(seedRuns.map((r) => r.harness.doc)),
      failureKind,
    };
  }

  function ensureBundle() {
    // A pre-built bundle (offline releases, tests) short-circuits preparation.
    bundle ??= env.HARNESS_EVAL_TB_BUNDLE_DIR
      ? { bundleDir: env.HARNESS_EVAL_TB_BUNDLE_DIR, mount: bundleMount(env.HARNESS_EVAL_TB_BUNDLE_DIR) }
      : prepareBundle({ bundleDir: path.join(workDir, 'harness-bundle'), spawnImpl });
  }

  return {
    environment,
    taskLock,
    /** One fresh generic+harness pair per pinned task. */
    kimiPair: async (budget) => {
      if (!host.validateCredentials().ok) return null;
      ensureBundle();
      const tasks = tasksOf(lock);
      const trialCeilingUsd = Math.min(profile.trialCeilingUsd, budget.remainingUsd() / (tasks.length * seeds * 2));
      return tasks.map((entry) => taskPair({ task: entry.task, budget, attempt: 'a', trialCeilingUsd }));
    },
    /** §9 conditional rerun: ONE complete fresh pair for ONE regressed task (never seed-multiplied). */
    rerunKimiPair: async (budget, task) => {
      if (!host.validateCredentials().ok) return null;
      ensureBundle();
      const trialCeilingUsd = Math.min(profile.trialCeilingUsd, budget.remainingUsd() / 2);
      return taskPair({ task: task ?? tasksOf(lock)[0].task, budget, attempt: 'b', trialCeilingUsd, n: 1 });
    },
    frontierPair: null,
    gemmaPair: null,
    smokes: null,
  };
}
