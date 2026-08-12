/**
 * P5AC9/P5AC10 — the turn loop.
 *
 * The loop is the one component in the harness whose caller cannot be reasoned
 * with, so most of what is pinned here is about what a model CANNOT cause: it
 * cannot reach an execution path other than the governed one, cannot escape the
 * environment allowlist by asking, cannot run past the budgets, and cannot put
 * a transcript into a durable record.
 *
 * The provider is injected throughout. That is not only a convenience for
 * offline tests — it is the same seam that keeps "core never consumes a model"
 * to a single reviewable line, so testing through it tests the real shape.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { agentResultOf, taskFromArgv } from '../lib/agent-cmd.mjs';
import { hasCommand } from '../lib/registry.mjs';
import {
  AGENT_TOOLS,
  BENCHMARK_PROFILE,
  STOP_REASONS,
  buildSystemPrompt,
  dispatchToolCall,
  renderToolResult,
  resolvePersona,
  resolveToolTimeout,
} from '../lib/agent-loop.mjs';
import { getCommand } from '../lib/registry.mjs';
import { EXIT } from '../lib/style.mjs';
import { setRunContext, clearRunContext } from '../lib/run-context.mjs';
import { createEventRegistry } from '../lib/event-registry.mjs';
import { writeEvent as writeHarnessEvent } from '../lib/events.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** A workspace and a Copilot home, with the persona hydrated the way `install`
 * would leave it. */
function scaffold(prefix, { persona = 'engineer', personaText = '# Engineer\n\nBe careful.\n' } = {}) {
  const ws = tempDir(`${prefix}-ws-`);
  const home = tempDir(`${prefix}-home-`);
  if (persona) {
    fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'agents', `${persona}.agent.md`), personaText);
  }
  return { ws, home };
}

/**
 * A scripted provider. Each entry is one completion, in order; running off the
 * end returns a no-tool-call completion, which is how the loop is told to stop.
 */
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
  return { start, requests, get consumed() { return i; } };
}

const say = (text) => ({ text, toolCalls: [], blocks: [{ type: 'text', text }], usage: { inputTokens: 5, outputTokens: 5 } });
const callTool = (id, name, input) => ({
  text: '',
  toolCalls: [{ id, name, input }],
  blocks: [{ type: 'tool_use', id, name, input }],
  usage: { inputTokens: 5, outputTokens: 5 },
});

const argvFor = (ws, home, task, extra = []) => [...task.split(' '), '--workspace', ws, '--copilot-home', home, '--no-events', ...extra];

// --- P5AC9: the loop completes a task -------------------------------------

test('P5AC9: the loop orients, acts through a tool, and stops when the model asks for nothing more', async () => {
  const { ws, home } = scaffold('agent-e2e');
  const provider = scriptedProvider([
    callTool('t1', 'bash', { script: 'echo hello > done.txt' }),
    say('wrote the file'),
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'write a file'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'done');
  assert.equal(result.status, 'ok');
  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.turnCount, 2, 'one acting turn and one finishing turn');
  assert.equal(fs.readFileSync(path.join(ws, 'done.txt'), 'utf8').trim(), 'hello', 'the tool actually ran');
  assert.equal(result.text, 'wrote the file');
  assert.equal(result.usage.outputTokens, 10, 'usage accumulates across turns');
});

// Adopted from Pi's loop (`failToolCallsFromTruncatedMessage`): a response
// stopped at the token limit can carry a tool call whose streamed arguments
// were cut mid-JSON and salvage-parsed into something that VALIDATES while
// being incomplete. A `write` whose content lost its tail would write a
// truncated file and report success.
test('a length-truncated message has its tool calls refused, not dispatched', async () => {
  const { ws, home } = scaffold('agent-truncated');
  const provider = scriptedProvider([
    {
      text: '',
      toolCalls: [
        { id: 't1', name: 'write', input: { path: 'half.txt', content: 'the beginning of somethi' } },
        { id: 't2', name: 'bash', input: { script: 'echo hi' } },
      ],
      blocks: [],
      stopReason: 'length',
      usage: { inputTokens: 5, outputTokens: 5 },
    },
    (request) => {
      // The refusal reaches the model as per-call errors it can act on.
      const results = request.messages.at(-1)?.toolResults ?? [];
      assert.equal(results.length, 2, 'every call in the truncated message is answered');
      assert.ok(results.every((r) => r.isError), 'all answered as errors');
      assert.match(results[0].output, /token limit|truncated/i);
      return say('re-issuing nothing, done');
    },
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'do a thing'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'done');
  assert.equal(fs.existsSync(path.join(ws, 'half.txt')), false, 'the truncated write must never touch the disk');
  const truncatedTurn = result.turns[0];
  assert.ok(truncatedTurn.tools.every((t) => t.dispatched === false), 'the journal says the calls were refused');
  assert.match(truncatedTurn.tools[0].reason, /truncated/);
});

test('P5AC9: the tool result is fed back, so a non-zero exit continues the loop instead of ending it', async () => {
  const { ws, home } = scaffold('agent-nonzero');
  const provider = scriptedProvider([
    callTool('t1', 'exec', { argv: [process.execPath, '-e', 'process.exit(3)'] }),
    say('recovered'),
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'try something'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'done', 'a failing command is information, not a terminal state');
  assert.equal(result.turns[0].tools[0].exitCode, 3);
  const followUp = provider.requests[1].messages.at(-1);
  assert.equal(followUp.role, 'user');
  assert.match(followUp.toolResults[0].output, /exit: 3/);
  assert.equal(followUp.toolResults[0].isError, true);
});

test('P5AC9: an unknown or malformed tool call is answered, not fatal', async () => {
  const { ws, home } = scaffold('agent-badtool');
  const provider = scriptedProvider([
    callTool('t1', 'telepathy', { wish: 'be done' }),
    callTool('t2', 'bash', { script: '' }),
    say('ok then'),
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'do a thing'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'done');
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /unknown tool: telepathy/);
  assert.match(result.turns[1].tools[0].reason, /non-empty `script`/);
});

// --- P5AC9: the model reaches nothing but the governed surface -------------

test('P5AC9: a model-issued command gets the same deny-all environment an operator’s does', async () => {
  const { ws, home } = scaffold('agent-env');
  process.env.AGENT_TEST_SECRET = 'must-not-be-visible';
  try {
    const provider = scriptedProvider([
      callTool('t1', 'exec', { argv: [process.execPath, '-e', 'console.log("SECRET=" + process.env.AGENT_TEST_SECRET)'] }),
      say('done'),
    ]);
    const result = await agentResultOf(argvFor(ws, home, 'print the secret'), {}, { startProviderFn: provider.start });
    const output = provider.requests[1].messages.at(-1).toolResults[0].output;
    assert.match(output, /SECRET=undefined/, 'asking through a model must not widen what a child can see');
    assert.equal(result.turns[0].tools[0].status, 'ok');
  } finally {
    delete process.env.AGENT_TEST_SECRET;
  }
});

test('P5AC9: the tool call starts in the workspace (which is NOT confinement — see below)', async () => {
  const { ws, home } = scaffold('agent-cwd');
  const outcome = await dispatchToolCall(
    { id: 't1', name: 'exec', input: { argv: [process.execPath, '-e', 'console.log(process.cwd())'] } },
    { workspace: ws, copilotHome: home },
  );
  assert.equal(outcome.dispatched, true);
  assert.equal(outcome.result.cwd, ws);
  assert.equal(outcome.result.output.map((r) => r.line).join('\n').trim(), ws);
});

test('P5AC9: and the harness does NOT confine a model to the workspace — asserted so the claim cannot drift back', async () => {
  // This test exists to keep a FALSE claim from returning. The previous version
  // of the test above was named "so a model cannot run outside it" while
  // asserting only the starting directory; Codex's final review caught the gap.
  // `resolveExecCwd` validates where a command STARTS. Nothing stops it leaving.
  const ws = tempDir('agent-escape-ws-');
  const outside = path.join(ws, '..', `escape-probe-${process.pid}`);
  const outcome = await dispatchToolCall(
    { id: 't1', name: 'bash', input: { script: `cd .. && printf x > ${JSON.stringify(path.basename(outside))}` } },
    { workspace: ws },
  );
  assert.equal(outcome.dispatched, true);
  const escaped = fs.existsSync(outside);
  if (escaped) fs.rmSync(outside, { force: true });
  assert.equal(escaped, true,
    'if this ever fails, real confinement has been added — delete this test and restore the stronger claim in agent-loop.mjs');
});

test('P5AC9: a refusal from the governed surface stops the loop rather than being re-tried forever', async () => {
  const { ws, home } = scaffold('agent-denied');
  // `bash` disabled in the user scope: the harness refuses to dispatch at all,
  // which is not something the model can work around by rephrasing.
  fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(home, 'harness', 'config.yaml'), '"exec.bash_enabled": false\n');

  const provider = scriptedProvider([callTool('t1', 'bash', { script: 'echo hi' }), say('unreachable')]);
  const result = await agentResultOf(argvFor(ws, home, 'run a script'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'tool-error');
  assert.equal(result.status, 'failed');
  assert.match(result.stopDetail, /bash is disabled/);
  assert.equal(provider.consumed, 1, 'the loop stopped rather than spending the budget on a settled no');
});

// --- P5AC9: the stop conditions -------------------------------------------

test('P5AC9: every stop reason maps to a distinct, named outcome', () => {
  assert.deepEqual(Object.keys(STOP_REASONS).sort(), ['cancelled', 'done', 'provider-error', 'time-budget', 'tool-error', 'turn-budget']);
  assert.equal(STOP_REASONS.done.status, 'ok');
  assert.equal(STOP_REASONS['time-budget'].status, 'timed-out');
  assert.equal(STOP_REASONS.cancelled.status, 'cancelled');
  assert.notEqual(STOP_REASONS.done.exit, STOP_REASONS['turn-budget'].exit,
    '"finished" and "ran out of turns" must not be one exit code apart from each other');
});

test('P5AC9: the turn budget stops the loop and says so', async () => {
  const { ws, home } = scaffold('agent-turns');
  const provider = scriptedProvider(Array.from({ length: 10 }, (_, i) => callTool(`t${i}`, 'exec', { argv: [process.execPath, '-e', '0'] })));
  const result = await agentResultOf(argvFor(ws, home, 'loop forever', ['--max-turns', '3']), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'turn-budget');
  assert.equal(result.status, 'failed');
  assert.equal(result.turnCount, 3);
  assert.notEqual(result.exitCode, EXIT.ok, 'a run that never finished must not report success');
});

test('P5AC9: a provider that cannot answer is a named outcome, not a crash', async () => {
  const { ws, home } = scaffold('agent-provfail');
  const provider = { start: () => ({
    provider: 'scripted', model: 'scripted-1', alive: false, logs: [],
    async complete() { throw new Error('anthropic request failed: ENOTFOUND'); },
    close() {},
  }) };
  const result = await agentResultOf(argvFor(ws, home, 'do a thing'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'provider-error');
  assert.equal(result.exitCode, EXIT.network);
  assert.match(result.stopDetail, /ENOTFOUND/);
});

test('P5AC9: an aborted signal ends the run as cancelled, not as a failure', async () => {
  const { ws, home } = scaffold('agent-cancel');
  const controller = new AbortController();
  const provider = scriptedProvider([
    (() => { controller.abort(); return callTool('t1', 'exec', { argv: [process.execPath, '-e', '0'] }); }),
    say('unreachable'),
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'do a thing'), { signal: controller.signal }, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.exitCode, EXIT.cancelled);
});

// --- the benchmark profile ------------------------------------------------

test('the benchmark profile names the dropped lifecycle steps instead of faking their preconditions', async () => {
  const { ws, home } = scaffold('agent-profile');
  const provider = scriptedProvider([say('nothing to do')]);
  const result = await agentResultOf(argvFor(ws, home, 'a task'), {}, { startProviderFn: provider.start });

  assert.equal(result.profile.id, 'benchmark');
  assert.deepEqual(result.profile.drops.map((d) => d.step).sort(), ['compound', 'gate', 'human-review', 'verify']);
  for (const drop of result.profile.drops) assert.ok(drop.precondition, `${drop.step} must say what it lacks`);

  assert.equal(fs.existsSync(path.join(ws, 'docs', 'plans')), false,
    'a plan file synthesized to satisfy `gate` would measure ceremony, not capability');

  const system = provider.requests[0].system;
  assert.match(system, /OUT OF SCOPE/, 'the model is told which steps are impossible here, so it does not spend turns finding out');
  for (const drop of BENCHMARK_PROFILE.drops) assert.ok(system.includes(drop.step));
});

test('the persona is the hydrated agent file, and a missing one degrades rather than refuses', async () => {
  const hydrated = scaffold('agent-persona', { personaText: '# Engineer\n\nSPECIFIC-PERSONA-MARKER\n' });
  const provider = scriptedProvider([say('ok')]);
  const result = await agentResultOf(argvFor(hydrated.ws, hydrated.home, 'a task'), {}, { startProviderFn: provider.start });
  assert.equal(result.persona.name, 'engineer');
  assert.equal(result.persona.hydrated, true);
  assert.match(provider.requests[0].system, /SPECIFIC-PERSONA-MARKER/);

  const bare = scaffold('agent-nopersona', { persona: null });
  const provider2 = scriptedProvider([say('ok')]);
  const result2 = await agentResultOf(argvFor(bare.ws, bare.home, 'a task'), {}, { startProviderFn: provider2.start });
  assert.equal(result2.status, 'ok', 'a container that never ran `install` still has a task to attempt');
  assert.equal(result2.persona.hydrated, false, 'and the result says so rather than implying a persona it did not have');
});

test('a persona name cannot walk out of the agents directory', () => {
  assert.throws(() => resolvePersona('/tmp/home', '../../etc/passwd'), (e) => e.code === 'E_USAGE');
  assert.throws(() => resolvePersona('/tmp/home', 'a/b'), (e) => e.code === 'E_USAGE');
});

test('orientation degrades cleanly when there is nothing to orient over', async () => {
  const { ws, home } = scaffold('agent-noorient');
  const provider = scriptedProvider([say('ok')]);
  const result = await agentResultOf(
    argvFor(ws, home, 'a task'),
    {},
    { startProviderFn: provider.start, runOrientFn: () => { throw new Error('no repo here'); } },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.orientation.available, false);
  assert.match(result.orientation.reason, /no repo here/);
});

// --- P5AC10: inspectable through the existing run surface ------------------

test('P5AC10: `agent` is a registered execute-class command, so bin/harness.mjs journals it like any other', () => {
  const entry = getCommand('agent');
  assert.ok(entry, 'an unregistered command would bypass the run journal entirely');
  assert.equal(entry.sideEffect, 'execute',
    'anything softer would let the loop run where `exec` itself is refused');
  assert.ok(typeof entry.resultOf === 'function' && typeof entry.exitOf === 'function',
    'the envelope lane must carry the same stop reason and exit code the ledger does');
});

test('P5AC10: a real dispatch appears in `run list` as an agent run', () => {
  const { ws, home } = scaffold('agent-journal');
  // AGENT MODE IS OFF BY DEFAULT, and this test dispatches for real — so it has
  // to grant the authority the gate exists to withhold. Written into the
  // fixture home rather than relaxed in the product: the whole point of the
  // gate is that reaching a provider is opted into, and a test that needed it
  // waived would be testing a harness nobody ships.
  fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(home, 'harness', 'config.yaml'), 'agent.enabled: true\n');
  // No network is needed and none is relied on: the 1-second wall clock bounds
  // the provider request, so this ends as `provider-error` or `time-budget`
  // whether the host can reach the API or not. Either way the run is journaled.
  const res = spawnSync(process.execPath, [
    binPath, 'agent', 'a task', '--workspace', ws, '--copilot-home', home, '--max-seconds', '1', '--max-turns', '1',
  ], { cwd: packageRoot, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'not-a-real-key' } });
  assert.notEqual(res.status, EXIT.ok);

  const listed = spawnSync(process.execPath, [binPath, 'run', 'list', '--workspace', ws, '--json'], {
    cwd: packageRoot, encoding: 'utf8',
  });
  const runs = JSON.parse(listed.stdout).runs;
  const agentRun = runs.find((r) => r.command === 'agent');
  assert.ok(agentRun, '`run list` is the surface an operator already has; the loop must appear there');
  assert.ok(agentRun.run, 'every run carries its id');
  assert.ok(agentRun.actor, 'and its actor');
  assert.ok(['failed', 'timed-out'].includes(agentRun.status), `unexpected status: ${agentRun.status}`);
});

test('P5AC10: every turn event carries the run id and actor, and no transcript', async () => {
  const { ws, home } = scaffold('agent-events');
  setRunContext({ run: 'run-fixture-1', actor: { kind: 'ci' } });
  try {
    const events = createEventRegistry({ run: 'run-fixture-1', writeEvent: (payload) => writeHarnessEvent(ws, {}, payload) });
    const provider = scriptedProvider([
      callTool('t1', 'bash', { script: 'echo SENTINEL-OUTPUT' }),
      say('the SENTINEL-ANSWER is 42'),
    ]);
    await agentResultOf(
      [...'a task'.split(' '), '--workspace', ws, '--copilot-home', home],
      { events },
      { startProviderFn: provider.start },
    );

    const lines = fs.readFileSync(path.join(ws, '.harness', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const turns = lines.filter((e) => e.type === 'agent.turn');
    assert.equal(turns.length, 2, 'one record per turn');
    for (const turn of turns) {
      assert.equal(turn.run, 'run-fixture-1', 'a turn with no run id cannot be correlated with the tools it caused');
      assert.ok(turn.actor, 'nor attributed');
    }
    assert.deepEqual(turns[0].agent.tools.map((t) => t.tool), ['bash']);
    assert.equal(turns[1].agent.ended, true);

    const raw = JSON.stringify(lines);
    assert.equal(raw.includes('SENTINEL-ANSWER'), false,
      'the journal is durable, and a transcript is where a pasted credential ends up');
    assert.ok(lines.some((e) => e.type === 'bash'), 'what the tool DID is still recorded, in the execution audit');
  } finally {
    clearRunContext();
  }
});

// --- the surface ----------------------------------------------------------

test('--dry-run reports the resolved plan and calls no model', async () => {
  const { ws, home } = scaffold('agent-dry');
  let started = false;
  const result = await agentResultOf(argvFor(ws, home, 'a task', ['--dry-run']), {}, {
    startProviderFn: () => { started = true; throw new Error('must not start'); },
  });
  assert.equal(started, false, 'a flag whose whole meaning is "show me what you would do" must not do it');
  assert.equal(result.dryRun, true);
  assert.equal(result.persona.name, 'engineer');
  assert.ok(result.systemPromptBytes > 0);
  assert.equal(result.exitCode, EXIT.ok);
});

test('the budget flags are validated, never best-guessed', async () => {
  const { ws, home } = scaffold('agent-flags');
  const bad = async (extra) => assert.rejects(
    () => agentResultOf(argvFor(ws, home, 'a task', extra), {}, { startProviderFn: () => { throw new Error('unreachable'); } }),
    (e) => e.code === 'E_USAGE',
  );
  await bad(['--max-turns', '0']);
  await bad(['--max-turns', 'lots']);
  await bad(['--max-turns=']);
  await bad(['--max-turns', '3', '--max-turns', '4']);
  await bad(['--max-seconds', '-1']);
  await bad(['--provider', 'telepathy']);
});

test('the task is every bare word, so an unquoted task is not truncated to its first token', () => {
  assert.equal(taskFromArgv(['make', 'the', 'test', 'pass', '--max-turns', '3']), 'make the test pass');
  assert.equal(taskFromArgv(['--max-turns=3', 'fix', 'it']), 'fix it');
  assert.equal(taskFromArgv(['--dry-run']), '');
});

// --- provider neutrality --------------------------------------------------

test('the loop builds no provider wire shape — every one of them lives in the adapter', () => {
  const code = fs.readFileSync(path.join(packageRoot, 'lib', 'agent-loop.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const wire of ['tool_use_id', 'input_schema', 'tool_result', 'max_tokens', 'anthropic']) {
    assert.equal(code.includes(wire), false,
      `${wire} in the loop would make it an Anthropic-shaped loop wearing a neutral name; the second provider would be what discovered that`);
  }
});

test('the declared tools are exactly the governed surfaces, and every one of them is a command', () => {
  assert.deepEqual(AGENT_TOOLS.map((t) => t.name).sort(), ['bash', 'edit', 'exec', 'read', 'search', 'write']);
  for (const tool of AGENT_TOOLS) {
    assert.ok(tool.description.length > 40, 'a tool the model must reason about needs its constraints described');
    assert.equal(tool.schema.type, 'object');
  }
  // The invariant the list exists to keep: a tool name that does not map to a
  // registered command would be a capability reachable by the model and by
  // nobody else — the second write path lib/agent-loop.mjs refuses to create.
  // `read` is the one alias, because `harness get` is the command that reads
  // and renaming it for the model would be worse than saying so here.
  const commandFor = { bash: 'bash', exec: 'exec', read: 'get', search: 'search', edit: 'edit', write: 'write' };
  for (const tool of AGENT_TOOLS) {
    assert.ok(hasCommand(commandFor[tool.name]), `${tool.name} must dispatch to a registered command`);
  }
});

test('undo is deliberately not a tool the model can call', () => {
  assert.equal(AGENT_TOOLS.some((t) => t.name === 'undo'), false);
  assert.ok(hasCommand('undo'), 'but it is still a command an operator can run');
  assert.equal(getCommand('undo').surfaces.includes('agent'), false);
});

test('tool output handed back to the model is bounded', () => {
  const result = { status: 'ok', exitCode: 0, output: [{ line: 'x'.repeat(100_000) }] };
  const text = renderToolResult(result, { maxBytes: 2048 });
  assert.ok(Buffer.byteLength(text, 'utf8') <= 2048 + 32);
  assert.match(text, /truncated/);
});

test('the system prompt survives a persona that is absent, empty, or enormous', () => {
  for (const persona of [
    { name: 'engineer', text: null, hydrated: false },
    { name: 'engineer', text: '', hydrated: true },
    { name: 'engineer', text: 'x'.repeat(200_000), hydrated: true },
  ]) {
    const system = buildSystemPrompt({ persona });
    assert.ok(system.includes('OUT OF SCOPE'), 'the profile section is never the part that gets dropped');
  }
});

// --- the three gaps found reading my own code back -------------------------

test('--dry-run writes nothing into the workspace', async () => {
  const { ws, home } = scaffold('agent-drywrite');
  await agentResultOf(
    [...'a task'.split(' '), '--workspace', ws, '--copilot-home', home, '--dry-run'],
    {},
    { startProviderFn: () => { throw new Error('must not start'); } },
  );
  const written = fs.existsSync(path.join(ws, '.harness'))
    ? fs.readdirSync(path.join(ws, '.harness'), { recursive: true })
    : [];
  assert.deepEqual(written, [],
    'orientation writes a context pack and a session; a dry run must not, and it was being handed no dry-run flag at all');
});

test('--dry-run still reports whether orientation would succeed, rather than claiming it failed', async () => {
  const { ws, home } = scaffold('agent-dryreport');
  const result = await agentResultOf(
    [...'a task'.split(' '), '--workspace', ws, '--copilot-home', home, '--dry-run'],
    {},
    { startProviderFn: () => { throw new Error('must not start'); } },
  );
  assert.equal(result.orientation.available, true, 'not writing the pack is not the same as being unable to orient');
  assert.equal(result.orientation.materialized, false, 'and the report says the pack is not on disk');
});

test('the operator’s --tool-timeout is a ceiling the model cannot raise', async () => {
  const { ws, home } = scaffold('agent-ceiling');
  const provider = scriptedProvider([
    // 3600 is the configured maximum; without a ceiling the model simply wins.
    callTool('t1', 'bash', { script: 'true', timeout: 3600 }),
    say('done'),
  ]);
  const result = await agentResultOf(
    argvFor(ws, home, 'run something', ['--tool-timeout', '5']),
    {},
    { startProviderFn: provider.start },
  );
  assert.equal(result.turns[0].tools[0].timeoutSeconds, 5,
    'a control the operator set must bound the model, not default beneath it');
});

test('a tool cannot run past the wall clock the operator set', async () => {
  const { ws, home } = scaffold('agent-wallclock');
  const provider = scriptedProvider([
    // An hour-long sleep against a one-second run. The wall clock is only
    // checked BETWEEN turns, so without cancellation this would sail past it.
    callTool('t1', 'bash', { script: 'sleep 3600', timeout: 3600 }),
    say('done'),
  ]);
  const started = Date.now();
  const result = await agentResultOf(
    argvFor(ws, home, 'run something', ['--max-seconds', '1']),
    {},
    { startProviderFn: provider.start },
  );
  assert.ok(Date.now() - started < 30_000, 'the deadline stopped the tool rather than waiting on its own timeout');
  assert.equal(result.turns[0].tools[0].status, 'cancelled', 'and the tool reports the truth about why it stopped');
  assert.equal(result.stopReason, 'time-budget');
});

test('the loop never RAISES a timeout the operator lowered in their config', async () => {
  // The bug the cancellation approach avoids: with no --tool-timeout there is
  // no operator value to shorten, so shortening `--timeout` to fit the wall
  // clock would have meant inventing one — and overriding a lower configured
  // `exec.timeout_seconds` upward while claiming to lower it.
  assert.equal(resolveToolTimeout({ requested: undefined, ceiling: null }), null,
    'saying nothing is what lets `exec` apply the configured timeout');
  assert.equal(resolveToolTimeout({ requested: 3600, ceiling: 5 }), 5, 'the operator ceiling wins');
  assert.equal(resolveToolTimeout({ requested: 2, ceiling: 5 }), 2, 'and a shorter request is honored');
  assert.equal(resolveToolTimeout({ requested: undefined, ceiling: 5 }), 5);
  assert.equal(resolveToolTimeout({ requested: 0, ceiling: null }), null, 'a nonsense request is not a bound');
  assert.equal(resolveToolTimeout({ requested: -5, ceiling: 10 }), 10);
});
