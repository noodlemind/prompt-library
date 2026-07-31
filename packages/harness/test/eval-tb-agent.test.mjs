import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { BRIDGE_TOOLS, runStdioAgent } from '../../../evals/external/terminal-bench/agent.mjs';
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
      if (line.type === 'exec') {
        input.write(`${JSON.stringify({ type: 'result', id: line.id, ...resultFor(line) })}\n`);
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
