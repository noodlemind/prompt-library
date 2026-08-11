import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureHarnessDir, readSession } from './session.mjs';
import { summarizeUsage } from './token-meter.mjs';
import { createRedactor } from './redact.mjs';
import { currentRunContext } from './run-context.mjs';
import { appendGuarded, pruneJournalFile } from './retention.mjs';
import { retentionDaysFor } from './retention-config.mjs';

export const EVENTS_FILE = 'events.jsonl';
export const EVENTS_DEFAULT_LIMIT = 20;
export const EVENTS_MAX_LIMIT = 200;
/** Terminal statuses an operator asking for failures means to see. `ok` is
 * excluded; everything else that ended badly is included. */
export const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'timed-out']);

export const EVENT_TYPES = new Set([
  'session_start',
  'orient',
  'gate',
  'pre_tool',
  'post_tool',
  'skill_activation',
  'verify',
  'compound',
  'consolidate',
  'remember',
  'learning',
  'knowledge',
  'session_end',
  // Formerly silently dropped (harness-tool-contract.md footnote): these four
  // commands always CALLED writeEvent, but their types were absent from this
  // allow-list, so the writes no-opped. Allow-listed as Phase 1 hygiene
  // (harness evolution blueprint P6) — the call sites in commands.mjs are
  // unchanged; the events simply record now.
  'init_repo',
  'recall',
  'validate_plan',
  'index',
  // P1.5 (lib/event-registry.mjs) — the central event registry's dispatch-
  // pipeline vocabulary: command.start/command.result bracket a registered
  // command's execution through the NEW envelope/agent output lanes;
  // agent_lane is lib/agent-lane.mjs's existing (unmodified)
  // `recordAgentLaneBytes` metering record.
  'command.start',
  'command.result',
  'agent_lane',
  // Phase 3 — the execution audit. This allow-list is CLOSED: `writeEvent`
  // silently returns null for an unlisted type, so an audit event added without
  // a line here would record nothing while every call site looked correct. That
  // failure is invisible by construction, which is exactly the wrong property
  // for the record of what the harness was asked to execute.
  //
  // `exec` and `bash` are separate types rather than one with a flag: they are
  // separately policy-gated, and an auditor filtering for shell invocations
  // should not have to trust a boolean inside a payload to find them.
  'exec',
  'bash',
  // The file mutation audit. Separate types for the same reason `exec` and
  // `bash` are separate: "what did this run change on disk" is a different
  // question from "what did it run", and an auditor should be able to answer it
  // by filtering rather than by inspecting payloads. `undo` is its own type
  // because reversing a change is a decision worth finding on its own.
  'edit',
  'write',
  'undo',
  // Trust changes (P3AC6). Granting or withdrawing a project's authority is a
  // security decision, and a security decision with no record is one nobody can
  // review after the fact.
  'trust',
  // One turn of the headless loop (P5AC10). Separate from `exec`/`bash`, which
  // record what each tool DID: this records what the agent decided, and the two
  // correlate through the run id. It carries no transcript — see the note in
  // lib/agent-loop.mjs for why a durable record of a conversation is the wrong
  // place to be generous.
  'agent.turn',
  // Retention writes this when it removes entries — a journal that silently
  // shrinks is worse than one that admits it.
  'journal.pruned',
]);

function shouldSkipEvents(flags = {}) {
  return flags.dryRun || flags.noEvents || process.env.HARNESS_NO_EVENTS === '1';
}

function eventId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function eventResult({ result, exitCode, checks }) {
  if (result) return result;
  if (exitCode === 1) return 'fail';
  if (exitCode === 2) return 'warn';
  if ((checks || []).some((check) => check.severity === 'warn')) return 'warn';
  return 'pass';
}

function safeChecks(checks) {
  return (checks || []).map((check) => ({
    id: check.id,
    pass: Boolean(check.pass),
    severity: check.severity || (check.pass ? 'ok' : 'fail'),
    // Retain the raw status so consumers can tell a skipped check (neutral)
    // from a failed one — `pass: false` alone conflates the two.
    ...(check.status ? { status: check.status } : {}),
  }));
}

export function eventPath(workspace) {
  return path.join(workspace, '.harness', EVENTS_FILE);
}

export function writeEvent(workspace, flags, payload) {
  if (shouldSkipEvents(flags)) return null;
  if (!EVENT_TYPES.has(payload.type)) return null;
  // A refusal from ensureHarnessDir means `.harness` is a symlink; writing
  // anyway is exactly the escape it just declined. Returning null here is the
  // same "no event was written" answer `--no-events` produces, which every
  // caller already handles.
  if (ensureHarnessDir(workspace, false) === null) return null;

  const checks = safeChecks(payload.checks);
  const session = readSession(workspace);
  // P4aAC6: every event carries the run it belongs to and the actor that drove
  // it, whether or not the writer went through the event registry. The ~20
  // legacy call sites in lib/commands.mjs supplied neither, so `run show` and
  // `run tree` saw the lifecycle pair and none of the domain events that say
  // what the command actually did. A payload that supplies its own values still
  // wins — the registry stamps both explicitly and knows more than the ambient
  // default.
  const ambient = currentRunContext();
  const event = {
    version: 2,
    id: eventId(),
    ts: new Date().toISOString(),
    type: payload.type,
    command: payload.command || payload.type,
    plan: payload.plan || null,
    phase: payload.phase || null,
    result: eventResult({ result: payload.result, exitCode: payload.exitCode, checks }),
    checks,
    session: payload.session || session?.sessionId || null,
    host: payload.host || flags.host || process.env.HARNESS_HOST || 'harness-cli',
    agent: payload.agent || process.env.HARNESS_AGENT || null,
    ...(payload.run ?? ambient.run ? { run: payload.run ?? ambient.run } : {}),
    ...(payload.actor ?? ambient.actor ? { actor: payload.actor ?? ambient.actor } : {}),
  };
  if (payload.blockedReason) event.blockedReason = payload.blockedReason;
  if (payload.usage) event.usage = payload.usage;
  for (const field of [
    // Minor fix: `exitCode` used to be unconditionally stamped `?? 0` above
    // — a `command.start`/`agent_lane` ('pending') event, which fires
    // BEFORE the command has run at all, therefore falsely persisted
    // `exitCode: 0` (a real, misleadingly-successful-looking value) instead
    // of simply having no exit code yet. Moved into this same
    // only-when-supplied loop as every other optional field — every
    // caller that HAS a real exit code (command.result and every legacy
    // writeEvent(workspace, flags, {...}) call site in lib/commands.mjs)
    // already passes it explicitly, so this is a no-op for them.
    'exitCode',
    'tool',
    'mutation',
    'targets',
    'targetResolved',
    'gate',
    'decision',
    'durationMs',
    'success',
    'learnings',
    'learningsBytes',
    // Harness evolution P6: per-occurrence layer attribution written by
    // cmdOrient when a branch-bucket learning surfaced (lib/report.mjs's
    // knowledgeSlos reads it back for the golden/branch split).
    'learningLayers',
    // P1.5 (lib/event-registry.mjs) additions — additive only, never read
    // by any pre-existing event type/call site.
    'actor',
    // Phase 4a: the run this event belongs to. Without it `events.jsonl` is a
    // flat stream in which a command and the work it spawned cannot be told
    // apart from unrelated commands that ran nearby.
    'run',
    'execution',
    'flags',
    'status',
    'bytes',
    // Phase 3 — the execution descriptor on `exec`/`bash` audit events: what
    // was asked to run and under what policy (argv, cwd, timeout, the child's
    // environment allowlist). One namespaced field rather than six loose keys,
    // so an execution record's fields stay distinguishable from the generic
    // event envelope's. The OUTCOME scalars stay top-level (`status`,
    // `exitCode`, `durationMs`, `result`) where every other event already puts
    // them, so `harness events --failures` and the summaries keep working
    // without knowing this field exists.
    'exec',
    // The file-mutation descriptor on `edit`/`write`/`undo` audit events, the
    // exact counterpart of `exec` above: which path, what happened to it, and
    // the digests either side of the change. Namespaced for the same reason —
    // and content-free for a different one: an event log is durable, and a
    // record of every line the harness ever wrote is the likeliest place for a
    // pasted credential to outlive the file it was removed from.
    'file',
    'removed',
    'reason',
    // The trust-change descriptor: which project, and which way it moved.
    'trust',
  ]) {
    if (payload[field] !== undefined) event[field] = payload[field];
  }

  // Fix-wave C3: redact the FULLY ASSEMBLED event — including the
  // host/actor/session metadata this function stamps AFTER the event
  // registry's payload-only redaction (lib/event-registry.mjs), and
  // including object keys (lib/redact.mjs walks those too) — immediately
  // before the append. Verified pre-fix leak: `HARNESS_HOST=token=<secret>`
  // landed verbatim in events.jsonl via the `host` field above. This makes
  // the event registry's own redaction a defense-in-depth layer rather than
  // the only screen, and it covers every legacy writeEvent call site in
  // lib/commands.mjs that never went through the registry at all. The
  // redacted event is also what gets RETURNED, so no caller can re-emit the
  // unredacted original. Byte-identical for secret-free events.
  const safeEvent = createRedactor().redactValue(event);
  const file = eventPath(workspace);
  appendGuarded(file, JSON.stringify(safeEvent) + '\n');
  // P4aAC7: bound the file itself, not just what a read returns. Gated to once
  // per process and to files that have actually grown — see lib/retention.mjs.
  pruneJournalFile(file, {
    retentionDays: retentionDaysFor(workspace, flags),
    markerFor: ({ removed, cutoff }) => ({
      version: 2,
      id: eventId(),
      ts: new Date().toISOString(),
      type: 'journal.pruned',
      command: 'journal.pruned',
      result: 'pass',
      checks: [],
      // P2-9: a maintenance action is still an action. Without these, the one
      // event that explains a gap in the history is the one `run show` cannot
      // join to the run that caused it.
      ...(ambient.run ? { run: ambient.run } : {}),
      ...(ambient.actor ? { actor: ambient.actor } : {}),
      removed,
      reason: `older than ${cutoff}`,
    }),
  });
  return safeEvent;
}

export function readEvents(workspace, options = 20) {
  const config = typeof options === 'number' ? { limit: options } : options || {};
  const file = eventPath(workspace);
  if (!fs.existsSync(file)) return [];
  const events = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const filtered = events.filter((event) => {
    if (config.session && event.session !== config.session) return false;
    // P4aAC7 (Phase 1 deferral): `cancelled` and `timed-out` map to the legacy
    // `warn` result, so filtering on `result === 'fail'` alone hid exactly the
    // runs an operator asking for failures wants most — the ones that were
    // interrupted or ran out of time. The unified `status` is consulted
    // alongside the legacy vocabulary rather than replacing it, so every
    // pre-existing event still filters the way it always did.
    if (config.failures
      && event.result !== 'fail'
      && event.decision !== 'block'
      && !event.blockedReason
      && !FAILURE_STATUSES.has(event.status)) return false;
    return true;
  });
  // Always bounded: a non-positive or missing limit clamps to the default, and
  // no request may exceed EVENTS_MAX_LIMIT, so there is no full-history dump.
  const requested = Number.isFinite(config.limit) && config.limit > 0 ? config.limit : EVENTS_DEFAULT_LIMIT;
  const cap = Math.min(requested, EVENTS_MAX_LIMIT);
  const result = filtered.slice(-cap);
  result.totalMatched = filtered.length;
  return result;
}

export function summarizeEvents(events) {
  const summary = {
    total: events.length,
    pass: 0,
    warn: 0,
    fail: 0,
    lastActivePlan: null,
    latestBlockedReason: null,
    usage: summarizeUsage(events),
  };
  for (const event of events) {
    if (event.result === 'pass') summary.pass++;
    else if (event.result === 'warn') summary.warn++;
    else if (event.result === 'fail') summary.fail++;
    if (event.plan) summary.lastActivePlan = event.plan;
    if (event.blockedReason) summary.latestBlockedReason = event.blockedReason;
  }
  return summary;
}
