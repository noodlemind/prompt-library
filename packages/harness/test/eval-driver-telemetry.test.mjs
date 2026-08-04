import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { openAiToolDriver, replayDriver } from '../../../evals/lib/drivers.mjs';
import { getProfile } from '../../../evals/lib/model-profiles.mjs';
import { createBudget } from '../../../evals/lib/budget.mjs';
import { createTelemetry } from '../../../evals/lib/telemetry.mjs';
import { buildPromptComponentManifest } from '../../../evals/lib/prompt-manifest.mjs';

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
  driver.reset({
    system: 'sys',
    instruction: 'do the task',
    tools: TOOLS,
    ...(opts.promptComponentManifest ? { promptComponentManifest: opts.promptComponentManifest } : {}),
  });
  return { driver, calls, telemetry, budget };
}

test('captures usage, exact outbound controls, local cost, provider cost, and generation/provider identifiers', async () => {
  const { driver, calls, telemetry, budget } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'harness orient' }]]), usage: USAGE }),
  ]);
  const action = await driver.next();
  assert.equal(action.type, 'tool');
  const { totals, events } = telemetry.snapshot();
  assert.equal(totals.promptTokens, 1000);
  assert.equal(totals.cachedTokens, 400);
  assert.equal(totals.reasoningTokens, 25);
  assert.equal(totals.cachedTokensComplete, true);
  assert.equal(totals.reasoningTokensComplete, true);
  assert.equal(totals.outputTokens, 100);
  assert.ok(Math.abs(totals.localCostUsd - USAGE_LOCAL_COST) < 1e-9);
  assert.ok(Math.abs(totals.providerCostUsd - 0.0012) < 1e-12);
  assert.ok(Math.abs(budget.spentUsd() - USAGE.cost) < 1e-9, 'the larger of local and provider cost is charged');
  const response = events.find((e) => e.type === 'response');
  assert.equal(response.generationId, 'gen-1');
  assert.equal(response.provider, 'Moonshot AI');
  assert.equal(response.model, KIMI.model);
  assert.equal(driver.fallbackDetected, false);
  assert.ok(!events.some((e) => e.type === 'fallback'), 'matching pinned provider must not read as fallback');
  const request = events.find((event) => event.type === 'request');
  assert.equal(request.toolMode, 'full');
  assert.equal(request.postVerify, false);
  assert.equal(request.toolCount, TOOLS.length);
  assert.match(request.toolSchemaHash, /^[a-f0-9]{64}$/);
  assert.equal(request.endpointHash, crypto.createHash('sha256').update(KIMI.url).digest('hex'));
  assert.equal(request.model, KIMI.model);
  assert.equal(request.maxTokens, KIMI.maxTokens);
  assert.equal(request.temperaturePresent, false);
  assert.equal(request.reasoningPresent, false);
  assert.equal(request.toolChoice, 'auto');
  assert.equal(request.providerPresent, true);
  assert.deepEqual(request.providerOrder, KIMI.provider.order);
  assert.equal(request.providerAllowFallbacks, false);
  assert.deepEqual(request.unexpectedRequestFields, []);
  assert.equal(
    request.requestBodyHash,
    crypto.createHash('sha256').update(JSON.stringify(calls[0].body)).digest('hex'),
    'the ledger binds the exact serialized provider body'
  );
  assert.match(request.requestControlHash, /^[a-f0-9]{64}$/);
});

test('missing provider token details stay null while conservative cost and billing remain usable', async () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 100, cost: 0.0015 };
  const { driver, telemetry, budget } = harness([
    completion({ message: { role: 'assistant', content: 'done' }, usage, finishReason: 'stop' }),
  ]);
  const action = await driver.next();
  assert.equal(action.type, 'finish');
  const { totals, events } = telemetry.snapshot();
  assert.equal(totals.cachedTokens, null);
  assert.equal(totals.reasoningTokens, null);
  assert.equal(totals.cachedTokensComplete, false);
  assert.equal(totals.reasoningTokensComplete, false);
  assert.equal(totals.usageComplete, true);
  assert.equal(totals.costComplete, true);
  assert.ok(budget.spentUsd() >= 0.0015);
  const response = events.find((event) => event.type === 'response');
  assert.equal(response.usage.cachedTokens, null);
  assert.equal(response.usage.reasoningTokens, null);
});

test('the provider-reported charge is reconciled inside the driver before another request can be sent', async () => {
  const expensiveUsage = { ...USAGE, cost: 0.04 };
  const { driver, calls, budget } = harness(
    [
      completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }]]), usage: expensiveUsage }),
      completion({ message: { role: 'assistant', content: 'must not run' }, usage: USAGE, finishReason: 'stop' }),
    ],
    { ceilingUsd: 0.04 }
  );
  const first = await driver.next();
  assert.equal(first.type, 'tool');
  assert.equal(budget.spentUsd(), 0.04, 'the larger provider amount, not the local estimate, is charged immediately');
  driver.observe(first, { code: 0, stdout: '', stderr: '' });
  const second = await driver.next();
  assert.equal(second.stopReason, 'budget_exhausted');
  assert.equal(calls.length, 1, 'provider reconciliation cannot leave room for another request');
});

test('a paid, budgeted driver stops immediately when usage is unusable and reserves the remaining allowance', async () => {
  const { driver, telemetry, budget } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }]]), usage: { prompt_tokens: 'lots' } }),
  ]);
  await assert.rejects(driver.next(), (err) => err.kind === 'usage' && err.billed === null);
  const { totals } = telemetry.snapshot();
  assert.equal(totals.missingUsage, 1, 'the unusable response is still counted');
  assert.equal(totals.costComplete, false);
  assert.equal(budget.spentUsd(), budget.ceilingUsd, 'unknown billing conservatively reserves the full remaining trial allowance');
  assert.ok(telemetry.snapshot().events.some((event) => event.type === 'billing_uncertain' && event.reservedUsd > 0));
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
  assert.deepEqual(body.provider, { order: ['moonshotai/int4'], allow_fallbacks: false });
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
  const { driver, calls, telemetry } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'ls' }], ['runInTerminal', { command: 'pwd' }]]), usage: USAGE }),
    completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
  ]);
  const first = await driver.next();
  assert.equal(
    telemetry.snapshot().events.filter((event) => event.type === 'tool_call').length,
    2,
    'all provider-issued calls are recorded before the first one executes'
  );
  driver.observe(first, { code: 0 });
  const second = await driver.next();
  driver.observe(second, { code: 0 });
  assert.equal(first.input.command, 'ls');
  assert.equal(second.input.command, 'pwd');
  assert.equal(calls.length, 1, 'both tool calls come from a single response');
  const toolCalls = telemetry.snapshot().events.filter((event) => event.type === 'tool_call');
  assert.equal(toolCalls.length, 2);
  assert.ok(toolCalls[0].requestId);
  assert.equal(toolCalls[1].requestId, toolCalls[0].requestId, 'every call from one completion retains its provider request identity');
  const finish = await driver.next();
  assert.equal(finish.type, 'finish');
  assert.equal(calls.length, 2);
});

test('finish suppresses every sibling actionable call with a correlated terminal result', async () => {
  const { driver, telemetry, calls } = harness([
    completion({
      message: assistantToolCalls([
        ['finish', { answer: 'complete' }],
        ['runInTerminal', { command: 'echo must-not-run' }],
      ]),
      usage: USAGE,
    }),
  ]);
  const result = await driver.next();
  assert.equal(result.type, 'finish');
  assert.equal(result.answer, 'complete');
  assert.equal(calls.length, 1);
  const events = telemetry.snapshot().events;
  const issued = events.filter((event) => event.type === 'tool_call');
  const terminals = events.filter((event) => event.type === 'tool_result');
  assert.equal(issued.length, 2);
  assert.equal(terminals.length, 2);
  assert.deepEqual(
    terminals.map((event) => `${event.requestId}:${event.toolCallId}`).sort(),
    issued.map((event) => `${event.requestId}:${event.toolCallId}`).sort()
  );
  const suppressed = terminals.find((event) => event.tool === 'runInTerminal');
  assert.equal(suppressed.exitCode, 126);
  assert.equal(suppressed.containmentMode, 'bridge-local');
  assert.equal(suppressed.containmentComplete, true);
  assert.ok(events.some((event) => event.type === 'tool_call_suppressed' && event.reason === 'finish_selected'));
});

test('markVerified and explicit step-ceiling suppression close every pending tool call', async () => {
  for (const mode of ['verification', 'step_ceiling']) {
    const { driver, telemetry } = harness([
      completion({
        message: assistantToolCalls([
          ['runInTerminal', { command: 'first' }],
          ['runInTerminal', { command: 'second' }],
        ]),
        usage: USAGE,
      }),
    ]);
    const first = await driver.next();
    driver.observe(first, {
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      containmentMode: 'linux-process-census',
      containmentComplete: true,
    });
    if (mode === 'verification') driver.markVerified({ fallbackAnswer: 'verified' });
    else driver.suppressPending('step_ceiling');
    const events = telemetry.snapshot().events;
    const calls = events.filter((event) => event.type === 'tool_call');
    const results = events.filter((event) => event.type === 'tool_result');
    assert.equal(calls.length, 2, mode);
    assert.equal(results.length, 2, mode);
    assert.deepEqual(
      results.map((event) => `${event.requestId}:${event.toolCallId}`).sort(),
      calls.map((event) => `${event.requestId}:${event.toolCallId}`).sort(),
      mode
    );
    assert.equal(results.at(-1).exitCode, 126);
  }
});

test('malformed provider tool arguments are explicit and cannot become an empty successful command', async () => {
  const malformed = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'bad-json', type: 'function', function: { name: 'runInTerminal', arguments: '{not-json' } }],
  };
  const { driver, telemetry } = harness([completion({ message: malformed, usage: USAGE })]);
  const action = await driver.next();
  assert.equal(action.type, 'tool');
  assert.equal(action._argumentsValid, false);
  assert.match(action._argumentError, /valid JSON object/);
  const event = telemetry.snapshot().events.find((candidate) => candidate.type === 'tool_call');
  assert.equal(event.argumentsValid, false);
  assert.equal(event.category, 'invalid');
});

test('a malformed finish call is retained in the one-to-one ledger', async () => {
  const message = {
    role: 'assistant',
    content: 'fallback summary',
    tool_calls: [{ id: 'bad-finish', type: 'function', function: { name: 'finish', arguments: '{broken' } }],
  };
  const { driver, telemetry } = harness([completion({ message, usage: USAGE })]);
  const result = await driver.next();
  assert.equal(result.type, 'finish');
  assert.equal(result.answer, 'fallback summary');
  const events = telemetry.snapshot().events;
  const call = events.find((event) => event.type === 'tool_call' && event.toolCallId === 'bad-finish');
  const terminal = events.find((event) => event.type === 'tool_result' && event.toolCallId === 'bad-finish');
  assert.equal(call.argumentsValid, false);
  assert.equal(terminal.exitCode, 126);
  assert.equal(terminal.requestId, call.requestId);
});

test('oversized tool results become valid bounded head/tail JSON and the compaction is recorded', async () => {
  const { driver, calls, telemetry } = harness(
    [
      completion({ message: assistantToolCalls([['runInTerminal', { command: 'cat big' }]]), usage: USAGE }),
      completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
    ],
    { driver: { toolResultLimit: 320 } }
  );
  const action = await driver.next();
  driver.observe(action, { code: 7, stdout: `HEAD-${'x'.repeat(10_000)}-TAIL`, stderr: 'important failure' });
  await driver.next();
  const toolMsg = calls[1].body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.ok(toolMsg.content.length <= 320);
  const compacted = JSON.parse(toolMsg.content);
  assert.equal(compacted.code, 7);
  assert.match(compacted.stderr, /important failure/);
  assert.match(compacted.stdout, /HEAD-/);
  assert.match(compacted.stdout, /-TAIL/);
  assert.ok(compacted._truncated.omittedChars > 0);
  const truncation = telemetry.snapshot().events.find((e) => e.type === 'tool_result_compacted');
  assert.equal(truncation.limit, 320);
  assert.ok(truncation.originalChars > 10_000);
});

test('tool call and result telemetry is correlated, timed, categorized, and never stores raw arguments or output', async () => {
  const secret = 'sk-live-secret-value';
  const { driver, telemetry } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: `printf ${secret} > result.txt` }]]), usage: USAGE }),
  ]);
  const action = await driver.next();
  driver.observe(action, { code: 0, stdout: secret, stderr: '' });
  const snapshot = telemetry.snapshot();
  const call = snapshot.events.find((event) => event.type === 'tool_call');
  const result = snapshot.events.find((event) => event.type === 'tool_result');
  assert.equal(call.toolCallId, action._id);
  assert.equal(result.toolCallId, action._id);
  assert.equal(call.category, 'edit');
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs >= 0);
  assert.ok(call.argsHash && result.resultHash);
  assert.equal(call.argsChars > 0, true);
  assert.equal(result.stdoutChars, secret.length);
  assert.doesNotMatch(JSON.stringify({ call, result }), new RegExp(secret));
});

test('immutable harness-cli invocations retain lifecycle categories without matching lookalike commands', async () => {
  const { driver, telemetry } = harness([
    completion({
      message: assistantToolCalls([
        ['runInTerminal', { command: 'cd /workspace && /opt/harness-bundle/harness-cli verify --json' }],
        ['runInTerminal', { command: 'evil-harness-cli verify' }],
        ['runInTerminal', { command: 'echo harness recall' }],
      ]),
      usage: USAGE,
    }),
  ]);
  let action = await driver.next();
  driver.observe(action, { code: 0, stdout: '', stderr: '' });
  action = await driver.next();
  driver.observe(action, { code: 0, stdout: '', stderr: '' });
  action = await driver.next();
  driver.observe(action, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(
    telemetry.snapshot().events.filter((event) => event.type === 'tool_call').map((event) => event.category),
    ['verify', 'other', 'other']
  );
  assert.equal(
    telemetry.snapshot().events.filter((event) => event.type === 'tool_call').at(-1).harnessOperation,
    null,
    'mentioning a Harness command as data must not count as lifecycle engagement'
  );
});

test('history-rewriting Git work is timed as an edit while read-only Git checks remain inspection', async () => {
  const commands = [
    ['git filter-repo --path secret.txt --invert-paths --force', 'edit'],
    ['git reflog expire --expire=now --all', 'edit'],
    ['git gc --prune=now', 'edit'],
    ['git update-ref -d refs/original/main', 'edit'],
    ['git -C /app rebase --root', 'edit'],
    ['git reset --hard HEAD~1', 'edit'],
    ['git fsck --no-reflogs --unreachable', 'inspect'],
    ['git rev-list --objects --all', 'inspect'],
    ['git cat-file -p HEAD', 'inspect'],
  ];
  const { driver, telemetry } = harness([
    completion({
      message: assistantToolCalls(commands.map(([command]) => ['runInTerminal', { command }])),
      usage: USAGE,
    }),
  ]);
  for (let index = 0; index < commands.length; index += 1) {
    const action = await driver.next();
    driver.observe(action, { code: 0, stdout: '', stderr: '' });
  }
  assert.deepEqual(
    telemetry.snapshot().events.filter((event) => event.type === 'tool_call').map((event) => event.category),
    commands.map(([, category]) => category)
  );
});

test('read-only script file access is not mislabeled as a workspace mutation', async () => {
  const commands = [
    ['python -c "print(open(\'README.md\').read())"', 'other'],
    ['python -c "open(\'result.txt\', \'w\').write(\'done\')"', 'edit'],
    ['node -e "require(\'fs\').writeFileSync(\'result.txt\', \'done\')"', 'edit'],
  ];
  const { driver, telemetry } = harness([
    completion({
      message: assistantToolCalls(commands.map(([command]) => ['runInTerminal', { command }])),
      usage: USAGE,
    }),
  ]);
  for (const _entry of commands) {
    const action = await driver.next();
    driver.observe(action, { code: 0, stdout: '', stderr: '' });
  }
  assert.deepEqual(
    telemetry.snapshot().events.filter((event) => event.type === 'tool_call').map((event) => event.category),
    commands.map(([, category]) => category)
  );
});

test('mutations containing test-like paths remain edits while actual test runners remain tests', async () => {
  const commands = [
    ['rm -rf test-output', 'edit'],
    ["sed -i 's/a/b/' src/test_util.py", 'edit'],
    ['printf x > tests/result.txt', 'edit'],
    ['echo test', 'other'],
    ['echo "not a command: && pytest"', 'other'],
    ['cat test', 'inspect'],
    ['rg pytest .', 'inspect'],
    ['npm view test', 'other'],
    ['npm --prefix packages/harness test', 'test'],
    ['pytest -q', 'test'],
    ['python -m pytest -q', 'test'],
    ['go test ./...', 'test'],
    ['cargo test --workspace', 'test'],
    ['node --test packages/harness/test/eval-budget.test.mjs', 'test'],
    ['npx vitest run', 'test'],
  ];
  const { driver, telemetry } = harness([
    completion({
      message: assistantToolCalls(commands.map(([command]) => ['runInTerminal', { command }])),
      usage: USAGE,
    }),
  ]);
  for (const _entry of commands) {
    const action = await driver.next();
    driver.observe(action, { code: 0, stdout: '', stderr: '' });
  }
  assert.deepEqual(
    telemetry.snapshot().events.filter((event) => event.type === 'tool_call').map((event) => event.category),
    commands.map(([, category]) => category)
  );
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

test('the pre-send prompt-token bound uses UTF-8 bytes and declares its estimate semantics', async () => {
  const telemetry = createTelemetry();
  const budget = createBudget({ ceilingUsd: 0, label: 'utf8-bound' });
  const driver = openAiToolDriver({
    profile: KIMI,
    apiKey: 'k',
    fetchImpl: async () => {
      throw new Error('must not send');
    },
    budget,
    telemetry,
  });
  driver.reset({ system: '🧪'.repeat(20), instruction: 'i', tools: TOOLS });
  const result = await driver.next();
  assert.equal(result.stopReason, 'budget_exhausted');
  const refusal = telemetry.snapshot().events.find((event) => event.type === 'budget_refusal');
  assert.equal(refusal.promptTokenUpperBound, refusal.payloadBytes);
  assert.ok(refusal.payloadBytes > refusal.payloadChars, 'multi-byte prompt text must not be priced by UTF-16 character count');
  assert.equal(refusal.maxOutputTokens, KIMI.maxTokens);
  assert.equal(refusal.estimateSemantics, 'utf8-bytes-upper-bound-plus-max-output');
});

test('a transport failure is unknown-billing and closes its correlated attempt', async () => {
  const { driver, telemetry, budget } = harness([new Error('socket hang up')]);
  await assert.rejects(driver.next(), (err) => err.kind === 'network' && err.billed === null);
  const { totals, events } = telemetry.snapshot();
  assert.equal(totals.providerAttempts, 1);
  assert.equal(totals.providerErrors, 1);
  assert.equal(totals.unknownBillingAttempts, 1);
  assert.equal(totals.costComplete, false);
  const error = events.find((event) => event.type === 'error' && event.kind === 'network');
  assert.ok(error.requestId && error.attemptId);
  assert.equal(error.billingStatus, 'unknown');
  assert.equal(budget.spentUsd(), budget.ceilingUsd, 'an ambiguous transport outcome consumes the trial allowance');
});

test('transient provider errors (429) back off and retry within the same request', async () => {
  const responses = [
    { ok: false, status: 429, headers: { get: () => '0' }, json: async () => ({}) },
    { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) },
    completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
  ];
  let i = 0;
  const sleeps = [];
  const telemetry = createTelemetry();
  const driver = openAiToolDriver({
    profile: KIMI,
    apiKey: 'k',
    fetchImpl: async () => responses[Math.min(i++, responses.length - 1)],
    telemetry,
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  const action = await driver.next();
  assert.equal(action.type, 'finish', 'the request succeeds after unbilled retries');
  assert.equal(i, 3, 'two 429s then success');
  assert.equal(sleeps.length, 2, 'each retry waits before re-sending');
  const { totals, events } = telemetry.snapshot();
  assert.equal(totals.modelRequests, 1);
  assert.equal(totals.providerAttempts, 3);
  assert.equal(totals.providerResponses, 1);
  assert.equal(totals.providerErrors, 2);
  assert.equal(totals.retries, 2);
  assert.equal(totals.billingComplete, true, '429s are the only default confirmed-unbilled retry status');
  const attempts = events.filter((event) => event.type === 'request_attempt');
  const terminals = events.filter((event) => event.type === 'response' || event.type === 'error');
  assert.deepEqual(terminals.map((event) => event.attemptId), attempts.map((event) => event.attemptId));
  assert.ok(terminals.every((event) => event.requestId === attempts[0].requestId));
  assert.deepEqual(sleeps, [0, 4000], 'an absent Retry-After header uses exponential backoff instead of being parsed as zero');
});

test('Retry-After is clamped to thirty seconds', async () => {
  const sleeps = [];
  let attempts = 0;
  const driver = openAiToolDriver({
    profile: KIMI,
    apiKey: 'k',
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 429, headers: { get: () => '999' }, json: async () => ({}) };
      return completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' });
    },
    transientRetries: 1,
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  await driver.next();
  assert.deepEqual(sleeps, [30_000]);
});

test('a 429 backoff cannot extend one logical request past its deadline', async () => {
  let now = 0;
  let attempts = 0;
  const sleeps = [];
  const telemetry = createTelemetry({ monotonicNow: () => now });
  const driver = openAiToolDriver({
    profile: KIMI,
    apiKey: 'k',
    fetchImpl: async () => {
      attempts += 1;
      const retryAfter = attempts === 1 ? '0.6' : '0.5';
      return { ok: false, status: 429, headers: { get: () => retryAfter }, json: async () => ({}) };
    },
    requestTimeoutMs: 1_000,
    transientRetries: 2,
    monotonicNow: () => now,
    telemetry,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });

  await assert.rejects(driver.next(), (error) => error.kind === 'timeout');
  assert.equal(attempts, 2, 'only the retry that fits inside the logical deadline may begin');
  assert.deepEqual(sleeps, [600], 'cumulative backoffs may not consume more than the logical deadline');
  const { totals, events } = telemetry.snapshot();
  assert.equal(totals.providerAttempts, 2);
  assert.equal(totals.providerErrors, 2);
  assert.equal(totals.retries, 1);
  assert.equal(totals.openAttempts, 0);
  assert.equal(totals.billingComplete, true, 'both completed 429 attempts are confirmed unbilled');
  assert.ok(events.some((event) => event.type === 'request_deadline_exhausted' && event.phase === 'backoff'));
});

test('a deadline abort while reading the response body remains an unknown-billing timeout', async () => {
  const telemetry = createTelemetry();
  const budget = createBudget({ ceilingUsd: 1, label: 'response-body-timeout' });
  const driver = openAiToolDriver({
    profile: KIMI,
    apiKey: 'k',
    requestTimeoutMs: 20,
    telemetry,
    budget,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted while reading the response body', 'AbortError')),
          { once: true }
        );
      }),
    }),
  });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });

  await assert.rejects(
    driver.next(),
    (error) => error.kind === 'timeout' && error.billed === null && error.billingUncertain === true
  );
  const { totals, events } = telemetry.snapshot();
  assert.equal(totals.providerAttempts, 1);
  assert.equal(totals.providerErrors, 1);
  assert.equal(totals.openAttempts, 0);
  assert.equal(totals.billingComplete, false);
  assert.equal(budget.spentUsd(), budget.ceilingUsd, 'an in-flight timeout reserves the remaining allowance');
  assert.ok(events.some((event) =>
    event.type === 'error' && event.kind === 'timeout' && event.billingStatus === 'unknown'
  ));
  assert.ok(events.some((event) =>
    event.type === 'request_deadline_exhausted' && event.phase === 'response_body'
  ));
});

test('retries exhaust into a classified http failure; terminal statuses never retry', async () => {
  const always429 = { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  let attempts = 0;
  const driver = openAiToolDriver({
    profile: KIMI,
    apiKey: 'k',
    fetchImpl: async () => {
      attempts += 1;
      return always429;
    },
    transientRetries: 2,
    sleepImpl: async () => {},
  });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  await assert.rejects(driver.next(), (err) => err.kind === 'http' && err.status === 429 && err.billed === false);
  assert.equal(attempts, 3, 'initial attempt plus two retries');

  let paymentAttempts = 0;
  const d402 = openAiToolDriver({
    profile: KIMI,
    apiKey: 'k',
    fetchImpl: async () => {
      paymentAttempts += 1;
      return { ok: false, status: 402, json: async () => ({}) };
    },
    sleepImpl: async () => {},
  });
  d402.reset({ system: 's', instruction: 'i', tools: TOOLS });
  await assert.rejects(d402.next(), (err) => err.kind === 'http' && err.status === 402);
  assert.equal(paymentAttempts, 1, 'a 402 is terminal — retrying cannot mint credits');
});

test('a provider http error has unknown billing with its status', async () => {
  const { driver, telemetry } = harness([{ ok: false, status: 502, json: async () => ({}) }]);
  await assert.rejects(driver.next(), (err) => err.kind === 'http' && err.billed === null && err.status === 502);
  assert.equal(telemetry.snapshot().totals.billingComplete, false);
});

test('heavily reduced durable state remains valid bounded JSON', async () => {
  const { driver, calls } = harness(
    [
      completion({ message: assistantToolCalls([['runInTerminal', { command: 'cat large.log' }]]), usage: USAGE }),
      completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
    ],
    { driver: { maxPayloadChars: 1200, maxStateChars: 180, retainCompletedTurns: 0 } }
  );
  driver.checkpoint({
    goal: 'g'.repeat(5000),
    constraints: Array.from({ length: 30 }, (_, i) => `constraint-${i}-${'x'.repeat(200)}`),
    files: { changed: ['src/critical-result.js'] },
    tests: [{ command: 'npm test', status: 'failed', summary: 'one failure' }],
    failures: [{ command: 'npm test', exitCode: 1, summary: 'assertion' }],
    nextAction: 'repair the failing assertion',
  });
  const action = await driver.next();
  driver.observe(action, { code: 0, stdout: 'x'.repeat(8000), stderr: '' });
  await driver.next();
  const stateMessage = calls.at(-1).body.messages.find((message) => String(message.content).startsWith('# Durable eval state\n'));
  assert.ok(stateMessage);
  const serializedState = stateMessage.content.slice('# Durable eval state\n'.length);
  assert.ok(serializedState.length <= 180);
  const parsedState = JSON.parse(serializedState);
  assert.match(parsedState.goal, /^g+/);
  assert.ok(parsedState.constraints.length > 0);
  assert.ok(parsedState.files.changed.length > 0);
  assert.ok(parsedState.tests.length > 0);
  assert.ok(parsedState.failures.length > 0);
  assert.ok(parsedState.nextAction);
});

test('a malformed completion that still reports usage is a billable failure and is charged', async () => {
  const { driver, budget, telemetry } = harness([ok({ id: 'gen-9', model: KIMI.model, usage: USAGE })]);
  await assert.rejects(driver.next(), (err) => err.kind === 'provider' && err.billed === true);
  assert.ok(Math.abs(budget.spentUsd() - USAGE.cost) < 1e-9, 'billed usage must still be charged at the reconciled amount');
  assert.equal(telemetry.snapshot().totals.requests, 1);
});

test('a 200 partial provider error is charged but never accepted as a model completion', async () => {
  const response = ok({
    id: 'gen-partial',
    model: KIMI.model,
    provider: 'Moonshot AI',
    choices: [{
      message: { role: 'assistant', content: 'partial answer' },
      finish_reason: 'error',
      error: { code: 502, message: 'upstream failed' },
    }],
    usage: USAGE,
  });
  const { driver, budget, telemetry } = harness([response]);
  await assert.rejects(driver.next(), (error) => error.kind === 'provider' && error.billed === true);
  assert.ok(Math.abs(budget.knownReconciledSpendUsd() - USAGE.cost) < 1e-9);
  const { totals, events } = telemetry.snapshot();
  assert.equal(totals.providerResponses, 0);
  assert.equal(totals.providerErrors, 1);
  assert.equal(totals.promptTokens, USAGE.prompt_tokens);
  assert.equal(events.some((event) => event.type === 'completion_error'), true);
});

test('reasoning tokens above completion tokens are retained as unknown detail', async () => {
  const usage = {
    ...USAGE,
    completion_tokens: 10,
    completion_tokens_details: { reasoning_tokens: 11 },
  };
  const { driver, telemetry } = harness([
    completion({ message: { role: 'assistant', content: 'done' }, usage, finishReason: 'stop' }),
  ]);
  await driver.next();
  const { totals } = telemetry.snapshot();
  assert.equal(totals.reasoningTokens, null);
  assert.equal(totals.reasoningTokensComplete, false);
});

test('a paid response without provider cost fail-stops and reserves the remainder after charging the local estimate', async () => {
  const usage = { ...USAGE };
  delete usage.cost;
  const { driver, telemetry } = harness([
    completion({ message: { role: 'assistant', content: 'done' }, usage, finishReason: 'stop' }),
  ]);
  await assert.rejects(driver.next(), (error) => error.kind === 'billing' && error.billed === null);
  const { totals } = telemetry.snapshot();
  assert.ok(totals.localCostUsd > 0);
  assert.equal(totals.providerCostUsd, null);
  assert.equal(totals.providerCostComplete, false);
  assert.equal(totals.billingComplete, false);
  assert.equal(totals.costComplete, false);
  assert.equal(telemetry.snapshot().events.some((event) => event.type === 'billing_uncertain'), true);
});

test('provider-controlled strings cannot reflect the active API key into telemetry, messages, errors, or actions', async () => {
  const secret = 'sk-reflected-secret';
  const response = completion({
    id: `generation-${secret}`,
    model: `model-${secret}`,
    provider: `provider-${secret}`,
    message: assistantToolCalls([['runInTerminal', { command: `printf ${secret}` }]], { content: secret }),
    usage: USAGE,
    finishReason: `finish-${secret}`,
  });
  const telemetry = createTelemetry();
  const driver = openAiToolDriver({
    profile: KIMI,
    apiKey: secret,
    fetchImpl: async () => response,
    budget: createBudget({ ceilingUsd: 5 }),
    telemetry,
  });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  const action = await driver.next();
  assert.doesNotMatch(JSON.stringify(action), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(telemetry.snapshot()), new RegExp(secret));
});

test('request telemetry records request and payload footprint without retaining message content', async () => {
  const { driver, telemetry } = harness([
    completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
  ]);
  await driver.next();
  const request = telemetry.snapshot().events.find((event) => event.type === 'request');
  assert.ok(request.requestId);
  assert.ok(request.payloadChars > 0);
  assert.ok(request.systemChars > 0);
  assert.ok(request.toolSchemaChars > 0);
  assert.ok(request.messagesHash);
  assert.equal(request.systemPromptPosition, 0);
  assert.equal(request.instructionPosition, 1);
  assert.equal(request.durableStateMessageCount, 0);
  assert.equal(request.unexpectedSystemMessageCount, 0);
  assert.equal('messages' in request, false);
});

test('request telemetry binds content-free prompt components and exact context buckets to memory operations', async () => {
  const systemPrompt = 'sys';
  const promptComponentManifest = {
    schema: 'prompt-component-manifest.v1',
    separator: '\n\n',
    systemPromptChars: systemPrompt.length,
    systemPromptBytes: Buffer.byteLength(systemPrompt, 'utf8'),
    systemPromptHash: crypto.createHash('sha256').update(systemPrompt).digest('hex'),
    complete: true,
    components: [{
      id: 'engineer-contract',
      ordinal: 0,
      startChar: 0,
      endChar: systemPrompt.length,
      chars: systemPrompt.length,
      bytes: Buffer.byteLength(systemPrompt, 'utf8'),
      sha256: crypto.createHash('sha256').update(systemPrompt).digest('hex'),
    }],
  };
  const { driver, telemetry } = harness([
    completion({
      message: assistantToolCalls([['runInTerminal', { command: '/opt/harness-bundle/harness-cli recall payment --json' }]]),
      usage: USAGE,
    }),
    completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
  ], { promptComponentManifest });

  const action = await driver.next();
  driver.observe(action, { code: 0, stdout: 'one bounded memory card', stderr: '' });
  await driver.next();

  const events = telemetry.snapshot().events;
  const recall = events.find((event) => event.type === 'tool_call');
  assert.equal(recall.harnessOperation, 'recall');
  assert.equal(recall.contextSource, 'memory-retrieval');
  const request = events.filter((event) => event.type === 'request').at(-1);
  assert.deepEqual(request.promptComponentManifest, promptComponentManifest);
  assert.equal(request.promptBuckets.complete, true);
  assert.ok(request.promptBuckets.toolResultHistoryBySource['memory-retrieval'] > 0);
  const disjointTotal = [
    'baseSystem', 'instruction', 'durableState', 'assistantHistory',
    'toolResultHistory', 'otherMessages', 'messageEnvelope', 'toolSchema', 'payloadEnvelope',
  ].reduce((sum, key) => sum + request.promptBuckets[key], 0);
  assert.equal(disjointTotal, request.payloadChars, 'disjoint serialized buckets must explain the complete provider request');
  assert.equal(JSON.stringify(request).includes('one bounded memory card'), false, 'telemetry retains sizes and hashes, never memory content');
});

test('prompt component manifests reject unknown content fields without leaking their values', () => {
  const secret = 'RAW-PROMPT-CONTENT-MUST-NOT-SURVIVE';
  const systemPrompt = 'sys';
  const component = {
    id: 'engineer-contract', ordinal: 0, startChar: 0, endChar: systemPrompt.length,
    chars: systemPrompt.length, bytes: Buffer.byteLength(systemPrompt, 'utf8'),
    sha256: crypto.createHash('sha256').update(systemPrompt).digest('hex'),
  };
  const manifest = {
    schema: 'prompt-component-manifest.v1', separator: '\n\n',
    systemPromptChars: systemPrompt.length,
    systemPromptBytes: Buffer.byteLength(systemPrompt, 'utf8'),
    systemPromptHash: crypto.createHash('sha256').update(systemPrompt).digest('hex'),
    complete: true,
    components: [{ ...component, content: secret }],
    content: secret,
  };
  let observed;
  try {
    harness([completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE })], {
      promptComponentManifest: manifest,
    });
  } catch (error) {
    observed = error;
  }
  assert.ok(observed);
  assert.match(observed.message, /manifest.*unexpected field/i);
  assert.doesNotMatch(observed.message, new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(observed.details ?? {}), new RegExp(secret));
});

test('the driver verifies structurally valid component hashes against the actual system prompt', () => {
  const { manifest } = buildPromptComponentManifest([{ id: 'system', content: 'sys' }]);
  manifest.components[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => harness([completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE })], {
      promptComponentManifest: manifest,
    }),
    /invalid component span/i
  );
});

test('deterministic compaction bounds the request and retains durable task state without orphaning tool messages', async () => {
  const responses = [
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'cat large.log' }]]), usage: USAGE }),
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'npm test' }]]), usage: USAGE }),
    completion({ message: { role: 'assistant', content: 'done' }, usage: USAGE, finishReason: 'stop' }),
  ];
  const { driver, calls, telemetry } = harness(responses, {
    driver: { maxPayloadChars: 1300, toolResultLimit: 500, retainCompletedTurns: 1 },
  });
  driver.checkpoint({
    schema: 'eval-agent-state.v1',
    goal: 'repair the service',
    constraints: ['do not change public API'],
    files: { inspected: ['src/a.js'], changed: ['src/b.js'] },
    tests: [{ command: 'npm test', status: 'failed', summary: 'one failure' }],
    failures: [{ command: 'npm test', exitCode: 1, summary: 'assertion' }],
  });
  let action = await driver.next();
  driver.observe(action, { code: 0, stdout: 'x'.repeat(8000), stderr: '' });
  action = await driver.next();
  driver.observe(action, { code: 1, stdout: '', stderr: 'failure'.repeat(500) });
  await driver.next();
  const last = calls.at(-1).body;
  assert.ok(JSON.stringify(last).length <= 1300);
  assert.equal(JSON.stringify(last).includes('_evalState'), false, 'internal compaction markers never enter provider messages');
  const text = JSON.stringify(last.messages);
  for (const retained of ['repair the service', 'do not change public API', 'src/b.js', 'npm test', 'assertion']) {
    assert.match(text, new RegExp(retained));
  }
  const toolIds = new Set(last.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
  for (const message of last.messages.filter((item) => item.role === 'assistant' && item.tool_calls)) {
    assert.ok(message.tool_calls.every((call) => toolIds.has(call.id)), 'no assistant tool call may survive without its tool result');
  }
  const events = telemetry.snapshot().events;
  assert.ok(events.some((event) => event.type === 'context_compacted'));
  const compactedRequest = events.filter((event) => event.type === 'request').at(-1);
  assert.equal(compactedRequest.systemPromptPosition, 0);
  assert.equal(compactedRequest.instructionPosition, 1);
  assert.equal(compactedRequest.systemMessageCount, 2);
  assert.equal(compactedRequest.durableStateMessageCount, 1);
  assert.equal(compactedRequest.durableStateMessageIndex, 2);
  assert.match(compactedRequest.durableStateMessageHash, /^[a-f0-9]{64}$/);
  assert.equal(compactedRequest.unexpectedSystemMessageCount, 0);
});

test('checkpoint normalizes malformed collection shapes before later observations', () => {
  const { driver } = harness([]);
  driver.checkpoint({ files: 'not-an-object', tests: { invalid: true }, failures: 'not-an-array' });
  assert.doesNotThrow(() => driver.observe(
    { name: 'runInTerminal', input: { command: 'printf updated > src/result.txt' }, _id: 'edit-1', _category: 'edit' },
    { code: 0, stdout: '', stderr: '' }
  ));
  assert.doesNotThrow(() => driver.observe(
    { name: 'runInTerminal', input: { command: 'npm test' }, _id: 'test-1', _category: 'test' },
    { code: 1, stdout: '', stderr: 'failed' }
  ));
});

test('verified stop permits one final provider attempt and suppresses later tool work', async () => {
  const { driver, calls, telemetry } = harness([
    completion({ message: assistantToolCalls([['runInTerminal', { command: 'echo should-not-run' }]]), usage: USAGE }),
  ]);
  driver.markVerified({ plan: 'docs/plans/task.md', evidencePath: '.harness/evidence/task.json', fallbackAnswer: 'verified' });
  const finish = await driver.next();
  assert.equal(finish.type, 'finish');
  assert.equal(finish.stopReason, 'verified_stop');
  assert.equal(finish.answer, 'verified');
  assert.equal(calls.length, 1);
  const request = telemetry.snapshot().events.find((event) => event.type === 'request');
  assert.equal(request.toolMode, 'finish-only');
  assert.equal(request.postVerify, true);
  assert.equal(request.toolCount, 1);
  assert.match(request.toolSchemaHash, /^[a-f0-9]{64}$/);
  const again = await driver.next();
  assert.equal(again.stopReason, 'verified_stop');
  assert.equal(calls.length, 1, 'verified completion never issues a second provider request');
  assert.ok(telemetry.snapshot().events.some((event) => event.type === 'post_verify_tool_suppressed'));
});

test('verified stop disables 429 retries and falls back locally on the final attempt', async () => {
  let attempts = 0;
  const driver = openAiToolDriver({
    profile: KIMI,
    apiKey: 'k',
    fetchImpl: async () => {
      attempts += 1;
      return { ok: false, status: 429, headers: { get: () => '0' }, json: async () => ({}) };
    },
    telemetry: createTelemetry(),
    sleepImpl: async () => {},
  });
  driver.reset({ system: 's', instruction: 'i', tools: TOOLS });
  driver.markVerified({ fallbackAnswer: 'verified locally' });
  const finish = await driver.next();
  assert.equal(finish.type, 'finish');
  assert.equal(finish.stopReason, 'verified_stop');
  assert.equal(finish.answer, 'verified locally');
  assert.equal(attempts, 1);
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
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000, cost: 1.35 };
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
