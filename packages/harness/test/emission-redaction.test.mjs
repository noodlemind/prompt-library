/**
 * Fix-wave regressions C2/C3 — the shared redacting emission boundary.
 *
 * C2: lib/commands.mjs's `emitJson` (and every legacy `--json` serializer)
 * and lib/envelope.mjs's JSONL rows used to serialize with a bare
 * `JSON.stringify` — no redaction. Verified live repro:
 * `harness learnings --why 'ghp_…' --json` printed the raw token.
 *
 * C3: lib/events.mjs's `writeEvent` appended the assembled event without
 * redaction; host/actor/session metadata is stamped AFTER the event
 * registry's payload-only redaction, so `HARNESS_HOST=token=<secret>`
 * leaked verbatim into events.jsonl.
 *
 * Both now route through lib/redact.mjs at the sink itself (redactValue /
 * redactedJson), with byte-identity preserved for secret-free data.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createJsonlStream } from '../lib/envelope.mjs';
import { writeEvent, eventPath } from '../lib/events.mjs';
import { createRedactor } from '../lib/redact.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

const KV_SECRET = 'token=abcdef1234567890';
const KV_MASK = 'token=«redacted:kv-secret»';
const GHP_SECRET = 'ghp_' + 'a'.repeat(36);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHarness(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// --- C2: legacy --json serializers (emitJson) ------------------------------

test('C2: `learnings --why <kv-secret> --json` never prints the raw secret (verified pre-fix leak)', () => {
  const workspace = tempDir('emit-redact-why-kv-');
  const res = runHarness(['learnings', '--why', KV_SECRET, '--json', '--workspace', workspace]);
  assert.doesNotMatch(res.stdout + res.stderr, /abcdef1234567890/, 'the raw secret must never reach any stream');
  const body = JSON.parse(res.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.id, KV_MASK, 'the echoed --why id must be masked, not dropped');
  assert.match(body.blockedReason, /«redacted:kv-secret»/);
});

test('C2: `learnings --why <github-token> --json` masks the token with its own kind', () => {
  const workspace = tempDir('emit-redact-why-ghp-');
  const res = runHarness(['learnings', '--why', GHP_SECRET, '--json', '--workspace', workspace]);
  assert.doesNotMatch(res.stdout + res.stderr, new RegExp('a'.repeat(36)), 'the raw token must never reach any stream');
  const body = JSON.parse(res.stdout);
  assert.equal(body.id, '«redacted:github-token»');
});

test('C2: secret-free --json output is byte-identical (redaction at the boundary is invisible)', () => {
  const workspace = tempDir('emit-redact-benign-ws-');
  const copilotHome = tempDir('emit-redact-benign-home-');
  const res = runHarness(['status', '--json', '--workspace', workspace, '--copilot-home', copilotHome]);
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  // The exact legacy shape: packageVersion/copilotHome/lock, no envelope.
  assert.deepEqual(Object.keys(body), ['packageVersion', 'copilotHome', 'lock']);
  assert.equal(body.copilotHome, copilotHome);
});

// --- C2: the JSONL serializer (lib/envelope.mjs) ---------------------------

test('C2: a direct JSONL row carrying a secret is redacted before it reaches the stream (verified pre-fix leak)', () => {
  const chunks = [];
  const sink = { write: (chunk) => chunks.push(chunk) };
  const jsonl = createJsonlStream(sink, { redactor: createRedactor({ env: {} }) });
  jsonl.row({ check: 'leaky', line: `stdout said ${KV_SECRET}` });
  jsonl.result({ status: 'ok', note: GHP_SECRET });
  const text = chunks.join('');
  assert.doesNotMatch(text, /abcdef1234567890/);
  assert.doesNotMatch(text, new RegExp('a'.repeat(36)));
  const rows = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows[0].line, `stdout said ${KV_MASK}`);
  assert.equal(rows[1].note, '«redacted:github-token»');
  assert.equal(rows[1].status, 'ok', 'redaction must not disturb the status vocabulary');
});

test('C2: secret-free JSONL rows are byte-identical to a bare JSON.stringify', () => {
  const chunks = [];
  const sink = { write: (chunk) => chunks.push(chunk) };
  const jsonl = createJsonlStream(sink, { redactor: createRedactor({ env: {} }) });
  jsonl.start({ command: 'verify', plan: null });
  assert.equal(chunks[0], `${JSON.stringify({ schema: 1, event: 'start', command: 'verify', plan: null })}\n`);
});

// --- C3: the events.jsonl final sink (lib/events.mjs) ----------------------

test('C3: writeEvent redacts the FULLY ASSEMBLED event — HARNESS_HOST metadata included (verified pre-fix leak)', () => {
  const workspace = tempDir('emit-redact-events-host-');
  const original = process.env.HARNESS_HOST;
  process.env.HARNESS_HOST = KV_SECRET;
  try {
    const event = writeEvent(workspace, {}, { type: 'orient', command: 'orient', result: 'pass', exitCode: 0 });
    assert.equal(event.host, KV_MASK, 'the returned event must be the redacted one');
    const onDisk = fs.readFileSync(eventPath(workspace), 'utf8');
    assert.doesNotMatch(onDisk, /abcdef1234567890/, 'the raw HARNESS_HOST secret must never be persisted');
    assert.equal(JSON.parse(onDisk.trim()).host, KV_MASK);
  } finally {
    if (original === undefined) delete process.env.HARNESS_HOST;
    else process.env.HARNESS_HOST = original;
  }
});

test('C3: writeEvent redacts secret-shaped payload fields from legacy call sites (no registry involved)', () => {
  const workspace = tempDir('emit-redact-events-payload-');
  writeEvent(workspace, {}, { type: 'gate', command: 'gate', result: 'fail', exitCode: 1, blockedReason: `bad ref ${GHP_SECRET}` });
  const onDisk = fs.readFileSync(eventPath(workspace), 'utf8');
  assert.doesNotMatch(onDisk, new RegExp('a'.repeat(36)));
  assert.match(onDisk, /«redacted:github-token»/);
});

test('C3: end-to-end — a CLI run under HARNESS_HOST=token=<secret> leaves no raw secret anywhere in events.jsonl', () => {
  const workspace = tempDir('emit-redact-events-e2e-');
  const res = runHarness(['knowledge', '--workspace', workspace], { env: { HARNESS_HOST: KV_SECRET } });
  assert.equal(res.status, 0, res.stderr);
  const file = eventPath(workspace);
  assert.ok(fs.existsSync(file), 'the run must have written events');
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(onDisk, /abcdef1234567890/, 'no row — lifecycle, command.start, command.result — may carry the raw secret');
  const rows = onDisk.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(row.host, KV_MASK, `every assembled event's host metadata must be masked (row type ${row.type})`);
  }
});

test('C3: secret-free events persist byte-identically (field-for-field, no redaction artifacts)', () => {
  const workspace = tempDir('emit-redact-events-benign-');
  const event = writeEvent(workspace, {}, { type: 'orient', command: 'orient', result: 'pass', exitCode: 0, plan: 'docs/plans/x.md' });
  const onDisk = JSON.parse(fs.readFileSync(eventPath(workspace), 'utf8').trim());
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(event)));
  assert.equal(onDisk.plan, 'docs/plans/x.md');
  assert.equal(onDisk.result, 'pass');
});

// --- Round-2 P1: human/ledger output is now IN scope (AC6 absolute) ---------
//
// The user's decision widened the guarantee: the human ledger and the
// HARNESS_DEBUG dump must redact too, not only the machine sinks. Verified
// pre-fix leaks: `learnings --why token=…` echoed the raw token in the LEDGER
// error block, and `HARNESS_DEBUG=1` printed a sanitized error followed by the
// ORIGINAL raw stack.

test('P1: `learnings --why <kv-secret>` on the LEDGER path (no --json) never prints the raw token', () => {
  const workspace = tempDir('emit-redact-why-ledger-');
  const res = runHarness(['learnings', '--why', KV_SECRET, '--workspace', workspace, '--no-color']);
  const all = res.stdout + res.stderr;
  assert.doesNotMatch(all, /abcdef1234567890/, 'the echoed --why id must be masked in the human error block');
  assert.match(all, /«redacted:kv-secret»/, 'the ledger surface must carry the mask');
});

test('P1: `learnings --why <github-token>` LEDGER path masks with the token kind', () => {
  const workspace = tempDir('emit-redact-why-ledger-ghp-');
  const res = runHarness(['learnings', '--why', GHP_SECRET, '--workspace', workspace, '--no-color']);
  assert.doesNotMatch(res.stdout + res.stderr, new RegExp('a'.repeat(36)), 'raw github token must never reach the ledger');
  assert.match(res.stdout + res.stderr, /«redacted:github-token»/);
});

test('P1: HARNESS_DEBUG=1 routes the raw error stack through the redactor (no post-sanitized raw dump)', () => {
  const workspace = tempDir('emit-redact-debug-');
  // A bad --output value throws E_USAGE with the value echoed in its message;
  // emitError sanitizes the block, and the HARNESS_DEBUG dump of the raw stack
  // must be redacted too (pre-fix it printed `console.error(err)` verbatim).
  const res = runHarness(['status', '--output', KV_SECRET, '--workspace', workspace], { env: { HARNESS_DEBUG: '1' } });
  assert.notEqual(res.status, 0);
  assert.doesNotMatch(res.stderr, /abcdef1234567890/, 'the HARNESS_DEBUG stack must not leak the raw secret');
  assert.match(res.stderr, /«redacted:kv-secret»/, 'the debug dump must carry the mask');
  assert.match(res.stderr, /\bat\b/, 'the debug dump really printed a stack — otherwise this proves nothing');
});

// --- Round-2 P1: report --sync repersistence is a redaction boundary --------
//
// lib/telemetry-store.mjs copied workspace event rows into the GLOBAL store
// with a bare JSON.stringify. Local rows are already redacted (C3), so this
// test hand-writes RAW secrets straight into the local log to prove the sync
// boundary masks independently, as defense in depth.

// --- JSON-validity regression: adversarial secret/quote placements must ----
// --- never produce malformed JSON through the real serialize-independent ---
// --- sinks (JSONL row writer, events.jsonl append), not just redactedJson --
// --- in isolation. See test/redact.test.mjs for the isolated table and the
// --- root-cause explanation (a text pass over already-serialized JSON
// --- consuming the escaping backslash before an escaped quote).

const QUOTE_ADJACENT_KV_SECRET = 'no learning "token=abcdef1234567890" found';
const STDOUT_QUOTE_ADJACENT_KV_SECRET = 'FAIL expected "token=abcdef1234567890" got x';

test('JSON-validity: a JSONL row carrying a secret adjacent to an escaped quote is still valid JSON', () => {
  const chunks = [];
  const sink = { write: (chunk) => chunks.push(chunk) };
  const jsonl = createJsonlStream(sink, { redactor: createRedactor({ env: {} }) });
  jsonl.row({ check: 'leaky', line: QUOTE_ADJACENT_KV_SECRET });
  jsonl.row({ check: 'leaky', stream: 'stdout', line: STDOUT_QUOTE_ADJACENT_KV_SECRET });
  jsonl.result({ status: 'failed', message: QUOTE_ADJACENT_KV_SECRET });
  const text = chunks.join('');
  const lines = text.trim().split('\n');
  const rows = lines.map((line, i) => {
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(line);
    }, `row ${i} must be valid JSON: ${line}`);
    return parsed;
  });
  assert.doesNotMatch(text, /abcdef1234567890/, 'the raw secret must never reach the stream');
  assert.match(rows[0].line, /«redacted:kv-secret»/);
  assert.match(rows[1].line, /«redacted:kv-secret»/);
  assert.match(rows[2].message, /«redacted:kv-secret»/);
  assert.equal(rows[2].status, 'failed');
});

test('JSON-validity: writeEvent persists a secret-adjacent-to-quote blockedReason as parseable JSONL', () => {
  const workspace = tempDir('emit-redact-json-validity-events-');
  writeEvent(workspace, {}, {
    type: 'gate',
    command: 'gate',
    result: 'fail',
    exitCode: 1,
    blockedReason: QUOTE_ADJACENT_KV_SECRET,
  });
  const onDisk = fs.readFileSync(eventPath(workspace), 'utf8');
  const line = onDisk.trim();
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(line);
  }, `events.jsonl row must be valid JSON: ${line}`);
  assert.doesNotMatch(onDisk, /abcdef1234567890/, 'the raw secret must never be persisted');
  assert.match(parsed.blockedReason, /«redacted:kv-secret»/);
});

test('P1: report --sync repersists each row through the redactor into the global store', async () => {
  const { syncWorkspaceEvents } = await import('../lib/telemetry-store.mjs');
  const workspace = tempDir('emit-redact-sync-ws-');
  const home = tempDir('emit-redact-sync-home-');
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(
    eventPath(workspace),
    JSON.stringify({ id: 'e1', type: 'orient', host: KV_SECRET, agent: GHP_SECRET }) + '\n',
    'utf8'
  );
  const prev = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    const synced = syncWorkspaceEvents({ workspace });
    assert.equal(synced.added, 1);
    const onDisk = fs.readFileSync(synced.file, 'utf8');
    assert.doesNotMatch(onDisk, /abcdef1234567890/, 'the raw kv-secret must never land in the global store');
    assert.doesNotMatch(onDisk, new RegExp('a'.repeat(36)), 'the raw github token must never land in the global store');
    const row = JSON.parse(onDisk.trim());
    assert.equal(row.host, KV_MASK);
    assert.equal(row.agent, '«redacted:github-token»');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = prev;
  }
});
