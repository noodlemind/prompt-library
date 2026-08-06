import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  BRIDGE_TOOLS,
  createScriptedCanaryDriver,
  createBrokerFetchImpl,
  resolveProviderRuntimeBoundary,
  runtimeBridgeTools,
  runStdioAgent,
} from '../external/terminal_bench/agent.mjs';
import { replayDriver, ProviderError } from '../lib/drivers.mjs';
import { createTelemetry } from '../lib/telemetry.mjs';
import { getProfile } from '../lib/model-profiles.mjs';

/**
 * Simulated Harbor side of the protocol: answers every exec line with a
 * scripted result and collects everything the agent writes.
 */
function pump({ resultFor = () => ({ code: 0, stdout: 'ok', stderr: '' }) } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, idx));
      lines.push(line);
      buffer = buffer.slice(idx + 1);
      if (line.type === 'exec' || line.type === 'verify') {
        const responseType = line.type === 'verify' ? 'verification_result' : 'result';
        input.write(`${JSON.stringify({ type: responseType, id: line.id, ...resultFor(line) })}\n`);
      }
    }
  });
  return { input, output, lines };
}

test('bridge tools expose exactly a terminal and a finish', () => {
  assert.deepEqual(
    BRIDGE_TOOLS.map((t) => t.name).sort(),
    ['bash', 'finish']
  );
});

test('agent entry point never restores an implicit model when profileId is missing or unknown', () => {
  const agentPath = fileURLToPath(new URL('../external/terminal_bench/agent.mjs', import.meta.url));
  for (const profileId of [undefined, 'not-a-registered-profile']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-profile-'));
    const conditionPath = path.join(root, 'condition.json');
    fs.writeFileSync(conditionPath, JSON.stringify({
      id: 'profile-contract',
      systemPrompt: 'system',
      instruction: 'instruction',
      ...(profileId === undefined ? {} : { profileId }),
    }));
    const result = spawnSync(process.execPath, [agentPath, '--condition', conditionPath], {
      encoding: 'utf8',
      env: {},
      timeout: 5_000,
    });
    assert.equal(result.status, 1);
    const done = JSON.parse(result.stdout.trim());
    assert.equal(done.stopReason, 'bridge_error');
    assert.match(done.detail, profileId === undefined ? /profileId is required/i : /unknown model profile/i);
  }
});

test('the archive condition alone selects one immediate no-model scripted canary finish', async () => {
  const condition = {
    id: 'runtime-canary',
    runtime: { driverMode: 'scripted-canary' },
  };
  const driver = createScriptedCanaryDriver({
    condition,
    environment: {},
  });
  assert.ok(driver, 'the exact archive-owned condition mode selects the canary');
  assert.equal(driver.name, 'scripted-canary');
  assert.equal(driver.model, 'none');
  assert.deepEqual(await driver.next(), {
    type: 'finish',
    answer: 'Scripted canary completed without model execution.',
    stopReason: 'scripted_canary',
  });
  assert.deepEqual(await driver.next(), {
    type: 'finish',
    answer: '(replay exhausted)',
    stopReason: 'replay_exhausted',
  });

  for (const runtime of [undefined, {}, { driverMode: 'scripted' }, { driverMode: 'scripted-canary ' }]) {
    assert.equal(createScriptedCanaryDriver({
      condition: { id: 'ordinary-release', ...(runtime === undefined ? {} : { runtime }) },
      environment: { HARNESS_EVAL_TB_DRIVER_MODE: 'scripted-canary' },
    }), null, 'process environment cannot opt an ordinary release condition into the canary');
  }
});

test('scripted canary CLI needs no model profile and records exactly zero provider activity', () => {
  const agentPath = fileURLToPath(new URL('../external/terminal_bench/agent.mjs', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-scripted-canary-'));
  const conditionPath = path.join(root, 'condition.json');
  fs.writeFileSync(conditionPath, JSON.stringify({
    id: 'runtime-canary',
    systemPrompt: 'fixed canary system',
    instruction: 'fixed canary instruction',
    runtime: { driverMode: 'scripted-canary' },
  }));
  const result = spawnSync(process.execPath, [agentPath, '--condition', conditionPath], {
    encoding: 'utf8',
    env: {},
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const done = JSON.parse(result.stdout.trim());
  assert.equal(done.stopReason, 'scripted_canary');
  assert.equal(done.steps, 0, 'the canary finishes before any sandbox tool request');
  assert.equal(done.telemetry.totals.modelRequests, 0);
  assert.equal(done.telemetry.totals.providerAttempts, 0);
  assert.equal(done.telemetry.totals.providerResponses, 0);
  assert.equal(done.telemetry.totals.providerErrors, 0);
  assert.deepEqual(done.telemetry.events, []);
  assert.equal(Object.hasOwn(done, 'passed'), false, 'the bridge never invents Harbor verifier success');
  assert.equal(Object.hasOwn(done, 'reward'), false, 'only Harbor may record a verifier reward');
});

test('the provider bridge maps exact model requests through a lease-bound broker without a credential', async () => {
  const profile = getProfile('kimi-k2.7-code');
  const observed = [];
  const fetchImpl = createBrokerFetchImpl({
    socketPath: '/run/engineer-eval/provider-relay.sock',
    binding: {
      leaseId: 'lease-1',
      leaseDigest: 'd'.repeat(64),
      trialId: 'trial-1',
      leaseSequence: 2,
    },
    profile,
    requestImpl: async (request) => {
      observed.push(request);
      return {
        version: 1,
        type: 'provider-response',
        ok: true,
        attemptId: request.request.attemptId,
        model: profile.provider.expectedResolvedModels[0],
        provider: profile.provider.expectedResolvedNames[0],
        message: { role: 'assistant', content: 'done', tool_calls: [] },
        finishReason: 'stop',
        evidence: {
          attemptId: request.request.attemptId,
          usage: {
            promptTokens: 12,
            cachedTokens: 3,
            cachedTokensComplete: true,
            outputTokens: 4,
            localCostUsd: 0.001,
            providerCostUsd: 0.002,
            reconciledCostUsd: 0.002,
          },
        },
      };
    },
  });
  const body = {
    model: profile.model,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    tool_choice: 'auto',
    max_tokens: profile.maxTokens,
    reasoning: profile.reasoning,
    provider: { order: profile.provider.order, allow_fallbacks: false },
  };
  const response = await fetchImpl(profile.url, {
    method: 'POST',
    headers: { authorization: 'Bearer broker-placeholder' },
    body: JSON.stringify(body),
  });
  assert.equal(response.ok, true);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].socketPath, '/run/engineer-eval/provider-relay.sock');
  assert.deepEqual(observed[0].request.provider, profile.provider);
  assert.equal(observed[0].request.sequence, 1);
  assert.equal(observed[0].request.leaseDigest, 'd'.repeat(64));
  assert.equal(JSON.stringify(observed[0]).includes('broker-placeholder'), false);
  const data = await response.json();
  assert.equal(data.model, profile.provider.expectedResolvedModels[0]);
  assert.equal(data.provider, profile.provider.expectedResolvedNames[0]);
  assert.equal(data.usage.prompt_tokens, 12);
  assert.equal(data.usage.prompt_tokens_details.cached_tokens, 3);
  assert.equal(data.usage.cost, 0.002);
  assert.equal(data.choices[0].message.content, 'done');
});

test('controlled OpenRouter runtime is derived from the complete signed environment binding only', () => {
  const profile = getProfile('kimi-k2.7-code');
  const environment = {
    ENGINEER_PROVIDER_BROKER_SOCKET: '/run/engineer/provider.sock',
    ENGINEER_PROVIDER_LEASE_ID: 'lease-trial-1',
    ENGINEER_PROVIDER_LEASE_DIGEST: 'd'.repeat(64),
    ENGINEER_PROVIDER_LEASE_SEQUENCE: '2',
    ENGINEER_PROVIDER_TRIAL_ID: 'pair-1-r1-generic-1',
  };
  const expected = {
    socketPath: environment.ENGINEER_PROVIDER_BROKER_SOCKET,
    binding: {
      leaseId: environment.ENGINEER_PROVIDER_LEASE_ID,
      leaseDigest: environment.ENGINEER_PROVIDER_LEASE_DIGEST,
      leaseSequence: 2,
      trialId: environment.ENGINEER_PROVIDER_TRIAL_ID,
    },
  };
  assert.deepEqual(resolveProviderRuntimeBoundary({
    condition: { id: 'generic', profileId: profile.id },
    profile,
    environment,
  }), expected);

  assert.deepEqual(resolveProviderRuntimeBoundary({
    condition: { id: 'generic', profileId: profile.id, runtime: { providerBroker: expected } },
    profile,
    environment,
  }), expected, 'a condition copy is tolerated only when it exactly matches signed runtime env');

  assert.throws(
    () => resolveProviderRuntimeBoundary({
      condition: {
        id: 'generic',
        profileId: profile.id,
        runtime: { providerBroker: { ...expected, binding: { ...expected.binding, leaseId: 'other' } } },
      },
      profile,
      environment,
    }),
    /mismatch|condition.*broker/i
  );
});

test('controlled OpenRouter rejects missing or partial broker binding and every raw credential environment', () => {
  const profile = getProfile('kimi-k2.7-code');
  const complete = {
    ENGINEER_PROVIDER_BROKER_SOCKET: '/run/engineer/provider.sock',
    ENGINEER_PROVIDER_LEASE_ID: 'lease-trial-1',
    ENGINEER_PROVIDER_LEASE_DIGEST: 'd'.repeat(64),
    ENGINEER_PROVIDER_LEASE_SEQUENCE: '2',
    ENGINEER_PROVIDER_TRIAL_ID: 'pair-1-r1-generic-1',
  };
  const condition = { id: 'generic', profileId: profile.id, apiKeyEnv: 'CUSTOM_PROVIDER_VALUE' };

  assert.throws(
    () => resolveProviderRuntimeBoundary({ condition, profile, environment: {} }),
    /isolated provider broker|complete.*binding/i
  );
  for (const name of Object.keys(complete)) {
    const partial = { ...complete };
    delete partial[name];
    assert.throws(
      () => resolveProviderRuntimeBoundary({ condition, profile, environment: partial }),
      /complete.*binding|partial/i,
      name
    );
  }
  for (const raw of [
    { OPENROUTER_API_KEY: 'raw-key' },
    { OPENROUTER_KEY: 'raw-key' },
    { OPENAI_API_KEY: 'raw-key' },
    { ANTHROPIC_AUTH_TOKEN: 'raw-key' },
    { CUSTOM_PROVIDER_VALUE: 'raw-key' },
    { DAYTONA_API_KEY: 'controller-key-must-not-reach-runner' },
  ]) {
    assert.throws(
      () => resolveProviderRuntimeBoundary({ condition, profile, environment: { ...complete, ...raw } }),
      /raw.*credential|credential.*environment/i,
      Object.keys(raw)[0]
    );
  }
});

test('runtime tools are treatment-only additions to the symmetric bridge baseline', () => {
  assert.deepEqual(
    runtimeBridgeTools({ guidanceCatalog: { 'ensure-plan': { content: 'plan safely' } }, enableTrustedVerify: true }).map((tool) => tool.name),
    ['bash', 'finish', 'load_guidance', 'checkpoint', 'verify_harness']
  );
  assert.deepEqual(runtimeBridgeTools().map((tool) => tool.name), ['bash', 'finish']);
  assert.deepEqual(BRIDGE_TOOLS.map((tool) => tool.name), ['bash', 'finish'], 'the generic arm remains unchanged');
});

test('load_guidance resolves locally and enters driver history only when requested', async () => {
  const observed = [];
  let resetTools = [];
  const driver = {
    reset: ({ tools }) => {
      resetTools = tools.map((tool) => tool.name);
    },
    next: (() => {
      const actions = [
        { type: 'tool', name: 'load_guidance', input: { name: 'ensure-plan' }, _id: 'guidance-1' },
        { type: 'finish', answer: 'done', stopReason: 'model_finish' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    checkpoint: (state, options) => observed.push({ checkpoint: state, options }),
    observe: (action, result) => observed.push({ action, result }),
  };
  const { input, output, lines } = pump();
  const done = await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 's',
    instruction: 'i',
    guidanceCatalog: {
      'ensure-plan': { id: 'ensure-plan', path: '.github/skills/ensure-plan/SKILL.md', content: 'LOCK THE PLAN', sha256: 'abc' },
    },
  });
  assert.equal(done.stopReason, 'model_finish');
  assert.deepEqual(resetTools, ['bash', 'finish', 'load_guidance', 'checkpoint']);
  assert.equal(lines.some((line) => line.type === 'exec'), false, 'local guidance never enters the task shell');
  assert.equal(observed.at(-1).result.stdout, 'LOCK THE PLAN');
  assert.deepEqual(observed[0].checkpoint.loadedGuidance, ['ensure-plan']);
});

test('large guidance is disclosed as a bounded section index and paged section content', async () => {
  const observed = [];
  const body = `# Ensure Plan\n\n## Guardrails\n\n${'safe step '.repeat(500)}\n\n## Return\n\nreport path`;
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'load_guidance', input: { name: 'ensure-plan' }, _id: 'index' },
        { type: 'tool', name: 'load_guidance', input: { name: 'ensure-plan', section: 'Guardrails', cursor: 0 }, _id: 'page' },
        { type: 'finish', answer: 'done', stopReason: 'model_finish' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    checkpoint: () => {},
    observe: (_action, result) => observed.push(result),
  };
  const { input, output, lines } = pump();
  await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 's',
    instruction: 'i',
    guidanceCatalog: { 'ensure-plan': { content: body } },
  });
  const index = JSON.parse(observed[0].stdout);
  const page = JSON.parse(observed[1].stdout);
  assert.deepEqual(index.sections, ['Ensure Plan', 'Guardrails', 'Return']);
  assert.equal(index.content, undefined, 'the full body is not returned with the catalog index');
  assert.equal(page.section, 'Guardrails');
  assert.ok(page.content.length <= 900);
  assert.ok(page.nextCursor > 0, 'the caller can page through a long section deterministically');
  assert.ok(observed[1].stdout.length < 1_200, 'one on-demand observation stays below the driver result budget');
  assert.equal(lines.some((line) => line.type === 'exec'), false);
});

test('large guidance section indexes page without hiding headings after the cap', async () => {
  const observed = [];
  const body = Array.from({ length: 65 }, (_, index) => `## Section ${index + 1}\n\n${'bounded detail '.repeat(8)}`).join('\n\n');
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'load_guidance', input: { name: 'many' }, _id: 'index-1' },
        { type: 'tool', name: 'load_guidance', input: { name: 'many', cursor: 60 }, _id: 'index-2' },
        { type: 'finish', answer: 'done', stopReason: 'model_finish' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    checkpoint: () => {},
    observe: (_action, result) => observed.push(result),
  };
  const { input, output } = pump();
  await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 's',
    instruction: 'i',
    guidanceCatalog: { many: { content: body } },
  });
  const first = JSON.parse(observed[0].stdout);
  const second = JSON.parse(observed[1].stdout);
  assert.equal(first.sections.length, 60);
  assert.equal(first.totalSections, 65);
  assert.equal(first.sectionsTruncated, true);
  assert.equal(first.nextCursor, 60);
  assert.deepEqual(second.sections, ['Section 61', 'Section 62', 'Section 63', 'Section 64', 'Section 65']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.sectionsTruncated, false);
});

test('large guidance without headings remains available through whole-document pages', async () => {
  const observed = [];
  const body = 'follow this bounded procedure. '.repeat(100);
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'load_guidance', input: { name: 'plain' }, _id: 'page-1' },
        { type: 'tool', name: 'load_guidance', input: { name: 'plain', cursor: 900 }, _id: 'page-2' },
        { type: 'finish', answer: 'done', stopReason: 'model_finish' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    checkpoint: () => {},
    observe: (_action, result) => observed.push(result),
  };
  const { input, output } = pump();
  await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 's',
    instruction: 'i',
    guidanceCatalog: { plain: { content: body } },
  });

  const first = JSON.parse(observed[0].stdout);
  const second = JSON.parse(observed[1].stdout);
  assert.equal(first.section, null);
  assert.equal(first.cursor, 0);
  assert.equal(first.content.length, 900);
  assert.equal(first.nextCursor, 900);
  assert.equal(second.section, null);
  assert.equal(second.cursor, 900);
  assert.ok(second.content.length <= 900);
  assert.equal(first.totalChars, body.length);
});

test('load_guidance rejects inherited object properties as unknown catalog entries', async () => {
  const observed = [];
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'load_guidance', input: { name: '__proto__' }, _id: 'bad-name' },
        { type: 'finish', answer: 'done', stopReason: 'model_finish' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    observe: (_action, result) => observed.push(result),
  };
  const { input, output } = pump();
  await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 's',
    instruction: 'i',
    guidanceCatalog: { 'ensure-plan': { content: 'safe' } },
  });
  assert.equal(observed[0].code, 2);
  assert.match(observed[0].stderr, /unknown guidance/);
});

test('checkpoint updates durable driver state locally without a terminal execution', async () => {
  const checkpoints = [];
  const observations = [];
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'checkpoint', input: { state: { goal: 'finish migration', nextAction: 'run tests' } }, _id: 'cp-1' },
        { type: 'finish', answer: 'done', stopReason: 'model_finish' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    checkpoint: (state) => checkpoints.push(state),
    observe: (action, result) => observations.push({ action, result }),
  };
  const { input, output, lines } = pump();
  await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 's',
    instruction: 'i',
    guidanceCatalog: {},
    enableCheckpoint: true,
  });
  assert.deepEqual(checkpoints, [{ goal: 'finish migration', nextAction: 'run tests' }]);
  assert.equal(JSON.parse(observations[0].result.stdout).checkpointed, true);
  assert.equal(lines.some((line) => line.type === 'exec'), false);
});

test('sandbox-authored verify output is observed but never promotes the driver to verified', async () => {
  const calls = [];
  const verifyBody = {
    outcome: 'passed',
    plan: 'docs/plans/task.md',
    evidencePath: '.harness/evidence/task.json',
    unverifiedCriteria: [],
    scopeViolations: [],
    openHardGaps: [],
    requiredReviews: [],
  };
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'bash', input: { command: '/opt/harness-bundle/harness-cli verify --plan docs/plans/task.md --workspace . --json' }, _id: 'verify-1' },
        { type: 'finish', answer: 'verified', stopReason: 'model_finish' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    observe: () => calls.push('observe'),
    markVerified: (detail) => calls.push({ markVerified: detail }),
  };
  const { input, output } = pump({ resultFor: () => ({ code: 0, stdout: JSON.stringify(verifyBody), stderr: '' }) });
  const done = await runStdioAgent({ driver, input, output, systemPrompt: 's', instruction: 'i' });
  assert.equal(done.stopReason, 'model_finish');
  assert.deepEqual(calls, ['observe']);
});

test('bridge-owned immutable verification promotes verified stop only on a complete attestation', async () => {
  const calls = [];
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'verify_harness', input: {}, _id: 'verify-1' },
        { type: 'finish', answer: 'verified', stopReason: 'verified_stop' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    observe: () => calls.push('observe'),
    markVerified: (detail) => calls.push({ markVerified: detail }),
  };
  const { input, output, lines } = pump({ resultFor: (line) => line.type === 'verify' ? ({
    code: 0,
    stdout: '{"outcome":"passed"}',
    stderr: '',
    trustedVerification: true,
    passed: true,
    plan: 'docs/plans/task.md',
    evidencePath: '.harness/evidence/task.json',
  }) : ({ code: 0, stdout: 'ok', stderr: '' }) });
  const done = await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 's',
    instruction: 'i',
    enableTrustedVerify: true,
  });
  assert.equal(done.stopReason, 'verified_stop');
  assert.deepEqual(calls, [
    'observe',
    { markVerified: { plan: 'docs/plans/task.md', evidencePath: '.harness/evidence/task.json', fallbackAnswer: 'Harness verification passed.' } },
  ]);
  assert.equal(lines.filter((line) => line.type === 'verify').length, 1);
  assert.equal(lines.some((line) => line.type === 'exec'), false, 'trusted verification is not a model-selected shell command');
});

test('trusted verification at the step ceiling still permits one finalization request', async () => {
  let marked = false;
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'verify_harness', input: {}, _id: 'verify-at-limit' },
        { type: 'finish', answer: 'final summary', stopReason: 'verified_stop' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    observe: () => {},
    markVerified: () => { marked = true; },
  };
  const { input, output } = pump({ resultFor: (line) => line.type === 'verify' ? ({
    code: 0,
    stdout: '{"outcome":"passed"}',
    stderr: '',
    trustedVerification: true,
    passed: true,
  }) : ({ code: 0, stdout: '', stderr: '' }) });
  const done = await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 's',
    instruction: 'i',
    enableTrustedVerify: true,
    maxSteps: 1,
  });
  assert.equal(marked, true);
  assert.equal(done.steps, 1);
  assert.equal(done.answer, 'final summary');
  assert.equal(done.stopReason, 'verified_stop');
});

test('unknown provider tools receive a correlated nonzero result', async () => {
  const observed = [];
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'not_advertised', input: {}, _id: 'unknown-1' },
        { type: 'finish', answer: 'done', stopReason: 'model_finish' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    observe: (_action, result) => observed.push(result),
  };
  const { input, output } = pump();
  await runStdioAgent({ driver, input, output, systemPrompt: 's', instruction: 'i' });
  assert.deepEqual(observed, [{ code: 127, stdout: '', stderr: 'unknown tool: not_advertised' }]);
});

test('malformed provider tool arguments are rejected locally before sandbox execution', async () => {
  const observed = [];
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'bash', input: {}, _id: 'bad-args', _argumentsValid: false, _argumentError: 'provider tool arguments were not a valid JSON object' },
        { type: 'finish', answer: 'recovered', stopReason: 'model_finish' },
      ];
      let index = 0;
      return async () => actions[index++];
    })(),
    observe: (_action, result) => observed.push(result),
  };
  const { input, output, lines } = pump();
  const done = await runStdioAgent({ driver, input, output, systemPrompt: 's', instruction: 'i' });
  assert.equal(done.stopReason, 'model_finish');
  assert.equal(lines.some((line) => line.type === 'exec'), false);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].code, 126);
  assert.equal(observed[0].containmentMode, 'bridge-local');
  assert.equal(observed[0].containmentComplete, true);
});

test('happy path: execs stream out, results stream back into the driver, done carries the answer', async () => {
  const observed = [];
  const driver = {
    next: (() => {
      const actions = [
        { type: 'tool', name: 'bash', input: { command: 'ls' } },
        { type: 'tool', name: 'bash', input: { command: 'cat main.cobol' } },
        { type: 'finish', answer: 'reimplemented', stopReason: 'model_finish' },
      ];
      let i = 0;
      return async () => actions[i++];
    })(),
    observe: (action, result) => observed.push({ action: action.input.command, result }),
  };
  const { input, output, lines } = pump({ resultFor: (line) => ({ code: 0, stdout: `ran:${JSON.parse('{}') ? line.command : ''}`, stderr: '' }) });
  const done = await runStdioAgent({ driver, input, output, systemPrompt: 's', instruction: 'i' });
  assert.equal(done.stopReason, 'model_finish');
  assert.equal(done.answer, 'reimplemented');
  const execs = lines.filter((l) => l.type === 'exec');
  assert.deepEqual(
    execs.map((e) => e.command),
    ['ls', 'cat main.cobol']
  );
  assert.equal(observed.length, 2, 'every exec result is observed by the driver');
  assert.equal(lines.at(-1).type, 'done');
});

test('a provider failure surfaces as provider_error with its classification', async () => {
  const driver = {
    next: async () => {
      throw new ProviderError('boom', { kind: 'network', billed: false });
    },
  };
  const { input, output, lines } = pump();
  const done = await runStdioAgent({ driver, input, output, systemPrompt: 's', instruction: 'i' });
  assert.equal(done.stopReason, 'provider_error');
  assert.equal(done.providerFailure.kind, 'network');
  assert.equal(done.providerFailure.billed, false);
  assert.equal(lines.at(-1).type, 'done');
});

test('the step ceiling ends the run with max_steps', async () => {
  const suppressed = [];
  const driver = {
    next: async () => ({ type: 'tool', name: 'bash', input: { command: 'true' } }),
    suppressPending: (reason) => suppressed.push(reason),
  };
  const { input, output } = pump();
  const done = await runStdioAgent({ driver, input, output, maxSteps: 3, systemPrompt: 's', instruction: 'i' });
  assert.equal(done.stopReason, 'max_steps');
  assert.equal(done.steps, 3);
  assert.deepEqual(suppressed, ['step_ceiling']);
});

test('a budget-exhausted finish passes its stop reason through', async () => {
  const driver = replayDriver([{ type: 'finish', answer: '', stopReason: 'budget_exhausted' }]);
  const { input, output } = pump();
  const done = await runStdioAgent({ driver, input, output, systemPrompt: 's', instruction: 'i' });
  assert.equal(done.stopReason, 'budget_exhausted');
});

test('telemetry snapshot rides along in the done message', async () => {
  const telemetry = createTelemetry();
  telemetry.record('request', { model: 'kimi' });
  const driver = replayDriver([{ type: 'finish', answer: 'x', stopReason: 'model_finish' }]);
  const { input, output, lines } = pump();
  await runStdioAgent({ driver, input, output, telemetry, systemPrompt: 's', instruction: 'i' });
  const done = lines.at(-1);
  assert.equal(done.telemetry.events[0].model, 'kimi');
  assert.match(done.runtime.toolSchemaHash, /^[a-f0-9]{64}$/);
  assert.match(done.runtime.systemPromptHash, /^[a-f0-9]{64}$/);
  assert.match(done.runtime.instructionHash, /^[a-f0-9]{64}$/);
  assert.equal(done.runtime.toolCount, 2);
});

test('a closed input stream settles the loop as protocol_error instead of hanging forever', async () => {
  const driver = { next: async () => ({ type: 'tool', name: 'bash', input: { command: 'ls' } }) };
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString();
    if (buffer.includes('"exec"')) input.end(); // the Python side died mid-exec
  });
  const done = await runStdioAgent({ driver, input, output, systemPrompt: 's', instruction: 'i' });
  assert.equal(done.stopReason, 'protocol_error');
});

test('the done payload is persisted to doneFilePath BEFORE the done line reaches stdout', async () => {
  const doneFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-done-')), 'done.json');
  const driver = replayDriver([{ type: 'finish', answer: 'x', stopReason: 'model_finish' }]);
  const input = new PassThrough();
  const output = new PassThrough();
  let fileExistedWhenDoneArrived = null;
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString();
    if (buffer.includes('"done"') && fileExistedWhenDoneArrived === null) {
      // The moment the harbor side could terminate us, the file must be safe.
      fileExistedWhenDoneArrived = fs.existsSync(doneFile) && fs.readFileSync(doneFile, 'utf8').length > 0;
    }
  });
  await runStdioAgent({ driver, input, output, systemPrompt: 's', instruction: 'i', doneFilePath: doneFile });
  assert.equal(fileExistedWhenDoneArrived, true, 'a terminate() race must never truncate the telemetry file');
  assert.equal(JSON.parse(fs.readFileSync(doneFile, 'utf8')).stopReason, 'model_finish');
});

test('a malformed result line ends the run as a protocol_error', async () => {
  const driver = { next: async () => ({ type: 'tool', name: 'bash', input: { command: 'ls' } }) };
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, idx));
      lines.push(line);
      buffer = buffer.slice(idx + 1);
      if (line.type === 'exec') input.write('this is not json\n');
    }
  });
  const done = await runStdioAgent({ driver, input, output, systemPrompt: 's', instruction: 'i' });
  assert.equal(done.stopReason, 'protocol_error');
});
