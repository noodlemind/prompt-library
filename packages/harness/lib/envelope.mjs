/**
 * Envelope lane — the "programs / TUI" audience from
 * docs/architecture/harness-cli-workbench.md § "Output lanes: the
 * three-audience contract". A versioned JSON envelope for a single result,
 * plus JSONL streaming for long-running operations. Both are pure,
 * deterministic serialization: no model pass, no network, no filesystem.
 *
 * Contract summary (binding, see the architecture doc for the full text):
 *   - top-level `schema` (integer, append-only-versioned), `command`,
 *     `status`, THEN summary scalars, THEN detail arrays/objects — so one
 *     payload serves both a one-line footer and an expanded view.
 *   - status vocabulary is `ok | failed | cancelled | timed-out`, plus
 *     `blocked` where gate semantics already use it (lib/gate.mjs).
 *   - JSONL rows are `{schema, event, ...}` with
 *     `event ∈ start | progress | row | result`; a terminal `result` row
 *     carries the same status vocabulary, and `cancelled` vs `timed-out`
 *     are never collapsed into each other or into `failed` — this mirrors
 *     lib/runner.mjs's own `status` contract end to end.
 *
 * This module does not decide WHICH lane a command renders (that is
 * lib/registry.mjs's `ctx.output` dispatch) — it only builds the shapes.
 */
import { EXIT } from './style.mjs';

export const ENVELOPE_SCHEMA_VERSION = 1;

// The status vocabulary every lane shares (architecture doc, "Output lanes"
// + lib/runner.mjs's `status` contract). `blocked` is additive for gate-like
// commands (lib/gate.mjs's existing pass/blockedReason semantics) — it is
// not one of runner.mjs's four process outcomes.
export const STATUS = Object.freeze({
  OK: 'ok',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed-out',
  BLOCKED: 'blocked',
});

export const STATUS_VALUES = Object.freeze(Object.values(STATUS));

function assertKnownStatus(status, who) {
  if (!STATUS_VALUES.includes(status)) {
    throw new TypeError(`${who}: unknown status ${JSON.stringify(status)} (expected ${STATUS_VALUES.join(' | ')})`);
  }
}

// Only `ok`, `cancelled`, and `timed-out` map to ONE fixed process exit code
// everywhere they occur (mirrors lib/runner.mjs's status contract 1:1).
// `failed` and `blocked` do not — a failed command's exit code depends on
// which E_* error produced it (E_USAGE vs E_TARGET vs ...), so callers
// building an error envelope should pass an explicit `exit`; this mapping is
// only the FALLBACK when they don't.
const STATUS_EXIT_CODES = Object.freeze({
  [STATUS.OK]: EXIT.ok,
  [STATUS.CANCELLED]: EXIT.cancelled,
  [STATUS.TIMED_OUT]: EXIT.timedOut,
});

/** Exit code for a status, when the caller has no more specific one. */
export function exitForStatus(status, fallback = 1) {
  return STATUS_EXIT_CODES[status] ?? fallback;
}

function isScalarValue(value) {
  return value === null || value === undefined || (typeof value !== 'object' && typeof value !== 'function');
}

/**
 * Split a plain data object into `{scalars, details}`, preserving each
 * bucket's original relative key order. `scalars` are strings/numbers/
 * booleans/null/undefined — the one-line-footer material; `details` are
 * arrays and plain objects — the expanded-view material. Shared by
 * `createEnvelope` (key ordering) and lib/agent-lane.mjs (rendering order)
 * so both lanes honor the SAME "summary first, detail after" rule from one
 * source of truth.
 */
export function splitScalarsAndDetails(data) {
  const scalars = {};
  const details = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (isScalarValue(value)) scalars[key] = value;
    else details[key] = value;
  }
  return { scalars, details };
}

/**
 * Build the versioned success envelope for one command's canonical result.
 *
 * `createEnvelope({ command, schema, status, ...resultFields })` — every
 * field besides `command`/`schema`/`status` is the command's own result data
 * (e.g. orient's `{recall, learnings, plans, gateStatus, ...}`), reordered
 * scalars-first/details-after per the contract. Never mutates `resultFields`;
 * always returns a fresh object so repeated calls with equal input serialize
 * to byte-identical JSON (determinism requirement of the agent/envelope
 * lanes).
 */
export function createEnvelope({ command, schema = ENVELOPE_SCHEMA_VERSION, status = STATUS.OK, ...data } = {}) {
  if (!command || typeof command !== 'string') {
    throw new TypeError('createEnvelope: command (string) is required');
  }
  assertKnownStatus(status, 'createEnvelope');
  const { scalars, details } = splitScalarsAndDetails(data);
  return { schema, command, status, ...scalars, ...details };
}

/**
 * Build the unified error envelope: `{schema, command, status, error:
 * {code, message, fix?, exit}}`. `code` follows the existing `E_*`
 * vocabulary used throughout lib/commands.mjs and lib/registry.mjs; `exit`
 * defaults via `exitForStatus` only when the caller doesn't supply one
 * (most real errors carry their own specific exit code, e.g. `EXIT.usage`).
 */
export function createErrorEnvelope({
  command,
  schema = ENVELOPE_SCHEMA_VERSION,
  status = STATUS.FAILED,
  code,
  message,
  fix,
  exit,
} = {}) {
  if (!command || typeof command !== 'string') {
    throw new TypeError('createErrorEnvelope: command (string) is required');
  }
  assertKnownStatus(status, 'createErrorEnvelope');
  if (!code || typeof code !== 'string') {
    throw new TypeError('createErrorEnvelope: error.code (string) is required');
  }
  const error = { code, message: message ?? '' };
  if (fix !== undefined && fix !== null) error.fix = fix;
  error.exit = Number.isInteger(exit) ? exit : exitForStatus(status);
  return { schema, command, status, error };
}

// The closed event vocabulary for a JSONL stream row (requirement #2).
const JSONL_EVENTS = new Set(['start', 'progress', 'row', 'result']);

/**
 * Open a JSONL emitter bound to one writable `stream` (typically
 * `process.stdout`, but any object with a `write(chunk)` method — including
 * a plain in-memory sink — works for tests). Each call writes exactly one
 * `{schema, event, ...fields}` line, newline-terminated.
 *
 * `event` must be one of `start | progress | row | result`; a `result`
 * row's `status`, when present, is validated against the same vocabulary
 * `createEnvelope` uses — a `cancelled` terminal row and a `timed-out`
 * terminal row are always distinguishable from each other and from `failed`,
 * matching lib/runner.mjs's status contract end to end.
 */
export function createJsonlStream(stream, { schema = ENVELOPE_SCHEMA_VERSION } = {}) {
  if (!stream || typeof stream.write !== 'function') {
    throw new TypeError('createJsonlStream: stream with a write(chunk) method is required');
  }

  function emit(event, fields = {}) {
    if (!JSONL_EVENTS.has(event)) {
      throw new TypeError(`createJsonlStream: unknown event ${JSON.stringify(event)} (expected ${[...JSONL_EVENTS].join(' | ')})`);
    }
    if (event === 'result' && fields.status !== undefined) {
      assertKnownStatus(fields.status, 'createJsonlStream result row');
    }
    stream.write(`${JSON.stringify({ schema, event, ...fields })}\n`);
  }

  return {
    start: (fields) => emit('start', fields),
    progress: (fields) => emit('progress', fields),
    row: (fields) => emit('row', fields),
    result: (fields) => emit('result', fields),
    write: emit,
  };
}
