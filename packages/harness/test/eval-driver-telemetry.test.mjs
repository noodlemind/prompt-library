import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAiToolDriver, replayDriver } from '../../../evals/lib/drivers.mjs';
import { getProfile } from '../../../evals/lib/model-profiles.mjs';
import { createBudget } from '../../../evals/lib/budget.mjs';
import { createTelemetry } from '../../../evals/lib/telemetry.mjs';

const KIMI = getProfile('kimi-k2.7-code');
const TOOLS = [
  { name: 'runInTerminal', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'finish', description: 'end', parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
];

function ok(payload) {
  return { ok: true, json: async () => payload };
}

function assistantToolCalls(callSpecs, extra = {}) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: callSpecs.map(([name, args], i) => ({
      id: `c${i}-${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })),
    ...extra,
  };
}

function completion({ message, usage, model = KIMI.model, provider = 'Moonshot AI', id = 'gen-1', finishReason = 'tool_calls' }) {
  return ok({ id, model, provider, choices: [{ message, finish_reason: finishReason }], usage });
}

const USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 400 },
  completion_tokens_details: { reasoning_tokens: 25 },
  cost: 0.0012,
};
// Pinned Moonshot AI endpoint rates: (600 * 0.95 + 400 * 0.19 + 100 * 4.0) / 1e6
const USAGE_LOCAL_COST = 0.001046;

/** Driver wired to a scripted mock endpoint; returns the driver plus captured requests. */
function harness(responses, opts = {}) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const telemetry = createTelemetry();
  const budget = createBudget({ ceilingUsd: opts.ceilingUsd ?? 5, label: 'trial' });
  const driver = openAiToolDriver({ profile: KIMI, apiKey: 'k', fetchImpl, budget, telemetry, ...opts.driver });
  driver.reset({ system: 'sys', instruction: 'do the task', tools: TOOLS });
  return { driver, calls, telemetry, budget };
}

test('captures usage, local cost, provider cost, and generation/provider identifiers', async () => {
  const { driver, telemetry, budget } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'harness orient' }]]), usage: USAGE }),
  ]);
  const action = await driver.next();
  assert.equal(action.type, 'tool');
  const { totals, events } = telemetry.snapshot();
  assert.equal(totals.promptTokens, 1000);
  assert.equal(totals.cachedTokens, 400);
  assert.equal(totals.reasoningTokens, 25);
  assert.equal(totals.outputTokens, 100);
  assert.ok(Math.abs(totals.localCostUsd - USAGE_LOCAL_COST) < 1e-9);
  assert.ok(Math.abs(totals.providerCostUsd - 0.0012) < 1e-12);
  assert.ok(Math.abs(budget.spentUsd() - USAGE_LOCAL_COST) < 1e-9);
  const response = events.find((e) => e.type === 'response');
  assert.equal(response.generationId, 'gen-1');
  assert.equal(response.provider, 'Moonshot AI');
  assert.equal(response.model, KIMI.model);
  assert.equal(driver.fallbackDetected, false);
  assert.ok(!events.some((e) => e.type === 'fallback'), 'matching pinned provider must not read as fallback');
});

test('a paid, budgeted driver stops immediately when usage is unusable — no unmetered spending', async () => {
  const { driver, telemetry, budget } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }]]), usage: { prompt_tokens: 'lots' } }),
  ]);
  await assert.rejects(driver.next(), (err) => err.kind === 'usage' && err.billed === null);
  const { totals } = telemetry.snapshot();
  assert.equal(totals.missingUsage, 1, 'the unusable response is still counted');
  assert.equal(totals.costComplete, false);
  assert.equal(budget.spentUsd(), 0, 'nothing is charged and nothing further can be spent');
});

test('without pricing and budget, unusable usage is recorded but the run may continue', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    return completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }]]), usage: { prompt_tokens: 'lots' } });
  };
  const telemetry = createTelemetry();
  const driver = openAiToolDriver({ url: 'http://localhost:11434/v1/chat/completions', apiKey: 'ollama', model: 'qwen2.5-coder', fetchImpl, telemetry });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  const action = await driver.next();
  assert.equal(action.type, 'tool');
  assert.equal(telemetry.snapshot().totals.missingUsage, 1);
});

test('a resolved model different from the requested model is a fallback', async () => {
  const { driver, telemetry } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }]]), usage: USAGE, model: 'moonshotai/kimi-k2-instruct' }),
  ]);
  await driver.next();
  assert.equal(driver.fallbackDetected, true);
  const fallback = telemetry.snapshot().events.find((e) => e.type === 'fallback');
  assert.equal(fallback.requestedModel, KIMI.model);
  assert.equal(fallback.resolvedModel, 'moonshotai/kimi-k2-instruct');
});

test('a provider outside the pinned order is a fallback', async () => {
  const { driver, telemetry } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }]]), usage: USAGE, provider: 'DeepInfra' }),
  ]);
  await driver.next();
  assert.equal(driver.fallbackDetected, true);
  const fallback = telemetry.snapshot().events.find((e) => e.type === 'fallback');
  assert.equal(fallback.resolvedProvider, 'DeepInfra');
});

test('profile supplies endpoint, model, limits, and pinning; temperature stays model-default', async () => {
  const { driver, calls } = harness([completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' })]);
  await driver.next();
  assert.equal(calls[0].url, KIMI.url);
  const body = calls[0].body;
  assert.equal(body.model, KIMI.model);
  assert.equal(body.max_tokens, KIMI.maxTokens);
  assert.deepEqual(body.provider, { order: ['moonshotai'], allow_fallbacks: false });
  assert.ok(!('temperature' in body), 'temperature must be omitted so the model default applies');
  assert.ok(!('reasoning' in body), 'kimi profile sets no reasoning override');
});

test('explicit temperature and reasoning configuration are sent on the wire', async () => {
  const { driver, calls } = harness([completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' })], {
    driver: { temperature: 0.2, reasoning: { effort: 'low' } },
  });
  await driver.next();
  assert.equal(calls[0].body.temperature, 0.2);
  assert.deepEqual(calls[0].body.reasoning, { effort: 'low' });
});

test('reasoning metadata round-trips into the next request', async () => {
  const reasoningDetails = [{ type: 'reasoning.text', text: 'thought about the task' }];
  const { driver, calls } = harness([
    completion({
      message: assistantToolCalls([['runInTerminal', { command: 'ls' }]], { reasoning_details: reasoningDetails }),
      usage: USAGE,
    }),
    completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
  ]);
  const action = await driver.next();
  driver.observe(action, { runInTerminal: 'ls', code: 0, stdout: 'ok' });
  await driver.next();
  const echoed = calls[1].body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.deepEqual(echoed.reasoning_details, reasoningDetails, 'reasoning metadata must be preserved across turns');
});

test('multiple tool calls in one response drain without extra provider requests', async () => {
  const { driver, calls } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }], ['runInTerminal', { command: 'pwd' }]]), usage: USAGE }),
    completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
  ]);
  const first = await driver.next();
  driver.observe(first, { code: 0 });
  const second = await driver.next();
  driver.observe(second, { code: 0 });
  assert.equal(first.input.command, 'ls');
  assert.equal(second.input.command, 'pwd');
  assert.equal(calls.length, 1, 'both tool calls come from a single response');
  const finish = await driver.next();
  assert.equal(finish.type, 'finish');
  assert.equal(calls.length, 2);
});

test('oversized tool results are truncated at the configured limit and the truncation is recorded', async () => {
  const { driver, calls, telemetry } = harness(
    [
      completion({ message: assistantToolCalls([['runInTerminal', { command: 'cat big' }]]), usage: USAGE }),
      completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
    ],
    { driver: { toolResultLimit: 50 } }
  );
  const action = await driver.next();
  driver.observe(action, { runInTerminal: 'cat big', stdout: 'x'.repeat(10_000) });
  await driver.next();
  const toolMsg = calls[1].body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.content.length, 50);
  const truncation = telemetry.snapshot().events.find((e) => e.type === 'tool_result_truncated');
  assert.equal(truncation.limit, 50);
  assert.ok(truncation.originalChars > 10_000);
});

test('a request that could cross the ceiling is refused before it is sent', async () => {
  const { driver, calls, telemetry, budget } = harness(
    [completion({ message: { role: 'assistant', content: 'never reached' }, usage: USAGE, finishReason: 'stop' })],
    { ceilingUsd: 0 }
  );
  const action = await driver.next();
  assert.equal(action.type, 'finish');
  assert.equal(action.stopReason, 'budget_exhausted');
  assert.equal(calls.length, 0, 'the provider must never be called once the budget is exhausted');
  assert.ok(telemetry.snapshot().events.some((e) => e.type === 'budget_refusal'));
  assert.equal(budget.exhausted, true);
});

test('a transport failure is classified as an unbilled network failure', async () => {
  const { driver } = harness([new Error('socket hang up')]);
  await assert.rejects(driver.next(), (err) => err.kind === 'network' && err.billed === false);
});

test('a provider http error is classified as unbilled with its status', async () => {
  const { driver } = harness([{ ok: false, status: 502, json: async () => ({}) }]);
  await assert.rejects(driver.next(), (err) => err.kind === 'http' && err.billed === false && err.status === 502);
});

test('a malformed completion that still reports usage is a billable failure and is charged', async () => {
  const { driver, budget, telemetry } = harness([ok({ id: 'gen-9', model: KIMI.model, usage: USAGE })]);
  await assert.rejects(driver.next(), (err) => err.kind === 'provider' && err.billed === true);
  assert.ok(Math.abs(budget.spentUsd() - USAGE_LOCAL_COST) < 1e-9, 'billed usage must still be charged');
  assert.equal(telemetry.snapshot().totals.requests, 1);
});

test('a plain text completion finishes with an explicit model_finish stop reason', async () => {
  const { driver } = harness([completion({ message: { role: 'assistant', content: 'all done' }, usage: USAGE, finishReason: 'stop' })]);
  const action = await driver.next();
  assert.equal(action.type, 'finish');
  assert.equal(action.answer, 'all done');
  assert.equal(action.stopReason, 'model_finish');
});

test('an exhausted replay driver reports replay_exhausted', async () => {
  const driver = replayDriver([]);
  const action = await driver.next();
  assert.equal(action.type, 'finish');
  assert.equal(action.stopReason, 'replay_exhausted');
});

test('a zero-priced local profile with a budget tolerates unusable usage — it is not paid spend', async () => {
  const gemma = getProfile('gemma-4-26b-local');
  const fetchImpl = async () =>
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }]]), usage: { prompt_tokens: 'junk' }, model: gemma.model });
  const driver = openAiToolDriver({ profile: gemma, apiKey: 'ollama', fetchImpl, budget: createBudget({ ceilingUsd: 0 }), telemetry: createTelemetry() });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  const action = await driver.next();
  assert.equal(action.type, 'tool', 'free local runs must not die on missing usage');
});

test('the budget precheck grows with observed prompt sizes, not just a character guess', async () => {
  // First response reports a 1M-token prompt. The next request's precheck must
  // assume at least last prompt + last output tokens, so a ceiling with room
  // for only the first call refuses the second even though the payload chars
  // alone would estimate far less.
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000 };
  // First-call cost: (1M * 0.95 + 100k * 4.0) / 1M = 1.35
  const { driver } = harness(
    [
      completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }]]), usage }),
      completion({ message: { role: 'assistant', content: 'done' }, usage, finishReason: 'stop' }),
    ],
    { ceilingUsd: 2.0 }
  );
  const first = await driver.next();
  driver.observe(first, { code: 0 });
  const second = await driver.next();
  assert.equal(second.type, 'finish');
  assert.equal(second.stopReason, 'budget_exhausted', 'observed usage must inform the worst-case estimate');
});

test('reset clears fallback state so a reused driver cannot taint a fresh trial', async () => {
  const { driver } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }]]), usage: USAGE, model: 'moonshotai/kimi-k2-instruct' }),
  ]);
  await driver.next();
  assert.equal(driver.fallbackDetected, true);
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  assert.equal(driver.fallbackDetected, false);
});

test('a hung request aborts at the configured timeout as an unknown-billing timeout failure', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const driver = openAiToolDriver({ profile: KIMI, apiKey: 'k', fetchImpl, requestTimeoutMs: 20 });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  await assert.rejects(driver.next(), (err) => err.kind === 'timeout' && err.billed === null);
});

test('legacy construction without profile, budget, or telemetry still works with model-default temperature', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return completion({ message: { role: 'assistant', content: 'ok' }, usage: undefined, finishReason: 'stop' });
  };
  const driver = openAiToolDriver({ url: 'http://localhost:11434/v1/chat/completions', apiKey: 'ollama', model: 'qwen2.5-coder', fetchImpl });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  const action = await driver.next();
  assert.equal(action.type, 'finish');
  assert.ok(!('temperature' in calls[0].body));
  assert.ok(!('provider' in calls[0].body));
  assert.equal(openAiToolDriver({}), null);
});
