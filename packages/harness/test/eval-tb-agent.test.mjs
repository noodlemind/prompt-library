import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  BRIDGE_TOOLS,
  runtimeBridgeTools,
  runStdioAgent,
} from '../../../evals/external/terminal_bench/agent.mjs';
import { replayDriver, ProviderError } from '../../../evals/lib/drivers.mjs';
import { createTelemetry } from '../../../evals/lib/telemetry.mjs';

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
  const driver = { next: async () => ({ type: 'tool', name: 'bash', input: { command: 'true' } }) };
  const { input, output } = pump();
  const done = await runStdioAgent({ driver, input, output, maxSteps: 3, systemPrompt: 's', instruction: 'i' });
  assert.equal(done.stopReason, 'max_steps');
  assert.equal(done.steps, 3);
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
