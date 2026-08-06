/**
 * Event registry — the central event emitter for the harness dispatch
 * pipeline (Phase 1 task P1.5, see
 * .superpowers/sdd/2026-07-29-harness-cli-phase1-core/task-5-brief.md).
 * `lib/registry.mjs`'s `dispatch`/`dispatchLane` (the NEW envelope/agent
 * output lanes from P1.2) call `emit`/`withCommand(...).emit` here instead
 * of reaching into `lib/events.mjs` directly, so every event this module
 * produces carries the SAME actor/execution metadata and is redacted BEFORE
 * it ever reaches the injected `writeEvent` sink (AC6/AC7).
 *
 * `createEventRegistry({ writeEvent, redactor, actor, clock, pid,
 * harnessVersion }) -> { emit(type, payload), withCommand(command) }`
 *
 *   - `writeEvent(payload)` — REQUIRED, single-argument sink. The caller
 *     (bin/harness.mjs — "registry construction plumbing") binds this to
 *     the real `lib/events.mjs` `writeEvent(workspace, flags, payload)` for
 *     one resolved workspace/flags pair. Tests inject a spy instead. This is
 *     deliberately NOT the 3-arg `lib/events.mjs` signature itself — it is
 *     also the exact shape `lib/agent-lane.mjs`'s `recordAgentLaneBytes`
 *     already expects from an `eventsApi` (`eventsApi.writeEvent(record)`),
 *     so this registry composes with that existing, unmodified contract.
 *   - `redactor` — defaults to the REAL `createRedactor()` (lib/redact.mjs),
 *     secure by default; inject a marker/spy redactor to prove redaction
 *     ran before persistence (AC6).
 *   - `actor` — defaults to `detectActor()` (below), evaluated once per
 *     `createEventRegistry(...)` call — the harness CLI calls this exactly
 *     once per process (bin/harness.mjs), so actor detection happens once
 *     per process as required (AC7 #2).
 *   - `clock` — defaults to `() => new Date().toISOString()`; injectable
 *     for deterministic tests. Note: when the injected `writeEvent` is the
 *     REAL `lib/events.mjs` sink, that function stamps its own wall-clock
 *     `ts` and ignores whatever `ts` arrives on `payload` (untouched,
 *     off-limits legacy behavior — see the module doc there) — the
 *     injected clock's determinism is therefore observable on the event
 *     OBJECT this module constructs and passes to `writeEvent`, which is
 *     what every test in test/event-registry.test.mjs asserts against.
 *   - `pid`/`harnessVersion` — the `execution` block stamped on
 *     `command.start` events ONLY, never on every event (AC7 #2).
 *     `harnessVersion` defaults to this package's own package.json version.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRedactor } from './redact.mjs';
import { pkgRootFromImportMeta } from './paths.mjs';

const PKG_ROOT = pkgRootFromImportMeta(import.meta.url);

function readDefaultHarnessVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/** The closed event-type vocabulary this module and its callers use. Kept
 * as a single source of truth so lib/registry.mjs never hardcodes the
 * literal strings, and so lib/events.mjs's additive EVENT_TYPES entries can
 * be cross-checked against the same names in tests. `AGENT_LANE` matches
 * the literal `'agent_lane'` string lib/agent-lane.mjs's (off-limits,
 * already-landed) `recordAgentLaneBytes` hardcodes internally — this module
 * does not choose that name, it must match it. */
export const EVENT_TYPE = Object.freeze({
  COMMAND_START: 'command.start',
  COMMAND_RESULT: 'command.result',
  AGENT_LANE: 'agent_lane',
});

/**
 * Actor/execution metadata (AC7 #2). Detection order:
 *   1. CI env (`CI` or `GITHUB_ACTIONS` truthy) -> `{kind: 'ci'}`.
 *   2. A known host marker -> `{kind: 'host', host: <name>}`. Per the brief,
 *      `lib/host-telemetry/` was studied first: `index.mjs`'s `ADAPTERS`
 *      map (vscode/intellij/cli) goes the OPPOSITE direction — given an
 *      explicit host id, collect that host's usage log — and is not
 *      exported for reuse (no detection function exists there to import).
 *      Rather than duplicate its literal id strings here, this reuses the
 *      harness's own EXISTING self-identification convention instead: the
 *      `HARNESS_HOST` env var lib/events.mjs's `writeEvent` already reads
 *      today (`payload.host || flags.host || process.env.HARNESS_HOST ||
 *      'harness-cli'`) is the one marker already established as "which
 *      host is orchestrating this CLI run" — so it is what this module
 *      checks too.
 *   3. default -> `{kind: 'user'}`.
 *
 * `env` is injectable (defaults to `process.env`) so tests can pin CI/host
 * detection deterministically without mutating global state.
 */
export function detectActor(env = process.env) {
  if (env.CI || env.GITHUB_ACTIONS) return { kind: 'ci' };
  if (env.HARNESS_HOST) return { kind: 'host', host: env.HARNESS_HOST };
  return { kind: 'user' };
}

/**
 * Flag NAMES only from an argv slice — NEVER values (a flag's value may be
 * a secret; this is requirement #3's "flag NAMES only, never values"
 * guarantee, self-reviewed explicitly for this task). Mirrors
 * lib/registry.mjs's `validateArgs` token walk: stops at a literal `--`
 * boundary (nothing past it is a flag), and a `--flag=value` token
 * contributes only `--flag`, never the part after `=`.
 *
 * `knownFlags` is an OPTIONAL `Map`-like lookup (name/alias -> `{type}`) —
 * pass `flagIndex(entry)`'s exact return shape from lib/registry.mjs for
 * PRECISE value-consumption (a flag explicitly declared `type: 'boolean'`
 * never consumes the next token; every other declared flag does, exactly
 * matching `validateArgs`'s own `nextIsValue` check). This is what
 * lib/registry.mjs's dispatch/dispatchLane pass, since they already have
 * the entry's schema in hand (the same schema `validateArgs` already
 * validated this exact argv against, one call earlier in the same
 * dispatch).
 *
 * WITHOUT `knownFlags` (e.g. calling this function directly, schema-free),
 * a flag's boolean-ness is unknowable from shape alone — `--explain -c` (two
 * flags) and `--why -explain-mode` (a flag plus a single-dash-shaped VALUE,
 * the exact precedent lib/flags.mjs itself already establishes for `--why`)
 * are indistinguishable by shape. This function then conservatively treats
 * any next token that doesn't itself start with `--` as a CONSUMED VALUE and
 * excludes it from the result — the safe failure mode: worst case this
 * drops a legitimate flag name adjacent to a boolean flag from the summary
 * (a false negative, harmless for best-effort telemetry); it must never do
 * the reverse and let a value be misclassified as a name (a false positive,
 * which could leak a secret).
 */
export function summarizeArgFlags(argv = [], knownFlags = null) {
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== 'string') continue;
    if (token === '--') break; // literal-argument boundary — nothing past this is a flag
    if (!token.startsWith('-') || token === '-') continue; // positional / bare '-'
    const eq = token.indexOf('=');
    const flagName = eq === -1 ? token : token.slice(0, eq);
    names.push(flagName);
    if (eq !== -1) continue; // inline `--flag=value` — nothing to look ahead for

    const next = argv[i + 1];
    const nextLooksLikeValue = next !== undefined && typeof next === 'string' && !next.startsWith('--');
    const def = knownFlags ? knownFlags.get(flagName) : undefined;
    const consumesNext = def ? def.type !== 'boolean' && nextLooksLikeValue : nextLooksLikeValue;
    if (consumesNext) i++; // skip the value — never inspected as a potential name
  }
  return names;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertEventType(type, who) {
  if (typeof type !== 'string' || !type) {
    throw new TypeError(`${who}: type (string) is required`);
  }
}

/**
 * Build the central event registry. See the module doc above for the exact
 * dependency/default contract.
 */
export function createEventRegistry({
  writeEvent,
  redactor = createRedactor(),
  actor = detectActor(),
  clock = () => new Date().toISOString(),
  pid = process.pid,
  harnessVersion = readDefaultHarnessVersion(),
} = {}) {
  if (typeof writeEvent !== 'function') {
    throw new TypeError('createEventRegistry: writeEvent(payload) function is required');
  }

  // Redaction before persistence (AC6): every payload passes through
  // redactor.redactValue here, unconditionally, before the constructed
  // event object ever reaches `writeEvent`. Only the command-specific
  // PAYLOAD is redacted (not the harness-controlled type/ts/actor/command
  // envelope fields, which never carry caller-supplied free text).
  function persist(type, payload, command) {
    const safePayload = redactor.redactValue(isPlainObject(payload) ? payload : {});
    const event = {
      type,
      ts: clock(),
      actor,
      ...(command ? { command } : {}),
      ...safePayload,
    };
    if (type === EVENT_TYPE.COMMAND_START) {
      event.execution = { pid, harnessVersion };
    }
    return writeEvent(event);
  }

  function emit(type, payload = {}) {
    assertEventType(type, 'createEventRegistry.emit');
    return persist(type, payload, undefined);
  }

  /** A command-scoped emitter: every event it produces carries `command`
   * automatically, for the duration of one command's dispatch. */
  function withCommand(command) {
    if (typeof command !== 'string' || !command) {
      throw new TypeError('createEventRegistry.withCommand: command (string) is required');
    }
    return {
      emit(type, payload = {}) {
        assertEventType(type, 'createEventRegistry.withCommand(...).emit');
        return persist(type, payload, command);
      },
    };
  }

  return { emit, withCommand };
}
