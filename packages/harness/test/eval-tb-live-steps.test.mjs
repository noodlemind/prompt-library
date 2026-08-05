import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AGENT_REF, buildLiveSteps, aggregateRepetitionDocs, buildRunDoc, instructionAsDeliveredByHarbor, promptAndPhaseEconomicsOf } from '../../../evals/external/terminal_bench/live-steps.mjs';
import { runtimeBridgeTools } from '../../../evals/external/terminal_bench/agent.mjs';
import { BUNDLE_MOUNT_TARGET, CONDITION_INPUTS_FILE, EVAL_RUNTIME_MOUNT_TARGET, harnessWrapperScript, activationCommands } from '../../../evals/external/terminal_bench/provision.mjs';
import { runHarbor, stampTaskLock, verifyTaskAgainstLock } from '../../../evals/external/terminal_bench/harbor-adapter.mjs';
import { hashTree, parseReward } from '../../../evals/external/terminal_bench/verifier.mjs';
import { efficiencyDelta, validateAgainstSchema, runRelease } from '../../../evals/release.mjs';
import { createBudget } from '../../../evals/lib/budget.mjs';
import { getProfile } from '../../../evals/lib/model-profiles.mjs';
import {
  ECONOMIC_PHASES,
  ECONOMIC_PHASE_FIELDS,
  SOURCE_USAGE_TO_ECONOMIC_FIELD,
  CONTEXT_SOURCE_TO_ECONOMIC_PHASE,
  economicPhaseForContextSource,
} from '../../../evals/lib/economic-phases.mjs';

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const BASE_LOCK = JSON.parse(fs.readFileSync(new URL('../../../evals/external/terminal_bench/task-lock.json', import.meta.url), 'utf8'));
const CONTROLLED_LANE = { host: 'openrouter-controlled', profileId: 'kimi-k2.7-code' };
const fakeHarborIdentity = () => ({ path: '/opt/test/harbor', sha256: 'e'.repeat(64) });
const fakeSandboxIdentity = ({ sandbox }) => ({
  ...sandbox,
  dockerExecutableHash: '7'.repeat(64),
  observedImageId: sandbox.imageId,
  observedPlatform: sandbox.platform,
  identityAttested: true,
});

test('eval-run schema pins the prompt-manifest separator to the builder contract', () => {
  assert.deepEqual(RUN_SCHEMA.$defs.promptManifest.properties.separator, { const: '\n\n' });
  const runtimeTrustEvidence = RUN_SCHEMA.properties.observability.properties.runtimeTrustEvidence;
  assert.equal(
    runtimeTrustEvidence.properties.schema.const,
    'engineer-runtime-trial-final-attestation.v1'
  );
  assert.equal(runtimeTrustEvidence.additionalProperties, false);
});

test('economic phase taxonomy and driver context sources stay closed and schema-aligned', () => {
  const schemaPhases = RUN_SCHEMA.properties.economics.properties.phases;
  const schemaPhase = RUN_SCHEMA.$defs.economicPhase;
  const schemaTotals = RUN_SCHEMA.$defs.economicTotals;
  const expectedEconomicProperties = [
    ...ECONOMIC_PHASE_FIELDS,
    ...ECONOMIC_PHASE_FIELDS.map((field) => `${field}Complete`),
  ].sort();
  const phaseMetadata = new Set([
    'status', 'logicalRequests', 'usageRecords', 'repetitionsObserved',
    'repetitionCoverage', 'derivedFrom',
  ]);
  const totalsMetadata = new Set(['logicalRequests', 'usageRecords']);
  assert.deepEqual(schemaPhases.required, ECONOMIC_PHASES);
  assert.deepEqual(Object.keys(schemaPhases.properties), ECONOMIC_PHASES);
  assert.deepEqual(ECONOMIC_PHASE_FIELDS, Object.values(SOURCE_USAGE_TO_ECONOMIC_FIELD));
  assert.deepEqual(
    Object.keys(schemaPhase.properties).filter((field) => !phaseMetadata.has(field)).sort(),
    expectedEconomicProperties,
    'phase schema economic fields must exactly match the usage mapping'
  );
  assert.deepEqual(
    Object.keys(schemaTotals.properties).filter((field) => !totalsMetadata.has(field)).sort(),
    expectedEconomicProperties,
    'totals schema economic fields must exactly match the usage mapping'
  );
  for (const field of ECONOMIC_PHASE_FIELDS) {
    assert.ok(schemaPhase.required.includes(field), `${field} phase value is required`);
    assert.ok(schemaPhase.required.includes(`${field}Complete`), `${field} phase completeness is required`);
    assert.ok(Object.hasOwn(schemaPhase.properties, field), `${field} phase value is declared`);
    assert.ok(Object.hasOwn(schemaPhase.properties, `${field}Complete`), `${field} phase completeness is declared`);
    assert.ok(schemaTotals.required.includes(field), `${field} total value is required`);
    assert.ok(schemaTotals.required.includes(`${field}Complete`), `${field} total completeness is required`);
  }
  for (const [source, phase] of Object.entries(CONTEXT_SOURCE_TO_ECONOMIC_PHASE)) {
    assert.equal(economicPhaseForContextSource(source), phase, source);
    assert.ok(ECONOMIC_PHASES.includes(phase), source);
  }
  assert.equal(economicPhaseForContextSource('new-unclassified-source'), 'unknown');
  assert.equal(economicPhaseForContextSource('toString'), 'unknown');
  assert.equal(economicPhaseForContextSource('constructor'), 'unknown');
  assert.equal(economicPhaseForContextSource('__proto__'), 'unknown');
  assert.equal(economicPhaseForContextSource('durable-state'), 'memory-construction');
});

function fakePreparedBundle(bundleDir, sourceIdentity = { releaseSha: 'sha1', harnessVersion: '0.5.0' }) {
  fs.mkdirSync(bundleDir, { recursive: true });
  const guidance = 'Fixture ensure-plan guidance.';
  fs.writeFileSync(path.join(bundleDir, CONDITION_INPUTS_FILE), JSON.stringify({
    version: 'eval-condition-inputs.v1',
    sourceIdentity,
    engineerRuntimeContract: 'Fixture Engineer runtime contract.',
    guidancePrompt: '# On-demand Harness guidance\n- ensure-plan',
    guidanceCatalog: {
      'ensure-plan': {
        id: 'ensure-plan',
        path: '.github/skills/ensure-plan/SKILL.md',
        description: 'Fixture guidance',
        content: guidance,
        sizeChars: guidance.length,
        sha256: crypto.createHash('sha256').update(guidance).digest('hex'),
      },
    },
  }));
  const commonTargets = [
    `${EVAL_RUNTIME_MOUNT_TARGET}/node-x64`,
    `${EVAL_RUNTIME_MOUNT_TARGET}/evidence-probe`,
    `${EVAL_RUNTIME_MOUNT_TARGET}/bounded-exec`,
  ];
  const treatmentOnlyTargets = [
    `${BUNDLE_MOUNT_TARGET}/harness`,
    `${BUNDLE_MOUNT_TARGET}/harness-cli`,
  ];
  const mounts = (targets) => targets.map((target) => ({
    type: 'bind',
    source: path.join(bundleDir, target.split('/').at(-1)),
    target,
    read_only: true,
  }));
  const generic = mounts(commonTargets);
  return {
    bundleDir,
    manifestHash: 'f'.repeat(64),
    mountPolicy: {
      version: 'eval-mount-policy.v1',
      generic,
      harness: [...generic, ...mounts(treatmentOnlyTargets)],
      commonTargets,
      treatmentOnlyTargets,
      structurallyIsolated: true,
    },
  };
}

function fakeValidateBundle(bundleDir, { expectedManifestHash, expectedSourceIdentity }) {
  const prepared = fakePreparedBundle(bundleDir, expectedSourceIdentity);
  return { manifestHash: expectedManifestHash, mountPolicy: prepared.mountPolicy };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-live-'));
}

function filesUnder(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

// Most live-step tests exercise telemetry, budgeting, pairing, and integrity
// logic independently of reward provenance. Their fake Harbor has no verifier
// phase, so inject a synthetic collector for those tests only. Production uses
// collectVerifierEvidence, which rejects Harbor 0.20's agent-writable rewards.
function trustedFixtureVerifierEvidence(jobDir) {
  const files = filesUnder(jobDir);
  const rewardJson = files.find((file) => /[/\\]verifier[/\\]reward\.json$/.test(file));
  const rewardTxt = files.find((file) => /[/\\]verifier[/\\]reward\.txt$/.test(file));
  let parsed = null;
  let rewardPath = null;
  for (const candidate of [rewardJson, rewardTxt]) {
    if (!candidate) continue;
    const result = parseReward(fs.readFileSync(candidate, 'utf8'), path.basename(candidate));
    if (result?.reward == null) continue;
    parsed = result;
    rewardPath = candidate;
    break;
  }
  return {
    reward: parsed?.reward ?? null,
    rewardPath,
    metrics: parsed?.metrics ?? null,
    pytest: null,
    treeHash: hashTree(jobDir),
    degraded: null,
  };
}

/** A fixture dataset root with the anchor task, plus a lock pinning ONLY it. */
function fixtureTask() {
  const datasetDir = tmpdir();
  const taskDir = path.join(datasetDir, 'cobol-modernization');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'instruction.md'), 'Modernize the COBOL program.');
  fs.writeFileSync(path.join(taskDir, 'task.toml'), `[environment]\n` +
    `docker_image = "alexgshaw/cobol-modernization:20251031"\n` +
    `cpus = 1\nmemory = "2G"\nstorage = "10G"\n`);
  fs.mkdirSync(path.join(taskDir, 'tests'));
  fs.writeFileSync(path.join(taskDir, 'tests', 'test.sh'), 'pytest');
  // Decouple from however many tasks the committed lock pins.
  const singleTaskLock = { ...BASE_LOCK, tasks: BASE_LOCK.tasks.filter((t) => t.task === 'cobol-modernization') };
  return { datasetDir, taskDir, lock: stampTaskLock(taskDir, singleTaskLock, 'cobol-modernization') };
}

/**
 * A fake harbor: `--version` succeeds; job and isolated-trial invocations write the verifier reward
 * and the bridge done-file exactly where the real pipeline would.
 */
function fakeHarborSpawn({
  reward = 1,
  exitCode = 0,
  writeTelemetry = true,
  writeHostResult = true,
  providerCostUsd = 0.02,
  providerCostComplete = true,
  billingComplete = true,
  unknownBillingAttempts = 0,
  stopReason = 'model_finish',
  mutateDone = null,
  mutateJob = null,
  harborVersion = '0.20.0',
} = {}) {
  const invocations = [];
  return {
    invocations,
    spawnImpl: (cmd, args, opts) => {
      invocations.push({ cmd, args, opts });
      if (args[0] === '--version') return { status: 0, stdout: harborVersion, stderr: '', containmentComplete: true };
      const isolatedTrial = args[0] === 'trial' && args[1] === 'start';
      if (args[0] !== 'run' && !isolatedTrial) {
        return { status: 0, stdout: '', stderr: '', containmentComplete: true };
      }
      const trialRoot = isolatedTrial ? args[args.indexOf('--trials-dir') + 1] : null;
      const jobsDir = isolatedTrial ? path.dirname(trialRoot) : args[args.indexOf('--jobs-dir') + 1];
      const jobName = isolatedTrial ? path.basename(trialRoot) : args[args.indexOf('--job-name') + 1];
      const trialName = isolatedTrial ? args[args.indexOf('--trial-name') + 1] : 'trial__fx0';
      const runIndex = invocations.filter((invocation) =>
        invocation.args[0] === 'run' ||
        (invocation.args[0] === 'trial' && invocation.args[1] === 'start')
      ).length;
      const agentEnv = {};
      let condition = null;
      args.forEach((a, i) => {
        if (a === '--ae') {
          const [k, ...rest] = args[i + 1].split('=');
          agentEnv[k] = rest.join('=');
        }
      });
      if (exitCode === 0) {
        const verifierDir = path.join(jobsDir, jobName, trialName, 'verifier');
        fs.mkdirSync(verifierDir, { recursive: true });
        const resolvedReward = typeof reward === 'function' ? reward({ jobName, runIndex }) : reward;
        fs.writeFileSync(path.join(verifierDir, 'reward.json'), JSON.stringify({ reward: resolvedReward }));
        // Harbor writes the trial record on the HOST after the verifier phase.
        if (writeHostResult) {
          fs.writeFileSync(
            path.join(jobsDir, jobName, trialName, 'result.json'),
            JSON.stringify({ verifier_result: { rewards: { reward: resolvedReward } } })
          );
        }
        if (writeTelemetry && agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE) {
          condition = JSON.parse(fs.readFileSync(agentEnv.HARNESS_EVAL_TB_CONDITION, 'utf8'));
          const runtime = condition.runtime ?? {};
          const tools = runtimeBridgeTools({
            guidanceCatalog: runtime.guidanceCatalog ?? condition.guidanceCatalog ?? null,
            enableCheckpoint: runtime.checkpoint === true,
            enableTrustedVerify: runtime.trustedVerify === true,
          });
          const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
          const profile = getProfile(condition.profileId);
          const paidProfile = Object.values(profile.pricing).some((value) => value > 0);
          const requestControls = {
            endpointHash: digest(condition.providerUrl),
            model: profile.model,
            maxTokens: condition.limits.maxOutputTokens,
            temperaturePresent: profile.temperature != null,
            temperature: profile.temperature ?? null,
            reasoningPresent: profile.reasoning != null,
            reasoning: profile.reasoning ?? null,
            toolChoice: 'auto',
            providerPresent: profile.provider != null,
            providerOrder: Array.isArray(profile.provider?.order) ? profile.provider.order.slice() : null,
            providerAllowFallbacks: profile.provider?.allowFallbacks ?? null,
            unexpectedRequestFields: [],
          };
          const providerTools = tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          }));
          const requestContract = {
            toolSchemaHash: digest(JSON.stringify(providerTools)),
            toolCount: providerTools.length,
            toolMode: 'full',
            postVerify: false,
            ...requestControls,
            requestBodyHash: '9'.repeat(64),
            requestControlHash: digest(JSON.stringify(requestControls)),
          };
          const taskPath = isolatedTrial
            ? args[args.indexOf('--path') + 1]
            : path.join(args[args.indexOf('-p') + 1], args[args.indexOf('--include-task-name') + 1]);
          const instruction = instructionAsDeliveredByHarbor(
            fs.readFileSync(path.join(taskPath, 'instruction.md'), 'utf8')
          );
          const systemMessageChars = JSON.stringify({ role: 'system', content: condition.systemPrompt }).length;
          const instructionMessageChars = JSON.stringify({ role: 'user', content: instruction }).length;
          const messageEnvelopeChars = JSON.stringify([
            { role: 'system', content: condition.systemPrompt },
            { role: 'user', content: instruction },
          ]).length - systemMessageChars - instructionMessageChars;
          const toolSchemaChars = JSON.stringify(providerTools).length;
          const payloadEnvelopeChars = 200;
          const payloadChars = systemMessageChars + instructionMessageChars + messageEnvelopeChars +
            toolSchemaChars + payloadEnvelopeChars;
          Object.assign(requestContract, {
            payloadChars,
            payloadBytes: payloadChars,
            systemPromptHash: digest(condition.systemPrompt),
            instructionHash: digest(instruction),
            systemMessageCount: 1,
            instructionMessageCount: 1,
            systemPromptPosition: 0,
            instructionPosition: 1,
            durableStateMessageCount: 0,
            durableStateMessageIndex: null,
            durableStateMessageHash: null,
            unexpectedSystemMessageCount: 0,
            promptComponentManifest: structuredClone(condition.promptComponentManifest),
            promptBuckets: {
              baseSystem: systemMessageChars,
              instruction: instructionMessageChars,
              durableState: 0,
              assistantHistory: 0,
              toolResultHistory: 0,
              otherMessages: 0,
              messageEnvelope: messageEnvelopeChars,
              toolSchema: toolSchemaChars,
              payloadEnvelope: payloadEnvelopeChars,
              toolResultHistoryBySource: {},
              complete: true,
            },
          });
          const localCostPerResponse = paidProfile ? 0.001328 : 0;
          const observedProviderCostUsd = paidProfile && providerCostComplete ? providerCostUsd : null;
          const responseUsage = {
            promptTokens: 800,
            cachedTokens: 200,
            cachedTokensComplete: true,
            reasoningTokens: 0,
            reasoningTokensComplete: true,
            outputTokens: 180,
            localCostUsd: localCostPerResponse,
            providerCostUsd: observedProviderCostUsd == null ? null : observedProviderCostUsd / 5,
            reconciledCostUsd: observedProviderCostUsd == null
              ? localCostPerResponse
              : Math.max(localCostPerResponse, observedProviderCostUsd / 5),
          };
          const observedUnknownBillingAttempts = paidProfile ? unknownBillingAttempts : 0;
          const observedBillingComplete = paidProfile ? billingComplete : true;
          const observedProviderCostComplete = paidProfile ? providerCostComplete : true;
          const responseBillingStatus = paidProfile
            ? observedBillingComplete && observedUnknownBillingAttempts === 0 ? 'reported' : 'unknown'
            : 'confirmed_unbilled';
          const done = {
              type: 'done',
              answer: 'done',
              stopReason,
              steps: 7,
              runtime: {
                systemPromptHash: digest(condition.systemPrompt),
                instructionHash: digest(instruction),
                toolSchemaHash: digest(JSON.stringify(tools)),
                toolCount: tools.length,
                promptComponentManifest: structuredClone(condition.promptComponentManifest),
                promptComponentManifestHash: digest(JSON.stringify(condition.promptComponentManifest)),
              },
              mountEvidence: {
                version: 'eval-mount-policy.v1',
                source: 'sandbox-observed',
                targets: JSON.parse(args[args.indexOf('--mounts') + 1]).map((mount) => mount.target),
                existingTargets: JSON.parse(args[args.indexOf('--mounts') + 1]).map((mount) => mount.target),
                allReadOnly: true,
                complete: true,
              },
              telemetry: {
                totals: {
                  requests: 8,
                  modelRequests: 5,
                  providerAttempts: 6,
                  providerResponses: 5,
                  providerErrors: 1,
                  retries: 1,
                  openAttempts: 0,
                  unknownBillingAttempts: observedUnknownBillingAttempts,
                  missingUsage: 0,
                  promptTokens: 4000,
                  cachedTokens: 1000,
                  reasoningTokens: 0,
                  cachedTokensComplete: true,
                  reasoningTokensComplete: true,
                  outputTokens: 900,
                  localCostUsd: paidProfile ? 0.00664 : 0,
                  providerCostUsd: observedProviderCostUsd,
                  reconciledCostUsd: observedProviderCostUsd == null
                    ? paidProfile ? 0.00664 : 0
                    : Math.max(paidProfile ? 0.00664 : 0, observedProviderCostUsd),
                  usageComplete: true,
                  providerCostComplete: observedProviderCostComplete,
                  billingComplete: observedBillingComplete,
                  costComplete: observedProviderCostComplete && observedBillingComplete && observedUnknownBillingAttempts === 0,
                },
                events: [
                  { seq: 0, eventId: 'e0', type: 'request', requestId: 'r1', monotonicMs: 10, ...requestContract },
                  { seq: 1, eventId: 'e1', type: 'request_attempt', requestId: 'r1', attemptId: 'a1', monotonicMs: 11 },
                  { seq: 2, eventId: 'e2', type: 'error', requestId: 'r1', attemptId: 'a1', billingStatus: 'confirmed_unbilled', monotonicMs: 12 },
                  { seq: 3, eventId: 'e3', type: 'retry', requestId: 'r1', attemptId: 'a1', monotonicMs: 13 },
                  { seq: 4, eventId: 'e4', type: 'request_attempt', requestId: 'r1', attemptId: 'a2', monotonicMs: 14 },
                  { seq: 5, eventId: 'e5', type: 'response', requestId: 'r1', attemptId: 'a2', model: profile.model, provider: paidProfile ? 'Moonshot AI' : null, generationId: 'gen-1', billingStatus: responseBillingStatus, usage: responseUsage, monotonicMs: 20 },
                  ...Array.from({ length: 4 }, (_, index) => {
                    const requestNumber = index + 2;
                    const attemptNumber = index + 3;
                    return [
                      { seq: 6 + index * 3, eventId: `e-request-${requestNumber}`, type: 'request', requestId: `r${requestNumber}`, monotonicMs: 21 + index * 3, ...requestContract },
                      { seq: 7 + index * 3, eventId: `e-attempt-${attemptNumber}`, type: 'request_attempt', requestId: `r${requestNumber}`, attemptId: `a${attemptNumber}`, monotonicMs: 22 + index * 3 },
                      { seq: 8 + index * 3, eventId: `e-response-${attemptNumber}`, type: 'response', requestId: `r${requestNumber}`, attemptId: `a${attemptNumber}`, model: profile.model, provider: paidProfile ? 'Moonshot AI' : null, generationId: `gen-${requestNumber}`, billingStatus: index === 0 ? responseBillingStatus : paidProfile ? 'reported' : 'confirmed_unbilled', usage: responseUsage, monotonicMs: 23 + index * 3 },
                    ];
                  }).flat(),
                  { seq: 18, eventId: 'e18', type: 'tool_call', requestId: 'r1', toolCallId: 'tc1', tool: 'bash', category: 'inspect', argsChars: 12, argsHash: '1'.repeat(64), immutableHarnessCli: false, argumentsValid: true, monotonicMs: 35 },
                  { seq: 19, eventId: 'e19', type: 'tool_result', requestId: 'r1', toolCallId: 'tc1', tool: 'bash', category: 'inspect', exitCode: 0, durationMs: 5, stdoutChars: 2, stderrChars: 0, resultChars: 40, resultHash: '2'.repeat(64), compacted: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false, containmentMode: 'linux-process-census', containmentComplete: true, monotonicMs: 40 },
                  { seq: 20, eventId: 'e20', type: 'tool_call', requestId: 'r2', toolCallId: 'tc2', tool: 'bash', category: 'test', argsChars: 10, argsHash: '3'.repeat(64), immutableHarnessCli: false, argumentsValid: true, monotonicMs: 45 },
                  { seq: 21, eventId: 'e21', type: 'tool_result', requestId: 'r2', toolCallId: 'tc2', tool: 'bash', category: 'test', exitCode: 1, durationMs: 5, stdoutChars: 0, stderrChars: 7, resultChars: 45, resultHash: '4'.repeat(64), compacted: true, stdoutTruncated: false, stderrTruncated: false, timedOut: false, containmentMode: 'linux-process-census', containmentComplete: true, monotonicMs: 50 },
                  { seq: 22, eventId: 'e22', type: 'context_compacted', beforeChars: 40000, afterChars: 20000, monotonicMs: 55 },
                  { seq: 23, eventId: 'e23', type: 'tool_result_compacted', toolCallId: 'tc2', originalChars: 9000, limit: 1600, monotonicMs: 56 },
                ],
              },
              workspaceEvidence: {
                available: true,
                collectionMode: 'bounded-typed-content-plus-git-state-v3',
                beforeManifestHash: 'a'.repeat(64),
                afterManifestHash: 'b'.repeat(64),
                diffHash: 'c'.repeat(64),
                changedPaths: ['src/result.txt'],
                changedPathCount: 1,
                changedPathsTruncated: false,
                gitStateAvailable: true,
                gitStatePresent: true,
                beforeGitStateHash: 'd'.repeat(64),
                afterGitStateHash: 'd'.repeat(64),
                gitStateChanged: false,
              },
              harnessEvents: [],
              harnessEventEvidence: {
                available: true,
                complete: true,
                reason: null,
                retainedEvents: 0,
                sourceTruncated: false,
                projectionRejectedEvents: 0,
                projectionRejectedChecks: 0,
              },
              enforcement: { hooksActive: false, policyBypassAchieved: false, source: 'sandbox-writable-harness-events' },
            };
          mutateDone?.(done, { condition, runIndex, jobName });
          fs.writeFileSync(
            agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE,
            JSON.stringify(done)
          );
        }
        mutateJob?.({ verifierDir, condition, runIndex, jobName });
      }
      return { status: exitCode, stdout: '', stderr: exitCode ? 'boom' : '', containmentComplete: true };
    },
  };
}

function testProviderControl({
  apiKey,
  fetchImpl,
  timeoutMs = 30_000,
  releaseSha,
} = {}) {
  if (apiKey == null) return { available: false, preflight: async () => null };
  return {
    available: true,
    async preflight({ ceilingUsd, hardLimitUsd }) {
      const lookup = fetchImpl ?? (async () => ({
        ok: true,
        json: async () => ({
          data: {
            limit: hardLimitUsd ?? ceilingUsd,
            limit_remaining: hardLimitUsd ?? ceilingUsd,
            limit_reset: null,
          },
        }),
      }));
      let timer;
      const response = await Promise.race([
        lookup(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('test provider metadata timeout')), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!response?.ok) throw new Error('test provider metadata lookup failed');
      const data = (await Promise.race([
        response.json(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('test provider metadata timeout')), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer)))?.data;
      const toMicrousd = (value) => typeof value === 'number' && Number.isFinite(value)
        ? Math.round(value * 1_000_000)
        : value;
      return {
        schema: 'engineer-provider-preflight-observation.v1',
        keyFingerprint: crypto.createHmac('sha256', apiKey)
          .update('engineer-harness/openrouter-key/v1\0')
          .update(releaseSha)
          .digest('hex'),
        limitMicrousd: toMicrousd(data?.limit),
        limitRemainingMicrousd: toMicrousd(data?.limit_remaining),
        reset: data?.limit_reset == null ? null : 'configured',
        checkedAt: '2026-07-31T00:00:00.000Z',
      };
    },
  };
}

function liveSteps({ datasetDir, taskDir, lock, spawnImpl, apiKey = 'test-key', workDir = tmpdir(), config = null, fetchImpl = undefined, providerLookupTimeoutMs = undefined, repetitions = null, releaseSha = 'sha1', ambientEnv = {}, validateBundle = fakeValidateBundle, prepareBundle = null, attestHostNodeExecutable = undefined, collectEvidence = trustedFixtureVerifierEvidence, trialExecutor = undefined, localEnabled = false }) {
  let clockTick = 0;
  return buildLiveSteps({
    config: { controlledLane: CONTROLLED_LANE, ...(config ?? { execution: { environment: 'docker' } }) },
    lock,
    workDir,
    env: { ...ambientEnv, HARNESS_EVAL_TB_DATASET_DIR: datasetDir ?? path.dirname(taskDir) },
    releaseSha,
    harnessVersion: '0.5.0',
    spawnImpl,
    attestHarborExecutable: fakeHarborIdentity,
    ...(attestHostNodeExecutable ? { attestHostNodeExecutable } : {}),
    attestSandboxImage: fakeSandboxIdentity,
    validateBundle,
    ...(collectEvidence ? { collectEvidence } : {}),
    providerControl: testProviderControl({
      apiKey,
      fetchImpl,
      timeoutMs: providerLookupTimeoutMs,
      releaseSha,
    }),
    ...(repetitions != null ? { repetitions } : {}),
    ...(trialExecutor ? { trialExecutor } : {}),
    localEnabled,
    now: () => new Date(Date.UTC(2026, 6, 31, 0, 0, clockTick++)).toISOString(),
    prepareBundle: prepareBundle ?? (({ bundleDir, sourceIdentity }) => fakePreparedBundle(bundleDir, sourceIdentity)),
  });
}

test('the live pair awaits one injected isolated executor per arm and retains its runtime evidence', async () => {
  const { taskDir, lock } = fixtureTask();
  const harbor = fakeHarborSpawn();
  const executions = [];
  const trialExecutor = async (request) => {
    assert.equal(Object.hasOwn(request, 'runLocal'), false, 'paid runtime never receives a host fallback');
    executions.push({
      trialId: request.trial.trialId,
      condition: request.trial.condition,
      hasProviderSecret: Object.values(request.harbor.spawnEnv ?? {}).includes('test-key'),
    });
    return {
      run: runHarbor({ ...request.harbor, spawnImpl: harbor.spawnImpl }),
      runtimeEvidence: {
        schema: 'engineer-runtime-trial-final-attestation.v1',
        evidenceHash: String(executions.length).repeat(64),
        providerSpendMicrousd: 20_000,
      },
    };
  };
  const steps = liveSteps({
    taskDir,
    lock,
    spawnImpl: harbor.spawnImpl,
    trialExecutor,
    localEnabled: true,
    config: {
      execution: { environment: 'docker' },
      pairs: [{ host: 'ollama-gemma', enabled: true, schedule: 'explicit-with-local', taskRole: 'anchor' }],
    },
  });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'isolated-executor' }));

  assert.deepEqual(executions.map(({ condition }) => condition).sort(), ['generic', 'harness']);
  assert.ok(executions.every(({ trialId }) => typeof trialId === 'string' && trialId.length > 0));
  assert.ok(executions.every(({ hasProviderSecret }) => hasProviderSecret === false));
  for (const repetition of [pair.generic.repetitions[0], pair.harness.repetitions[0]]) {
    assert.equal(repetition.observability.runtimeTrustEvidence.schema, 'engineer-runtime-trial-final-attestation.v1');
    assert.match(repetition.observability.runtimeTrustEvidence.evidenceHash, /^[12]{64}$/);
    assert.equal(repetition.observability.runtimeTrustEvidence.providerSpendMicrousd, 20_000);
  }
  await steps.gemmaPair(createBudget({ ceilingUsd: 1, label: 'local-informational' }));
  assert.equal(executions.length, 2, 'the local Ollama lane never enters the credential-bearing executor');
});

test('injected provider custody rejects an ambient raw OpenRouter key before preflight', () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  assert.throws(
    () => buildLiveSteps({
      config: { controlledLane: CONTROLLED_LANE, execution: { environment: 'docker' } },
      lock,
      workDir: tmpdir(),
      env: {
        OPENROUTER_API_KEY: 'raw-key-must-be-rejected',
        HARNESS_EVAL_TB_DATASET_DIR: path.dirname(taskDir),
      },
      providerControl: testProviderControl({ apiKey: 'custodied-key', releaseSha: 'sha1' }),
      spawnImpl,
      attestHarborExecutable: fakeHarborIdentity,
      attestSandboxImage: fakeSandboxIdentity,
      validateBundle: fakeValidateBundle,
      collectEvidence: trustedFixtureVerifierEvidence,
      prepareBundle: ({ bundleDir, sourceIdentity }) => fakePreparedBundle(bundleDir, sourceIdentity),
    }),
    /raw.*credential|OPENROUTER_API_KEY|ambient/i
  );
});

test('controlled live steps require an explicit lane instead of silently selecting Kimi', () => {
  const { lock } = fixtureTask();
  assert.throws(
    () => buildLiveSteps({
      config: { execution: { environment: 'docker' } },
      lock,
      workDir: tmpdir(),
      env: {},
      providerControl: testProviderControl(),
    }),
    /controlledLane.*required/i
  );
});

test('historical Kimi pair names remain exact aliases of the controlled API', () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  const steps = liveSteps({ taskDir, lock, spawnImpl });

  assert.equal(steps.kimiPair, steps.controlledPair);
  assert.equal(steps.rerunKimiPair, steps.rerunControlledPair);
});

function requestControlsFromEvent(event) {
  return {
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
  };
}

function refreshRequestControlHash(event) {
  event.requestControlHash = crypto.createHash('sha256')
    .update(JSON.stringify(requestControlsFromEvent(event)))
    .digest('hex');
}

test('live steps reject invalid repetition counts before scheduling trials', () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  for (const repetitions of [0, -1, 1.5, Number.NaN, '2']) {
    assert.throws(
      () => liveSteps({ taskDir, lock, spawnImpl, repetitions }),
      /repetitions must be a positive integer/i,
      String(repetitions)
    );
  }
});

test('controlled live steps reject cloud environments that cannot materialize attested host mounts', () => {
  const { taskDir, lock } = fixtureTask();
  for (const [config, env] of [
    [{ execution: { environment: 'daytona' } }, {}],
    [{ execution: { environment: 'docker' } }, { HARNESS_EVAL_TB_ENV: 'daytona' }],
  ]) {
    assert.throws(
      () => buildLiveSteps({
        config,
        lock,
        workDir: tmpdir(),
        env: { ...env, HARNESS_EVAL_TB_DATASET_DIR: path.dirname(taskDir) },
        providerControl: testProviderControl(),
      }),
      /attested host mount materialization currently requires Harbor Docker/
    );
  }
});

test('host Node attestation is lazy and failures become bounded environment preflight evidence', async () => {
  const { taskDir, lock } = fixtureTask();
  const harbor = fakeHarborSpawn();
  let attestationCalls = 0;
  const steps = liveSteps({
    taskDir,
    lock,
    spawnImpl: harbor.spawnImpl,
    attestHostNodeExecutable: () => {
      attestationCalls += 1;
      throw new Error('private host Node attestation detail');
    },
  });

  assert.equal(attestationCalls, 0, 'constructing step contracts does not hash Node');
  const result = await steps.environment();
  assert.equal(attestationCalls, 1);
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((entry) => /host-node-preflight/i.test(entry)));
  assert.doesNotMatch(JSON.stringify(result), /private host Node attestation detail/);
  assert.equal(harbor.invocations.length, 0, 'an unattested runtime is never executed');
});

test('the harness wrapper picks the node runtime matching the container architecture', () => {
  const script = harnessWrapperScript();
  assert.match(script, /^#!\/bin\/sh/);
  // The task image arch is the registry's choice (cobol-modernization ships
  // amd64-only even on arm64 hosts) — the wrapper must decide at runtime.
  assert.match(script, /uname -m/);
  assert.ok(script.includes(`${EVAL_RUNTIME_MOUNT_TARGET}/node-x64/bin/node`));
  assert.ok(script.includes(`${EVAL_RUNTIME_MOUNT_TARGET}/node-arm64/bin/node`));
  assert.ok(script.includes(`${BUNDLE_MOUNT_TARGET}/harness/bin/harness.mjs`));
  assert.ok(script.includes('"$@"'));
});

test('activation uses only the immutable read-only bundle CLI', () => {
  const commands = activationCommands();
  assert.deepEqual(commands, [`${BUNDLE_MOUNT_TARGET}/harness-cli help`]);
  assert.ok(commands.every((command) => !/\b(?:install|cp|ln)\b/.test(command)), 'activation must not copy or link trusted code into writable paths');
});

test('the task bytes are verified against the lock before any provider work', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  assert.equal((await steps.taskLock()).ok, true);
  fs.writeFileSync(path.join(taskDir, 'tests', 'test.sh'), 'tampered');
  const tampered = await steps.taskLock();
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /checksum/i);
});

test('duplicate task resource assignments are rejected before provider work', async () => {
  for (const duplicate of ['cpus = 1\n', 'memory = "2G"\n', 'storage = "10G"\n']) {
    const { taskDir, lock } = fixtureTask();
    fs.appendFileSync(path.join(taskDir, 'task.toml'), duplicate);
    const restamped = stampTaskLock(taskDir, lock, 'cobol-modernization');
    const harbor = fakeHarborSpawn();
    const steps = liveSteps({ taskDir, lock: restamped, spawnImpl: harbor.spawnImpl });
    const verdict = await steps.taskLock();
    assert.equal(verdict.ok, false, duplicate.trim());
    assert.match(verdict.reason, /TASK_SNAPSHOT_FAILURE|task-snapshot/i);
    assert.equal(harbor.invocations.filter((entry) => entry.args[0] === 'run').length, 0);
  }
});

test('Harbor uses a runner-owned verified snapshot even if the configured dataset mutates after preflight', async () => {
  const { datasetDir, taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn();
  const steps = liveSteps({ datasetDir, taskDir, lock, spawnImpl });
  assert.equal((await steps.taskLock()).ok, true);
  fs.writeFileSync(path.join(taskDir, 'instruction.md'), 'mutated after verification');
  await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'snapshot-race' }));
  const runs = invocations.filter((invocation) => invocation.args[0] === 'run');
  const snapshot = runs[0].args[runs[0].args.indexOf('-p') + 1];
  assert.notEqual(snapshot, datasetDir);
  assert.equal(fs.readFileSync(path.join(snapshot, 'cobol-modernization', 'instruction.md'), 'utf8'), 'Modernize the COBOL program.');
  assert.match(
    fs.readFileSync(path.join(snapshot, 'cobol-modernization', 'task.toml'), 'utf8'),
    /docker_image = "alexgshaw\/cobol-modernization@sha256:593ab9df/,
    'the verified source task is materialized into a digest-qualified execution snapshot'
  );
  assert.equal(verifyTaskAgainstLock(path.join(snapshot, 'cobol-modernization'), lock, 'cobol-modernization').ok, false,
    'the raw fixture lock and execution snapshot hashes are intentionally distinct');
});

test('runner-owned task snapshot drift fail-stops later paid arms and retains a safe diagnosis', async () => {
  const { datasetDir, taskDir, lock } = fixtureTask();
  const harbor = fakeHarborSpawn();
  const spawnImpl = (cmd, args, opts) => {
    const result = harbor.spawnImpl(cmd, args, opts);
    if (args[0] === 'run' && harbor.invocations.filter((entry) => entry.args[0] === 'run').length === 1) {
      const snapshot = args[args.indexOf('-p') + 1];
      const instruction = path.join(snapshot, 'cobol-modernization', 'instruction.md');
      fs.chmodSync(instruction, 0o600);
      fs.writeFileSync(instruction, 'mutated runner-owned snapshot');
    }
    return result;
  };
  const steps = liveSteps({ datasetDir, taskDir, lock, spawnImpl });
  assert.equal((await steps.taskLock()).ok, true);
  const budget = createBudget({ ceilingUsd: 10, label: 'task-snapshot-drift' });
  const [pair] = await steps.controlledPair(budget);

  assert.equal(pair.failureKind, 'infrastructure');
  assert.equal(harbor.invocations.filter((entry) => entry.args[0] === 'run').length, 1);
  assert.equal(pair.paidSchedulingStop.reason, 'structural-integrity-failure');
  assert.ok(pair.failureDiagnostics.some((entry) => entry.code === 'TASK_SNAPSHOT_DRIFT'));
  const retained = pair.generic ?? pair.harness;
  assert.equal(retained.executionIntegrityEvidence.complete, false);
  assert.equal(retained.executionIntegrityEvidence.reason, 'TASK_SNAPSHOT_DRIFT');
  assert.equal(budget.spentUsd(), 5, 'the uncertain first-arm allocation is reserved; later arms are not scheduled');
});

test('bundle drift after one arm fail-stops the experiment and preserves the integrity code', async () => {
  const { datasetDir, taskDir, lock } = fixtureTask();
  const harbor = fakeHarborSpawn();
  let validations = 0;
  const validateBundle = (bundleDir, options) => {
    validations += 1;
    if (validations >= 4) throw new Error('bundle contents drifted after validation');
    return fakeValidateBundle(bundleDir, options);
  };
  const steps = liveSteps({ datasetDir, taskDir, lock, spawnImpl: harbor.spawnImpl, validateBundle });
  assert.equal((await steps.taskLock()).ok, true);
  const budget = createBudget({ ceilingUsd: 10, label: 'bundle-drift' });
  const [pair] = await steps.controlledPair(budget);

  assert.equal(pair.failureKind, 'infrastructure');
  assert.equal(harbor.invocations.filter((entry) => entry.args[0] === 'run').length, 1);
  assert.equal(pair.paidSchedulingStop.reason, 'structural-integrity-failure');
  assert.ok(pair.failureDiagnostics.some((entry) => entry.code === 'BUNDLE_INTEGRITY_FAILURE'));
  assert.equal(budget.spentUsd(), 5);
});

test('a later repetition setup failure retains earlier paired documents and billing evidence', async () => {
  const { datasetDir, taskDir, lock } = fixtureTask();
  const harbor = fakeHarborSpawn();
  let validations = 0;
  const validateBundle = (bundleDir, options) => {
    validations += 1;
    // Initial pair setup, repetition setup, and both pre/post-arm checks for
    // repetition 1 consume six validations. Fail at repetition 2 setup.
    if (validations === 7) throw new Error('bundle drifted before repetition two');
    return fakeValidateBundle(bundleDir, options);
  };
  const steps = liveSteps({
    datasetDir,
    taskDir,
    lock,
    spawnImpl: harbor.spawnImpl,
    repetitions: 3,
    validateBundle,
  });
  assert.equal((await steps.taskLock()).ok, true);
  const budget = createBudget({ ceilingUsd: 10, label: 'later-repetition-setup' });
  const [pair] = await steps.controlledPair(budget);

  assert.equal(harbor.invocations.filter((entry) => entry.args[0] === 'run').length, 2);
  assert.equal(pair.attemptedRepetitionCount, 2);
  assert.equal(pair.validRepetitionCount, 1);
  assert.equal(pair.failureKind, 'infrastructure');
  assert.equal(pair.generic.repetitions.length, 1);
  assert.equal(pair.harness.repetitions.length, 1);
  assert.equal(pair.generic.repetitions[0].billingEvidence.uncertain, false);
  assert.equal(pair.harness.repetitions[0].billingEvidence.uncertain, false);
  assert.ok(pair.failureDiagnostics.some((entry) =>
    entry.repetitionIndex === 2 && entry.condition === null && entry.stage === 'repetition-setup'
  ));
  assert.equal(budget.spentUsd(), 10, 'the uncertain remaining allowance is reserved without erasing prior charges');
});

test('read-only task snapshots preserve restrictive attested read and execute modes', async () => {
  const { datasetDir, taskDir, lock } = fixtureTask();
  const instruction = path.join(taskDir, 'instruction.md');
  fs.chmodSync(taskDir, 0o700);
  fs.chmodSync(instruction, 0o600);
  const restrictedLock = stampTaskLock(taskDir, lock, 'cobol-modernization');
  const { spawnImpl, invocations } = fakeHarborSpawn();
  const steps = liveSteps({ datasetDir, taskDir, lock: restrictedLock, spawnImpl });

  assert.equal((await steps.taskLock()).ok, true);
  await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'restrictive-snapshot-modes' }));
  const run = invocations.find((invocation) => invocation.args[0] === 'run');
  const snapshot = run.args[run.args.indexOf('-p') + 1];
  const snapshotTask = path.join(snapshot, 'cobol-modernization');

  assert.equal(fs.statSync(snapshotTask).mode & 0o777, 0o500);
  assert.equal(fs.statSync(path.join(snapshotTask, 'instruction.md')).mode & 0o777, 0o400);
  assert.equal(verifyTaskAgainstLock(snapshotTask, restrictedLock, 'cobol-modernization').ok, false);
});

test('runtime instruction attestation models Harbor 0.20 canary stripping while the task lock binds raw bytes', async () => {
  const { taskDir, lock } = fixtureTask();
  const raw = '<!-- harbor-canary GUID fixture -->\n# SECOND CANARY\n\nModernize the COBOL program.\n';
  fs.writeFileSync(path.join(taskDir, 'instruction.md'), raw);
  const canaryLock = stampTaskLock(taskDir, lock, 'cobol-modernization');
  const rawTaskHash = canaryLock.tasks.find((entry) => entry.task === 'cobol-modernization').taskChecksum;
  const { spawnImpl } = fakeHarborSpawn();
  const steps = liveSteps({ taskDir, lock: canaryLock, spawnImpl });

  assert.equal((await steps.taskLock()).ok, true);
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'canary-instruction' }));
  for (const condition of [pair.generic, pair.harness]) {
    const rawTrial = condition.repetitions[0];
    assert.equal(rawTrial.observability.runtimeContractEvidence.matchesExpected, true);
    assert.equal(
      rawTrial.observability.runtimeContractEvidence.expectedInstructionHash,
      crypto.createHash('sha256').update('Modernize the COBOL program.\n').digest('hex')
    );
    assert.equal(rawTrial.reproducibility.taskHash, rawTaskHash);
  }
});

test('a multi-task lock runs a fresh pair per pinned task with per-task job identities', async () => {
  const { taskDir, lock } = fixtureTask();
  // Second pinned task: its own directory and checksum entry.
  const datasetDir = path.dirname(taskDir);
  const secondDir = path.join(datasetDir, 'build-pmars');
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(secondDir, 'instruction.md'), 'Build pMARS.');
  fs.writeFileSync(path.join(secondDir, 'task.toml'), `[environment]\n` +
    `docker_image = "fixture/build-pmars:locked"\n` +
    `cpus = 1\nmemory = "2G"\nstorage = "10G"\n`);
  const { stampTaskLock: stamp } = await import('../../../evals/external/terminal_bench/harbor-adapter.mjs');
  const buildPmarsSandbox = {
    sourceImage: 'fixture/build-pmars:locked',
    immutableImage: `fixture/build-pmars@sha256:${'9'.repeat(64)}`,
    imageId: `sha256:${'9'.repeat(64)}`,
    platform: 'linux/amd64',
    cpus: 1,
    memoryMb: 2048,
    storageMb: 10240,
  };
  const multiLock = stamp(secondDir, lock, 'build-pmars', { sandbox: buildPmarsSandbox });
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.01 });
  const steps = liveSteps({ taskDir, lock: multiLock, spawnImpl });
  assert.equal((await steps.taskLock()).ok, true, 'every pinned task verifies');
  const budget = createBudget({ ceilingUsd: 10, label: 'controlled-pair' });
  const pairs = await steps.controlledPair(budget);
  assert.equal(pairs.length, 2, 'one pair per pinned task');
  assert.deepEqual(
    pairs.map((p) => p.task),
    ['cobol-modernization', 'build-pmars']
  );
  const runs = invocations.filter((i) => i.args[0] === 'run');
  assert.equal(runs.length, 4, 'generic+harness per task');
  const jobNames = runs.map((i) => i.args[i.args.indexOf('--job-name') + 1]);
  assert.ok(jobNames.every((n, idx) => n.includes(pairs[Math.floor(idx / 2)].task)), 'job identity carries the task name');
  assert.ok(runs.every((invocation) => invocation.args.includes('-p')));
  const datasetSnapshots = new Set(runs.map((invocation) => invocation.args[invocation.args.indexOf('-p') + 1]));
  assert.equal(datasetSnapshots.size, 1);
  const [datasetSnapshot] = datasetSnapshots;
  assert.notEqual(datasetSnapshot, datasetDir, 'the mutable configured source is never the execution path');
  assert.equal(path.basename(datasetSnapshot), 'verified-dataset');
  assert.equal(verifyTaskAgainstLock(path.join(datasetSnapshot, 'cobol-modernization'), multiLock, 'cobol-modernization').ok, false);
  assert.equal(verifyTaskAgainstLock(path.join(datasetSnapshot, 'build-pmars'), multiLock, 'build-pmars').ok, false);
  for (const pair of pairs) {
    const executionHash = hashTree(path.join(datasetSnapshot, pair.task));
    assert.equal(pair.generic.reproducibility.sandbox.executionTaskHash, executionHash);
    assert.equal(pair.harness.reproducibility.sandbox.executionTaskHash, executionHash);
  }
  assert.ok(runs.every((invocation) => !invocation.args.includes('-d')), 'the registry reference is not re-resolved after verification');
  const conditionPaths = runs.map((i) => i.args[i.args.findIndex((a) => typeof a === 'string' && a.startsWith('HARNESS_EVAL_TB_CONDITION='))]);
  const ceilings = conditionPaths.map((kv) => JSON.parse(fs.readFileSync(kv.split('=')[1], 'utf8')).limits.trialCeilingUsd);
  assert.deepEqual(ceilings, [2.5, 2.5, 2.5, 2.5], 'the initial allowance is preallocated equally across every task and arm');
  assert.ok(Math.abs(budget.spentUsd() - 0.04) < 1e-12, 'all four trials charge the larger reconciled estimate');
});

test('a live controlled pair produces two schema-valid run documents and charges provider-reported cost', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.02 });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  assert.equal((await steps.taskLock()).ok, true);
  const budget = createBudget({ ceilingUsd: 10, label: 'controlled-pair' });
  const [pair] = await steps.controlledPair(budget);
  assert.equal(pair.host, 'openrouter-controlled');
  for (const doc of [pair.generic, pair.harness]) {
    assert.deepEqual(validateAgainstSchema(doc, RUN_SCHEMA).errors, []);
    assert.equal(doc.correctness.verdict, 'pass');
    assert.equal(doc.efficiency.promptTokens, 4000, 'metered telemetry must be non-null');
    assert.equal(doc.efficiency.modelRequests, 5, 'logical requests must not be confused with completed usage records');
    assert.equal(doc.efficiency.providerAttempts, 6);
    assert.equal(doc.efficiency.providerResponses, 5);
    assert.equal(doc.efficiency.providerErrors, 1);
    assert.equal(doc.efficiency.retries, 1);
    assert.equal(doc.efficiency.toolCalls, 2, 'tool calls are counted from correlated telemetry, not the loop step fallback');
    assert.equal(doc.efficiency.failedCommands, 1);
    assert.equal(doc.efficiency.testExecutions, 1);
    assert.equal(doc.efficiency.failedTests, 1);
    assert.equal(doc.efficiency.contextCompactions, 1);
    assert.equal(doc.efficiency.compactedToolResults, 1);
    assert.equal(doc.efficiency.costComplete, true, 'every paid response was metered');
    assert.equal(doc.efficiency.billingComplete, true);
    assert.equal(doc.efficiency.usageComplete, true);
    assert.equal(doc.efficiency.providerCostComplete, true);
    assert.equal(doc.efficiency.reconciledCostUsd, 0.02, 'the charged per-trial cost is retained for aggregation');
    assert.equal(doc.efficiency.missingUsage, 0);
    assert.equal(doc.reproducibility.modelResolved, 'moonshotai/kimi-k2.7-code-20260612');
    assert.match(doc.reproducibility.pairId, /^[a-f0-9]{24}$/);
    assert.equal(doc.reproducibility.repetitionId, null, 'the aggregate is not mislabeled as one repetition');
    assert.match(doc.repetitions[0].reproducibility.repetitionId, /^[a-f0-9]{24}$/);
    assert.match(doc.reproducibility.conditionHash, /^[a-f0-9]{64}$/);
    assert.match(doc.reproducibility.taskHash, /^[a-f0-9]{64}$/);
    assert.equal(doc.reproducibility.sandbox.identityAttested, true);
    assert.equal(doc.reproducibility.sandbox.observedImageId, lock.tasks[0].sandbox.imageId);
    assert.equal(doc.reproducibility.sandbox.observedPlatform, 'linux/amd64');
    assert.match(doc.reproducibility.sandbox.executionTaskHash, /^[a-f0-9]{64}$/);
    assert.equal(doc.reproducibility.bundleManifestHash, 'f'.repeat(64), 'the exact mounted bundle identity is retained');
    assert.match(doc.reproducibility.toolSchemaHash, /^[a-f0-9]{64}$/);
    assert.match(doc.reproducibility.instructionHash, /^[a-f0-9]{64}$/);
    assert.equal(doc.observability.runtimeContractEvidence.complete, true);
    assert.equal(doc.observability.runtimeContractEvidence.matchesExpected, true);
    assert.equal(doc.observability.runtimeContractEvidence.requestContractsChecked, 5);
    assert.equal(doc.observability.runtimeContractEvidence.requestContractMismatches, 0);
    assert.equal(
      doc.observability.runtimeContractEvidence.actualInstructionHash,
      doc.observability.runtimeContractEvidence.expectedInstructionHash,
      'the bridge-reported instruction is independently bound to the pinned task bytes'
    );
    const rawTrial = doc.repetitions[0];
    assert.equal(doc.correctness.finalDiffHash, null, 'an aggregate never impersonates one repetition workspace');
    assert.equal(rawTrial.correctness.finalDiffHash, 'c'.repeat(64), 'the retained trial diff hash comes from workspace evidence');
    assert.match(rawTrial.correctness.verifierArtifactHash, /^[a-f0-9]{64}$/);
    assert.equal(rawTrial.workspaceEvidence.available, true, 'collected workspace evidence is retained independently of verifier artifacts');
    assert.notEqual(rawTrial.correctness.finalDiffHash, rawTrial.correctness.verifierArtifactHash, 'verifier artifacts never masquerade as workspace diffs');
    assert.equal(doc.enforcementFidelity.mode, doc.reproducibility.condition === 'harness' ? 'prompt-and-cli' : 'none');
    assert.equal(doc.enforcementFidelity.mechanicalHooksActive, false);
    assert.equal(doc.observability.providerEvents.length, 0, 'aggregate ledgers are summary-only');
    assert.ok(rawTrial.observability.providerEvents.length > 0, 'redacted provider correlation events are retained exactly once');
    assert.equal(doc.observability.providerAttemptsStarted, 6);
    assert.equal(doc.observability.providerAttemptsClosed, 6);
    assert.equal(doc.observability.unclosedProviderAttempts, 0);
    assert.equal(doc.observability.uncorrelatedProviderTerminals, 0);
    assert.equal(doc.observability.duplicateProviderAttemptIdentities, 0);
    assert.equal(doc.observability.duplicateProviderTerminalIdentities, 0);
    assert.equal(doc.observability.invalidProviderEventIdentities, 0);
    assert.equal(doc.observability.malformedToolCallEvidence, 0);
    assert.equal(doc.observability.malformedToolResultEvidence, 0);
    assert.equal(doc.observability.incompleteToolContainment, 0);
    assert.equal(doc.observability.toolEvents.length, 0, 'aggregate tool ledgers are summary-only');
    assert.equal(rawTrial.observability.toolEvents.length, 5, 'redacted tool call/result/compaction evidence is retained exactly once');
    assert.equal(doc.observability.correlatedToolResults, 2);
    assert.equal(doc.repetitions.length, 1, 'even one repetition retains its raw run document');
  }
  assert.ok(Math.abs(budget.spentUsd() - 0.04) < 1e-12, 'provider-reported cost is the ledger of record');
  const runs = invocations.filter((i) => i.args[0] === 'run');
  assert.equal(runs.length, 2, 'one fresh sandboxed run per condition');
  assert.ok(runs.every((i) => i.args.includes('--mounts')), 'the immutable common runtime is mounted in both conditions');
  for (const invocation of runs) {
    const mounts = JSON.parse(invocation.args[invocation.args.indexOf('--mounts') + 1]);
    const conditionArg = invocation.args.find((arg) => typeof arg === 'string' && arg.startsWith('HARNESS_EVAL_TB_CONDITION='));
    const condition = JSON.parse(fs.readFileSync(conditionArg.split('=')[1], 'utf8')).id;
    const hasHarnessMount = mounts.some((mount) => mount.target.startsWith(`${BUNDLE_MOUNT_TARGET}/`));
    assert.equal(hasHarnessMount, condition === 'harness', 'only treatment can reach any Harness entrypoint');
  }
  assert.ok(
    runs.every((i) => !i.args.some((arg) => typeof arg === 'string' && arg.startsWith('OPENROUTER_API_KEY='))),
    'the provider credential must never be placed in Harbor --ae arguments'
  );
});

test('the host-written harbor trial record grades through the production collector', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({ reward: 1, providerCostUsd: 0.02 });
  const steps = liveSteps({ taskDir, lock, spawnImpl, collectEvidence: null });
  assert.equal((await steps.taskLock()).ok, true);
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'host-graded' }));

  assert.equal(pair.failureKind, null);
  for (const doc of [pair.generic.repetitions[0], pair.harness.repetitions[0]]) {
    assert.equal(doc.correctness.verifierReward, 1);
    assert.equal(doc.correctness.verdict, 'pass');
    assert.equal(doc.trialValidity.valid, true);
    assert.equal(doc.verifierEvidence.rewardTrusted, true);
    assert.equal(doc.verifierEvidence.rewardSource, 'harbor-host-result', 'grading comes from the host record, not sandbox files');
    assert.equal(doc.verifierEvidence.assertionEvidenceTrusted, false, 'assertion counts stay advisory');
  }
});

test('production collection classifies Harbor shared-mode reward files as verifier-invalid', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({ reward: 1, providerCostUsd: 0.02, writeHostResult: false });
  const steps = liveSteps({ taskDir, lock, spawnImpl, collectEvidence: null });
  assert.equal((await steps.taskLock()).ok, true);
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'untrusted-verifier-reward' }));

  assert.equal(pair.failureKind, 'verifier');
  for (const doc of [pair.generic.repetitions[0], pair.harness.repetitions[0]]) {
    assert.equal(doc.correctness.verifierReward, null);
    assert.equal(doc.correctness.verdict, 'fail');
    assert.equal(doc.trialValidity.valid, false);
    assert.equal(doc.trialValidity.failureKind, 'verifier');
    assert.equal(doc.verifierEvidence.collectionComplete, true);
    assert.equal(doc.verifierEvidence.trustComplete, false);
    assert.equal(doc.verifierEvidence.rewardTrusted, false);
    assert.equal(doc.verifierEvidence.assertionEvidenceTrusted, false);
    assert.equal(doc.verifierEvidence.reason, 'verifier-evidence-degraded');
    assert.match(doc.verifierEvidence.degraded, /agent-writable/i);
    assert.match(doc.correctness.verifierArtifactHash, /^[a-f0-9]{64}$/);
  }
});

test('an unavailable trusted reward never masks billing, budget, or runtime-integrity failures', async () => {
  const cases = [
    {
      name: 'billing',
      spawnOptions: { billingComplete: false, unknownBillingAttempts: 1 },
      expectedFailureKind: 'billing',
      expectedDiagnostic: 'BILLING_EVIDENCE_INCOMPLETE',
    },
    {
      name: 'budget',
      spawnOptions: { providerCostUsd: 6 },
      expectedFailureKind: 'budget',
      expectedDiagnostic: 'TRIAL_ALLOCATION_EXCEEDED',
    },
    {
      name: 'runtime integrity',
      spawnOptions: {
        mutateDone: (done) => {
          done.workspaceEvidence.available = false;
          done.workspaceEvidence.reason = 'fixture-integrity-failure';
        },
      },
      expectedFailureKind: 'infrastructure',
      expectedDiagnostic: 'RUNTIME_EVIDENCE_INTEGRITY_FAILURE',
    },
    {
      name: 'billing plus runtime integrity',
      spawnOptions: {
        billingComplete: false,
        unknownBillingAttempts: 1,
        mutateDone: (done) => {
          done.workspaceEvidence.available = false;
          done.workspaceEvidence.reason = 'fixture-integrity-failure';
        },
      },
      expectedFailureKind: 'billing',
      expectedDiagnostic: 'RUNTIME_EVIDENCE_INTEGRITY_FAILURE',
    },
  ];

  for (const fixtureCase of cases) {
    const { taskDir, lock } = fixtureTask();
    const { spawnImpl } = fakeHarborSpawn(fixtureCase.spawnOptions);
    const steps = liveSteps({ taskDir, lock, spawnImpl, collectEvidence: null });
    assert.equal((await steps.taskLock()).ok, true, fixtureCase.name);
    const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: `untrusted-reward-${fixtureCase.name}` }));

    assert.equal(pair.failureKind, fixtureCase.expectedFailureKind, fixtureCase.name);
    assert.ok(
      pair.failureDiagnostics.some((diagnostic) => diagnostic.code === fixtureCase.expectedDiagnostic),
      `${fixtureCase.name}: ${JSON.stringify(pair.failureDiagnostics)}`
    );
  }
});

test('agent-writable pytest summaries remain advisory and retain degraded provenance', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateJob: ({ verifierDir }) => {
      fs.writeFileSync(path.join(verifierDir, 'pytest.log'), '==== 9999 passed in 0.01s ====');
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl, collectEvidence: null });
  assert.equal((await steps.taskLock()).ok, true);
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'untrusted-assertions' }));

  for (const doc of [pair.generic.repetitions[0], pair.harness.repetitions[0]]) {
    assert.equal(doc.correctness.assertionsPassed, null);
    assert.equal(doc.correctness.assertionsFailed, null);
    assert.deepEqual(doc.verifierEvidence.advisoryAssertions, { passed: 9999, failed: 0 });
    assert.equal(doc.verifierEvidence.assertionEvidenceTrusted, false);
    assert.equal(doc.verifierEvidence.reason, 'verifier-evidence-degraded');
    assert.match(doc.verifierEvidence.degraded, /agent-writable/i);
  }
});

test('a wrong provider-facing request tool contract invalidates a rewarded trial', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id === 'harness') {
        const request = done.telemetry.events.find((event) => event.type === 'request');
        request.toolCount += 1;
        request.toolSchemaHash = '0'.repeat(64);
      }
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'runtime-mismatch' }));
  const rawHarness = pair.harness.repetitions[0];
  assert.equal(rawHarness.correctness.verdict, 'pass', 'the official verifier result remains visible on raw evidence');
  assert.equal(rawHarness.observability.runtimeContractEvidence.matchesExpected, false);
  assert.match(rawHarness.observability.runtimeContractEvidence.reason, /tool-(?:schema|count)-mismatch|request-tool-contract-mismatch/);
  assert.equal(rawHarness.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('every exact outbound provider control is independently attested', async () => {
  const mutations = [
    ['endpoint', (event) => { event.endpointHash = '0'.repeat(64); }],
    ['model', (event) => { event.model = 'different/model'; }],
    ['max tokens', (event) => { event.maxTokens += 1; }],
    ['temperature', (event) => { event.temperaturePresent = true; event.temperature = 0.2; }],
    ['reasoning', (event) => { event.reasoningPresent = true; event.reasoning = { effort: 'low' }; }],
    ['tool choice', (event) => { event.toolChoice = 'required'; }],
    ['provider order', (event) => { event.providerOrder = ['different']; }],
    ['provider fallback', (event) => { event.providerAllowFallbacks = true; }],
    ['unexpected body field', (event) => { event.unexpectedRequestFields = ['seed']; }],
  ];
  for (const [label, mutate] of mutations) {
    const { taskDir, lock } = fixtureTask();
    const { spawnImpl } = fakeHarborSpawn({
      mutateDone: (done, { condition }) => {
        if (condition.id !== 'harness') return;
        const request = done.telemetry.events.find((event) => event.type === 'request');
        mutate(request);
        refreshRequestControlHash(request);
      },
    });
    const steps = liveSteps({ taskDir, lock, spawnImpl });
    await steps.taskLock();
    const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: `request-control-${label}` }));
    const rawHarness = pair.harness.repetitions[0];
    assert.equal(rawHarness.observability.runtimeContractEvidence.matchesExpected, false, label);
    assert.equal(rawHarness.observability.runtimeContractEvidence.requestControlMismatches, 1, label);
    assert.match(rawHarness.observability.runtimeContractEvidence.reason, /request-control-contract-mismatch/, label);
    assert.equal(rawHarness.trialValidity.valid, false, label);
  }

  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'harness') return;
      done.telemetry.events.find((event) => event.type === 'request').requestBodyHash = null;
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'request-body-hash' }));
  assert.equal(pair.harness.repetitions[0].observability.runtimeContractEvidence.complete, false);
  assert.equal(pair.harness.repetitions[0].trialValidity.valid, false);
});

test('a post-verification request must expose only the independently expected finish contract', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'harness') return;
      const request = done.telemetry.events.find((event) => event.type === 'request');
      request.postVerify = true;
      request.toolMode = 'finish-only';
      // Its full-tool hash/count are deliberately left intact.
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'finish-contract-mismatch' }));
  const rawHarness = pair.harness.repetitions[0];
  assert.equal(rawHarness.observability.runtimeContractEvidence.matchesExpected, false);
  assert.equal(rawHarness.observability.runtimeContractEvidence.postVerifyRequestContracts, 1);
  assert.equal(rawHarness.observability.runtimeContractEvidence.requestContractMismatches, 1);
  assert.match(rawHarness.observability.runtimeContractEvidence.reason, /request-tool-contract-mismatch/);
  assert.equal(rawHarness.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('runtime attestation accepts one exact durable-state system message after compaction', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'harness') return;
      for (const event of done.telemetry.events.filter((candidate) => candidate.type === 'request')) {
        event.systemMessageCount = 2;
        event.durableStateMessageCount = 1;
        event.durableStateMessageIndex = 2;
        event.durableStateMessageHash = 'a'.repeat(64);
        event.stateRevision = 1;
      }
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'compacted-runtime' }));
  const rawHarness = pair.harness.repetitions[0];

  assert.equal(rawHarness.observability.runtimeContractEvidence.complete, true);
  assert.equal(rawHarness.observability.runtimeContractEvidence.matchesExpected, true);
  assert.equal(rawHarness.trialValidity.valid, true);
});

test('runtime attestation rejects an unexpected extra system message', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'harness') return;
      const request = done.telemetry.events.find((event) => event.type === 'request');
      request.systemMessageCount = 2;
      request.unexpectedSystemMessageCount = 1;
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'unexpected-system-message' }));
  const rawHarness = pair.harness.repetitions[0];

  assert.equal(rawHarness.observability.runtimeContractEvidence.matchesExpected, false);
  assert.equal(rawHarness.observability.runtimeContractEvidence.requestPromptMismatches, 1);
  assert.equal(rawHarness.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('runtime attestation rejects prompt-manifest drift and incomplete request buckets', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'harness') return;
      const requests = done.telemetry.events.filter((event) => event.type === 'request');
      requests[0].promptComponentManifest = structuredClone(requests[0].promptComponentManifest);
      requests[0].promptComponentManifest.components[0].sha256 = '0'.repeat(64);
      requests[1].promptBuckets = structuredClone(requests[1].promptBuckets);
      requests[1].promptBuckets.complete = false;
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'prompt-evidence-drift' }));
  const rawHarness = pair.harness.repetitions[0];

  assert.equal(rawHarness.observability.runtimeContractEvidence.matchesExpected, false);
  assert.equal(rawHarness.observability.runtimeContractEvidence.requestPromptManifestMismatches, 1);
  assert.equal(rawHarness.observability.runtimeContractEvidence.requestPromptBucketMismatches, 1);
  assert.match(rawHarness.observability.runtimeContractEvidence.reason, /prompt-manifest|prompt-bucket/);
  assert.equal(rawHarness.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('a wrong runtime instruction attestation invalidates a rewarded trial', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id === 'harness') {
        for (const event of done.telemetry.events.filter((candidate) => candidate.type === 'request')) {
          event.instructionHash = '0'.repeat(64);
        }
      }
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'instruction-mismatch' }));
  const rawHarness = pair.harness.repetitions[0];
  assert.equal(rawHarness.correctness.verdict, 'pass');
  assert.equal(rawHarness.observability.runtimeContractEvidence.matchesExpected, false);
  assert.match(rawHarness.observability.runtimeContractEvidence.reason, /instruction-hash-mismatch/);
  assert.equal(rawHarness.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('a rewarded bridge-integrity stop with an unclosed tool call fails closed', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'harness') return;
      done.stopReason = 'protocol_error';
      done.telemetry.events = done.telemetry.events.filter(
        (event) => !(event.type === 'tool_result' && event.toolCallId === 'tc2')
      );
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'unclosed-tool' }));
  const rawHarness = pair.harness.repetitions[0];
  assert.equal(rawHarness.correctness.verdict, 'pass');
  assert.equal(rawHarness.observability.unclosedToolCalls, 1);
  assert.equal(rawHarness.observability.uncorrelatedToolResults, 0);
  assert.equal(rawHarness.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('a generic arm that invokes the immutable Harness CLI is control-contaminated and invalid', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'generic') return;
      const call = done.telemetry.events.find((event) => event.type === 'tool_call');
      call.immutableHarnessCli = true;
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'contaminated-control' }));
  const rawGeneric = pair.generic.repetitions[0];
  assert.equal(rawGeneric.correctness.verdict, 'pass');
  assert.equal(rawGeneric.observability.controlContaminationDetected, true);
  assert.equal(rawGeneric.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('a treatment mount or preexisting Harness path in the generic sandbox invalidates the control', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'generic') return;
      done.mountEvidence.targets.push(`${BUNDLE_MOUNT_TARGET}/harness-cli`);
      done.mountEvidence.existingTargets.push(`${BUNDLE_MOUNT_TARGET}/harness-cli`);
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'mounted-control' }));
  const rawGeneric = pair.generic.repetitions[0];
  assert.equal(rawGeneric.observability.mountPolicyEvidence.matchesCondition, false);
  assert.equal(rawGeneric.observability.mountPolicyEvidence.complete, false);
  assert.equal(rawGeneric.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('sandbox observations cannot overwrite incomplete or mismatched configured mount policy', async () => {
  const cases = [
    {
      name: 'missing treatment-only policy',
      reason: 'mount-policy-incomplete',
      mutatePolicy: (policy) => ({
        ...policy,
        harness: policy.generic.slice(),
        treatmentOnlyTargets: [],
      }),
    },
    {
      name: 'configured rogue mount',
      reason: 'effective-mounts-do-not-match-condition',
      mutatePolicy: (policy, bundleDir) => {
        const source = path.join(bundleDir, 'rogue-runtime');
        fs.writeFileSync(source, 'fixture');
        return {
          ...policy,
          generic: [...policy.generic, {
            type: 'bind',
            source,
            target: `${EVAL_RUNTIME_MOUNT_TARGET}/rogue`,
            read_only: true,
          }],
        };
      },
    },
  ];

  for (const fixtureCase of cases) {
    const { taskDir, lock } = fixtureTask();
    let expectedGenericTargets = [];
    const prepareBundle = ({ bundleDir, sourceIdentity }) => {
      const prepared = fakePreparedBundle(bundleDir, sourceIdentity);
      expectedGenericTargets = prepared.mountPolicy.commonTargets.slice();
      return {
        ...prepared,
        mountPolicy: fixtureCase.mutatePolicy(prepared.mountPolicy, bundleDir),
      };
    };
    const validateBundle = (bundleDir, { expectedManifestHash, expectedSourceIdentity }) => {
      const prepared = prepareBundle({ bundleDir, sourceIdentity: expectedSourceIdentity });
      return { manifestHash: expectedManifestHash, mountPolicy: prepared.mountPolicy };
    };
    const { spawnImpl } = fakeHarborSpawn({
      mutateDone: (done, { condition }) => {
        if (condition.id !== 'generic') return;
        // Simulate a successful-looking sandbox projection. The configured
        // Harbor argv remains independently authoritative and must keep the
        // arm invalid.
        done.mountEvidence.targets = expectedGenericTargets.slice();
        done.mountEvidence.existingTargets = expectedGenericTargets.slice();
        done.mountEvidence.complete = true;
      },
    });
    const steps = liveSteps({ taskDir, lock, spawnImpl, prepareBundle, validateBundle });
    await steps.taskLock();
    const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: fixtureCase.name }));
    assert.ok(pair.generic, `${fixtureCase.name}: ${JSON.stringify(pair.failureDiagnostics)}`);
    const rawGeneric = pair.generic.repetitions[0];
    const evidence = rawGeneric.observability.mountPolicyEvidence;

    assert.equal(evidence.complete, false, fixtureCase.name);
    assert.equal(evidence.matchesCondition, false, fixtureCase.name);
    assert.equal(evidence.reason, fixtureCase.reason, fixtureCase.name);
    assert.deepEqual(evidence.observedTargets, expectedGenericTargets, fixtureCase.name);
    if (fixtureCase.name === 'configured rogue mount') {
      assert.ok(evidence.effectiveTargets.includes(`${EVAL_RUNTIME_MOUNT_TARGET}/rogue`));
    }
    assert.equal(rawGeneric.trialValidity.valid, false, fixtureCase.name);
    assert.equal(pair.failureKind, 'infrastructure', fixtureCase.name);
  }
});

test('duplicate or unmatched provider-attempt events invalidate a rewarded trial', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'harness') return;
      const attempt = done.telemetry.events.find((event) => event.type === 'request_attempt');
      done.telemetry.events.push({ ...attempt, seq: 900, eventId: 'duplicate-attempt' });
      done.telemetry.events.push({
        type: 'response',
        seq: 901,
        eventId: 'unmatched-terminal',
        requestId: 'r-unmatched',
        attemptId: 'a-unmatched',
        model: 'moonshotai/kimi-k2.7-code',
        provider: 'Moonshot AI',
      });
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'provider-ledger-integrity' }));
  const rawHarness = pair.harness.repetitions[0];
  assert.equal(rawHarness.correctness.verdict, 'pass');
  assert.equal(rawHarness.observability.duplicateProviderAttemptIdentities, 1);
  assert.equal(rawHarness.observability.unclosedProviderAttempts, 1);
  assert.equal(rawHarness.observability.uncorrelatedProviderTerminals, 1);
  assert.equal(rawHarness.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('malformed tool metadata invalidates a rewarded trial', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    mutateDone: (done, { condition }) => {
      if (condition.id !== 'harness') return;
      const result = done.telemetry.events.find((event) => event.type === 'tool_result');
      delete result.durationMs;
    },
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'malformed-tool-evidence' }));
  const rawHarness = pair.harness.repetitions[0];
  assert.equal(rawHarness.correctness.verdict, 'pass');
  assert.equal(rawHarness.observability.malformedToolResultEvidence, 1);
  assert.equal(rawHarness.trialValidity.valid, false);
  assert.equal(pair.failureKind, 'infrastructure');
});

test('only the harness condition receives the lazy guidance catalog and checkpoint runtime', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn();
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'runtime' }));
  const conditionDocs = invocations
    .filter((invocation) => invocation.args[0] === 'run')
    .map((invocation) => invocation.args.find((arg) => String(arg).startsWith('HARNESS_EVAL_TB_CONDITION=')))
    .map((assignment) => JSON.parse(fs.readFileSync(assignment.split('=')[1], 'utf8')));
  const generic = conditionDocs.find((condition) => condition.id === 'generic');
  const harness = conditionDocs.find((condition) => condition.id === 'harness');
  assert.equal(generic.runtime.checkpoint, undefined, 'the control tool surface remains unchanged');
  assert.equal(generic.runtime.guidanceCatalog, undefined);
  assert.deepEqual(generic.runtime.expectedMountTargets, generic.runtime.mountProbeTargets.slice(0, 3));
  assert.equal(generic.runtime.mountProbeTargets.length, 5, 'the control also probes for forbidden treatment mounts');
  assert.equal(harness.runtime.checkpoint, true);
  assert.deepEqual(Object.keys(harness.runtime.guidanceCatalog), ['ensure-plan']);
  assert.ok(harness.runtime.guidanceCatalog['ensure-plan'].content.length > 0, 'guidance is available locally on demand');
  assert.doesNotMatch(harness.systemPrompt, /## Skill: create-primitive|creation-details/, 'irrelevant primitive bodies never enter the provider prefix');
});

test('the external controller retains the provider credential; Harbor never receives or persists it', async () => {
  const sentinel = 'sentinel-openrouter-secret-do-not-persist';
  const { datasetDir, taskDir, lock } = fixtureTask();
  const workDir = tmpdir();
  const { spawnImpl, invocations } = fakeHarborSpawn();
  const hostileSearchRoot = path.join(workDir, 'hostile-search-root');
  const hostileHome = path.join(workDir, 'hostile-home');
  const steps = liveSteps({
    datasetDir,
    taskDir,
    lock,
    spawnImpl,
    apiKey: sentinel,
    workDir,
    ambientEnv: { PATH: hostileSearchRoot, PYTHONPATH: hostileSearchRoot, HOME: hostileHome },
  });
  assert.equal((await steps.taskLock()).ok, true);
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'credential-boundary' }));

  const runs = invocations.filter((invocation) => invocation.args[0] === 'run');
  assert.equal(runs.length, 2);
  for (const invocation of runs) {
    assert.equal(invocation.cmd, '/opt/test/harbor', 'Harbor is never resolved through ambient PATH');
    assert.equal(invocation.opts.env.OPENROUTER_API_KEY, undefined, 'Harbor never receives the provider key');
    assert.notEqual(invocation.opts.env.PATH, hostileSearchRoot, 'ambient PATH is not credential-bearing process input');
    assert.notEqual(invocation.opts.env.HOME, hostileHome, 'ambient HOME is not credential-bearing process input');
    assert.ok(invocation.opts.env.HOME.startsWith(workDir));
    assert.ok(invocation.opts.env.DOCKER_CONFIG.startsWith(workDir));
    assert.equal(invocation.opts.env.PYTHONPATH, path.join(workDir, 'harness-bundle', 'bridge'));
    assert.equal(invocation.opts.env.PYTHONNOUSERSITE, '1');
    assert.equal(invocation.opts.env.PYTHONSAFEPATH, '1');
    assert.ok(!JSON.stringify(invocation.args).includes(sentinel), 'the key value must not enter Harbor argv');
    assert.ok(!invocation.args.some((arg) => String(arg).startsWith('OPENROUTER_API_KEY=')), 'the key must not enter --ae');
  }

  assert.ok(!JSON.stringify(pair).includes(sentinel), 'run documents and failure summaries must not contain the key');
  const artifacts = filesUnder(workDir);
  assert.ok(artifacts.length > 0, 'the run must persist artifacts for the credential scan to be meaningful');
  for (const artifact of artifacts) {
    assert.ok(!fs.readFileSync(artifact, 'utf8').includes(sentinel), `the key must not be persisted in ${path.basename(artifact)}`);
  }
});

test('the pair allowance is preallocated equally across both conditions', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 3 });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 7, label: 'controlled-pair' });
  await steps.controlledPair(budget);
  const conditionPaths = invocations
    .filter((i) => i.args[0] === 'run')
    .map((i) => i.args[i.args.findIndex((a) => typeof a === 'string' && a.startsWith('HARNESS_EVAL_TB_CONDITION=')) ]);
  const ceilings = conditionPaths.map((kv) => JSON.parse(fs.readFileSync(kv.split('=')[1], 'utf8')).limits.trialCeilingUsd);
  assert.deepEqual(ceilings, [3.5, 3.5], 'generic and harness receive identical fixed ceilings');
});

test('a qualification pair keeps its fixed arm ceiling when no rerun is scheduled', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.01 });
  const steps = liveSteps({
    taskDir,
    lock,
    spawnImpl,
    config: {
      execution: { environment: 'docker' },
      budget: {
        releaseCeilingUsd: 1.3,
        controlledPairUsd: 1.3,
        rerunUsd: 0,
        controlledArmCeilingUsd: 0.65,
      },
    },
  });
  await steps.taskLock();
  await steps.controlledPair(createBudget({ ceilingUsd: 1.3, label: 'qualification-pair' }));
  const conditionPaths = invocations
    .filter((invocation) => invocation.args[0] === 'run')
    .map((invocation) => invocation.args.find((arg) => String(arg).startsWith('HARNESS_EVAL_TB_CONDITION=')))
    .map((assignment) => assignment.split('=')[1]);
  assert.deepEqual(
    conditionPaths.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).limits.trialCeilingUsd),
    [0.65, 0.65]
  );
});

test('a selected-task calibration and its rerun keep the exact same per-arm budget condition', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.01 });
  const budgetConfig = { releaseCeilingUsd: 10, controlledPairUsd: 8, rerunUsd: 2, reserveUsd: 2 };
  const steps = liveSteps({
    taskDir,
    lock,
    spawnImpl,
    repetitions: 3,
    config: { execution: { environment: 'docker' }, budget: budgetConfig },
  });
  await steps.taskLock();
  const [primary] = await steps.controlledPair(createBudget({ ceilingUsd: 8, label: 'primary-selected-calibration' }));
  const rerun = await steps.rerunControlledPair(
    createBudget({ ceilingUsd: 2, label: 'rerun-selected-calibration' }),
    'cobol-modernization'
  );

  for (const condition of ['generic', 'harness']) {
    const hashes = [
      ...primary[condition].repetitions.map((run) => run.reproducibility.conditionHash),
      ...rerun[condition].repetitions.map((run) => run.reproducibility.conditionHash),
    ];
    assert.equal(new Set(hashes).size, 1, `${condition} must not receive a different budget/prompt contract on rerun`);
  }
  const conditionPaths = invocations
    .filter((invocation) => invocation.args[0] === 'run')
    .map((invocation) => invocation.args.find((arg) => String(arg).startsWith('HARNESS_EVAL_TB_CONDITION=')))
    .map((assignment) => assignment.split('=')[1]);
  assert.deepEqual(
    conditionPaths.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).limits.trialCeilingUsd),
    Array(8).fill(1),
    'the primary ceiling is capped at the amount a full rerun can reproduce'
  );
});

test('an incomplete provider-cost total never undercharges the release ledger', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({ providerCostUsd: 0.001, providerCostComplete: false });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 10, label: 'controlled-pair' });
  const [pair] = await steps.controlledPair(budget);
  assert.equal(pair.failureKind, 'billing');
  assert.equal(pair.harness, null, 'paid scheduling stops before the second arm after uncertain billing');
  assert.equal(budget.spentUsd(), 5, 'the first trial allowance is conservatively reserved');
});

test('missing done telemetry reserves the attempted allowance and fail-stops all later paid arms and tasks', async () => {
  const { taskDir, lock } = fixtureTask();
  const datasetDir = path.dirname(taskDir);
  const secondDir = path.join(datasetDir, 'build-pmars');
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(secondDir, 'instruction.md'), 'Build pMARS.');
  fs.writeFileSync(path.join(secondDir, 'task.toml'), `[environment]\n` +
    `docker_image = "fixture/build-pmars:locked"\ncpus = 1\nmemory = "2G"\nstorage = "10G"\n`);
  const buildPmarsSandbox = {
    sourceImage: 'fixture/build-pmars:locked',
    immutableImage: `fixture/build-pmars@sha256:${'9'.repeat(64)}`,
    imageId: `sha256:${'9'.repeat(64)}`,
    platform: 'linux/amd64',
    cpus: 1,
    memoryMb: 2048,
    storageMb: 10240,
  };
  const multiLock = stampTaskLock(secondDir, lock, 'build-pmars', { sandbox: buildPmarsSandbox });
  const { spawnImpl, invocations } = fakeHarborSpawn({ writeTelemetry: false });
  const steps = liveSteps({ datasetDir, taskDir, lock: multiLock, spawnImpl });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 10, label: 'controlled-pair' });
  const pairs = await steps.controlledPair(budget);
  assert.equal(invocations.filter((invocation) => invocation.args[0] === 'run').length, 1, 'no later arm or task is scheduled');
  assert.equal(pairs.length, 1, 'only the partially attempted task is retained');
  assert.equal(pairs[0].failureKind, 'billing');
  assert.equal(pairs[0].harness, null);
  assert.equal(budget.spentUsd(), 2.5, 'the attempted trial\'s fixed allowance is consumed even without a done file');
});

test('unknown billing in a done ledger also reserves the allowance and fail-stops scheduling', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ billingComplete: false, unknownBillingAttempts: 1 });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 10, label: 'controlled-pair' });
  const [pair] = await steps.controlledPair(budget);
  assert.equal(invocations.filter((invocation) => invocation.args[0] === 'run').length, 1);
  assert.equal(pair.failureKind, 'billing');
  assert.equal(pair.generic.efficiency.billingUncertain, true);
  assert.equal(budget.spentUsd(), 5);
});

test('release reconciliation charges the larger of provider and locally calculated cost', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({ providerCostUsd: 0.001 });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 10, label: 'controlled-pair' });
  await steps.controlledPair(budget);
  assert.ok(Math.abs(budget.spentUsd() - 0.01328) < 1e-12, 'two arms each charge max($0.00664 local, $0.001 provider)');
});

test('a provider reconciliation above one trial allocation stops before another paid arm', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 6 });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 10, label: 'controlled-pair' });
  const [pair] = await steps.controlledPair(budget);
  assert.equal(invocations.filter((invocation) => invocation.args[0] === 'run').length, 1);
  assert.equal(pair.failureKind, 'budget');
  assert.equal(pair.generic.correctness.completedWithinBudget, false);
  assert.equal(pair.generic.billingEvidence.allocationBreached, true);
  assert.equal(budget.spentUsd(), 6);
});

test('paid preflight requires a fresh no-reset provider key limited to the configured release ceiling', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  const config = { execution: { environment: 'docker' }, budget: { releaseCeilingUsd: 10 } };
  const accepted = liveSteps({
    taskDir,
    lock,
    spawnImpl,
    config,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { limit: 10, limit_remaining: 10, limit_reset: null } }) }),
  });
  const good = await accepted.environment();
  assert.equal(good.ok, true);
  const expectedKeyFingerprint = crypto.createHmac('sha256', 'test-key')
    .update('engineer-harness/openrouter-key/v1\0')
    .update('sha1')
    .digest('hex');
  assert.deepEqual(good.providerSpendGuard, {
    verified: true,
    required: true,
    limitUsd: 10,
    limitRemainingUsd: 10,
    reset: null,
    ceilingUsd: 10,
    hardLimitUsd: 10,
    keyFingerprint: expectedKeyFingerprint,
    observedKeyConsumedUsd: 0,
    checkedAt: '2026-07-31T00:00:00.000Z',
  });

  for (const metadata of [
    { limit: null, limit_remaining: null, limit_reset: null },
    { limit: '10', limit_remaining: '10', limit_reset: null },
    { limit: 5, limit_remaining: 5, limit_reset: null },
    { limit: 20, limit_remaining: 20, limit_reset: null },
    { limit: 10, limit_remaining: 11, limit_reset: null },
    { limit: 10, limit_remaining: 9.99, limit_reset: null },
    { limit: 10, limit_remaining: 10, limit_reset: 'daily' },
  ]) {
    const rejected = liveSteps({
      taskDir,
      lock,
      spawnImpl,
      config,
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: metadata }) }),
    });
    const verdict = await rejected.environment();
    assert.equal(verdict.ok, false, JSON.stringify(metadata));
    assert.ok(verdict.missing.some((reason) => /provider.*limit|dedicated.*key|reset/i.test(reason)));
  }
});

test('a malformed configured release ceiling cannot disable the provider cash guard', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  for (const releaseCeilingUsd of [-1, '10', Number.NaN]) {
    const steps = liveSteps({
      taskDir,
      lock,
      spawnImpl,
      config: { execution: { environment: 'docker' }, budget: { releaseCeilingUsd } },
      fetchImpl: async () => {
        throw new Error('invalid policy must fail before provider lookup');
      },
    });
    const verdict = await steps.environment();
    assert.equal(verdict.ok, false, String(releaseCeilingUsd));
    assert.ok(verdict.missing.some((reason) => /scheduled ceiling/i.test(reason)));
  }
});

test('qualification and calibration share one pseudonymously linked 20 USD provider key limit', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  const keyMetadata = (limitRemaining) => async () => ({
    ok: true,
    json: async () => ({ data: { limit: 20, limit_remaining: limitRemaining, limit_reset: null } }),
  });
  const qualification = liveSteps({
    taskDir,
    lock,
    spawnImpl,
    apiKey: 'a',
    config: {
      evaluationScope: { mode: 'qualification' },
      execution: { environment: 'docker' },
      budget: { releaseCeilingUsd: 1.3, providerHardLimitUsd: 20 },
    },
    fetchImpl: keyMetadata(20),
  });
  const qualified = await qualification.environment();
  assert.equal(qualified.ok, true);
  assert.equal(qualified.providerSpendGuard.verified, true);
  assert.equal(qualified.providerSpendGuard.hardLimitUsd, 20);
  assert.match(qualified.providerSpendGuard.keyFingerprint, /^[a-f0-9]{64}$/);

  const calibrationConfig = {
    evaluationScope: { mode: 'calibration' },
    execution: { environment: 'docker' },
    budget: { releaseCeilingUsd: 18.7, providerHardLimitUsd: 20 },
    qualificationBaseline: {
      providerKeyFingerprint: qualified.providerSpendGuard.keyFingerprint,
    },
  };
  const calibration = liveSteps({
    taskDir,
    lock,
    spawnImpl,
    apiKey: 'a',
    config: calibrationConfig,
    fetchImpl: keyMetadata(18.9),
  });
  assert.equal((await calibration.environment()).ok, true, 'prior accepted-path spend may consume the first 1.3 USD');

  const changedKey = liveSteps({
    taskDir,
    lock,
    spawnImpl,
    apiKey: 'b',
    config: calibrationConfig,
    fetchImpl: keyMetadata(18.9),
  });
  const changedKeyVerdict = await changedKey.environment();
  assert.equal(changedKeyVerdict.ok, false);
  assert.ok(changedKeyVerdict.missing.some((reason) => /same dedicated.*key|credential/i.test(reason)));

  const overspentBeforeCalibration = liveSteps({
    taskDir,
    lock,
    spawnImpl,
    apiKey: 'a',
    config: calibrationConfig,
    fetchImpl: keyMetadata(18.69),
  });
  const overspentVerdict = await overspentBeforeCalibration.environment();
  assert.equal(overspentVerdict.ok, false);
  assert.ok(overspentVerdict.missing.some((reason) => /remaining|20.*limit|dedicated.*key/i.test(reason)));
});

test('paid preflight times out a hung provider key-limit lookup', async () => {
  const { taskDir, lock } = fixtureTask();
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => ({ ok: true, json: async () => new Promise(() => {}) }),
  ]) {
    const { spawnImpl } = fakeHarborSpawn();
    const steps = liveSteps({
      taskDir,
      lock,
      spawnImpl,
      config: { budget: { releaseCeilingUsd: 10 }, execution: { environment: 'docker' } },
      fetchImpl,
      providerLookupTimeoutMs: 5,
    });
    const startedAt = Date.now();
    const result = await steps.environment();
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((reason) => /provider key limit lookup failed/.test(reason)));
    assert.ok(Date.now() - startedAt < 1_000, 'environment preflight must not inherit an unbounded provider response');
  }
});

test('environment preflight requires the exact supported Harbor version', async () => {
  const { taskDir, lock } = fixtureTask();
  for (const harborVersion of ['0.19.0', '0.20.1', 'harbor 0.20.0 and 0.20.1']) {
    const { spawnImpl } = fakeHarborSpawn({ harborVersion });
    const result = await liveSteps({ taskDir, lock, spawnImpl }).environment();
    assert.equal(result.ok, false, harborVersion);
    assert.ok(result.missing.includes('harbor CLI 0.20.0 required'));
  }
});

test('a nonzero harbor exit becomes an infrastructure-invalid pair that blocks an active gate', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({ exitCode: 3 });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'p' }));
  assert.equal(pair.failureKind, 'infrastructure');
});

test('hostile verifier artifacts preserve billing and become retained infrastructure evidence', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    providerCostUsd: 0.02,
    mutateJob: ({ verifierDir }) => fs.symlinkSync('/tmp', path.join(verifierDir, 'hostile-link')),
  });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 10, label: 'hostile-verifier-artifact' });
  const [pair] = await steps.controlledPair(budget);

  assert.ok(budget.spentUsd() > 0, 'provider billing is reconciled before untrusted verifier traversal');
  assert.equal(pair.failureKind, 'infrastructure');
  for (const raw of [pair.generic.repetitions[0], pair.harness.repetitions[0]]) {
    assert.equal(raw.verifierEvidence.collectionComplete, false);
    assert.equal(raw.verifierEvidence.reason, 'verifier-evidence-collection-failed');
    assert.equal(raw.trialValidity.valid, false);
  }
});

test('missing credentials skip the pair without touching harbor run', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn();
  const steps = liveSteps({ taskDir, lock, spawnImpl, apiKey: null });
  const pair = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'p' }));
  assert.equal(pair, null);
  assert.equal(invocations.filter((i) => i.args[0] === 'run').length, 0);
});

test('the local model floor is explicit opt-in, anchor-only, secret-free, and zero API spend', async () => {
  const { taskDir, lock, datasetDir } = fixtureTask();
  const disabled = buildLiveSteps({
    config: { controlledLane: CONTROLLED_LANE, execution: { environment: 'docker' } },
    lock,
    workDir: tmpdir(),
    env: { HARNESS_EVAL_TB_DATASET_DIR: datasetDir ?? path.dirname(taskDir) },
    providerControl: testProviderControl(),
  });
  assert.equal(disabled.gemmaPair, null, 'routine releases do not inherit local-model wall time');

  const scheduleDisabled = buildLiveSteps({
    config: {
      controlledLane: CONTROLLED_LANE,
      execution: { environment: 'docker' },
      pairs: [{ host: 'ollama-gemma', enabled: true, schedule: 'disabled', taskRole: 'anchor' }],
    },
    lock,
    workDir: tmpdir(),
    env: { HARNESS_EVAL_TB_DATASET_DIR: datasetDir ?? path.dirname(taskDir) },
    localEnabled: true,
    providerControl: testProviderControl(),
  });
  assert.equal(scheduleDisabled.gemmaPair, null, 'the configured schedule can reject the CLI opt-in');
  assert.throws(
    () => buildLiveSteps({
      config: {
        controlledLane: CONTROLLED_LANE,
        execution: { environment: 'docker' },
        pairs: [{ host: 'ollama-gemma', enabled: true, schedule: 'explicit-with-local', taskRole: 'stress' }],
      },
      lock,
      workDir: tmpdir(),
      env: { HARNESS_EVAL_TB_DATASET_DIR: datasetDir ?? path.dirname(taskDir) },
      localEnabled: true,
      providerControl: testProviderControl(),
    }),
    /taskRole is not pinned.*stress/,
    'the configured role is consumed instead of silently falling back to the anchor'
  );

  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 9.99 });
  const enabled = buildLiveSteps({
    config: {
      controlledLane: CONTROLLED_LANE,
      execution: { environment: 'docker' },
      pairs: [{ host: 'ollama-gemma', enabled: true, schedule: 'explicit-with-local', taskRole: 'anchor' }],
    },
    lock,
    workDir: tmpdir(),
    env: { HARNESS_EVAL_TB_DATASET_DIR: datasetDir ?? path.dirname(taskDir) },
    spawnImpl,
    attestHarborExecutable: fakeHarborIdentity,
    attestSandboxImage: fakeSandboxIdentity,
    localEnabled: true,
    providerControl: testProviderControl(),
    prepareBundle: ({ bundleDir, sourceIdentity }) => fakePreparedBundle(bundleDir, sourceIdentity),
    validateBundle: fakeValidateBundle,
  });
  assert.equal((await enabled.taskLock()).ok, true);
  const budget = createBudget({ ceilingUsd: 0, label: 'local-floor' });
  const [pair] = await enabled.gemmaPair(budget);
  assert.equal(pair.host, 'ollama-gemma');
  assert.equal(pair.task, 'cobol-modernization');
  assert.equal(pair.repetitionCount, 1);
  assert.equal(pair.generic.reproducibility.host, 'ollama-gemma');
  assert.equal(pair.generic.reproducibility.modelProfileId, 'gemma-4-26b-local');
  assert.equal(pair.generic.reproducibility.modelRequested, 'gemma4:26b-a4b-it-q4_K_M');
  for (const doc of [pair.generic, pair.harness]) {
    assert.equal(doc.efficiency.localCostUsd, 0);
    assert.equal(doc.efficiency.providerReportedCostUsd, null);
    assert.equal(doc.efficiency.reconciledCostUsd, 0);
    assert.ok(doc.observability.providerEvents
      .filter((event) => event.type === 'response')
      .every((event) => event.billingStatus === 'confirmed_unbilled' &&
        event.usage.localCostUsd === 0 && event.usage.providerCostUsd === null));
  }
  assert.equal(budget.spentUsd(), 0, 'provider-like fields from a local endpoint never count as API spend');
  const runs = invocations.filter((invocation) => invocation.args[0] === 'run');
  assert.equal(runs.length, 2, 'only the anchor task receives a generic/harness local pair');
  assert.ok(runs.every((invocation) => !Object.hasOwn(invocation.opts.env, 'OPENROUTER_API_KEY')));
  const conditionPaths = runs.map((invocation) => invocation.args[invocation.args.findIndex((arg) => typeof arg === 'string' && arg.startsWith('HARNESS_EVAL_TB_CONDITION='))].split('=')[1]);
  const conditions = conditionPaths.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.ok(conditions.every((condition) => condition.profileId === 'gemma-4-26b-local'));
  assert.ok(
    conditions.every((condition) => condition.providerUrl === 'http://localhost:11434/v1/chat/completions'),
    'the host-side provider bridge calls Ollama over host loopback'
  );
});

test('live steps feed runRelease end to end: green pair, valid report, exit 0', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  const [taskEntry] = lock.tasks;
  const config = {
    controlledLane: CONTROLLED_LANE,
    evaluationScope: {
      mode: 'release',
      releaseEligible: true,
      trust: {
        ok: true,
        status: 'attested',
        configuredStatus: 'attested',
        evidenceSource: 'runtime-observed',
        evidenceHash: 'e'.repeat(64),
        requiredCapabilities: [
          'fullHarborRuntimeClosureAttested',
          'keyBearingToolchainIsolated',
          'sandboxEntryChainAttested',
          'mountsObservedFromTrustedSupervisor',
          'escapedProcessesAndContainersReaped',
          'imageResourcesAndNetworkObserved',
        ],
        missingCapabilities: [],
      },
    },
    budget: { releaseCeilingUsd: 10, controlledPairUsd: 8, rerunUsd: 2, providerHardLimitUsd: 10 },
    efficiencyThresholds: { promptRatio: 2, costRatio: 1.5, wallTimeRatio: 1.25 },
    valueThresholds: {
      maxIncrementalApiCostPerAdditionalSuccessUsd: 2,
      maxIncrementalWallTimePerAdditionalSuccessMs: 600_000,
    },
    task: {
      datasetRef: lock.datasetRef,
      task: taskEntry.task,
      taskChecksum: taskEntry.taskChecksum,
      taskSet: [taskEntry],
    },
  };
  const steps = liveSteps({
    taskDir,
    lock,
    spawnImpl,
    config: { controlledLane: CONTROLLED_LANE, execution: { environment: 'docker' }, budget: config.budget },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { limit: 10, limit_remaining: 10, limit_reset: null } }) }),
  });
  let liveProviderSpendGuard = null;
  const { report, exitCode } = await runRelease({
    config,
    steps: {
      ...steps,
      deterministic: async () => ({ passed: 17, failed: 0, skipped: 2 }),
      environment: async () => {
        const evidence = await steps.environment();
        liveProviderSpendGuard = evidence.providerSpendGuard;
        return evidence;
      },
    },
    requiredPairs: ['openrouter-controlled'],
  });
  assert.equal(exitCode, 0, JSON.stringify({ reasons: report.gate.reasons, delta: report.pairs.find((pair) => pair.host === 'openrouter-controlled')?.efficiencyDelta }));
  const controlled = report.pairs.find((p) => p.host === 'openrouter-controlled');
  assert.equal(controlled.result, 'parity');
  assert.deepEqual(
    report.budget.providerSpendGuard,
    liveProviderSpendGuard,
    'release revalidation must consume the same resolved provider policy as live preflight'
  );
  assert.ok(Math.abs(report.budget.spentUsd - 0.04) < 1e-12, 'live child charges reach the release report');
});

test('AGENT_REF matches the importable module path', () => {
  assert.equal(AGENT_REF, 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent');
});

function promptEconomicsFixture(requestId = 'r1') {
  const manifest = {
    schema: 'prompt-component-manifest.v1',
    separator: '\n\n',
    systemPromptChars: 10,
    systemPromptBytes: 10,
    systemPromptHash: 'a'.repeat(64),
    complete: true,
    components: [
      { id: 'engineer-contract', ordinal: 0, startChar: 0, endChar: 4, chars: 4, bytes: 4, sha256: 'b'.repeat(64) },
      { id: 'loaded-guidance', ordinal: 1, startChar: 6, endChar: 10, chars: 4, bytes: 4, sha256: 'c'.repeat(64) },
    ],
  };
  const request = {
    type: 'request',
    requestId,
    payloadChars: 100,
    promptComponentManifest: manifest,
    promptBuckets: {
      baseSystem: 20,
      instruction: 10,
      durableState: 0,
      assistantHistory: 20,
      toolResultHistory: 10,
      otherMessages: 0,
      messageEnvelope: 10,
      toolSchema: 20,
      payloadEnvelope: 10,
      toolResultHistoryBySource: { 'memory-retrieval': 10 },
      complete: true,
    },
  };
  const response = {
    type: 'response',
    requestId,
    usage: {
      promptTokens: 100,
      cachedTokens: 40,
      cachedTokensComplete: true,
      reasoningTokens: 0,
      reasoningTokensComplete: true,
      outputTokens: 20,
      localCostUsd: 0.01,
      providerCostUsd: 0.01,
      reconciledCostUsd: 0.01,
    },
  };
  return { request, response };
}

function promptEconomicsAuthoritativeTotals(multiplier = 1) {
  return {
    modelRequests: multiplier,
    promptTokens: 100 * multiplier,
    cachedTokens: 40 * multiplier,
    cachedTokensComplete: true,
    outputTokens: 20 * multiplier,
    localCostUsd: 0.01 * multiplier,
    providerCostUsd: 0.01 * multiplier,
    reconciledCostUsd: 0.01 * multiplier,
    usageComplete: true,
    providerCostComplete: true,
    billingComplete: true,
    costComplete: true,
  };
}

test('prompt and phase economics reconcile exact usage without inventing component token splits', () => {
  const manifest = {
    schema: 'prompt-component-manifest.v1',
    separator: '\n\n',
    systemPromptChars: 10,
    systemPromptBytes: 10,
    systemPromptHash: 'a'.repeat(64),
    complete: true,
    components: [{ id: 'engineer-contract', ordinal: 0, startChar: 0, endChar: 10, chars: 10, bytes: 10, sha256: 'b'.repeat(64) }],
  };
  const request = (requestId, toolResultSource = null) => ({
    type: 'request',
    requestId,
    payloadChars: 100,
    promptComponentManifest: manifest,
    promptBuckets: {
      baseSystem: 20,
      instruction: 10,
      durableState: 0,
      assistantHistory: 20,
      toolResultHistory: toolResultSource ? 10 : 0,
      otherMessages: 0,
      messageEnvelope: 10,
      toolSchema: 20,
      payloadEnvelope: toolResultSource ? 10 : 20,
      toolResultHistoryBySource: toolResultSource ? { [toolResultSource]: 10 } : {},
      complete: true,
    },
  });
  const usage = (requestId, promptTokens, cachedTokens, outputTokens, cost) => ({
    type: 'response',
    requestId,
    usage: {
      promptTokens,
      cachedTokens,
      cachedTokensComplete: true,
      reasoningTokens: 0,
      reasoningTokensComplete: true,
      outputTokens,
      localCostUsd: cost,
      providerCostUsd: cost,
      reconciledCostUsd: cost,
    },
  });
  const events = [
    request('r1'),
    usage('r1', 100, 40, 20, 0.01),
    { type: 'tool_call', requestId: 'r1', contextSource: 'memory-retrieval', category: 'orient' },
    request('r2', 'memory-retrieval'),
    usage('r2', 150, 70, 30, 0.02),
  ];
  const economics = promptAndPhaseEconomicsOf(events, {
    modelRequests: 2,
    promptTokens: 250,
    cachedTokens: 110,
    cachedTokensComplete: true,
    outputTokens: 50,
    localCostUsd: 0.03,
    providerCostUsd: 0.03,
    reconciledCostUsd: 0.03,
    usageComplete: true,
    providerCostComplete: true,
    billingComplete: true,
    costComplete: true,
  });

  assert.equal(economics.coverage.status, 'complete');
  assert.equal(economics.prompt.cumulative.payloadChars, 200);
  assert.equal(economics.prompt.cumulative.toolResultHistoryBySource['memory-retrieval'], 10);
  assert.equal(economics.phases['memory-retrieval'].promptTokens, 100);
  assert.equal(economics.phases['memory-retrieval'].status, 'measured');
  assert.equal(economics.phases['memory-construction'].status, 'not_exercised');
  assert.equal(economics.phases['memory-construction'].promptTokens, null);
  assert.equal(economics.phases.finalization.promptTokens, 150);
  assert.equal(economics.rollups['task-execution'].logicalRequests, 1);
  assert.equal(economics.rollups['task-execution'].promptTokens, 150);
  for (const [source, target] of Object.entries(SOURCE_USAGE_TO_ECONOMIC_FIELD)) {
    const expected = events
      .filter((event) => event.usage)
      .reduce((sum, event) => sum + event.usage[source], 0);
    assert.equal(economics.totals[target], expected, `${source} maps to ${target}`);
    assert.equal(economics.totals[`${target}Complete`], true, `${target} completeness is retained`);
  }
  assert.deepEqual(
    economics.rollups['task-execution'].derivedFrom,
    ['guidance', 'planning-and-gate', 'verification', 'orientation', 'implementation', 'finalization', 'uncategorized', 'mixed', 'unknown']
  );
  assert.equal(economics.reconciliation.complete, true);
  assert.equal('componentPromptTokens' in economics.prompt, false, 'provider totals cannot be truthfully split across prompt components');
});

test('a complete authoritative reasoning-token mismatch makes phase economics partial', () => {
  const { request, response } = promptEconomicsFixture();
  const authoritativeTotals = {
    ...promptEconomicsAuthoritativeTotals(),
    reasoningTokens: 1,
    reasoningTokensComplete: true,
  };
  const economics = promptAndPhaseEconomicsOf([request, response], authoritativeTotals);

  assert.equal(economics.totals.reasoningTokens, 0, 'provider event usage remains the measured total');
  assert.equal(economics.totals.reasoningTokensComplete, true);
  assert.equal(economics.reconciliation.checks.reasoningTokens, false);
  assert.equal(economics.reconciliation.complete, false);
  assert.equal(economics.coverage.complete, false);
  assert.equal(economics.coverage.status, 'partial');
  assert.match(economics.coverage.reason, /phase usage does not reconcile/i);
});

test('prompt and phase economics reject malformed disjoint bucket attribution', async (t) => {
  const cases = [
    {
      name: 'negative bucket value',
      mutate: (request) => {
        request.promptBuckets.baseSystem = -1;
        request.promptBuckets.payloadEnvelope = 31;
      },
    },
    {
      name: 'fractional bucket value',
      mutate: (request) => {
        request.promptBuckets.baseSystem = 19.5;
        request.promptBuckets.payloadEnvelope = 10.5;
      },
    },
    {
      name: 'bucket sum differs from payloadChars',
      mutate: (request) => {
        request.promptBuckets.payloadEnvelope = 9;
      },
    },
    {
      name: 'tool-result source subtotal overflows its bucket',
      mutate: (request) => {
        request.promptBuckets.toolResultHistoryBySource['memory-retrieval'] = 11;
      },
    },
    {
      name: 'tool-result source subtotal does not explain its bucket',
      mutate: (request) => {
        request.promptBuckets.toolResultHistoryBySource['memory-retrieval'] = 9;
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const { request, response } = promptEconomicsFixture();
      entry.mutate(request);
      const economics = promptAndPhaseEconomicsOf(
        [request, response],
        promptEconomicsAuthoritativeTotals()
      );

      assert.equal(economics.coverage.status, 'partial');
      assert.equal(economics.coverage.complete, false);
      assert.equal(economics.prompt.coverage.complete, false);
      assert.equal(economics.prompt.coverage.requestsWithCompleteBuckets, 0);
      assert.equal(economics.prompt.cumulative.payloadChars, 100, 'the independently valid request size remains usable');
      for (const field of [
        'baseSystemChars', 'instructionChars', 'durableStateChars', 'assistantHistoryChars',
        'toolResultHistoryChars', 'otherMessageChars', 'messageEnvelopeChars',
        'toolSchemaChars', 'payloadEnvelopeChars',
      ]) {
        assert.equal(economics.prompt.cumulative[field], null, `${field} must fail closed`);
      }
      assert.equal(economics.prompt.cumulative.toolResultHistoryBySource, null);
      assert.match(economics.coverage.reason, /prompt bucket contract/i);
      assert.equal(
        economics.coverage.complete && economics.prompt.coverage.complete && economics.reconciliation.complete,
        false,
        'malformed attribution cannot become causal evidence'
      );
    });
  }
});

test('prompt and phase economics reject malformed content-free component manifests', async (t) => {
  const rawPromptSentinel = 'RAW-PROMPT-MUST-NOT-BE-RETAINED';
  const cases = [
    {
      name: 'component spans are not contiguous through the separator',
      mutate: (manifest) => { manifest.components[1].startChar = 5; },
    },
    {
      name: 'system hash is not a SHA-256 digest',
      mutate: (manifest) => { manifest.systemPromptHash = 'not-a-sha256'; },
    },
    {
      name: 'component hash is not a SHA-256 digest',
      mutate: (manifest) => { manifest.components[0].sha256 = 'not-a-sha256'; },
    },
    {
      name: 'separator does not agree with component geometry',
      mutate: (manifest) => { manifest.separator = '\n'; },
    },
    {
      name: 'component character total does not match its span',
      mutate: (manifest) => { manifest.components[0].chars = 5; },
    },
    {
      name: 'component byte totals do not match the system total',
      mutate: (manifest) => { manifest.components[0].bytes = 5; },
    },
    {
      name: 'unexpected content-bearing manifest field',
      mutate: (manifest) => { manifest.components[0].content = rawPromptSentinel; },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const { request, response } = promptEconomicsFixture();
      entry.mutate(request.promptComponentManifest);
      const economics = promptAndPhaseEconomicsOf(
        [request, response],
        promptEconomicsAuthoritativeTotals()
      );

      assert.equal(economics.coverage.status, 'partial');
      assert.equal(economics.coverage.complete, false);
      assert.equal(economics.prompt.coverage.complete, false);
      assert.equal(economics.prompt.manifest, null);
      assert.equal(economics.prompt.cumulative.payloadChars, 100);
      assert.equal(economics.prompt.cumulative.baseSystemChars, 20, 'valid bucket evidence remains usable');
      assert.match(economics.coverage.reason, /prompt component manifest contract/i);
      assert.doesNotMatch(JSON.stringify(economics), new RegExp(rawPromptSentinel));
      assert.equal(
        economics.coverage.complete && economics.prompt.coverage.complete && economics.reconciliation.complete,
        false,
        'malformed attribution cannot become causal evidence'
      );
    });
  }
});

test('prompt and phase economics reject duplicate request identities without double-counting prompt totals', () => {
  const first = promptEconomicsFixture('duplicate-request');
  const second = structuredClone(first);
  const economics = promptAndPhaseEconomicsOf(
    [first.request, first.response, second.request, second.response],
    promptEconomicsAuthoritativeTotals(2)
  );

  assert.equal(economics.coverage.status, 'partial');
  assert.equal(economics.coverage.complete, false);
  assert.equal(economics.prompt.coverage.complete, false);
  assert.equal(economics.prompt.cumulative.payloadChars, null);
  assert.equal(economics.prompt.cumulative.baseSystemChars, null);
  assert.equal(economics.prompt.cumulative.toolResultHistoryBySource, null);
  assert.match(economics.coverage.reason, /duplicate request identit/i);
  assert.equal(
    economics.coverage.complete && economics.prompt.coverage.complete && economics.reconciliation.complete,
    false,
    'ambiguous request identities cannot become causal evidence'
  );
});

test('prompt and phase economics label unmatched or missing evidence as partial instead of zero', () => {
  const economics = promptAndPhaseEconomicsOf([
    { type: 'request', requestId: 'r1', payloadChars: 50, promptComponentManifest: null, promptBuckets: null },
    { type: 'response', requestId: 'missing-request', usage: { promptTokens: 10, outputTokens: 2, localCostUsd: 0.01, reconciledCostUsd: 0.01 } },
  ], { modelRequests: 1, promptTokens: 10, outputTokens: 2, localCostUsd: 0.01, reconciledCostUsd: 0.01 });
  assert.equal(economics.coverage.status, 'partial');
  assert.equal(economics.coverage.complete, false);
  assert.equal(economics.prompt.cumulative.baseSystemChars, null);
  assert.equal(economics.phases.unknown.promptTokens, 10);
  assert.equal(economics.phases['memory-construction'].status, 'unavailable');
  assert.equal(economics.phases['memory-construction'].promptTokens, null);
  assert.match(economics.coverage.reason, /manifest|bucket|unmatched/i);
});

test('absent prompt telemetry explicitly marks every economic phase unavailable', () => {
  const economics = promptAndPhaseEconomicsOf([], null);
  assert.equal(economics.coverage.status, 'unavailable');
  for (const phase of ['memory-retrieval', 'memory-construction', 'memory-consolidation']) {
    assert.equal(economics.phases[phase].status, 'unavailable');
    assert.equal(economics.phases[phase].promptTokens, null);
  }
  assert.equal(economics.rollups['task-execution'].status, 'unavailable');
  assert.equal(economics.rollups['task-execution'].promptTokens, null);
});

function repetitionDoc({ verdict = 'pass', reward = 1, repetitionIndex = 1, promptTokens = 1000, costUsd = 0.02, providerCostUsd = costUsd, reconciledCostUsd = Math.max(costUsd, providerCostUsd), costComplete = true, missingUsage = 0 } = {}) {
  return {
    schema: 'eval-run.v1',
    reproducibility: { condition: 'generic', repetitionIndex, startedAt: '2026-07-31T00:00:00Z', endedAt: '2026-07-31T00:03:00Z' },
    correctness: { verifierReward: reward, verdict, exitReason: 'model_finish', completedWithinTimeout: true, completedWithinBudget: true },
    trialValidity: { valid: true, failureKind: null },
    efficiency: { promptTokens, outputTokens: 500, modelRequests: 10, localCostUsd: costUsd, providerReportedCostUsd: providerCostUsd, reconciledCostUsd, cachedPromptTokens: 0, reasoningTokens: 0, costComplete, missingUsage },
    harnessBehavior: {},
    subscription: null,
  };
}

function withCompleteObservability(doc, { providerEvents = [], eventEvidenceHash = 'a'.repeat(64) } = {}) {
  doc.observability = {
    providerEvents,
    toolEvents: [],
    harnessEvents: [],
    harnessEventEvidence: {
      available: true,
      complete: true,
      reason: null,
      retainedEvents: 0,
      sourceTruncated: false,
      projectionRejectedEvents: 0,
      projectionRejectedChecks: 0,
    },
    providerAttemptsStarted: 0,
    providerAttemptsClosed: 0,
    unclosedProviderAttempts: 0,
    uncorrelatedProviderTerminals: 0,
    duplicateProviderAttemptIdentities: 0,
    duplicateProviderTerminalIdentities: 0,
    invalidProviderEventIdentities: 0,
    correlatedToolResults: 0,
    uncorrelatedToolResults: 0,
    unclosedToolCalls: 0,
    duplicateToolCallIdentities: 0,
    duplicateToolResultIdentities: 0,
    invalidToolEventIdentities: 0,
    malformedToolCallEvidence: 0,
    malformedToolResultEvidence: 0,
    invalidToolArguments: 0,
    incompleteToolContainment: 0,
    controlContaminationDetected: false,
    runtimeContractEvidence: {
      complete: true,
      matchesExpected: true,
      requestContractsChecked: 1,
      postVerifyRequestContracts: 0,
      requestPromptMismatches: 0,
      requestContractMismatches: 0,
    },
    mountPolicyEvidence: {
      version: 'eval-mount-policy.v1',
      source: 'sandbox-observed',
      observed: true,
      complete: true,
      matchesCondition: true,
      structurallyIsolated: true,
      effectiveTargets: ['/opt/eval-runtime/agent.mjs'],
      commonTargets: ['/opt/eval-runtime/agent.mjs'],
      treatmentOnlyTargets: [],
      reason: null,
    },
    eventEvidenceHash,
  };
  return doc;
}

test('repetition aggregation uses majority verdict and median efficiency over valid trials', () => {
  const agg = aggregateRepetitionDocs([
    repetitionDoc({ verdict: 'pass', reward: 1, promptTokens: 100, costUsd: 0.01 }),
    repetitionDoc({ verdict: 'fail', reward: 0, promptTokens: 200, costUsd: 0.02 }),
    repetitionDoc({ verdict: 'pass', reward: 1, promptTokens: 400, costUsd: 0.04 }),
  ]);
  assert.equal(agg.correctness.verdict, 'pass', '2/3 passes is a pass');
  assert.equal(agg.correctness.verifierReward, 1, 'median reward');
  assert.equal(agg.efficiency.promptTokens, 200, 'median tokens');
  assert.match(agg.correctness.exitReason, /repetition-aggregate\(n=3\)/);
});

test('repetition aggregation preserves the median per-trial reconciled charge for efficiency comparison', () => {
  const generic = aggregateRepetitionDocs([
    repetitionDoc({ repetitionIndex: 1, costUsd: 1, providerCostUsd: 1 }),
    repetitionDoc({ repetitionIndex: 2, costUsd: 1, providerCostUsd: 1 }),
    repetitionDoc({ repetitionIndex: 3, costUsd: 1, providerCostUsd: 1 }),
  ]);
  const harness = aggregateRepetitionDocs([
    repetitionDoc({ repetitionIndex: 1, costUsd: 100, providerCostUsd: 1 }),
    repetitionDoc({ repetitionIndex: 2, costUsd: 1, providerCostUsd: 100 }),
    repetitionDoc({ repetitionIndex: 3, costUsd: 1, providerCostUsd: 1 }),
  ]);

  assert.equal(harness.efficiency.localCostUsd, 1, 'component medians alone would understate charged cost');
  assert.equal(harness.efficiency.providerReportedCostUsd, 1);
  assert.equal(harness.efficiency.reconciledCostUsd, 100);
  assert.equal(efficiencyDelta(generic, harness).costRatio, 100);
});

test('repetition aggregation summarizes prompt and phase economics instead of retaining the first trial as typical', () => {
  const withEconomics = (promptTokens, payloadChars, status = 'complete') => {
    const doc = repetitionDoc({ promptTokens });
    doc.economics = {
      coverage: { status, complete: status === 'complete', requestEvents: 2, usageEvents: 2, matchedUsageEvents: 2, reason: status === 'complete' ? null : 'partial fixture' },
      prompt: {
        manifest: { schema: 'prompt-component-manifest.v1', systemPromptHash: 'a'.repeat(64), complete: true, components: [] },
        coverage: { complete: status === 'complete', requests: 2, requestsWithCompleteBuckets: status === 'complete' ? 2 : 1 },
        cumulative: { payloadChars, baseSystemChars: payloadChars / 2, toolResultHistoryBySource: { 'memory-retrieval': payloadChars / 10 } },
      },
      phases: {
        implementation: { logicalRequests: 2, usageRecords: 2, promptTokens, promptTokensComplete: true },
      },
      totals: { logicalRequests: 2, usageRecords: 2, promptTokens, promptTokensComplete: true },
      reconciliation: { complete: status === 'complete', checks: { promptTokens: true }, reason: status === 'complete' ? null : 'partial fixture' },
    };
    return doc;
  };
  const aggregate = aggregateRepetitionDocs([
    withEconomics(100, 1000),
    withEconomics(200, 2000),
    withEconomics(900, 9000, 'partial'),
  ]);
  assert.equal(aggregate.economics.aggregation, 'median-per-valid-repetition');
  assert.equal(aggregate.economics.prompt.cumulative.payloadChars, 2000);
  assert.equal(aggregate.economics.phases.implementation.promptTokens, 200);
  assert.equal(aggregate.economics.coverage.complete, false, 'one partial repetition makes aggregate coverage partial');
  assert.equal(aggregate.economics.coverage.status, 'partial');
});

test('invalid repetitions are excluded from the verdict denominator while raw evidence remains retained', () => {
  const broken = repetitionDoc({ verdict: 'fail', reward: null });
  const agg = aggregateRepetitionDocs([repetitionDoc({ verdict: 'pass' }), broken, broken]);
  assert.equal(agg.correctness.verdict, 'pass', 'the one valid repetition is the verdict denominator');
  assert.equal(agg.correctness.verifierReward, 1, 'median over valid rewards only');
  assert.equal(agg.repetitions.length, 3, 'invalid trials remain available for audit');
  assert.match(agg.correctness.exitReason, /valid=1/);
});

test('repetition verdicts require a strict majority of valid trials', () => {
  const agg = aggregateRepetitionDocs([
    repetitionDoc({ verdict: 'pass', reward: 1 }),
    repetitionDoc({ verdict: 'fail', reward: 0 }),
  ]);
  assert.equal(agg.correctness.verdict, 'fail', 'a one-to-one tie is not a majority');
});

test('repetition aggregation preserves incomplete-cost evidence from any attempted trial', () => {
  const agg = aggregateRepetitionDocs([repetitionDoc(), repetitionDoc({ costComplete: false, missingUsage: 1 }), repetitionDoc()]);
  assert.equal(agg.efficiency.costComplete, false);
  assert.equal(agg.efficiency.missingUsage, 1);
});

test('repetition aggregation retains every raw trial and all-trial completeness invariants', () => {
  const first = repetitionDoc();
  first.reproducibility.pairId = 'pair';
  first.reproducibility.repetitionId = 'rep-1';
  first.efficiency.billingComplete = true;
  first.efficiency.usageComplete = true;
  first.efficiency.providerCostComplete = true;
  const second = repetitionDoc({ costComplete: false });
  second.reproducibility.pairId = 'pair';
  second.reproducibility.repetitionId = 'rep-2';
  second.efficiency.billingComplete = false;
  second.efficiency.usageComplete = true;
  second.efficiency.providerCostComplete = true;
  const aggregate = aggregateRepetitionDocs([first, second]);
  assert.deepEqual(aggregate.repetitions.map((run) => run.reproducibility.repetitionId), ['rep-1', 'rep-2']);
  assert.equal(aggregate.efficiency.billingComplete, false);
  assert.equal(aggregate.efficiency.usageComplete, true);
  assert.equal(aggregate.efficiency.providerCostComplete, true);
});

test('aggregate summaries retain large event ledgers exactly once', () => {
  const providerEvents = Array.from({ length: 200 }, (_, index) => ({
    eventId: `event-${index}`,
    type: 'request',
    requestId: `request-${index}`,
    redactedDiagnostic: 'x'.repeat(1024),
  }));
  const raw = withCompleteObservability(repetitionDoc(), { providerEvents });
  const rawBytes = Buffer.byteLength(JSON.stringify(raw));
  const aggregate = aggregateRepetitionDocs([raw]);
  const aggregateBytes = Buffer.byteLength(JSON.stringify(aggregate));

  assert.deepEqual(aggregate.observability.providerEvents, []);
  assert.deepEqual(aggregate.observability.toolEvents, []);
  assert.deepEqual(aggregate.observability.harnessEvents, []);
  assert.equal(aggregate.repetitions[0].observability.providerEvents.length, providerEvents.length);
  assert.ok(aggregateBytes < rawBytes * 1.1, `summary overhead should stay bounded: raw=${rawBytes}, aggregate=${aggregateBytes}`);
});

test('one repetition missing observability makes aggregate evidence incomplete', () => {
  const observed = withCompleteObservability(repetitionDoc());
  const missing = repetitionDoc();
  const aggregate = aggregateRepetitionDocs([observed, missing]);

  assert.equal(aggregate.observability.harnessEventEvidence.available, false);
  assert.equal(aggregate.observability.harnessEventEvidence.complete, false);
  assert.equal(aggregate.observability.runtimeContractEvidence.complete, false);
  assert.equal(aggregate.observability.runtimeContractEvidence.matchesExpected, false);
  assert.equal(aggregate.observability.mountPolicyEvidence.complete, false);
  assert.equal(aggregate.observability.mountPolicyEvidence.structurallyIsolated, false);
});

test('aggregate views never relabel one repetition diff/artifact as the aggregate and preserve any safety bypass', () => {
  const first = repetitionDoc();
  first.reproducibility.repetitionId = 'rep-1';
  first.correctness.finalDiffHash = 'a'.repeat(64);
  first.correctness.verifierArtifactHash = 'b'.repeat(64);
  first.workspaceEvidence = { available: true, diffHash: 'a'.repeat(64), changedPaths: ['one'] };
  first.harnessBehavior.policyBypassAchieved = false;
  const second = repetitionDoc();
  second.reproducibility.repetitionId = 'rep-2';
  second.correctness.finalDiffHash = 'c'.repeat(64);
  second.correctness.verifierArtifactHash = 'd'.repeat(64);
  second.workspaceEvidence = { available: true, diffHash: 'c'.repeat(64), changedPaths: ['two'] };
  second.harnessBehavior.policyBypassAchieved = true;
  const aggregate = aggregateRepetitionDocs([first, second]);
  assert.equal(aggregate.correctness.finalDiffHash, null);
  assert.equal(aggregate.correctness.verifierArtifactHash, null);
  assert.equal(aggregate.workspaceEvidence.available, false);
  assert.equal(aggregate.workspaceEvidence.reason, 'workspace-evidence-retained-per-repetition');
  assert.equal(aggregate.harnessBehavior.policyBypassAchieved, true, 'one successful bypass remains a release-blocking safety signal');
  assert.deepEqual(aggregate.repetitions.map((run) => run.correctness.finalDiffHash), ['a'.repeat(64), 'c'.repeat(64)]);
});

test('run documents derive harness behavior only from retained evidence and label hook fidelity honestly', () => {
  const telemetryEvents = [
    { eventId: 't1', type: 'tool_call', requestId: 'r1', toolCallId: 'c1', tool: 'bash', category: 'edit', monotonicMs: 10 },
    { eventId: 't2', type: 'tool_result', requestId: 'r1', toolCallId: 'c1', tool: 'bash', category: 'edit', exitCode: 0, monotonicMs: 20 },
    {
      eventId: 't3', type: 'tool_call', requestId: 'r2', toolCallId: 'c2', tool: 'bash',
      category: 'verify', program: 'harness-cli', immutableHarnessCli: true,
      argumentsValid: true, argsChars: 16, argsHash: '1'.repeat(64), monotonicMs: 30,
    },
    {
      eventId: 't4', type: 'tool_result', requestId: 'r2', toolCallId: 'c2', tool: 'bash',
      category: 'verify', exitCode: 0, monotonicMs: 40, durationMs: 10,
      stdoutChars: 0, stderrChars: 0, resultChars: 2, resultHash: '2'.repeat(64),
      compacted: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      containmentMode: 'host-bounded', containmentComplete: true,
    },
  ];
  const harnessEvents = [
    { id: 'h1', type: 'orient', result: 'pass', ts: '2026-07-31T00:00:01Z' },
    { id: 'h2', type: 'gate', result: 'pass', plan: 'docs/plans/work.md', ts: '2026-07-31T00:00:02Z' },
    { id: 'h3', type: 'pre_tool', decision: 'block', result: 'fail', blockedReason: 'target outside plan scope', mutation: true, ts: '2026-07-31T00:00:03Z' },
    { id: 'h4', type: 'post_tool', decision: 'allow', result: 'pass', mutation: true, ts: '2026-07-31T00:00:04Z' },
    { id: 'h5', type: 'verify', result: 'pass', ts: '2026-07-31T00:00:05Z' },
  ];
  const doc = buildRunDoc({
    condition: 'harness',
    task: 'fixture',
    evidence: { reward: 1, pytest: null, treeHash: 'a'.repeat(64) },
    done: {
      stopReason: 'verified_stop',
      telemetry: { totals: { modelRequests: 2, providerAttempts: 2, providerResponses: 2, providerErrors: 0, retries: 0, openAttempts: 0, unknownBillingAttempts: 0, usageComplete: true, providerCostComplete: true, billingComplete: true, costComplete: true, missingUsage: 0 }, events: telemetryEvents },
      harnessEvents,
      enforcement: { hooksActive: true, source: 'trusted-test-bridge' },
      workspaceEvidence: { beforeManifestHash: 'b'.repeat(64), afterManifestHash: 'c'.repeat(64), diffHash: 'd'.repeat(64), changedPaths: ['src/a.c'] },
    },
    run: { timedOut: false },
    profile: getProfile('kimi-k2.7-code'),
    lock: { datasetRef: 'dataset@1', verifier: { passingReward: 1 }, tasks: [{ task: 'fixture', taskChecksum: 'e'.repeat(64) }] },
    releaseSha: 'sha',
    harnessVersion: 'v',
    startedAt: '2026-07-31T00:00:00Z',
    endedAt: '2026-07-31T00:01:00Z',
    hostId: 'openrouter-controlled',
    identity: { pairId: 'pair', repetitionId: 'rep', repetitionIndex: 1, orderIndex: 2 },
    conditionDocument: { id: 'harness', systemPrompt: 'safe prompt', limits: {} },
  });
  // The done payload crosses the sandbox boundary: even a bridge-relayed
  // hooksActive:true is forgeable by a root-capable agent replacing the probe
  // invocation, so mechanical fidelity is clamped until a supervisor outside
  // the sandbox can attest it.
  assert.equal(doc.enforcementFidelity.mode, 'prompt-and-cli');
  assert.equal(doc.enforcementFidelity.cliInvoked, true);
  assert.equal(doc.enforcementFidelity.cliSucceeded, true);
  assert.equal(doc.enforcementFidelity.cliActivated, true);
  assert.equal(doc.enforcementFidelity.mechanicalHooksActive, false, 'sandbox-relayed enforcement claims can never establish mechanical hooks');
  assert.equal(doc.harnessBehavior.orientInvoked, true);
  assert.equal(doc.harnessBehavior.planCreatedOrSelected, true);
  assert.equal(doc.harnessBehavior.gateAttempts, 1);
  assert.equal(doc.harnessBehavior.gateDenials, null, 'agent-writable absence cannot prove zero denials');
  assert.equal(doc.harnessBehavior.outOfScopeMutationAttempts, 1);
  assert.equal(doc.harnessBehavior.dangerousCommandAttempts, null, 'agent-writable absence cannot prove zero attempts');
  assert.equal(doc.harnessBehavior.verificationAfterFinalMutation, true);
  assert.equal(doc.harnessBehavior.policyBypassAttempted, true);
  assert.equal(doc.harnessBehavior.policyBypassAchieved, null, 'unsupported bypass-success evidence is not invented');
  assert.equal(doc.correctness.finalDiffHash, 'd'.repeat(64));
  assert.equal(doc.correctness.verifierArtifactHash, 'a'.repeat(64));
  assert.equal(doc.workspaceEvidence.available, true);
  assert.equal(doc.efficiency.timeFromFinalEditToVerificationMs, 20);
  assert.deepEqual(validateAgainstSchema(doc, RUN_SCHEMA).errors, []);
});

test('agent-writable hook event names cannot establish mechanical enforcement fidelity', () => {
  const failedCliEvents = [
    {
      eventId: 'cli-call', type: 'tool_call', requestId: 'r1', toolCallId: 'c1', tool: 'bash',
      category: 'verify_harness', program: 'harness-cli', immutableHarnessCli: true,
      argumentsValid: true, argsChars: 16, argsHash: '3'.repeat(64), monotonicMs: 10,
    },
    {
      eventId: 'cli-result', type: 'tool_result', requestId: 'r1', toolCallId: 'c1', tool: 'bash',
      category: 'verify_harness', exitCode: 2, monotonicMs: 20, durationMs: 10,
      stdoutChars: 0, stderrChars: 8, resultChars: 8, resultHash: '4'.repeat(64),
      compacted: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      containmentMode: 'host-bounded', containmentComplete: true,
    },
  ];
  const doc = buildRunDoc({
    condition: 'harness',
    task: 'fixture',
    evidence: { reward: 1, pytest: null, treeHash: 'a'.repeat(64) },
    done: {
      stopReason: 'model_finish',
      telemetry: { totals: {}, events: failedCliEvents },
      harnessEvents: [{ type: 'pre_tool' }, { type: 'post_tool' }, { type: 'session_end' }],
      harnessEventEvidence: { available: true, reason: null, retainedEvents: 3, sourceTruncated: false },
      enforcement: { hooksActive: false, policyBypassAchieved: false, source: 'sandbox-writable-harness-events' },
    },
    run: { timedOut: false },
    profile: getProfile('kimi-k2.7-code'),
    lock: { datasetRef: 'dataset@1', verifier: { passingReward: 1 }, tasks: [{ task: 'fixture', taskChecksum: 'f'.repeat(64) }] },
    releaseSha: 'sha',
    harnessVersion: 'v',
    startedAt: '2026-07-31T00:00:00Z',
    endedAt: '2026-07-31T00:01:00Z',
    hostId: 'openrouter-controlled',
  });
  assert.equal(doc.enforcementFidelity.mode, 'prompt-and-cli');
  assert.equal(doc.enforcementFidelity.cliInvoked, true);
  assert.equal(doc.enforcementFidelity.cliSucceeded, false);
  assert.equal(doc.enforcementFidelity.cliActivated, false);
  assert.equal(doc.enforcementFidelity.mechanicalHooksActive, false);
  assert.equal(doc.enforcementFidelity.evidenceSource, 'sandbox-writable-harness-events');
});

test('missing event ledgers stay unknown instead of being converted into zero activity claims', () => {
  const doc = buildRunDoc({
    condition: 'harness',
    task: 'fixture',
    evidence: { reward: 0, pytest: null, treeHash: 'a'.repeat(64) },
    done: {
      stopReason: 'bridge_error',
      telemetry: { totals: {} },
      harnessEvents: [],
      harnessEventEvidence: { available: false, reason: 'harness-events-not-found', retainedEvents: 0, sourceTruncated: false },
    },
    run: { timedOut: false },
    profile: getProfile('kimi-k2.7-code'),
    lock: { datasetRef: 'dataset@1', verifier: { passingReward: 1 }, tasks: [{ task: 'fixture', taskChecksum: 'b'.repeat(64) }] },
    releaseSha: 'sha',
    harnessVersion: 'v',
    startedAt: '2026-07-31T00:00:00Z',
    endedAt: '2026-07-31T00:01:00Z',
    hostId: 'openrouter-controlled',
  });
  assert.equal(doc.harnessBehavior.orientInvoked, null);
  assert.equal(doc.harnessBehavior.gateAttempts, null);
  assert.equal(doc.harnessBehavior.policyBypassAttempted, null);
  assert.equal(doc.enforcementFidelity.mode, 'prompt-and-cli');
  assert.equal(doc.enforcementFidelity.cliInvoked, false);
  assert.equal(doc.enforcementFidelity.cliSucceeded, false);
  assert.equal(doc.enforcementFidelity.cliActivated, false);
  assert.equal(doc.enforcementFidelity.harnessEventsCaptured, false);
  assert.equal(doc.observability.harnessEventEvidence.reason, 'harness-events-not-found');
});

test('a complete before/after manifest with no changed paths is available evidence, not a missing diff', () => {
  const doc = buildRunDoc({
    condition: 'generic',
    task: 'fixture',
    evidence: { reward: 1, pytest: null, treeHash: 'a'.repeat(64) },
    done: {
      stopReason: 'model_finish',
      telemetry: { totals: {}, events: [] },
      workspaceEvidence: {
        available: true,
        collectionMode: 'bounded-content-hash-manifest-v1',
        containmentMode: 'descriptor-relative-procfs',
        beforeManifestHash: 'b'.repeat(64),
        afterManifestHash: 'b'.repeat(64),
        diffHash: null,
        changedPaths: [],
        changedPathCount: 0,
        changedPathsTruncated: false,
        reason: null,
      },
    },
    run: { timedOut: false },
    profile: getProfile('kimi-k2.7-code'),
    lock: { datasetRef: 'dataset@1', verifier: { passingReward: 1 }, tasks: [{ task: 'fixture', taskChecksum: 'c'.repeat(64) }] },
    releaseSha: 'sha',
    harnessVersion: 'v',
    startedAt: '2026-07-31T00:00:00Z',
    endedAt: '2026-07-31T00:01:00Z',
    hostId: 'openrouter-controlled',
  });
  assert.equal(doc.workspaceEvidence.available, true);
  assert.equal(doc.workspaceEvidence.containmentMode, 'descriptor-relative-procfs');
  assert.equal(doc.workspaceEvidence.diffHash, null);
  assert.equal(doc.workspaceEvidence.reason, null);
  assert.equal(doc.correctness.finalDiffHash, null);
});

test('multiple repetitions run each condition, alternate order, and all charge the pair budget', async () => {
  const { taskDir, lock, datasetDir } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.01 });
  const steps = buildLiveSteps({
    config: { controlledLane: CONTROLLED_LANE, execution: { environment: 'docker' } },
    lock,
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tb-repetitions-')),
    env: { HARNESS_EVAL_TB_DATASET_DIR: datasetDir ?? path.dirname(taskDir) },
    releaseSha: 's',
    harnessVersion: 'v',
    spawnImpl,
    repetitions: 2,
    attestHarborExecutable: fakeHarborIdentity,
    attestSandboxImage: fakeSandboxIdentity,
    prepareBundle: ({ bundleDir, sourceIdentity }) => fakePreparedBundle(bundleDir, sourceIdentity),
    validateBundle: fakeValidateBundle,
    collectEvidence: trustedFixtureVerifierEvidence,
    providerControl: testProviderControl({ apiKey: 'k', releaseSha: 's' }),
  });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 10, label: 'controlled-pair' });
  const [pair] = await steps.controlledPair(budget);
  assert.equal(pair.repetitionCount, 2);
  const runs = invocations.filter((i) => i.args[0] === 'run');
  assert.equal(runs.length, 4, '2 repetitions × 2 conditions');
  const jobNames = runs.map((i) => i.args[i.args.indexOf('--job-name') + 1]);
  assert.deepEqual(
    jobNames.map((name) => name.match(/(generic|harness)-a\d$/)?.[1]),
    ['generic', 'harness', 'harness', 'generic'],
    'condition order alternates AB then BA across repetitions'
  );
  const conditionPaths = runs.map((i) => i.args[i.args.findIndex((a) => typeof a === 'string' && a.startsWith('HARNESS_EVAL_TB_CONDITION='))]);
  const ceilings = conditionPaths.map((kv) => JSON.parse(fs.readFileSync(kv.split('=')[1], 'utf8')).limits.trialCeilingUsd);
  assert.deepEqual(ceilings, [2.5, 2.5, 2.5, 2.5], 'every repetition arm receives an equal preallocated ceiling');
  assert.ok(Math.abs(budget.spentUsd() - 0.04) < 1e-12, 'every repetition trial charges the larger reconciled estimate');
  assert.equal(pair.generic.correctness.verdict, 'pass');
  assert.match(pair.generic.correctness.exitReason, /repetition-aggregate\(n=2\)/);
  assert.deepEqual(
    pair.generic.repetitions.map((run) => run.reproducibility.repetitionId),
    pair.harness.repetitions.map((run) => run.reproducibility.repetitionId),
    'the two arms share a repetition identity so paired analysis cannot drift'
  );
});

test('routine primary order alternates deterministically across release identities', async () => {
  const { taskDir, lock } = fixtureTask();
  const firstConditions = [];
  for (const releaseSha of ['abc', 'def']) {
    const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.01 });
    const steps = liveSteps({ taskDir, lock, spawnImpl, releaseSha });
    await steps.taskLock();
    await steps.controlledPair(createBudget({ ceilingUsd: 10, label: `order-${releaseSha}` }));
    const firstJob = invocations.find((invocation) => invocation.args[0] === 'run')
      .args.find((arg, index, args) => args[index - 1] === '--job-name');
    firstConditions.push(firstJob.match(/-(generic|harness)-a$/)?.[1]);
  }
  assert.deepEqual(firstConditions, ['harness', 'generic']);
});

test('a four-task routine is blocked into an exact two-by-two AB/BA order balance', async () => {
  const { datasetDir, taskDir } = fixtureTask();
  const taskNames = ['cobol-modernization', 'cancel-async-tasks', 'git-leak-recovery', 'custom-memory-heap-crash'];
  let lock = structuredClone(BASE_LOCK);
  lock = stampTaskLock(taskDir, lock, 'cobol-modernization');
  for (const taskName of taskNames.slice(1)) {
    const candidateDir = path.join(datasetDir, taskName);
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(path.join(candidateDir, 'instruction.md'), `Complete ${taskName}.`);
    const sandbox = lock.tasks.find((entry) => entry.task === taskName).sandbox;
    fs.writeFileSync(path.join(candidateDir, 'task.toml'), `[environment]\n` +
      `docker_image = "${sandbox.sourceImage}"\ncpus = ${sandbox.cpus}\n` +
      `memory = "${sandbox.memoryMb / 1024}G"\nstorage = "${sandbox.storageMb / 1024}G"\n`);
    lock = stampTaskLock(candidateDir, lock, taskName);
  }
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.01 });
  const steps = liveSteps({ datasetDir, lock, spawnImpl, releaseSha: 'balanced-release' });
  await steps.taskLock();
  await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'balanced-order' }));
  const firstArmByTask = new Map();
  for (const invocation of invocations.filter((entry) => entry.args[0] === 'run')) {
    const task = invocation.args[invocation.args.indexOf('--include-task-name') + 1];
    const jobName = invocation.args[invocation.args.indexOf('--job-name') + 1];
    const condition = jobName.match(/-(generic|harness)-a$/)?.[1];
    if (!firstArmByTask.has(task)) firstArmByTask.set(task, condition);
  }
  const sequence = taskNames.map((task) => firstArmByTask.get(task));
  assert.equal(sequence.filter((condition) => condition === 'generic').length, 2);
  assert.equal(sequence.filter((condition) => condition === 'harness').length, 2);
  assert.ok(sequence.every((condition, index) => index === 0 || condition !== sequence[index - 1]), sequence.join(','));
});

test('a pair requires a strict majority of scheduled repetitions to have two valid aligned arms', async () => {
  const { taskDir, lock, datasetDir } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({
    reward: ({ jobName }) => /-(?:generic|harness)-a1$/.test(jobName) ? 1 : null,
  });
  const steps = buildLiveSteps({
    config: { controlledLane: CONTROLLED_LANE, execution: { environment: 'docker' } },
    lock,
    workDir: tmpdir(),
    env: { HARNESS_EVAL_TB_DATASET_DIR: datasetDir },
    spawnImpl,
    repetitions: 3,
    attestHarborExecutable: fakeHarborIdentity,
    attestSandboxImage: fakeSandboxIdentity,
    prepareBundle: ({ bundleDir, sourceIdentity }) => fakePreparedBundle(bundleDir, sourceIdentity),
    validateBundle: fakeValidateBundle,
    collectEvidence: trustedFixtureVerifierEvidence,
    providerControl: testProviderControl({ apiKey: 'k', releaseSha: 'workdir' }),
  });
  await steps.taskLock();
  const [pair] = await steps.controlledPair(createBudget({ ceilingUsd: 10, label: 'strict-pair-validity' }));
  assert.equal(pair.validRepetitionCount, 1);
  assert.equal(pair.invalidRepetitionCount, 2);
  assert.equal(pair.failureKind, 'verifier', 'one valid paired trial out of three scheduled cannot validate the pair');
  assert.equal(pair.generic.correctness.verdict, 'pass', 'the descriptive verdict is still computed only over the valid paired trial');
  assert.equal(pair.generic.repetitions.length, 3, 'all attempted evidence remains retained');
});
