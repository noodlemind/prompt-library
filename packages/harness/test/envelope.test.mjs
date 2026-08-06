import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import {
  ENVELOPE_SCHEMA_VERSION,
  STATUS,
  STATUS_VALUES,
  exitForStatus,
  splitScalarsAndDetails,
  createEnvelope,
  createErrorEnvelope,
  createJsonlStream,
} from '../lib/envelope.mjs';

// A minimal in-memory writable — `createJsonlStream` only ever calls
// `stream.write(chunk)`, so this is all a fake stream needs to be.
function fakeStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    chunks,
    lines() {
      return chunks.map((c) => JSON.parse(c));
    },
  };
}

// --- splitScalarsAndDetails -------------------------------------------------

test('splitScalarsAndDetails buckets scalars (incl. null) vs arrays/objects, preserving relative order', () => {
  const { scalars, details } = splitScalarsAndDetails({
    b: [1, 2],
    a: 'text',
    d: { x: 1 },
    c: 5,
    e: null,
    f: true,
  });
  assert.deepEqual(Object.keys(scalars), ['a', 'c', 'e', 'f']);
  assert.deepEqual(scalars, { a: 'text', c: 5, e: null, f: true });
  assert.deepEqual(Object.keys(details), ['b', 'd']);
  assert.deepEqual(details, { b: [1, 2], d: { x: 1 } });
});

test('splitScalarsAndDetails handles an empty/absent input', () => {
  assert.deepEqual(splitScalarsAndDetails({}), { scalars: {}, details: {} });
  assert.deepEqual(splitScalarsAndDetails(undefined), { scalars: {}, details: {} });
});

// --- createEnvelope ----------------------------------------------------------

test('createEnvelope requires a command', () => {
  assert.throws(() => createEnvelope({}), TypeError);
  assert.throws(() => createEnvelope(), TypeError);
  assert.throws(() => createEnvelope({ command: '' }), TypeError);
});

test('createEnvelope defaults schema to the current version and status to ok', () => {
  const envelope = createEnvelope({ command: 'status' });
  assert.equal(envelope.schema, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.schema, 1);
  assert.equal(envelope.command, 'status');
  assert.equal(envelope.status, 'ok');
});

test('createEnvelope rejects an unknown status', () => {
  assert.throws(() => createEnvelope({ command: 'orient', status: 'not-a-real-status' }), TypeError);
});

test('createEnvelope orders scalars (incl. null) before arrays/objects on the serialized envelope', () => {
  // Modeled on orient's actual --json shape (task-1-report.md repro output),
  // deliberately declared out of "natural" order to prove the envelope
  // reorders rather than merely preserving input order.
  const envelope = createEnvelope({
    command: 'orient',
    recall: [1, 2],
    contextPack: '.harness/context-pack.md',
    plans: [],
    gateStatus: 'blocked',
    activePlan: null,
    learningsBytes: 0,
  });

  assert.deepEqual(Object.keys(envelope), [
    'schema',
    'command',
    'status',
    'contextPack',
    'gateStatus',
    'activePlan',
    'learningsBytes',
    'recall',
    'plans',
  ]);

  // Ordering must hold on the ACTUAL SERIALIZED bytes, not just the live
  // object's key iteration — every scalar key's position in the JSON string
  // precedes every detail key's position.
  const json = JSON.stringify(envelope);
  const scalarPositions = ['contextPack', 'gateStatus', 'activePlan', 'learningsBytes'].map((k) => json.indexOf(`"${k}"`));
  const detailPositions = ['recall', 'plans'].map((k) => json.indexOf(`"${k}"`));
  assert.ok(scalarPositions.every((p) => p !== -1) && detailPositions.every((p) => p !== -1));
  assert.ok(Math.max(...scalarPositions) < Math.min(...detailPositions), `expected all scalars before all details in: ${json}`);
});

test('createEnvelope carries result data through unchanged in value', () => {
  const recall = [{ id: 'a' }];
  const envelope = createEnvelope({ command: 'orient', recall });
  assert.deepEqual(envelope.recall, recall);
});

test('createEnvelope is deterministic — equal input serializes to byte-identical JSON', () => {
  const build = () =>
    createEnvelope({
      command: 'learnings',
      learnings: [{ id: 'sql/x', status: 'active' }],
      quarantined: [],
    });
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
});

// --- createErrorEnvelope ------------------------------------------------------

test('createErrorEnvelope requires command and error.code', () => {
  assert.throws(() => createErrorEnvelope({ code: 'E_USAGE', message: 'x' }), TypeError);
  assert.throws(() => createErrorEnvelope({ command: 'orient', message: 'x' }), TypeError);
});

test('createErrorEnvelope shape matches {schema, command, status, error:{code,message,exit}}', () => {
  const envelope = createErrorEnvelope({ command: 'learnings', code: 'E_TARGET', message: 'no learning x', exit: 1 });
  assert.deepEqual(envelope, {
    schema: 1,
    command: 'learnings',
    status: 'failed',
    error: { code: 'E_TARGET', message: 'no learning x', exit: 1 },
  });
});

test('createErrorEnvelope includes error.fix only when supplied', () => {
  const withFix = createErrorEnvelope({ command: 'learnings', code: 'E_USAGE', message: 'bad flag', fix: 'harness help learnings', exit: 2 });
  assert.equal(withFix.error.fix, 'harness help learnings');

  const withoutFix = createErrorEnvelope({ command: 'learnings', code: 'E_USAGE', message: 'bad flag', exit: 2 });
  assert.ok(!('fix' in withoutFix.error));
});

test('createErrorEnvelope defaults exit from status when the caller supplies none', () => {
  const cancelled = createErrorEnvelope({ command: 'exec', code: 'E_CANCELLED', message: 'aborted', status: 'cancelled' });
  assert.equal(cancelled.error.exit, EXIT.cancelled);
  assert.equal(cancelled.error.exit, 130);

  const timedOut = createErrorEnvelope({ command: 'exec', code: 'E_TIMEOUT', message: 'ran out of time', status: 'timed-out' });
  assert.equal(timedOut.error.exit, EXIT.timedOut);
  assert.notEqual(timedOut.error.exit, cancelled.error.exit, 'cancelled and timed-out must never collapse to the same exit code');
});

// --- status vocabulary / exit mapping -----------------------------------------

test('STATUS_VALUES is the closed ok|failed|cancelled|timed-out(+blocked) vocabulary', () => {
  assert.deepEqual([...STATUS_VALUES].sort(), ['blocked', 'cancelled', 'failed', 'ok', 'timed-out'].sort());
  assert.equal(STATUS.OK, 'ok');
  assert.equal(STATUS.FAILED, 'failed');
  assert.equal(STATUS.CANCELLED, 'cancelled');
  assert.equal(STATUS.TIMED_OUT, 'timed-out');
  assert.equal(STATUS.BLOCKED, 'blocked');
});

test('exitForStatus maps ok/cancelled/timed-out to their fixed EXIT codes', () => {
  assert.equal(exitForStatus('ok'), EXIT.ok);
  assert.equal(exitForStatus('cancelled'), EXIT.cancelled);
  assert.equal(exitForStatus('timed-out'), EXIT.timedOut);
});

test('exitForStatus falls back for statuses with no single fixed exit code (failed/blocked)', () => {
  assert.equal(exitForStatus('failed'), 1); // default fallback
  assert.equal(exitForStatus('blocked'), 1);
  assert.equal(exitForStatus('blocked', 4), 4); // caller-supplied fallback
});

test('lib/style.mjs EXIT table gained cancelled (reusing interrupted) and a distinct timedOut', () => {
  assert.equal(EXIT.cancelled, EXIT.interrupted);
  assert.equal(EXIT.cancelled, 130);
  assert.equal(typeof EXIT.timedOut, 'number');
  const others = [EXIT.ok, EXIT.usage, EXIT.notInitialized, EXIT.needsApproval, EXIT.syncConflict, EXIT.doctorFailed, EXIT.network, EXIT.interrupted];
  assert.ok(!others.includes(EXIT.timedOut), 'timedOut must be distinct from every pre-existing exit code');
});

// --- createJsonlStream ---------------------------------------------------------

test('createJsonlStream requires a writable stream', () => {
  assert.throws(() => createJsonlStream(null), TypeError);
  assert.throws(() => createJsonlStream({}), TypeError); // no write()
});

test('createJsonlStream emits one JSON object per line for each event kind', () => {
  const s = fakeStream();
  const jsonl = createJsonlStream(s);
  jsonl.start({ command: 'exec' });
  jsonl.progress({ command: 'exec', note: 'halfway' });
  jsonl.row({ command: 'exec', line: 'stdout chunk' });
  jsonl.result({ command: 'exec', status: 'ok' });

  assert.equal(s.chunks.length, 4);
  for (const chunk of s.chunks) {
    assert.equal(chunk.endsWith('\n'), true);
    assert.equal(chunk.split('\n').length, 2); // exactly one JSON object + trailing empty
  }
  const [start, progress, row, result] = s.lines();
  assert.deepEqual(
    [start.event, progress.event, row.event, result.event],
    ['start', 'progress', 'row', 'result']
  );
  for (const line of [start, progress, row, result]) {
    assert.equal(line.schema, 1);
  }
  assert.equal(progress.note, 'halfway');
  assert.equal(row.line, 'stdout chunk');
  assert.equal(result.status, 'ok');
});

test('createJsonlStream rejects an event outside start|progress|row|result', () => {
  const jsonl = createJsonlStream(fakeStream());
  assert.throws(() => jsonl.write('bogus', {}), TypeError);
});

test('createJsonlStream validates a result row status against the shared vocabulary', () => {
  const jsonl = createJsonlStream(fakeStream());
  assert.throws(() => jsonl.result({ command: 'exec', status: 'not-a-status' }), TypeError);
  assert.doesNotThrow(() => jsonl.result({ command: 'exec', status: 'ok' }));
});

test('createJsonlStream keeps cancelled and timed-out terminal rows distinct, never collapsed into failed', () => {
  const s = fakeStream();
  const jsonl = createJsonlStream(s);
  jsonl.result({ command: 'exec', status: 'cancelled' });
  jsonl.result({ command: 'exec', status: 'timed-out' });
  const [cancelledRow, timedOutRow] = s.lines();
  assert.equal(cancelledRow.status, 'cancelled');
  assert.equal(timedOutRow.status, 'timed-out');
  assert.notEqual(cancelledRow.status, timedOutRow.status);
  assert.ok(![cancelledRow.status, timedOutRow.status].includes('failed'));
});

test('createJsonlStream honors a custom schema version', () => {
  const s = fakeStream();
  const jsonl = createJsonlStream(s, { schema: 2 });
  jsonl.start({});
  assert.equal(s.lines()[0].schema, 2);
});

// --- Fix-wave P2: JSONL backpressure — the terminal row is never discarded --
//
// emit() ignored `stream.write() === false`, and the CLI's unconditional
// process.exit could discard a terminal `result` row buffered under
// backpressure. The stream now tracks the write result and exposes drained(),
// which a producer (and the CLI, plus bin/harness.mjs's flush-before-exit)
// awaits before exiting.

test('createJsonlStream: drained() waits while the stream is backpressured, then resolves on drain', async () => {
  const emitter = new EventEmitter();
  const writes = [];
  const stream = {
    write(chunk) {
      writes.push(chunk);
      return false; // always backpressured, like a full pipe
    },
    once: (event, cb) => emitter.once(event, cb),
  };
  const jsonl = createJsonlStream(stream);
  jsonl.result({ status: 'ok' });
  assert.equal(writes.length, 1, 'the terminal row was still written');

  let resolved = false;
  const pending = jsonl.drained().then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false, 'drained() must not resolve while backpressure is unrelieved');
  emitter.emit('drain');
  await pending;
  assert.equal(resolved, true, 'drained() resolves once the stream drains');
});

test('createJsonlStream: drained() resolves immediately when no backpressure occurred', async () => {
  const jsonl = createJsonlStream({ write: () => true });
  jsonl.result({ status: 'ok' });
  await jsonl.drained(); // must not hang
  assert.ok(true);
});

test('createJsonlStream: a plain in-memory sink (no once) never hangs drained()', async () => {
  const s = fakeStream();
  const jsonl = createJsonlStream(s);
  jsonl.row({ line: 'x' });
  await jsonl.drained();
  assert.equal(s.chunks.length, 1);
});
