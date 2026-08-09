import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureHarnessDir, readSession } from './session.mjs';
import { summarizeUsage } from './token-meter.mjs';
import { createRedactor } from './redact.mjs';

export const EVENTS_FILE = 'events.jsonl';
export const EVENTS_DEFAULT_LIMIT = 20;
export const EVENTS_MAX_LIMIT = 200;
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
  // Trust changes (P3AC6). Granting or withdrawing a project's authority is a
  // security decision, and a security decision with no record is one nobody can
  // review after the fact.
  'trust',
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
  ensureHarnessDir(workspace, false);

  const checks = safeChecks(payload.checks);
  const session = readSession(workspace);
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
  fs.appendFileSync(eventPath(workspace), JSON.stringify(safeEvent) + '\n', 'utf8');
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
    if (config.failures && event.result !== 'fail' && event.decision !== 'block' && !event.blockedReason) return false;
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
