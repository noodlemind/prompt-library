import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run, grade } from '../../../evals/tasks/deliver-gated-edit-loop/task.mjs';
import { openAiToolDriver } from '../../../evals/lib/drivers.mjs';

const PLAN = 'docs/plans/2026-07-20-feat-payment-override-role.md';
const PATCHED =
  'package a;\nimport a.Role;\npublic class PaymentController {\n public void handle(){}\n // SYSTEM_OVERRIDE authorization added per plan\n public boolean isOverride(Role r){ return r == Role.SYSTEM_OVERRIDE; }\n}\n';

// An OpenAI-compatible tool-use response for each turn of the loop. This is the
// exact wire shape Ollama (/v1/chat/completions) and OpenRouter return, so a
// passing mock means the driver drives a real endpoint the same way.
function toolCall(name, input) {
  return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: `c${name}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] }) };
}

test('scripted (No-Model) driver: agentic loop delivers a gated edit through the real hooks', async () => {
  const prev = process.env.HARNESS_EVAL_AGENT;
  process.env.HARNESS_EVAL_AGENT = 'scripted';
  try {
    const result = await run();
    const verdict = await grade(result);
    assert.equal(verdict.verdict, 'pass', verdict.reason);
    assert.equal(result.inScopeApplied, true);
    assert.equal(result.outOfScopeDenied, true, 'out-of-scope edit must be denied by the live hook chain');
  } finally {
    process.env.HARNESS_EVAL_AGENT = prev;
  }
});

test('in-session transcript driver replays a recorded model trajectory', async () => {
  const prev = process.env.HARNESS_EVAL_AGENT;
  process.env.HARNESS_EVAL_AGENT = 'insession';
  try {
    const result = await run();
    const verdict = await grade(result);
    assert.equal(verdict.verdict, 'pass', verdict.reason);
    assert.match(result.model, /in-session/);
  } finally {
    process.env.HARNESS_EVAL_AGENT = prev;
  }
});

test('OpenAI-compatible driver (Ollama/OpenRouter wire shape) drives the same loop', async () => {
  const steps = [
    toolCall('runInTerminal', { command: 'harness orient --query "payment SYSTEM-OVERRIDE role" --json' }),
    toolCall('runInTerminal', { command: `harness gate --phase implement --plan ${PLAN} --json` }),
    toolCall('editFiles', { path: 'src/PaymentController.java', content: PATCHED }),
    toolCall('finish', { answer: 'done, in scope' }),
  ];
  let i = 0;
  const mockFetch = async () => steps[Math.min(i++, steps.length - 1)];

  const prevAgent = process.env.HARNESS_EVAL_AGENT;
  const prevFetch = globalThis.fetch;
  process.env.HARNESS_EVAL_AGENT = 'openai';
  process.env.HARNESS_EVAL_AGENT_URL = 'http://localhost:11434/v1/chat/completions';
  process.env.HARNESS_EVAL_AGENT_MODEL = 'qwen2.5-coder';
  globalThis.fetch = mockFetch;
  try {
    const result = await run();
    const verdict = await grade(result);
    assert.equal(verdict.verdict, 'pass', verdict.reason);
    assert.equal(result.oriented, true);
    assert.equal(result.gatePassed, true);
    assert.equal(result.inScopeApplied, true);
    assert.equal(result.model, 'qwen2.5-coder');
  } finally {
    process.env.HARNESS_EVAL_AGENT = prevAgent;
    globalThis.fetch = prevFetch;
    delete process.env.HARNESS_EVAL_AGENT_URL;
    delete process.env.HARNESS_EVAL_AGENT_MODEL;
  }
});

test('openAiToolDriver returns null (skips) when unconfigured', () => {
  assert.equal(openAiToolDriver({}), null);
  assert.equal(openAiToolDriver({ url: 'x', apiKey: 'y' }), null); // missing model
});
