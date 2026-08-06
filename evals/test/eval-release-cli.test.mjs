import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stampTaskLock } from '../external/terminal_bench/harbor-adapter.mjs';
import {
  HARNESS_PACKAGE_ARCHIVE,
  prepareHarnessBundle,
} from '../external/terminal_bench/provision.mjs';

/**
 * Process-level coverage for parsing, Git/source integrity, deterministic
 * execution, and red-trust diagnostics. Armed runtime construction is tested
 * through runReleaseCli's injected artifact/runtime seam in eval-release.test;
 * this suite never rewrites a trust boundary or installs a raw-key backdoor.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_LOCK = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'task-lock.json'), 'utf8'));
const SENTINEL_PROVIDER_KEY = 'sentinel-openrouter-secret-do-not-persist';
const harnessVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'harness', 'package.json'), 'utf8')).version;
const YAML = createRequire(import.meta.url)('yaml');
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tmpdir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-'));
  temporaryRoots.add(root);
  return root;
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

function fixtureGit(sourceRoot, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key];
  }
  const result = spawnSync('git', args, { cwd: sourceRoot, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function commitFixtureMutation(sourceRoot, message) {
  fixtureGit(sourceRoot, ['add', '-A']);
  fixtureGit(sourceRoot, ['-c', 'user.name=Eval Test', '-c', 'user.email=eval-test@example.invalid', 'commit', '-m', message]);
}

function cleanGitView(taskLock, { attestTrust = false } = {}) {
  const sourceRoot = tmpdir();
  fs.cpSync(repoRoot, sourceRoot, {
    recursive: true,
    filter: (source) => path.resolve(source) !== path.join(repoRoot, '.git'),
  });
  fs.writeFileSync(
    path.join(sourceRoot, 'evals', 'external', 'terminal_bench', 'task-lock.json'),
    `${JSON.stringify(taskLock, null, 2)}\n`
  );
  const profilePath = path.join(sourceRoot, 'evals', 'config', 'release-canary.yaml');
  const profile = YAML.parse(fs.readFileSync(profilePath, 'utf8'));
  if (attestTrust) {
    profile.releaseTrust.status = 'attested';
    for (const capability of Object.keys(profile.releaseTrust.capabilities)) {
      profile.releaseTrust.capabilities[capability] = true;
    }
    profile.claimPolicy.minimumHarnessSolvedTasks = 1;
  }
  fs.writeFileSync(profilePath, YAML.stringify(profile));
  fixtureGit(sourceRoot, ['init']);
  commitFixtureMutation(sourceRoot, 'clean eval source snapshot');
  const releaseSha = fixtureGit(sourceRoot, ['rev-parse', '--verify', 'HEAD']);
  assert.match(releaseSha, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  assert.equal(fixtureGit(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  return { sourceRoot, releaseSha };
}

function snapshotFixtureSource({ repoRoot: sourceRoot, destination }) {
  fs.mkdirSync(path.join(destination, '.github', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(destination, '.github', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRoot, '.github', 'agents', 'engineer.agent.md'),
    path.join(destination, '.github', 'agents', 'engineer.agent.md')
  );
  fs.cpSync(
    path.join(sourceRoot, '.github', 'skills', 'ensure-plan'),
    path.join(destination, '.github', 'skills', 'ensure-plan'),
    { recursive: true }
  );
  fs.cpSync(path.join(sourceRoot, 'packages', 'harness'), path.join(destination, 'packages', 'harness'), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRoot, 'scripts', 'harness-asset-contract.mjs'),
    path.join(destination, 'scripts', 'harness-asset-contract.mjs'),
  );
  fs.copyFileSync(
    path.join(sourceRoot, 'scripts', 'build-harness-assets.mjs'),
    path.join(destination, 'scripts', 'build-harness-assets.mjs'),
  );
  fs.copyFileSync(path.join(sourceRoot, 'evals', '__init__.py'), path.join(destination, 'evals', '__init__.py'));
  for (const directory of ['config', 'hosts', 'lib', 'runtime']) {
    fs.cpSync(path.join(sourceRoot, 'evals', directory), path.join(destination, 'evals', directory), { recursive: true });
  }
  fs.copyFileSync(path.join(sourceRoot, 'evals', 'external', '__init__.py'), path.join(destination, 'evals', 'external', '__init__.py'));
  for (const file of ['__init__.py', 'agent.mjs', 'harbor_agent.py', 'evidence-probe.mjs', 'bounded-exec.mjs']) {
    fs.copyFileSync(
      path.join(sourceRoot, 'evals', 'external', 'terminal_bench', file),
      path.join(destination, 'evals', 'external', 'terminal_bench', file)
    );
  }
}

function setupFixture({
  taskNames = ['cobol-modernization'],
  attestTrust = true,
  genericVerifierReward = 1,
  trialCostUsd = 0.02,
  providerLimitUsd = 10,
} = {}) {
  const datasetDir = tmpdir();
  for (const taskName of taskNames) {
    const taskDir = path.join(datasetDir, taskName);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'instruction.md'), `Complete ${taskName}.`);
    const sandbox = BASE_LOCK.tasks.find((entry) => entry.task === taskName)?.sandbox;
    assert.ok(sandbox, `BASE_LOCK must define sandbox identity for fixture task ${taskName}`);
    fs.writeFileSync(path.join(taskDir, 'task.toml'), `[environment]\n` +
      `docker_image = "${sandbox.sourceImage}"\ncpus = ${sandbox.cpus}\n` +
      `memory = "${sandbox.memoryMb / 1024}G"\nstorage = "${sandbox.storageMb / 1024}G"\n`);
  }
  const lockFile = path.join(tmpdir(), 'lock.json');
  let selectedLock = { ...BASE_LOCK, tasks: BASE_LOCK.tasks.filter((entry) => taskNames.includes(entry.task)) };
  for (const taskName of taskNames) {
    selectedLock = stampTaskLock(path.join(datasetDir, taskName), selectedLock, taskName);
  }
  fs.writeFileSync(lockFile, JSON.stringify(selectedLock));
  const { sourceRoot, releaseSha } = cleanGitView(selectedLock, { attestTrust });

  const binDir = tmpdir();
  const auditFile = path.join(binDir, 'harbor-audit.jsonl');
  const fakeHarbor = path.join(binDir, 'fake-harbor.mjs');
  fs.writeFileSync(
    fakeHarbor,
    `
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeBridgeTools } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'agent.mjs')).href)};
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.20.0'); process.exit(0); }
if (args[0] !== 'run') process.exit(0);
const jobsDir = args[args.indexOf('--jobs-dir') + 1];
const jobName = args[args.indexOf('--job-name') + 1];
const agentEnv = {};
args.forEach((a, i) => { if (a === '--ae') { const [k, ...r] = args[i + 1].split('='); agentEnv[k] = r.join('='); } });
const providerKey = process.env.OPENROUTER_API_KEY;
const githubTokenPresent = Object.hasOwn(process.env, 'GITHUB_TOKEN');
const secretInArgv = Boolean(providerKey && args.some((arg) => arg.includes(providerKey)));
const providerKeyInAgentEnv = Object.hasOwn(agentEnv, 'OPENROUTER_API_KEY');
fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({
  providerKeyPresent: Boolean(providerKey),
  githubTokenPresent,
  secretInArgv,
  providerKeyInAgentEnv,
  conditionPath: agentEnv.HARNESS_EVAL_TB_CONDITION,
  telemetryFile: agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE,
  jobName,
  jobsDir,
}) + '\\n');
if (!providerKey || secretInArgv || providerKeyInAgentEnv) {
  console.error('unsafe provider credential delivery');
  process.exit(86);
}
const condition = JSON.parse(fs.readFileSync(agentEnv.HARNESS_EVAL_TB_CONDITION, 'utf8'));
const verifierReward = condition.id === 'generic' ? ${JSON.stringify(genericVerifierReward)} : 1;
const verifierDir = path.join(jobsDir, jobName, 'trial__fx0', 'verifier');
fs.mkdirSync(verifierDir, { recursive: true });
fs.writeFileSync(path.join(verifierDir, 'reward.json'), JSON.stringify({ reward: verifierReward }));
fs.writeFileSync(
  path.join(path.dirname(verifierDir), 'result.json'),
  JSON.stringify({ verifier_result: { rewards: { reward: verifierReward } } })
);
const runtimeConfig = condition.runtime ?? {};
const tools = runtimeBridgeTools({
  guidanceCatalog: runtimeConfig.guidanceCatalog ?? condition.guidanceCatalog ?? null,
  enableCheckpoint: runtimeConfig.checkpoint === true,
  enableTrustedVerify: runtimeConfig.trustedVerify === true,
});
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const providerTools = tools.map((tool) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}));
const requestContract = {
  toolSchemaHash: digest(JSON.stringify(providerTools)),
  toolCount: providerTools.length,
  toolMode: 'full',
  postVerify: false,
};
const requestControls = {
  endpointHash: digest(condition.providerUrl),
  model: 'moonshotai/kimi-k2.7-code',
  maxTokens: condition.limits.maxOutputTokens,
  temperaturePresent: false,
  temperature: null,
  reasoningPresent: false,
  reasoning: null,
  toolChoice: 'auto',
  providerPresent: true,
  providerOrder: ['moonshotai/int4'],
  providerAllowFallbacks: false,
  unexpectedRequestFields: [],
};
Object.assign(requestContract, requestControls, {
  requestBodyHash: '9'.repeat(64),
  requestControlHash: digest(JSON.stringify(requestControls)),
});
const instruction = fs.readFileSync(
  path.join(args[args.indexOf('-p') + 1], args[args.indexOf('--include-task-name') + 1], 'instruction.md'),
  'utf8'
);
const systemMessageChars = JSON.stringify({ role: 'system', content: condition.systemPrompt }).length;
const instructionMessageChars = JSON.stringify({ role: 'user', content: instruction }).length;
const messageEnvelopeChars = JSON.stringify([
  { role: 'system', content: condition.systemPrompt },
  { role: 'user', content: instruction },
]).length - systemMessageChars - instructionMessageChars;
const toolSchemaChars = JSON.stringify(providerTools).length;
const payloadEnvelopeChars = 200;
const payloadChars = systemMessageChars + instructionMessageChars + messageEnvelopeChars + toolSchemaChars + payloadEnvelopeChars;
const cliEvents = condition.id === 'harness' ? [
  {
    eventId: 'cli-call', type: 'tool_call', requestId: 'r4', toolCallId: 'cli-1',
    tool: 'bash', category: 'verify_harness', program: 'harness-cli', immutableHarnessCli: true,
    argumentsValid: true, argsChars: 16, argsHash: '1'.repeat(64), monotonicMs: 100,
  },
  {
    eventId: 'cli-result', type: 'tool_result', requestId: 'r4', toolCallId: 'cli-1',
    tool: 'bash', category: 'verify_harness', exitCode: 0, monotonicMs: 110, durationMs: 10,
    stdoutChars: 0, stderrChars: 0, resultChars: 2, resultHash: '2'.repeat(64),
    compacted: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
    containmentMode: 'host-bounded', containmentComplete: true,
  },
] : [];
const trialCostUsd = ${JSON.stringify(trialCostUsd)};
const responseProviderCostUsd = trialCostUsd / 4;
const responseLocalCostUsd = 0.0013175;
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
fs.writeFileSync(agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE, JSON.stringify({
  type: 'done', answer: 'ok', stopReason: 'model_finish', steps: 6,
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
  harnessEventEvidence: { available: true, complete: true, reason: null, retainedEvents: 0, sourceTruncated: false, projectionRejectedEvents: 0, projectionRejectedChecks: 0 },
  enforcement: { hooksActive: false, policyBypassAchieved: false },
  telemetry: {
    totals: { requests: 4, modelRequests: 4, providerAttempts: 4, providerResponses: 4, providerErrors: 0, retries: 0, openAttempts: 0, unknownBillingAttempts: 0, missingUsage: 0, promptTokens: 3000, cachedTokens: 500, reasoningTokens: 0, cachedTokensComplete: true, reasoningTokensComplete: true, outputTokens: 700, localCostUsd: responseLocalCostUsd * 4, providerCostUsd: trialCostUsd, reconciledCostUsd: trialCostUsd, usageComplete: true, providerCostComplete: true, billingComplete: true, costComplete: true },
    events: [...Array.from({ length: 4 }, (_, index) => [
      { seq: index * 3, type: 'request', requestId: 'r' + (index + 1), ...requestContract },
      { seq: index * 3 + 1, type: 'request_attempt', requestId: 'r' + (index + 1), attemptId: 'a' + (index + 1) },
      { seq: index * 3 + 2, type: 'response', requestId: 'r' + (index + 1), attemptId: 'a' + (index + 1), model: 'moonshotai/kimi-k2.7-code-20260612', provider: 'Moonshot AI', generationId: 'g' + (index + 1), billingStatus: 'reported', usage: { promptTokens: 750, cachedTokens: 125, cachedTokensComplete: true, reasoningTokens: 0, reasoningTokensComplete: true, outputTokens: 175, localCostUsd: responseLocalCostUsd, providerCostUsd: responseProviderCostUsd, reconciledCostUsd: responseProviderCostUsd } },
    ]).flat(), ...cliEvents],
  },
}));
process.exit(0);
`
  );
  const harborBin = path.join(binDir, 'harbor');
  fs.writeFileSync(harborBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeHarbor)} "$@"\n`, { mode: 0o755 });
  const harborSha256 = crypto.createHash('sha256').update(fs.readFileSync(harborBin)).digest('hex');
  const fakeDocker = path.join(binDir, 'fake-docker.mjs');
  const imageMap = Object.fromEntries(selectedLock.tasks.map((entry) => [entry.sandbox.immutableImage, {
    Id: entry.sandbox.imageId,
    Os: entry.sandbox.platform.split('/')[0],
    Architecture: entry.sandbox.platform.split('/')[1],
    RepoDigests: [entry.sandbox.immutableImage],
  }]));
  fs.writeFileSync(fakeDocker, `
const args = process.argv.slice(2);
const images = ${JSON.stringify(imageMap)};
if (args[0] !== 'image' || args[1] !== 'inspect' || !images[args[2]]) process.exit(3);
process.stdout.write(JSON.stringify([images[args[2]]]));
`);
  const dockerBin = path.join(binDir, 'docker-fixture');
  fs.writeFileSync(dockerBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeDocker)} "$@"\n`, { mode: 0o755 });
  const dockerSha256 = crypto.createHash('sha256').update(fs.readFileSync(dockerBin)).digest('hex');
  const fetchPreload = path.join(binDir, 'provider-key-fetch-preload.mjs');
  fs.writeFileSync(
    fetchPreload,
    `globalThis.fetch = async (url) => {
      if (String(url) !== 'https://openrouter.ai/api/v1/key') throw new Error('unexpected network request');
      const remaining = Number(process.env.HARNESS_TEST_PROVIDER_LIMIT_REMAINING_USD ?? ${JSON.stringify(providerLimitUsd)});
      return { ok: true, status: 200, json: async () => ({ data: { limit: ${JSON.stringify(providerLimitUsd)}, limit_remaining: remaining, limit_reset: null } }) };
    };\n`
  );
  const bundleFixtureRoot = tmpdir();
  fs.mkdirSync(path.join(bundleFixtureRoot, '.github', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(bundleFixtureRoot, '.github', 'skills', 'ensure-plan'), { recursive: true });
  fs.mkdirSync(path.join(bundleFixtureRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'assets', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'assets', 'skills', 'engineer'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'evals'), path.join(bundleFixtureRoot, 'evals'), { recursive: true });
  for (const file of ['harness-asset-contract.mjs', 'build-harness-assets.mjs']) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', file), path.join(bundleFixtureRoot, 'scripts', file));
  }
  fs.writeFileSync(
    path.join(bundleFixtureRoot, 'packages', 'harness', 'package.json'),
    `${JSON.stringify({ name: '@dev-kit/harness', version: harnessVersion, files: ['bin', 'assets'] })}\n`
  );
  fs.writeFileSync(
    path.join(bundleFixtureRoot, 'packages', 'harness', 'package-lock.json'),
    `${JSON.stringify({
      name: '@dev-kit/harness',
      version: harnessVersion,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: '@dev-kit/harness', version: harnessVersion } },
    })}\n`
  );
  fs.writeFileSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'bin', 'harness.mjs'), 'process.stdout.write("ok\\n")');
  fs.writeFileSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'assets', 'harness-version.txt'), `${harnessVersion}\n`);
  fs.writeFileSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'assets', 'agents', 'engineer.agent.md'), '# Engineer\n');
  fs.writeFileSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'assets', 'skills', 'engineer', 'SKILL.md'), '# Engineer skill\n');
  fs.writeFileSync(
    path.join(bundleFixtureRoot, '.github', 'agents', 'engineer.agent.md'),
    '---\nname: engineer\n---\n# Fixture Engineer\nFollow the verified delivery contract.\n'
  );
  fs.writeFileSync(
    path.join(bundleFixtureRoot, '.github', 'skills', 'ensure-plan', 'SKILL.md'),
    '---\ndescription: Fixture planning guidance\n---\n# Ensure Plan\nRetain a bounded plan.\n'
  );
  fs.writeFileSync(path.join(bundleFixtureRoot, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'), 'process.stdout.write("{}\\n")');
  fs.writeFileSync(path.join(bundleFixtureRoot, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'), 'process.stdout.write("{}\\n")');
  const nodeTarball = path.join(bundleFixtureRoot, 'node-v-test-linux-x64.tar.gz');
  fs.writeFileSync(nodeTarball, 'pinned fixture archive bytes');
  const bundleDir = path.join(tmpdir(), 'bundle');
  const prepared = prepareHarnessBundle({
    bundleDir,
    repoRoot: bundleFixtureRoot,
    sourceIdentity: { releaseSha, harnessVersion },
    nodeTarballs: { x64: nodeTarball, arm64: null },
    nodeTarballHashes: { x64: crypto.createHash('sha256').update(fs.readFileSync(nodeTarball)).digest('hex'), arm64: null },
    snapshotSource: snapshotFixtureSource,
    spawnImpl: (command, args, options) => {
      if (command === 'node') return { status: 0, stdout: '', stderr: '' };
      if (command === 'npm') return spawnSync(command, args, { ...options, encoding: 'utf8' });
      if (command === 'tar') {
        if (args[0] === '-xzf' && args[1].endsWith(HARNESS_PACKAGE_ARCHIVE)) {
          return spawnSync(command, args, { ...options, encoding: 'utf8' });
        }
        const destination = args[args.indexOf('-C') + 1];
        fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(destination, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  return { datasetDir, lockFile, binDir, harborBin, harborSha256, dockerBin, dockerSha256, bundleDir, bundleHash: prepared.manifestHash, auditFile, fetchPreload, sourceRoot, releaseSha };
}

function runCli({ datasetDir, lockFile, binDir, harborBin, harborSha256, dockerBin, dockerSha256, bundleDir, bundleHash, auditFile, fetchPreload, sourceRoot, withKey = true, task = null, omitTaskValue = false, releaseSha = null, dirtySource = false, useExternalLock = false, omitLockValue = false, profile = 'release-canary', reportFile = null, ambientGitEnv = null, ambientEvalEnv = null, deterministicOnly = false, calibration = false, qualification = false, budgetUsd = null, qualificationBaseline = null, calibrationBaseline = null, omitQualificationBaselineValue = false, omitCalibrationBaselineValue = false, providerLimitRemainingUsd = null }) {
  if (dirtySource) {
    fs.appendFileSync(path.join(sourceRoot, 'evals', 'release.mjs'), '\n// dirty fixture source\n');
  }
  const env = {
    ...process.env,
    ...(ambientGitEnv ?? {}),
    ...(ambientEvalEnv ?? {}),
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    HARNESS_EVAL_TB_DATASET_DIR: datasetDir,
    HARNESS_EVAL_TB_BUNDLE_DIR: bundleDir,
    HARNESS_EVAL_TB_BUNDLE_SHA256: bundleHash,
    HARNESS_EVAL_HARBOR_BIN: harborBin,
    HARNESS_EVAL_HARBOR_SHA256: harborSha256,
    HARNESS_EVAL_DOCKER_BIN: dockerBin,
    HARNESS_EVAL_DOCKER_SHA256: dockerSha256,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${fetchPreload}`.trim(),
    GITHUB_TOKEN: 'sentinel-unrelated-ci-token',
  };
  if (providerLimitRemainingUsd !== null) {
    env.HARNESS_TEST_PROVIDER_LIMIT_REMAINING_USD = String(providerLimitRemainingUsd);
  } else {
    delete env.HARNESS_TEST_PROVIDER_LIMIT_REMAINING_USD;
  }
  if (withKey) env.OPENROUTER_API_KEY = SENTINEL_PROVIDER_KEY;
  else delete env.OPENROUTER_API_KEY;
  const args = ['evals/release.mjs', '--profile', profile, '--json'];
  if (deterministicOnly) args.push('--deterministic-only');
  if (calibration) args.push('--calibration', '--budget-usd', budgetUsd ?? '18.7');
  if (qualification) args.push('--qualification');
  if (omitQualificationBaselineValue) args.push('--qualification-baseline');
  else if (qualificationBaseline !== null) args.push('--qualification-baseline', qualificationBaseline);
  if (omitCalibrationBaselineValue) args.push('--calibration-baseline');
  else if (calibrationBaseline !== null) args.push('--calibration-baseline', calibrationBaseline);
  if (!calibration && budgetUsd !== null) args.push('--budget-usd', String(budgetUsd));
  if (useExternalLock) {
    args.push('--lock-file');
    if (!omitLockValue) args.push(lockFile);
  }
  if (releaseSha !== null) args.push('--release-sha', releaseSha);
  if (reportFile !== null) args.push('--report-file', reportFile);
  if (omitTaskValue) args.push('--task');
  else if (task !== null) args.push('--task', task);
  return spawnSync(process.execPath, args, {
    cwd: sourceRoot,
    env,
    encoding: 'utf8',
    timeout: 600_000,
  });
}

test('configured trust intent arms only the code-owned one-FD runtime path', () => {
  const fixture = setupFixture({ attestTrust: true });
  const result = runCli(fixture);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes(SENTINEL_PROVIDER_KEY), 'CLI output and errors must not echo the provider key');
  assert.match(result.stderr, /exactly one --provider-key-fd/i);
  assert.equal(fs.existsSync(fixture.auditFile), false, 'runtime construction stays untouched without inherited FD custody');
});

test('qualification applies a lower operator budget instead of restoring the profile maximum', () => {
  const fixture = setupFixture({ attestTrust: false });
  const result = runCli({ ...fixture, qualification: true, budgetUsd: 0.9 });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.evaluationScope.mode, 'qualification');
  assert.equal(report.budget.ceilingUsd, 0.9);
  assert.equal(report.budget.allocations.controlledPairUsd, 0.9);
  assert.equal(fs.existsSync(fixture.auditFile), false, 'runtime trust still withholds Harbor and provider spend');
});

test('qualification and calibration CLI state transitions fail closed before provider execution', () => {
  const cases = [
    {
      selection: { qualification: true, calibration: true },
      message: /qualification and --calibration are mutually exclusive/i,
    },
    {
      selection: { calibration: true },
      message: /calibration requires --qualification-baseline/i,
    },
    {
      selection: { qualification: true, task: 'cobol-modernization' },
      message: /qualification.*cannot be combined with --task/i,
    },
    {
      selection: { omitQualificationBaselineValue: true },
      message: /qualification-baseline requires a nonempty report path/i,
    },
    {
      selection: { omitCalibrationBaselineValue: true },
      message: /calibration-baseline requires a nonempty report path/i,
    },
  ];
  for (const { selection, message } of cases) {
    const fixture = setupFixture({ attestTrust: false });
    const result = runCli({ ...fixture, ...selection });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, message);
    assert.equal(fs.existsSync(fixture.auditFile), false);
  }
});

test('CLI phase boundaries and private artifact transitions remain fail-closed and zero-spend under red trust', () => {
  const fixture = setupFixture({ attestTrust: false });
  const reportFile = path.join(tmpdir(), 'red-trust-report.json');
  const archived = runCli({ ...fixture, qualification: true, budgetUsd: 1.3, reportFile });
  assert.equal(archived.status, 1, archived.stderr || archived.stdout);
  assert.equal(fs.existsSync(reportFile), true, 'a red diagnostic may retain one private report');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.evaluationScope.mode, 'qualification');
  assert.equal(report.evaluationScope.trust.ok, false);
  assert.equal(report.budget.ceilingUsd, 1.3);
  assert.equal(report.budget.spentUsd, 0);
  assert.equal(Object.hasOwn(report, 'treatmentArtifact'), false,
    'a withheld paid run cannot synthesize exact treatment evidence');
  assert.equal(fs.statSync(reportFile).mode & 0o077, 0, 'the diagnostic archive remains private');
  assert.equal(fs.existsSync(fixture.auditFile), false, 'red trust never invokes Harbor');

  const rejected = [
    { name: 'qualification $1.31', selection: { qualification: true, budgetUsd: 1.31 }, ceiling: 1.3 },
    {
      name: 'calibration $18.71',
      selection: { calibration: true, budgetUsd: 18.71 },
      ceiling: 18.7,
    },
    {
      name: 'routine $10.01',
      selection: { profile: 'release-routine', budgetUsd: 10.01 },
      ceiling: 10,
    },
  ];
  for (const { name, selection, ceiling } of rejected) {
    const result = runCli({ ...fixture, ...selection });
    assert.equal(result.status, 2, `${name}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, new RegExp(`exceeds the \\$${ceiling} ceiling`, 'i'), name);
    assert.equal(fs.existsSync(fixture.auditFile), false, `${name} must fail before Harbor`);
  }
});

test('qualification mode cannot consume a prior qualification artifact', () => {
  const fixture = setupFixture({ attestTrust: false });
  const evidence = path.join(tmpdir(), 'qualification.json');
  fs.writeFileSync(evidence, '{}\n', { mode: 0o600 });
  const result = runCli({ ...fixture, qualification: true, qualificationBaseline: evidence });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /qualification cannot consume an earlier qualification baseline/i);
  assert.equal(fs.existsSync(fixture.auditFile), false);
});

test('the committed red trust gate blocks provider execution while deterministic-only remains free', () => {
  const fixture = setupFixture({ attestTrust: false });
  const blocked = runCli(fixture);
  assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
  const report = JSON.parse(blocked.stdout);
  assert.equal(report.evaluationScope.mode, 'diagnostic-trust');
  assert.equal(report.evaluationScope.releaseEligible, false);
  assert.equal(report.evaluationScope.trust.ok, false);
  assert.equal(report.preflight.environment.ok, false);
  assert.equal(report.budget.spentUsd, 0);
  assert.equal(fs.existsSync(fixture.auditFile), false, 'Harbor/provider execution is withheld before trust closure');

  const deterministic = runCli({
    ...fixture,
    deterministicOnly: true,
    ambientEvalEnv: {
      HARNESS_EVAL_AGENT: 'openai',
      HARNESS_EVAL_AGENT_URL: 'https://must-not-be-called.invalid/v1/chat/completions',
      HARNESS_EVAL_AGENT_MODEL: 'sentinel-paid-model',
      HARNESS_EVAL_AGENT_KEY: 'sentinel-agent-key',
      HARNESS_EVAL_JUDGE_KEY: 'sentinel-judge-key',
      ANTHROPIC_API_KEY: 'sentinel-anthropic-key',
    },
  });
  assert.equal(deterministic.status, 0, deterministic.stderr || deterministic.stdout);
  const deterministicReport = JSON.parse(deterministic.stdout);
  assert.equal(deterministicReport.evaluationScope.mode, 'deterministic-only');
  assert.equal(deterministicReport.preflight.ok, true);
  assert.equal(deterministicReport.budget.spentUsd, 0);
});

test('an explicit task lock is diagnostic-only and cannot green the release', () => {
  const fixture = setupFixture({ attestTrust: false });
  const result = runCli({ ...fixture, useExternalLock: true });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual({
    mode: report.evaluationScope.mode,
    releaseEligible: report.evaluationScope.releaseEligible,
    selectedTasks: report.evaluationScope.selectedTasks,
    requiredTasks: report.evaluationScope.requiredTasks,
  }, {
    mode: 'diagnostic-lock',
    releaseEligible: false,
    selectedTasks: ['cobol-modernization'],
    requiredTasks: ['cobol-modernization'],
  });
  assert.equal(report.claim.level, 'inconclusive');
  assert.equal(report.gate.block, true);
  assert.ok(report.gate.reasons.some((reason) => /task-lock diagnostic.*not eligible/i.test(reason)));
  assert.equal(fs.existsSync(fixture.auditFile), false, 'the diagnostic scope does not bypass the independent runtime trust gate');
});

test('--lock-file requires a value and cannot silently fall back to the release lock', () => {
  const fixture = setupFixture();
  const result = runCli({ ...fixture, useExternalLock: true, omitLockValue: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--lock-file.*nonempty.*path/i);
  assert.equal(fs.existsSync(fixture.auditFile), false);
});

test('a malformed task lock fails with an explicit bounded JSON diagnostic', () => {
  const fixture = setupFixture();
  fs.writeFileSync(fixture.lockFile, '{not-json');
  const result = runCli({ ...fixture, useExternalLock: true, deterministicOnly: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /task lock is not valid JSON/i);
  assert.doesNotMatch(result.stderr, /Unexpected token|position [0-9]+/i);
  assert.equal(fs.existsSync(fixture.auditFile), false);
});

test('--report-file rejects repository destinations before evaluation', () => {
  const fixture = setupFixture();
  const result = runCli({ ...fixture, reportFile: path.join(fixture.sourceRoot, 'eval-report.json') });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /report-file.*outside.*source repository/i);
  assert.equal(fs.existsSync(fixture.auditFile), false);
  assert.equal(fs.existsSync(path.join(fixture.sourceRoot, 'eval-report.json')), false);
});

test('--calibration rejects the post-calibration routine profile before Harbor execution', () => {
  const fixture = setupFixture();
  const result = runCli({ ...fixture, profile: 'release-routine', calibration: true });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /calibration requires an initial-user-ship profile/i);
  assert.equal(fs.existsSync(fixture.auditFile), false);
});

test('release git identity ignores ambient GIT_DIR and GIT_WORK_TREE injection', () => {
  const fixture = setupFixture({ attestTrust: false });
  const result = runCli({
    ...fixture,
    withKey: false,
    ambientGitEnv: {
      GIT_DIR: path.join(tmpdir(), 'attacker-controlled.git'),
      GIT_WORK_TREE: tmpdir(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: tmpdir(),
    },
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.releaseSha, fixture.releaseSha, 'identity comes from the checkout containing release.mjs');
  assert.ok(report.gate.reasons.some((reason) => /dependencies or credentials/i.test(reason)));
});

test('missing code-owned git metadata produces the explicit invalid-checkout diagnostic', () => {
  const fixture = setupFixture();
  fs.rmSync(path.join(fixture.sourceRoot, '.git'), { recursive: true, force: true });
  const result = runCli({ ...fixture, deterministicOnly: true, releaseSha: null });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /code-owned checkout has no git metadata/i);
  assert.doesNotMatch(result.stderr, /ENOENT|lstat/i);
  assert.equal(fs.existsSync(fixture.auditFile), false);
});

test('--profile rejects traversal before reading an out-of-tree configuration', () => {
  const fixture = setupFixture();
  const result = runCli({ ...fixture, profile: '../external/terminal_bench/task-lock' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--profile.*safe.*basename/i);
  assert.equal(fs.existsSync(fixture.auditFile), false, 'Harbor must not run for an invalid profile path');
});

test('a live profile must be tracked and byte-identical to HEAD even when git ignores it', () => {
  const fixture = setupFixture();
  const ignoredProfile = path.join(fixture.sourceRoot, 'evals', 'config', 'ignored-profile.yaml');
  fs.copyFileSync(path.join(fixture.sourceRoot, 'evals', 'config', 'release-canary.yaml'), ignoredProfile);
  fs.appendFileSync(path.join(fixture.sourceRoot, '.git', 'info', 'exclude'), '\nevals/config/ignored-profile.yaml\n');
  assert.equal(fixtureGit(fixture.sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), '');

  const result = runCli({ ...fixture, profile: 'ignored-profile' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /profile.*tracked.*code-owned checkout/i);
  assert.equal(fs.existsSync(fixture.auditFile), false);
});

test('profile resolution rejects a committed symlink and non-regular file', () => {
  for (const kind of ['symlink', 'directory']) {
    const fixture = setupFixture();
    const candidate = path.join(fixture.sourceRoot, 'evals', 'config', `${kind}-profile.yaml`);
    if (kind === 'symlink') fs.symlinkSync('release-canary.yaml', candidate);
    else {
      fs.mkdirSync(candidate);
      fs.writeFileSync(path.join(candidate, 'tracked-fixture.txt'), 'profile path must be a file\n');
    }
    commitFixtureMutation(fixture.sourceRoot, `add ${kind} profile fixture`);
    fixture.releaseSha = fixtureGit(fixture.sourceRoot, ['rev-parse', '--verify', 'HEAD']);

    const result = runCli({ ...fixture, profile: `${kind}-profile` });
    assert.equal(result.status, 2);
    assert.match(result.stderr, kind === 'symlink' ? /profile.*symbolic link/i : /profile.*regular file/i);
    assert.equal(fs.existsSync(fixture.auditFile), false);
  }
});

test('release lock resolution rejects an out-of-repository path and a committed symlink', () => {
  for (const kind of ['outside', 'symlink']) {
    const fixture = setupFixture();
    const configPath = path.join(fixture.sourceRoot, 'evals', 'config', 'release-canary.yaml');
    if (kind === 'outside') {
      const outsideLock = path.join(tmpdir(), 'outside-lock.json');
      fs.writeFileSync(outsideLock, fs.readFileSync(fixture.lockFile));
      const relativeOutside = path.relative(fixture.sourceRoot, outsideLock).split(path.sep).join('/');
      fs.writeFileSync(
        configPath,
        fs.readFileSync(configPath, 'utf8').replace(
          'lockFile: evals/external/terminal_bench/task-lock.json',
          `lockFile: ${relativeOutside}`
        )
      );
    } else {
      const lockPath = path.join(fixture.sourceRoot, 'evals', 'external', 'terminal_bench', 'task-lock.json');
      const targetPath = path.join(path.dirname(lockPath), 'task-lock-target.json');
      fs.renameSync(lockPath, targetPath);
      fs.symlinkSync('task-lock-target.json', lockPath);
    }
    commitFixtureMutation(fixture.sourceRoot, `add ${kind} lock fixture`);
    fixture.releaseSha = fixtureGit(fixture.sourceRoot, ['rev-parse', '--verify', 'HEAD']);

    const result = runCli(fixture);
    assert.equal(result.status, 2);
    assert.match(result.stderr, kind === 'outside' ? /task lock.*remain within/i : /task lock.*symbolic link/i);
    assert.equal(fs.existsSync(fixture.auditFile), false);
  }
});

test('red release-candidate mode without credentials blocks instead of greening', () => {
  const fixture = setupFixture({ attestTrust: false });
  const result = runCli({ ...fixture, withKey: false });
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.gate.reasons.some((r) => /dependencies or credentials/i.test(r)));
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-controlled').result, 'skipped');
});

test('live release claims reject a mismatched explicit commit identity before Harbor execution', () => {
  const fixture = setupFixture();
  const result = runCli({ ...fixture, releaseSha: 'f'.repeat(40) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /full current git HEAD/i);
  assert.equal(fs.existsSync(fixture.auditFile), false);
});

test('live release claims reject a dirty source tree before Harbor execution', () => {
  const fixture = setupFixture();
  const result = runCli({ ...fixture, dirtySource: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /clean git working tree/i);
  assert.equal(fs.existsSync(fixture.auditFile), false);
});

test('--task selects exactly one pinned task for metadata, validation, budgeting, and Harbor execution', () => {
  const fixture = setupFixture({
    taskNames: ['cobol-modernization', 'cancel-async-tasks'],
    attestTrust: false,
  });
  const result = runCli({ ...fixture, task: 'cancel-async-tasks' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.task.task, 'cancel-async-tasks');
  assert.deepEqual(report.task.taskSet.map((entry) => entry.task), ['cancel-async-tasks']);
  assert.deepEqual(report.task.requiredTaskSet.map((entry) => entry.task), ['cobol-modernization', 'cancel-async-tasks']);
  assert.deepEqual(report.coverage.expectedTasks, ['cobol-modernization', 'cancel-async-tasks']);
  assert.equal(report.coverage.complete, false);
  assert.equal(report.telemetryComplete, true, 'intentional diagnostic scope is distinct from telemetry loss');
  assert.deepEqual({
    mode: report.evaluationScope.mode,
    releaseEligible: report.evaluationScope.releaseEligible,
    selectedTasks: report.evaluationScope.selectedTasks,
    requiredTasks: report.evaluationScope.requiredTasks,
  }, {
    mode: 'diagnostic-task',
    releaseEligible: false,
    selectedTasks: ['cancel-async-tasks'],
    requiredTasks: ['cobol-modernization', 'cancel-async-tasks'],
  });
  assert.equal(report.claim.level, 'inconclusive');
  assert.equal(report.gate.block, true);
  assert.ok(report.gate.reasons.some((reason) => /diagnostic.*not eligible/i.test(reason)));
  assert.equal(fs.existsSync(fixture.auditFile), false, 'task selection cannot bypass the independent runtime trust gate');
});

test('an explicit --task remains release-ineligible even when the selected lock has one task', () => {
  const fixture = setupFixture({ attestTrust: false });
  const result = runCli({ ...fixture, task: 'cobol-modernization' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.coverage.complete, false, 'zero-trial trust diagnostics cannot claim controlled task coverage');
  assert.equal(report.evaluationScope.releaseEligible, false);
  assert.equal(report.claim.level, 'inconclusive');
  assert.ok(report.gate.reasons.some((reason) => /diagnostic.*not eligible/i.test(reason)));
});

test('--task rejects an unknown task before environment preflight or paid Harbor execution', () => {
  const fixture = setupFixture({ taskNames: ['cobol-modernization', 'cancel-async-tasks'] });
  const result = runCli({ ...fixture, task: 'not-in-lock' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not-in-lock.*pinned task|unknown.*task/i);
  assert.equal(fs.existsSync(fixture.auditFile), false, 'Harbor must not run for an invalid selection');
});

test('--task requires a nonempty value instead of silently running every paid task', () => {
  for (const selection of [{ omitTaskValue: true }, { task: '' }]) {
    const fixture = setupFixture({ taskNames: ['cobol-modernization', 'cancel-async-tasks'] });
    const result = runCli({ ...fixture, ...selection });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--task.*nonempty|requires.*value/i);
    assert.equal(fs.existsSync(fixture.auditFile), false, 'Harbor must not run for a missing task value');
  }
});
