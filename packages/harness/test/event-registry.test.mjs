/**
 * Coverage for lib/event-registry.mjs (P1.5) — the central event registry —
 * plus the dispatch-pipeline wiring it enables in lib/registry.mjs and the
 * additive lib/events.mjs schema/vocabulary changes it depends on.
 *
 * Per the task-5 brief (requirement #7):
 *   - emission shape (emit / withCommand)
 *   - actor detection (injected env)
 *   - redaction-before-persistence (a marker redactor demonstrably runs on
 *     the persisted payload BEFORE it reaches writeEvent)
 *   - command.start flag-names-only guarantee (never values)
 *   - agent-lane bytes event (AC10 metering wiring)
 *   - injectable clock determinism
 * plus integration coverage of the dispatch()/dispatchLane() wiring in
 * lib/registry.mjs and one real end-to-end CLI run proving events.jsonl
 * compatibility (requirement #6).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createEventRegistry, detectActor, summarizeArgFlags, EVENT_TYPE } from '../lib/event-registry.mjs';
import { dispatch, registerCommand } from '../lib/registry.mjs';
import { EVENT_TYPES as REAL_EVENT_TYPES, eventPath, readEvents, summarizeEvents } from '../lib/events.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHarness(args) {
  return spawnSync(process.execPath, [binPath, ...args], { cwd: packageRoot, encoding: 'utf8' });
}

/** A spy writeEvent(payload) sink — records every event object it receives,
 * in order, and returns it (mirroring lib/events.mjs's own writeEvent
 * return value on success). */
function spyWriteEvent() {
  const calls = [];
  const fn = (event) => {
    calls.push(event);
    return event;
  };
  fn.calls = calls;
  return fn;
}

// --- emission shape ---------------------------------------------------

test('emit(type, payload) carries type, ts, actor, and the payload fields; no command field when unscoped', () => {
  const writeEvent = spyWriteEvent();
  const actor = { kind: 'user' };
  const registry = createEventRegistry({ writeEvent, actor, clock: () => '2026-01-01T00:00:00.000Z' });

  registry.emit('learning', { plan: 'docs/plans/x.md', durationMs: 12 });

  assert.equal(writeEvent.calls.length, 1);
  const [event] = writeEvent.calls;
  assert.equal(event.type, 'learning');
  assert.equal(event.ts, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(event.actor, { kind: 'user' });
  assert.equal(event.plan, 'docs/plans/x.md');
  assert.equal(event.durationMs, 12);
  assert.equal('command' in event, false, 'unscoped emit must not stamp a command field');
});

test('withCommand(command).emit(type, payload) stamps command on every event it produces', () => {
  const writeEvent = spyWriteEvent();
  const registry = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  const scoped = registry.withCommand('orient');

  scoped.emit('command.start', { flags: ['--query'] });
  scoped.emit('command.result', { status: 'ok', durationMs: 5, exitCode: 0 });

  assert.equal(writeEvent.calls.length, 2);
  for (const event of writeEvent.calls) {
    assert.equal(event.command, 'orient');
  }
});

test('command.start carries a per-process execution block (pid, harnessVersion); other event types do not', () => {
  const writeEvent = spyWriteEvent();
  const registry = createEventRegistry({ writeEvent, actor: { kind: 'user' }, pid: 4242, harnessVersion: '9.9.9' });
  const scoped = registry.withCommand('status');

  scoped.emit(EVENT_TYPE.COMMAND_START, {});
  scoped.emit(EVENT_TYPE.COMMAND_RESULT, { status: 'ok', durationMs: 1, exitCode: 0 });

  const [start, result] = writeEvent.calls;
  assert.deepEqual(start.execution, { pid: 4242, harnessVersion: '9.9.9' });
  assert.equal('execution' in result, false, 'execution block is command.start-only');
});

test('createEventRegistry requires a writeEvent(payload) function', () => {
  assert.throws(() => createEventRegistry({}), /writeEvent/);
  assert.throws(() => createEventRegistry({ writeEvent: 'nope' }), /writeEvent/);
});

test('emit requires a non-empty string type; withCommand requires a non-empty string command', () => {
  const writeEvent = spyWriteEvent();
  const registry = createEventRegistry({ writeEvent });
  assert.throws(() => registry.emit(''), /type/);
  assert.throws(() => registry.emit(undefined), /type/);
  assert.throws(() => registry.withCommand(''), /command/);
});

test('EVENT_TYPE constants are registered in lib/events.mjs EVENT_TYPES (additive integration)', () => {
  assert.ok(REAL_EVENT_TYPES.has(EVENT_TYPE.COMMAND_START));
  assert.ok(REAL_EVENT_TYPES.has(EVENT_TYPE.COMMAND_RESULT));
  assert.ok(REAL_EVENT_TYPES.has(EVENT_TYPE.AGENT_LANE));
  assert.equal(EVENT_TYPE.AGENT_LANE, 'agent_lane', 'must match lib/agent-lane.mjs\'s hardcoded record.type exactly');
});

// --- actor detection (injected env) ------------------------------------

test('detectActor: CI env (CI=true) takes priority and reports {kind: "ci"}', () => {
  assert.deepEqual(detectActor({ CI: 'true', HARNESS_HOST: 'vscode' }), { kind: 'ci' });
});

test('detectActor: GITHUB_ACTIONS is treated the same as CI', () => {
  assert.deepEqual(detectActor({ GITHUB_ACTIONS: 'true' }), { kind: 'ci' });
});

test('detectActor: a HARNESS_HOST marker (no CI) reports {kind: "host", host}', () => {
  assert.deepEqual(detectActor({ HARNESS_HOST: 'vscode' }), { kind: 'host', host: 'vscode' });
});

test('detectActor: no CI, no HARNESS_HOST -> default {kind: "user"}', () => {
  assert.deepEqual(detectActor({}), { kind: 'user' });
});

test('detectActor: empty-string HARNESS_HOST does not count as a host marker', () => {
  assert.deepEqual(detectActor({ HARNESS_HOST: '' }), { kind: 'user' });
});

test('createEventRegistry derives actor once via detectActor when not injected, and stamps it on every event', () => {
  const writeEvent = spyWriteEvent();
  const registry = createEventRegistry({ writeEvent, clock: () => 't' });
  // No explicit `actor` — falls back to the real detectActor(process.env).
  // We only assert shape here (kind is always one of the three), not the
  // live env's actual value, since that would make the test environment-
  // dependent.
  registry.emit('learning', {});
  const { actor } = writeEvent.calls[0];
  assert.ok(['user', 'host', 'ci'].includes(actor.kind));
});

// --- redaction before persistence (AC6) ---------------------------------

test('redaction runs on the payload BEFORE it reaches writeEvent (marker redactor proves order)', () => {
  const writeEvent = spyWriteEvent();
  let redactCalled = false;
  const markerRedactor = {
    redactValue(value) {
      redactCalled = true;
      // A visible, distinguishing transform so we can assert writeEvent
      // received the REDACTED shape, not the raw one.
      return { ...value, secret: '«redacted:marker»' };
    },
  };
  const registry = createEventRegistry({ writeEvent, redactor: markerRedactor, actor: { kind: 'user' } });

  registry.emit('learning', { secret: 'ghp_realtoken1234567890abcd' });

  assert.equal(redactCalled, true, 'the injected redactor must have run');
  assert.equal(writeEvent.calls.length, 1);
  assert.equal(writeEvent.calls[0].secret, '«redacted:marker»', 'writeEvent must receive the REDACTED payload, never the raw one');
});

test('the default redactor (real createRedactor) actually removes a secret shape from a persisted payload', () => {
  const writeEvent = spyWriteEvent();
  const registry = createEventRegistry({ writeEvent, actor: { kind: 'user' } });

  registry.emit('learning', { note: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' });

  const [event] = writeEvent.calls;
  assert.doesNotMatch(event.note, /ghp_[A-Za-z0-9]{36}/, 'the raw github-token-shaped secret must not survive to writeEvent');
  assert.match(event.note, /«redacted:/);
});

test('withCommand(...).emit also redacts before persistence', () => {
  const writeEvent = spyWriteEvent();
  const registry = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  registry.withCommand('orient').emit('learning', { note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.doesNotMatch(writeEvent.calls[0].note, /ghp_[A-Za-z0-9]{36}/);
});

// --- command.start flag-names-only guarantee (never values) ------------

test('summarizeArgFlags: extracts only flag NAMES, never values (schema-free conservative default)', () => {
  const argv = ['--query', 'super secret task', '--limit', '5', '--explain', '-c', 'team'];
  // Without a flag-type schema, boolean-ness is unknowable from shape alone
  // (`--explain -c` and `--why -explain-mode` are indistinguishable), so the
  // conservative default assumes --explain might take a value too and
  // consumes the following single-dash token (-c) as that value, dropping
  // it from the summary — see summarizeArgFlags's doc comment for why this
  // is the safe failure mode: a dropped name (false negative) is harmless,
  // a leaked value misclassified as a name (false positive) is not.
  assert.deepEqual(summarizeArgFlags(argv), ['--query', '--limit', '--explain']);
});

test('summarizeArgFlags: with a flag-type schema (as lib/registry.mjs\'s dispatch/dispatchLane supply via flagIndex(entry)), a boolean flag never swallows the next flag name', () => {
  const argv = ['--query', 'super secret task', '--limit', '5', '--explain', '-c', 'team'];
  const knownFlags = new Map([
    ['--query', { type: 'string' }],
    ['--limit', { type: 'number' }],
    ['--explain', { type: 'boolean' }],
    ['-c', { type: 'string' }],
  ]);
  assert.deepEqual(summarizeArgFlags(argv, knownFlags), ['--query', '--limit', '--explain', '-c']);
});

test('summarizeArgFlags: a --flag=value token contributes only the flag name', () => {
  assert.deepEqual(summarizeArgFlags(['--query=super secret task', '--limit=5']), ['--query', '--limit']);
});

test('summarizeArgFlags: stops at a literal `--` boundary — nothing after it is a flag', () => {
  assert.deepEqual(summarizeArgFlags(['--query', 'x', '--', '--not-a-flag', 'ghp_realsecret']), ['--query']);
});

test('summarizeArgFlags: never leaks a value that itself looks secret-shaped', () => {
  const argv = ['--token', 'ghp_realtoken1234567890abcdefghijklmnop', '--why', '-explain-mode'];
  const names = summarizeArgFlags(argv);
  assert.deepEqual(names, ['--token', '--why']);
  for (const name of names) {
    assert.doesNotMatch(name, /ghp_|secret|explain-mode/i);
  }
});

test('summarizeArgFlags: positional (non-flag) tokens are excluded entirely', () => {
  assert.deepEqual(summarizeArgFlags(['orders timeout', '--limit', '3']), ['--limit']);
});

test('dispatch integration: command.start on a registered command carries only flag names in the events payload, never values', async () => {
  registerCommand({
    name: '__test-event-flags',
    summary: 'fixture: flag-names-only guarantee',
    sideEffect: 'read',
    args: { flags: [{ name: '--secret', type: 'string' }], positionals: [] },
    handler: async () => 0,
    resultOf: async () => ({ ok: true }),
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  await dispatch(['__test-event-flags', '--secret', 'ghp_realtoken1234567890abcdefghijklmnop'], { output: 'json', events });

  const start = writeEvent.calls.find((e) => e.type === 'command.start');
  assert.ok(start, 'command.start must have been emitted');
  assert.deepEqual(start.flags, ['--secret']);
  const serialized = JSON.stringify(start);
  assert.doesNotMatch(serialized, /ghp_realtoken1234567890abcdefghijklmnop/, 'the flag VALUE must never appear anywhere on the command.start event');
});

// --- injectable clock determinism --------------------------------------

test('injectable clock: the same fixed clock produces byte-identical ts across repeated emits', () => {
  const writeEvent = spyWriteEvent();
  const registry = createEventRegistry({ writeEvent, actor: { kind: 'user' }, clock: () => '2026-03-14T00:00:00.000Z' });
  registry.emit('learning', {});
  registry.emit('learning', {});
  assert.equal(writeEvent.calls[0].ts, '2026-03-14T00:00:00.000Z');
  assert.equal(writeEvent.calls[1].ts, '2026-03-14T00:00:00.000Z');
});

test('injectable clock: a stepping clock is observed in call order (proves the clock is invoked per-emit, not memoized)', () => {
  const writeEvent = spyWriteEvent();
  let tick = 0;
  const registry = createEventRegistry({ writeEvent, actor: { kind: 'user' }, clock: () => `t${tick++}` });
  registry.emit('learning', {});
  registry.emit('learning', {});
  registry.emit('learning', {});
  assert.deepEqual(writeEvent.calls.map((e) => e.ts), ['t0', 't1', 't2']);
});

// --- agent-lane bytes event (AC10) --------------------------------------

test('dispatchLane records an agent_lane event with the rendered byte count on the success path', async () => {
  registerCommand({
    name: '__test-agent-lane-bytes',
    summary: 'fixture: agent-lane metering',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => ({ hello: 'world', n: 42 }),
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  const code = await dispatch(['__test-agent-lane-bytes'], { output: 'agent', events });
  assert.equal(code, 0);

  const metered = writeEvent.calls.find((e) => e.type === 'agent_lane');
  assert.ok(metered, 'an agent_lane event must have been recorded');
  assert.equal(metered.command, '__test-agent-lane-bytes');
  assert.equal(typeof metered.bytes, 'number');
  assert.ok(metered.bytes > 0);
});

test('dispatchLane records an agent_lane event on the error path too (both branches render the agent lane)', async () => {
  registerCommand({
    name: '__test-agent-lane-bytes-error',
    summary: 'fixture: agent-lane metering on error',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => {
      throw Object.assign(new Error('boom'), { code: 'E_TEST', exit: 1 });
    },
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  const code = await dispatch(['__test-agent-lane-bytes-error'], { output: 'agent', events });
  assert.equal(code, 1);

  const metered = writeEvent.calls.find((e) => e.type === 'agent_lane');
  assert.ok(metered, 'an agent_lane event must have been recorded on the error path too');
  assert.equal(metered.command, '__test-agent-lane-bytes-error');
});

test('the json lane (not agent) never records an agent_lane event', async () => {
  registerCommand({
    name: '__test-json-lane-no-metering',
    summary: 'fixture: json lane must not meter agent-lane bytes',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => ({ ok: true }),
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  await dispatch(['__test-json-lane-no-metering'], { output: 'json', events });

  assert.equal(writeEvent.calls.some((e) => e.type === 'agent_lane'), false);
});

// --- review round 1 (Important): command.start / agent_lane must carry an
// explicit, non-tallied result:'pending' marker -------------------------
//
// lib/events.mjs's writeEvent() computes a `result` field via
// eventResult({result, exitCode, checks}), which DEFAULTS TO 'pass' when
// neither `result` nor a meaningful exitCode/checks is supplied.
// command.start (fires before the handler runs) and agent_lane (a byte-
// count metering record) have no outcome of their own, so — left unset —
// each one would silently inflate `harness events --summary`'s pass count.
// lib/registry.mjs now stamps `result: 'pending'` on both; these tests
// assert the PERSISTED event (not just the in-memory payload before it
// reaches writeEvent) carries it.

test('dispatchLane: the persisted command.start event carries result:"pending", not the eventResult() pass default', async () => {
  registerCommand({
    name: '__test-start-pending-lane',
    summary: 'fixture: command.start result:pending on the dispatchLane path',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => ({ ok: true }),
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  await dispatch(['__test-start-pending-lane'], { output: 'json', events });

  const start = writeEvent.calls.find((e) => e.type === 'command.start');
  assert.ok(start);
  assert.equal(start.result, 'pending');
});

test('runHandler (legacy/ledger branch): the persisted command.start event also carries result:"pending"', async () => {
  registerCommand({
    name: '__test-start-pending-ledger',
    summary: 'fixture: command.start result:pending on the legacy-handler path',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    // deliberately no resultOf — forces the ledger branch even under an
    // output lane, same as the earlier forward-looking-path test.
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  await dispatch(['__test-start-pending-ledger'], { output: 'agent', events });

  const start = writeEvent.calls.find((e) => e.type === 'command.start');
  assert.ok(start);
  assert.equal(start.result, 'pending');
});

test('dispatchLane: the persisted agent_lane event carries result:"pending" on the success path', async () => {
  registerCommand({
    name: '__test-agent-lane-pending-success',
    summary: 'fixture: agent_lane result:pending on success',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => ({ ok: true }),
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  await dispatch(['__test-agent-lane-pending-success'], { output: 'agent', events });

  const metered = writeEvent.calls.find((e) => e.type === 'agent_lane');
  assert.ok(metered);
  assert.equal(metered.result, 'pending');
  // The metering record's own fields (command, bytes) must survive unchanged
  // alongside the added result marker.
  assert.equal(metered.command, '__test-agent-lane-pending-success');
  assert.equal(typeof metered.bytes, 'number');
});

test('dispatchLane: the persisted agent_lane event carries result:"pending" on the error path too', async () => {
  registerCommand({
    name: '__test-agent-lane-pending-error',
    summary: 'fixture: agent_lane result:pending on error',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => {
      throw Object.assign(new Error('boom'), { code: 'E_TEST', exit: 1 });
    },
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  await dispatch(['__test-agent-lane-pending-error'], { output: 'agent', events });

  const metered = writeEvent.calls.find((e) => e.type === 'agent_lane');
  assert.ok(metered);
  assert.equal(metered.result, 'pending');
});

// --- dispatch()/dispatchLane() wiring: command.start/command.result ----

test('dispatch: ctx.events omitted (or falsy) — zero event emission, identical to every pre-P1.5 caller', async () => {
  registerCommand({
    name: '__test-no-events',
    summary: 'fixture: backward compatibility with no events registry',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => ({ ok: true }),
  });
  // Must not throw, and must behave exactly as before P1.5 — no events arg.
  const code1 = await dispatch(['__test-no-events'], {});
  assert.equal(code1, 0);
  const code2 = await dispatch(['__test-no-events'], { output: 'json' });
  assert.equal(code2, 0);
});

test('dispatchLane: command.start then command.result bracket a successful call, with status ok and a numeric durationMs', async () => {
  registerCommand({
    name: '__test-bracket-success',
    summary: 'fixture: start/result bracketing',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => ({ ok: true }),
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  await dispatch(['__test-bracket-success'], { output: 'json', events });

  const types = writeEvent.calls.map((e) => e.type);
  assert.deepEqual(types, ['command.start', 'command.result']);
  const [, result] = writeEvent.calls;
  assert.equal(result.status, 'ok');
  assert.equal(result.exitCode, 0);
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.durationMs >= 0);
});

test('dispatchLane: a thrown E_CANCELLED error produces command.result with status "cancelled"', async () => {
  registerCommand({
    name: '__test-bracket-cancelled',
    summary: 'fixture: cancelled status mapping',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => {
      throw Object.assign(new Error('cancelled'), { code: 'E_CANCELLED', exit: 130 });
    },
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  const code = await dispatch(['__test-bracket-cancelled'], { output: 'json', events });
  assert.equal(code, 130);

  const result = writeEvent.calls.find((e) => e.type === 'command.result');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.exitCode, 130);
});

test('dispatchLane: a thrown E_TIMEOUT error produces command.result with status "timed-out"', async () => {
  registerCommand({
    name: '__test-bracket-timeout',
    summary: 'fixture: timed-out status mapping',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => {
      throw Object.assign(new Error('too slow'), { code: 'E_TIMEOUT', exit: 8 });
    },
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  const code = await dispatch(['__test-bracket-timeout'], { output: 'json', events });
  assert.equal(code, 8);

  const result = writeEvent.calls.find((e) => e.type === 'command.result');
  assert.equal(result.status, 'timed-out');
});

test('dispatch: the legacy-handler (ledger) branch also brackets with command.start/command.result when a resultOf-less entry runs under ctx.events (forward-looking path)', async () => {
  registerCommand({
    name: '__test-ledger-branch-events',
    summary: 'fixture: no resultOf, so dispatch falls through to the legacy handler even with output set',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    // deliberately no resultOf
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  const code = await dispatch(['__test-ledger-branch-events'], { output: 'agent', events });
  assert.equal(code, 0);

  const types = writeEvent.calls.map((e) => e.type);
  assert.deepEqual(types, ['command.start', 'command.result']);
});

test('dispatch: a thrown error from the legacy handler still emits command.result and re-throws the original error unmodified', async () => {
  const original = Object.assign(new Error('handler blew up'), { code: 'E_UNEXPECTED_TEST', exit: 1 });
  registerCommand({
    name: '__test-ledger-branch-throws',
    summary: 'fixture: legacy handler throws',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => {
      throw original;
    },
  });

  const writeEvent = spyWriteEvent();
  const events = createEventRegistry({ writeEvent, actor: { kind: 'user' } });
  await assert.rejects(() => dispatch(['__test-ledger-branch-throws'], { output: 'agent', events }), (err) => err === original);

  const result = writeEvent.calls.find((e) => e.type === 'command.result');
  assert.ok(result);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
});

// --- end-to-end: events.jsonl compatibility (requirement #6) -----------

test('end-to-end CLI: --output json-envelope on a registered pilot appends valid, readable JSONL events', () => {
  const workspace = tempDir('event-registry-e2e-ws-');
  const copilotHome = tempDir('event-registry-e2e-home-');

  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'json-envelope']);
  assert.equal(result.status, 0, result.stderr);

  const file = eventPath(workspace);
  assert.ok(fs.existsSync(file), 'events.jsonl must exist after a lane-dispatched command');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `every events.jsonl line must stay strict JSON: ${line}`);
  }

  const events = readEvents(workspace);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('command.start'));
  assert.ok(types.includes('command.result'));

  // The existing `harness events` command must still read this file without
  // choking on the new event types/fields (requirement #6).
  const eventsCmd = runHarness(['events', '--workspace', workspace, '--json']);
  assert.equal(eventsCmd.status, 0, eventsCmd.stderr);
  assert.doesNotThrow(() => JSON.parse(eventsCmd.stdout));
});

// P1.6 (carry-list, AC7 widening): the ledger/--json path used to be
// deliberately excluded from ctx.events (see the superseded test this one
// replaces, in git history) so that AC8 (verify's Ctrl-C cancellation ->
// command.result with a real status) works uniformly whether or not
// `--output` is present, and so every registered command gets the same
// baseline dispatch telemetry bin/harness.mjs's docs describe. This test now
// asserts the OPPOSITE of the old restriction on purpose.
test('end-to-end CLI: the legacy ledger/--json path on the same pilot NOW gains command.start/command.result events too', () => {
  const workspace = tempDir('event-registry-e2e-ledger-ws-');
  const copilotHome = tempDir('event-registry-e2e-ledger-home-');

  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(result.status, 0, result.stderr);

  const file = eventPath(workspace);
  assert.ok(fs.existsSync(file), 'events.jsonl must exist after a registered command dispatches on the legacy ledger/--json path');
  const events = readEvents(workspace);
  assert.deepEqual(events.map((e) => e.type), ['command.start', 'command.result']);
  assert.deepEqual(events.map((e) => e.result), ['pending', 'pass']);
});

// --- review round 1 regression: `harness events --summary` must not show
// phantom passes (the reviewer's exact repro, reproduced end to end) -----

test('end-to-end CLI: a successful pilot run under --output agent summarizes to exactly ONE pass, not one per event', () => {
  const workspace = tempDir('event-registry-summary-ok-ws-');
  const copilotHome = tempDir('event-registry-summary-ok-home-');

  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'agent']);
  assert.equal(result.status, 0, result.stderr);

  // Three events persist for one real outcome: command.start (pending),
  // agent_lane (pending, metering only), command.result (the real pass) —
  // pre-fix, eventResult()'s default inflated ALL THREE to 'pass'.
  const events = readEvents(workspace);
  assert.deepEqual(
    events.map((e) => e.type),
    ['command.start', 'agent_lane', 'command.result']
  );
  assert.deepEqual(
    events.map((e) => e.result),
    ['pending', 'pending', 'pass']
  );

  const summary = summarizeEvents(events);
  assert.equal(summary.total, 3, 'total still counts every persisted event');
  assert.equal(summary.pass, 1, 'exactly one real pass, not three phantom passes');
  assert.equal(summary.warn, 0);
  assert.equal(summary.fail, 0);

  // Same assertion via the actual `harness events --summary --json` CLI
  // surface the reviewer used to reproduce this.
  const summaryCmd = runHarness(['events', '--workspace', workspace, '--summary', '--json']);
  assert.equal(summaryCmd.status, 0, summaryCmd.stderr);
  const body = JSON.parse(summaryCmd.stdout);
  assert.equal(body.summary.pass, 1);
  assert.equal(body.summary.fail, 0);
});

test('end-to-end CLI: a FAILING pilot run (learnings --why <bad-id>) summarizes to fail:1 with zero phantom passes', () => {
  const workspace = tempDir('event-registry-summary-fail-ws-');
  const copilotHome = tempDir('event-registry-summary-fail-home-');

  const result = runHarness([
    'learnings',
    '--why',
    'this-id-does-not-exist',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--output',
    'json-envelope',
  ]);
  assert.equal(result.status, 1); // E_TARGET
  // dispatchLane's error branch writes the JSON error envelope to STDERR
  // (console.error), matching the existing json-envelope error convention.
  const body = JSON.parse(result.stderr);
  assert.equal(body.status, 'failed');

  const events = readEvents(workspace);
  assert.deepEqual(
    events.map((e) => e.type),
    ['command.start', 'command.result']
  );
  assert.equal(events[0].result, 'pending');
  assert.equal(events[1].result, 'fail');

  const summary = summarizeEvents(events);
  // Pre-fix (reviewer's repro): pass:1, fail:1 — a phantom 50% pass rate for
  // a command that failed outright. Post-fix: the command.start event no
  // longer tallies as a pass at all.
  assert.equal(summary.total, 2);
  assert.equal(summary.pass, 0, 'no phantom pass from command.start');
  assert.equal(summary.fail, 1);

  const summaryCmd = runHarness(['events', '--workspace', workspace, '--summary', '--json']);
  assert.equal(summaryCmd.status, 0, summaryCmd.stderr);
  const summaryBody = JSON.parse(summaryCmd.stdout);
  assert.equal(summaryBody.summary.pass, 0);
  assert.equal(summaryBody.summary.fail, 1);

  // --failures must surface the real failure and never a 'pending' row.
  const failuresCmd = runHarness(['events', '--workspace', workspace, '--failures', '--json']);
  assert.equal(failuresCmd.status, 0, failuresCmd.stderr);
  const failuresBody = JSON.parse(failuresCmd.stdout);
  const failureTypes = failuresBody.events.map((e) => e.type);
  assert.deepEqual(failureTypes, ['command.result']);
});
