import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createHost as createControlledHost,
  validateControlledProfile,
} from '../hosts/openrouter-controlled.mjs';
import { createHost as createKimiHost } from '../hosts/openrouter-kimi.mjs';
import { createHost as createGemmaHost } from '../hosts/ollama-gemma.mjs';
import { createHost as createCodexHost } from '../hosts/codex-subscription.mjs';
import { createHost as createClaudeHost } from '../hosts/claude-subscription.mjs';
import { createHost as createCopilotSmoke } from '../hosts/copilot-smoke.mjs';
import { createHost as createGrokSmoke } from '../hosts/grok-smoke.mjs';
import { createBudget } from '../lib/budget.mjs';
import { createTelemetry } from '../lib/telemetry.mjs';

test('controlled OpenRouter host requires an explicit registered OpenRouter profile', () => {
  assert.throws(
    () => createControlledHost({ apiKey: 'test-key' }),
    /profileId.*required/i,
  );
  assert.throws(
    () => createControlledHost({ profileId: 'unknown-profile', apiKey: 'test-key' }),
    /unknown model profile/i,
  );
  assert.throws(
    () => createControlledHost({ profileId: 'gemma-4-26b-local', apiKey: 'test-key' }),
    /OpenRouter profile/i,
  );
});

test('controlled OpenRouter host uses the selected profile with provider fallback disabled', async () => {
  const requests = [];
  const host = createControlledHost({ profileId: 'kimi-k2.7-code', apiKey: 'test-key' });
  assert.equal(host.id, 'openrouter-controlled');
  assert.equal(host.kind, 'api');
  assert.equal(host.gate, 'controlled-ablation');
  assert.equal(host.profile.id, 'kimi-k2.7-code');

  const driver = host.createDriver({
    budget: createBudget({ ceilingUsd: 5 }),
    telemetry: createTelemetry(),
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return {
        ok: true,
        json: async () => ({
          id: 'gen',
          model: host.profile.provider.expectedResolvedModels[0],
          provider: 'Moonshot AI',
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.00001 },
          choices: [{ message: { role: 'assistant', content: 'done', tool_calls: [] } }],
        }),
      };
    },
  });
  driver.reset({ system: 's', instruction: 'i', tools: [] });
  await driver.next();

  assert.deepEqual(requests[0].provider, {
    order: ['moonshotai/int4'],
    allow_fallbacks: false,
  });
});

test('controlled OpenRouter profiles pin exactly one endpoint and resolved provider identity', () => {
  const profile = structuredClone(createControlledHost({ profileId: 'kimi-k2.7-code', apiKey: 'test-key' }).profile);
  assert.throws(
    () => validateControlledProfile({
      ...profile,
      provider: { ...profile.provider, order: [...profile.provider.order, 'another/provider'] },
    }),
    /exactly one provider endpoint/i,
  );
  assert.throws(
    () => validateControlledProfile({
      ...profile,
      provider: { ...profile.provider, expectedResolvedNames: [...profile.provider.expectedResolvedNames, 'Other'] },
    }),
    /exactly one resolved provider identity/i,
  );
  assert.throws(
    () => validateControlledProfile({
      ...profile,
      provider: { ...profile.provider, expectedResolvedModels: ['moonshotai/other-model'] },
    }),
    /exactly one resolved model identity/i,
  );
  assert.throws(
    () => validateControlledProfile({
      ...profile,
      catalogPin: { ...profile.catalogPin, modelId: 'moonshotai/other-model' },
    }),
    /catalog model identity/i,
  );
});

test('release profiles select the controlled host and budget without a model-named lane', () => {
  for (const name of ['release-canary.yaml', 'release-routine.yaml']) {
    const config = fs.readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8');
    const expected = name === 'release-canary.yaml'
      ? { controlled: '8.4', rerun: '1.6', hardLimit: '20' }
      : { controlled: '8', rerun: '2', hardLimit: '10' };
    assert.match(config, /controlledLane:\s*\n\s+host: openrouter-controlled\s*\n\s+profileId: kimi-k2\.7-code/);
    assert.match(config, new RegExp(`controlledPairUsd: ${expected.controlled}(?:\\n|$)`));
    assert.match(config, new RegExp(`rerunUsd: ${expected.rerun}(?:\\n|$)`));
    assert.match(config, new RegExp(`providerHardLimitUsd: ${expected.hardLimit}(?:\\n|$)`));
    assert.doesNotMatch(config, /kimiPairUsd:/);
  }
});

test('kimi host is the controlled API experiment on the pinned profile', () => {
  const host = createKimiHost({ apiKey: 'test-key' });
  assert.equal(host.id, 'openrouter-kimi');
  assert.equal(host.kind, 'api');
  assert.equal(host.gate, 'controlled-ablation');
  assert.equal(host.profile.id, 'kimi-k2.7-code');
  const driver = host.createDriver({ budget: createBudget({ ceilingUsd: 5 }), telemetry: createTelemetry() });
  assert.equal(driver.model, 'moonshotai/kimi-k2.7-code');
});

test('kimi host enforces the profile trial ceiling even when no budget is supplied', async () => {
  const host = createKimiHost({ apiKey: 'test-key' });
  // Usage priced at ~$8 against the $5 trial ceiling: the first response is
  // charged, the second request must be refused by the auto-created budget.
  const bigUsage = { prompt_tokens: 10, completion_tokens: 2_000_000, cost: 8 };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      id: 'gen',
      model: host.profile.model,
      provider: 'Moonshot AI',
      usage: bigUsage,
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }],
    }),
  });
  const driver = host.createDriver({ fetchImpl });
  driver.reset({ system: 's', instruction: 'i', tools: [{ name: 'bash', description: 'x', parameters: { type: 'object', properties: {} } }] });
  const first = await driver.next();
  assert.equal(first.type, 'tool');
  driver.observe(first, { code: 0 });
  const second = await driver.next();
  assert.equal(second.type, 'finish');
  assert.equal(second.stopReason, 'budget_exhausted', 'an unbudgeted paid driver must still hit a ceiling');
});

test('kimi host fails credential validation closed without its API key', () => {
  const host = createKimiHost({ apiKey: undefined });
  const verdict = host.validateCredentials();
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['OPENROUTER_API_KEY']);
  assert.equal(host.createDriver({}), null, 'no key, no driver, no spend');
});

test('gemma host is local, free, and needs no credentials', () => {
  const host = createGemmaHost();
  assert.equal(host.id, 'ollama-gemma');
  assert.equal(host.kind, 'api');
  assert.equal(host.gate, 'informational');
  assert.deepEqual(host.validateCredentials(), { ok: true, missing: [] });
  const driver = host.createDriver({ telemetry: createTelemetry() });
  assert.equal(driver.model, 'gemma4:26b-a4b-it-q4_K_M');
});

test('gemma host keeps its provider bridge on the host loopback endpoint', () => {
  const host = createGemmaHost();
  assert.equal(host.profile.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(Object.hasOwn(host, 'urlForDockerContainer'), false);
});

test('subscription hosts report every unavailable telemetry field as null, never an estimate', () => {
  for (const host of [createCodexHost(), createClaudeHost()]) {
    assert.equal(host.kind, 'subscription');
    const template = host.telemetryTemplate();
    assert.deepEqual(template, {
      premiumRequestsConsumed: null,
      rateLimitEvents: null,
      hostReportedPromptTokens: null,
      hostReportedOutputTokens: null,
      hostReportedModel: null,
      fallbackObserved: null,
    });
  }
});

test('normalizeHostReport keeps known numeric fields and nulls everything unusable', () => {
  const host = createCodexHost();
  const report = host.normalizeHostReport({
    premiumRequestsConsumed: 3,
    hostReportedModel: 'gpt-5.3-codex',
    hostReportedPromptTokens: 'a lot',
    unexpected: 'ignored',
  });
  assert.equal(report.premiumRequestsConsumed, 3);
  assert.equal(report.hostReportedModel, 'gpt-5.3-codex');
  assert.equal(report.hostReportedPromptTokens, null, 'non-numeric usage must become null, not a guess');
  assert.equal(report.fallbackObserved, null);
  assert.ok(!('unexpected' in report));
});

test('subscription hosts preserve transcripts to disk and describe the manual A/B', () => {
  const host = createClaudeHost();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-transcript-'));
  const file = host.preserveTranscript({ transcript: 'turn 1: ...', dir, label: 'harness' });
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, 'utf8'), 'turn 1: ...');
  const text = host.runInstructions.join('\n');
  assert.match(text, /without.*Harness/i);
  assert.match(text, /with.*Harness/i);
  assert.match(text, /resolved model/i, 'operators must record the exact resolved model');
});

test('smoke hosts carry the compatibility checklist from the plan', () => {
  for (const host of [createCopilotSmoke(), createGrokSmoke()]) {
    assert.equal(host.kind, 'smoke');
    const ids = host.checklist.map((c) => c.id);
    assert.deepEqual(ids, ['install', 'discovery', 'activation', 'hooks', 'completion']);
  }
});

test('smoke evaluation passes only when every checklist item passes', () => {
  const host = createGrokSmoke();
  const allPass = host.evaluate({ install: true, discovery: true, activation: true, hooks: true, completion: true });
  assert.deepEqual(allPass, { ok: true, failed: [] });
  const partial = host.evaluate({ install: true, discovery: false, activation: true });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.failed, ['discovery', 'hooks', 'completion'], 'unreported items fail closed');
});
