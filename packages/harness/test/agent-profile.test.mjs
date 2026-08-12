/**
 * Dual-track agent profiles + verifier-shaped autonomous stop (AC8–AC13, AC21–AC22).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { agentResultOf, parseVerifyCmd } from '../lib/agent-cmd.mjs';
import {
  AGENT_ADDON_DISCLAIMER,
  AUTONOMOUS_PROFILE,
  AUTONOMOUS_SYSTEM_MAX_BYTES,
  BENCHMARK_PROFILE,
  DELIVER_PROFILE,
  buildSystemPrompt,
  compactMessages,
  dispatchToolBatch,
  resolveProfile,
  listProfileIds,
} from '../lib/agent-loop.mjs';
import { CONFIG_SCHEMA } from '../lib/config.mjs';
import { EXIT } from '../lib/style.mjs';

const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function scaffold(prefix) {
  const ws = tempDir(`${prefix}-ws-`);
  const home = tempDir(`${prefix}-home-`);
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', 'engineer.agent.md'), '# Engineer\n\nBe careful.\n');
  return { ws, home };
}

function scriptedProvider(script) {
  const requests = [];
  let i = 0;
  const start = () => ({
    provider: 'scripted',
    model: 'scripted-1',
    alive: true,
    logs: [],
    async complete(request) {
      requests.push(request);
      const step = script[i];
      i += 1;
      const completion = typeof step === 'function' ? await step(request, requests) : step;
      return completion || { text: 'finished', toolCalls: [], blocks: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
    close() {},
  });
  return { start, requests };
}

const say = (text) => ({ text, toolCalls: [], blocks: [{ type: 'text', text }], usage: { inputTokens: 5, outputTokens: 5 } });
const callTool = (id, name, input) => ({
  text: '',
  toolCalls: [{ id, name, input }],
  blocks: [{ type: 'tool_use', id, name, input }],
  usage: { inputTokens: 5, outputTokens: 5 },
});

const argvFor = (ws, home, task, extra = []) => [
  ...task.split(' '), '--workspace', ws, '--copilot-home', home, '--no-events', ...extra,
];

// --- profile selection (AC8, AC13) ----------------------------------------

test('resolveProfile accepts deliver, autonomous, bench alias, and benchmark fixture', () => {
  assert.equal(resolveProfile('deliver').id, 'deliver');
  assert.equal(resolveProfile('autonomous').id, 'autonomous');
  assert.equal(resolveProfile('bench').id, 'autonomous');
  assert.equal(resolveProfile('benchmark').id, 'benchmark');
  assert.equal(resolveProfile('benchmark').testOnly, true);
  assert.equal(AUTONOMOUS_PROFILE.testOnly, false);
  assert.equal(DELIVER_PROFILE.track, 'deliver');
  assert.ok(listProfileIds().includes('autonomous'));
  assert.throws(() => resolveProfile('telepathy'), (e) => e.code === 'E_USAGE');
});

test('agent.profile and agent.enabled defaults (AC13)', () => {
  assert.equal(CONFIG_SCHEMA['agent.enabled'].default, false);
  assert.equal(CONFIG_SCHEMA['agent.profile'].default, 'autonomous');
});

test('--profile deliver vs autonomous selects tracks and prompt shape (AC8–AC10)', async () => {
  const { ws, home } = scaffold('profile-select');
  const autoProvider = scriptedProvider([say('done')]);
  const auto = await agentResultOf(
    argvFor(ws, home, 'task', ['--profile', 'autonomous', '--verify-cmd', 'true']),
    {},
    { startProviderFn: autoProvider.start },
  );
  assert.equal(auto.profile.id, 'autonomous');
  assert.equal(auto.profile.track, 'autonomous');
  assert.ok(auto.profile.drops.some((d) => d.step === 'gate'));
  assert.ok(auto.profile.drops.some((d) => d.step === 'compound'));
  assert.ok(Buffer.byteLength(autoProvider.requests[0].system, 'utf8') <= AUTONOMOUS_SYSTEM_MAX_BYTES);

  const delProvider = scriptedProvider([say('done')]);
  const del = await agentResultOf(
    argvFor(ws, home, 'task', ['--profile', 'deliver']),
    {},
    { startProviderFn: delProvider.start },
  );
  assert.equal(del.profile.id, 'deliver');
  assert.equal(del.profile.drops.length, 0);
  assert.match(delProvider.requests[0].system, /deliver/i);
});

test('autonomous system prompt is short and omits full persona body (AC9)', () => {
  const persona = { name: 'engineer', text: `# Engineer\n\n${'x'.repeat(50_000)}\n`, hydrated: true };
  const system = buildSystemPrompt({ persona, profile: AUTONOMOUS_PROFILE, hasVerifier: true });
  assert.ok(Buffer.byteLength(system, 'utf8') <= AUTONOMOUS_SYSTEM_MAX_BYTES);
  assert.equal(system.includes('x'.repeat(1000)), false, 'must not inject full persona');
  assert.match(system, /OUT OF SCOPE/);
  assert.match(system, /verifier|Reproduce|reproduce/i);
});

test('dry-run reports profile and verifier without starting a provider (AC8)', async () => {
  const { ws, home } = scaffold('profile-dry');
  let started = false;
  const result = await agentResultOf(
    argvFor(ws, home, 'task', ['--dry-run', '--profile', 'autonomous', '--verify-cmd', 'node verify.mjs']),
    {},
    { startProviderFn: () => { started = true; throw new Error('no'); } },
  );
  assert.equal(started, false);
  assert.equal(result.profile.id, 'autonomous');
  assert.deepEqual(result.verifyCmd, ['node', 'verify.mjs']);
  assert.ok(result.systemPromptBytes <= AUTONOMOUS_SYSTEM_MAX_BYTES);
  assert.match(AGENT_ADDON_DISCLAIMER, /optional add-on/);
});

// --- verifier stop (AC11–AC12, AC21) --------------------------------------

test('parseVerifyCmd splits quoted argv', () => {
  assert.deepEqual(parseVerifyCmd(['--verify-cmd', 'node ./v.mjs']), ['node', './v.mjs']);
  assert.deepEqual(parseVerifyCmd(['--verify-cmd', 'node "./path with space/v.mjs"']), ['node', './path with space/v.mjs']);
});

test('autonomous verifier-pass is terminal success after mutation (AC11)', async () => {
  const { ws, home } = scaffold('verify-pass');
  fs.writeFileSync(path.join(ws, 'flag.txt'), 'broken\n');
  fs.writeFileSync(path.join(ws, 'verify.mjs'), `
import fs from 'node:fs';
const t = fs.readFileSync('flag.txt','utf8');
process.exit(t.includes('fixed') ? 0 : 1);
`);
  const provider = scriptedProvider([
    callTool('e1', 'edit', { path: 'flag.txt', old: 'broken', new: 'fixed' }),
    // If verifier does not stop the loop, model would be asked again — should not happen.
    say('should not reach'),
  ]);
  const result = await agentResultOf(
    argvFor(ws, home, 'fix flag', [
      '--profile', 'autonomous',
      '--verify-cmd', `node ${path.join(ws, 'verify.mjs')}`,
    ]),
    {},
    { startProviderFn: provider.start },
  );
  assert.equal(result.stopReason, 'verifier-pass');
  assert.equal(result.status, 'ok');
  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.verifier?.ok, true);
  assert.equal(result.metrics.pass, true);
  assert.ok(result.metrics.steps >= 1);
  assert.equal(fs.readFileSync(path.join(ws, 'flag.txt'), 'utf8').trim(), 'fixed');
});

test('autonomous model-done without verifier is not ok success-with-proof (AC12)', async () => {
  const { ws, home } = scaffold('verify-missing');
  const provider = scriptedProvider([say('I fixed it in prose')]);
  const result = await agentResultOf(
    argvFor(ws, home, 'task', ['--profile', 'autonomous']),
    {},
    { startProviderFn: provider.start },
  );
  assert.equal(result.stopReason, 'verifier-missing');
  assert.notEqual(result.status, 'ok');
  assert.equal(result.metrics.pass, false);
});

test('autonomous model-done with failing verifier is not ok (AC12)', async () => {
  const { ws, home } = scaffold('verify-fail');
  fs.writeFileSync(path.join(ws, 'verify.mjs'), 'process.exit(1);\n');
  const provider = scriptedProvider([say('done without fixing')]);
  const result = await agentResultOf(
    argvFor(ws, home, 'task', [
      '--profile', 'autonomous',
      '--verify-cmd', `node ${path.join(ws, 'verify.mjs')}`,
    ]),
    {},
    { startProviderFn: provider.start },
  );
  assert.equal(result.stopReason, 'verifier-failed');
  assert.equal(result.status, 'failed');
  assert.equal(result.verifier?.ok, false);
});

test('benchmark fixture still allows model-done without verify-cmd', async () => {
  const { ws, home } = scaffold('bench-done');
  const provider = scriptedProvider([say('finished')]);
  const result = await agentResultOf(
    argvFor(ws, home, 'task', ['--profile', 'benchmark']),
    {},
    { startProviderFn: provider.start },
  );
  assert.equal(result.stopReason, 'done');
  assert.equal(result.status, 'ok');
  assert.equal(result.profile.testOnly, true);
  assert.equal(BENCHMARK_PROFILE.id, 'benchmark');
});

// --- compaction (AC15) ----------------------------------------------------

test('compactMessages stubs all old tool results in all mode', () => {
  const messages = [
    { role: 'user', text: 'task' },
  ];
  for (let i = 0; i < 8; i += 1) {
    messages.push({ role: 'assistant', text: '', blocks: [] });
    messages.push({
      role: 'user',
      toolResults: [{ id: `t${i}`, output: `status: ok\n\nbig payload ${i} ${'y'.repeat(200)}`, isError: false }],
    });
  }
  const compacted = compactMessages(messages, { keepTurns: 2, mode: 'all' });
  const old = compacted.filter((m) => m.toolResults).slice(0, -2);
  assert.ok(old.length >= 1);
  for (const m of old) {
    assert.match(m.toolResults[0].output, /omitted to save context/);
  }
});

test('read-only tools may dispatch in parallel within a turn (AC16)', async () => {
  const ws = tempDir('parallel-read-');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'A\n');
  fs.writeFileSync(path.join(ws, 'b.txt'), 'B\n');
  const calls = [
    { id: '1', name: 'read', input: { path: 'a.txt' } },
    { id: '2', name: 'read', input: { path: 'b.txt' } },
  ];
  // Smoke: batch completes both reads (implementation uses Promise.all for read-only groups).
  const outcomes = await dispatchToolBatch(calls, { workspace: ws });
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((o) => o.dispatched));
  assert.equal(outcomes[0].result.status, 'ok');
  assert.equal(outcomes[1].result.status, 'ok');
});

test('eval pack has ≥3 tasks with prompt + verify (AC19)', () => {
  const tasksDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../eval/tasks');
  const ids = fs.readdirSync(tasksDir).filter((n) => fs.existsSync(path.join(tasksDir, n, 'task.json')));
  assert.ok(ids.length >= 3, `expected ≥3 tasks, got ${ids.join(',')}`);
  for (const id of ids) {
    const task = JSON.parse(fs.readFileSync(path.join(tasksDir, id, 'task.json'), 'utf8'));
    assert.ok(task.prompt?.length > 10);
    assert.ok(Array.isArray(task.verifyCmd) && task.verifyCmd.length);
    assert.ok(fs.existsSync(path.join(tasksDir, id, 'workspace')));
  }
});
