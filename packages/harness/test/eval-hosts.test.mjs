import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHost as createKimiHost } from '../../../evals/hosts/openrouter-kimi.mjs';
import { createHost as createGemmaHost } from '../../../evals/hosts/ollama-gemma.mjs';
import { createHost as createCodexHost } from '../../../evals/hosts/codex-subscription.mjs';
import { createHost as createClaudeHost } from '../../../evals/hosts/claude-subscription.mjs';
import { createHost as createCopilotSmoke } from '../../../evals/hosts/copilot-smoke.mjs';
import { createHost as createGrokSmoke } from '../../../evals/hosts/grok-smoke.mjs';
import { createBudget } from '../../../evals/lib/budget.mjs';
import { createTelemetry } from '../../../evals/lib/telemetry.mjs';

test('kimi host is the controlled API experiment on the pinned profile', () => {
  const host = createKimiHost({ apiKey: 'test-key' });
  assert.equal(host.id, 'openrouter-kimi');
  assert.equal(host.kind, 'api');
  assert.equal(host.gate, 'after-calibration');
  assert.equal(host.profile.id, 'kimi-k2.7-code');
  const driver = host.createDriver({ budget: createBudget({ ceilingUsd: 5 }), telemetry: createTelemetry() });
  assert.equal(driver.model, 'moonshotai/kimi-k2.7-code');
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

test('gemma host rewrites its endpoint for agents running inside Docker', () => {
  const host = createGemmaHost();
  assert.match(host.urlForDockerContainer(), /^http:\/\/host\.docker\.internal:11434\//);
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
