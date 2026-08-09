/**
 * The run journal — what this harness did, in an order nobody can rewrite.
 *
 * A RUN is one invocation of the CLI. Until now the harness recorded events but
 * had no notion of the invocation they belonged to: `events.jsonl` held a flat
 * stream where a `verify` and the four checks it spawned were indistinguishable
 * from four unrelated commands that happened to run nearby. A run id is what
 * turns that stream into history.
 *
 * APPEND-ONLY MEANS NO ENTRY IS EVER MODIFIED. That is the property an audit
 * depends on, and it is deliberately narrower than "the file only ever grows" —
 * a journal that grows forever is one that eventually gets deleted by hand,
 * which loses more history than bounded retention ever would. Pruning therefore
 * writes a fresh file atomically and appends a `journal.pruned` record saying
 * what went and why: a journal that silently shrinks is worse than one that
 * admits it.
 *
 * A RUN WITH NO TERMINAL RECORD IS `running`, NOT `interrupted`. The status
 * vocabulary is fixed by the contract (running, succeeded, failed,
 * inconclusive, blocked, cancelled, timed-out) and `interrupted` is not in it.
 * Telling a live run from one whose process died needs liveness, not a new
 * status — so the recorded pid is checked and reported as a separate `live`
 * field. Inventing a status the contract does not list would have been the
 * easier lie.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureHarnessDir } from './session.mjs';
import { assertNoSymlinkAncestors } from './fs-safe.mjs';
import { createRedactor } from './redact.mjs';
import { pruneJournalFile } from './retention.mjs';
import { retentionDaysFor } from './retention-config.mjs';

export const RUNS_FILE = 'runs.jsonl';
export const RUN_SCHEMA = 1;

/** The terminal statuses a run may end in, plus the one non-terminal state.
 * Fixed by `docs/architecture/harness-cli-workbench.md` §Runs and evidence. */
export const RUN_STATUSES = Object.freeze([
  'running',
  'succeeded',
  'failed',
  'inconclusive',
  'blocked',
  'cancelled',
  'timed-out',
]);

export const TERMINAL_RUN_STATUSES = Object.freeze(RUN_STATUSES.filter((s) => s !== 'running'));

export function runsPath(workspace) {
  return path.join(workspace, '.harness', RUNS_FILE);
}

/**
 * A stable run id.
 *
 * Time-ordered prefix so the journal sorts chronologically by id alone, plus
 * random bytes so two runs starting in the same millisecond — a real case under
 * `xargs -P` — cannot collide. Same construction as `eventId`, deliberately: a
 * reader who has learned to recognize one recognizes the other.
 */
export function newRunId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function append(workspace, record, flags = {}) {
  ensureHarnessDir(workspace, false);
  // P1-5 (Codex phase-4a review): `.harness` replaced by a symlink redirected
  // every journal write outside the workspace — a read-class command could be
  // made to append attacker-chosen bytes to an attacker-chosen path. The repo
  // already has the primitive for this; use it rather than trusting the path's
  // spelling.
  if (!assertNoSymlinkAncestors(path.resolve(workspace), path.join('.harness', RUNS_FILE))) {
    return null;
  }
  // Redacted before it lands, on the same terms as every other persisted
  // surface: a run record carries the argv, which is caller free-text.
  const safe = createRedactor().redactValue(record);
  const file = runsPath(workspace);
  ensureNewlineTerminated(file);
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
  // Bounded by the same policy the event log uses, and it says so when it
  // prunes — see lib/retention.mjs on why that is not a breach of append-only.
  pruneJournalFile(file, {
    retentionDays: retentionDaysFor(workspace, flags),
    markerFor: ({ removed, cutoff }) => ({
      schema: RUN_SCHEMA,
      type: 'journal.pruned',
      ts: new Date().toISOString(),
      removed,
      reason: `older than ${cutoff}`,
    }),
  });
  return safe;
}

/**
 * Open a run. Returns the record actually written, so a caller never has to
 * guess what was persisted after redaction.
 */
export function startRun(workspace, { run, command, argv = [], plan = null, host = null, actor = null, pid = process.pid, harnessVersion = null, ts = new Date().toISOString(), flags = {} }) {
  return append(workspace, {
    schema: RUN_SCHEMA,
    type: 'run.start',
    run,
    ts,
    command,
    argv,
    plan,
    host,
    actor,
    execution: { pid, harnessVersion },
  }, flags);
}

/**
 * Close a run with its terminal status.
 *
 * `status` is validated rather than accepted: a typo here would create a run
 * that no filter matches and no reader can classify, and it would be persisted
 * forever in an append-only file.
 */
export function finishRun(workspace, { run, status, exitCode = null, durationMs = null, plan = null, ts = new Date().toISOString(), flags = {} }) {
  if (!TERMINAL_RUN_STATUSES.includes(status)) {
    throw new TypeError(`finishRun: status must be one of ${TERMINAL_RUN_STATUSES.join(', ')} (got ${JSON.stringify(status)})`);
  }
  return append(workspace, {
    schema: RUN_SCHEMA,
    type: 'run.result',
    run,
    ts,
    status,
    exitCode,
    durationMs,
    ...(plan ? { plan } : {}),
  }, flags);
}

/**
 * P2-6: a torn final line — a crash mid-append — would otherwise have the next
 * valid record concatenated onto it, losing BOTH. Terminate the file first so
 * recovery costs one damaged record rather than two.
 */
function ensureNewlineTerminated(file) {
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return;
    const fd = fs.openSync(file, 'r');
    const tail = Buffer.alloc(1);
    fs.readSync(fd, tail, 0, 1, size - 1);
    fs.closeSync(fd);
    if (tail.toString() !== '\n') fs.appendFileSync(file, '\n', 'utf8');
  } catch {
    /* nothing to terminate */
  }
}

/** Note that entries were removed, and why. See the module doc on pruning. */
export function recordPrune(workspace, { removed, reason, ts = new Date().toISOString() }) {
  return append(workspace, { schema: RUN_SCHEMA, type: 'journal.pruned', ts, removed, reason });
}

/** Every raw journal record, in write order. A malformed line is skipped rather
 * than fatal — a torn final write from a crash must not make the whole history
 * unreadable, which is the failure the journal exists to survive. */
export function readJournal(workspace) {
  const file = runsPath(workspace);
  if (!fs.existsSync(file)) return [];
  return fs
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
}

/** Is the process that opened this run still alive? Signal 0 tests existence
 * without delivering anything. EPERM means it exists and is not ours, which is
 * still alive for this purpose. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Fold the journal into one record per run.
 *
 * The start record supplies identity and the result record supplies the
 * outcome; a run missing the second is `running`, with `live` telling the
 * reader whether that is true or whether the process died without recording.
 */
export function foldRuns(records, { isAlive = pidAlive } = {}) {
  const runs = new Map();
  for (const record of records) {
    if (!record?.run) continue;
    if (record.type === 'run.start') {
      const existing = runs.get(record.run);
      // P2-17: the comment below has always said the first start is the truth,
      // and the spread underneath quietly let a second one replace command,
      // argv, actor, host, pid and start time. Now it says no.
      if (existing?.startedAt) continue;
      runs.set(record.run, {
        run: record.run,
        command: record.command,
        argv: record.argv || [],
        plan: record.plan ?? null,
        host: record.host ?? null,
        actor: record.actor ?? null,
        pid: record.execution?.pid ?? null,
        harnessVersion: record.execution?.harnessVersion ?? null,
        startedAt: record.ts,
        status: existing?.status ?? 'running',
        exitCode: existing?.exitCode ?? null,
        durationMs: existing?.durationMs ?? null,
        finishedAt: existing?.finishedAt ?? null,
        terminal: existing?.terminal ?? false,
      });
    } else if (record.type === 'run.result') {
      const existing = runs.get(record.run) || { run: record.run, command: null, argv: [], plan: null, host: null, actor: null, pid: null, startedAt: null };
      // First terminal record wins. Tracked as an explicit flag rather than
      // inferred from `finishedAt` being truthy — a result whose `ts` was null
      // left the run looking un-terminated and let the NEXT result revise the
      // outcome (P2-16).
      if (existing.terminal) continue;
      runs.set(record.run, {
        ...existing,
        status: record.status,
        exitCode: record.exitCode ?? null,
        durationMs: record.durationMs ?? null,
        finishedAt: record.ts ?? null,
        terminal: true,
        plan: record.plan ?? existing.plan ?? null,
      });
    }
  }
  return [...runs.values()].map((r) => {
    // P2-15: a hand-edited or corrupted journal could carry a status outside
    // the fixed vocabulary, and `resume` would then treat it as a terminal
    // read-class run and call it resumable. An unrecognized status is reported
    // as such rather than believed.
    const known = RUN_STATUSES.includes(r.status);
    return {
      ...r,
      status: known ? r.status : 'running',
      ...(known ? {} : { corrupt: `unrecognized status ${JSON.stringify(r.status)}` }),
      live: (known ? r.status : 'running') === 'running' ? isAlive(r.pid) : false,
    };
  });
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * P4aAC5 — query by status, command, host, plan, and date.
 *
 * `since`/`until` accept a bare date as well as a full timestamp, because
 * `--since 2026-08-09` is what a person types and rejecting it would be a
 * papercut on the one filter people reach for most.
 */
export function queryRuns(runs, { status = null, command = null, host = null, plan = null, since = null, until = null } = {}) {
  const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
  // Compared as INSTANTS. String comparison excluded any offset timestamp that
  // was chronologically inside a UTC bound, and accepted `--since 2026-99-99`
  // as a filter that silently matched nothing (P2-13).
  const bound = (value, endOfDay) => {
    if (!value) return null;
    const text = DATE_ONLY.test(value)
      ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
      : value;
    const at = Date.parse(text);
    if (!Number.isFinite(at)) {
      throw Object.assign(new Error(`not a date: ${JSON.stringify(value)}`), { code: 'E_USAGE', exit: 2 });
    }
    return at;
  };
  const from = bound(since, false);
  const to = bound(until, true);

  return runs.filter((run) => {
    if (status && lower(run.status) !== lower(status)) return false;
    if (command && lower(run.command) !== lower(command)) return false;
    if (host && lower(run.host) !== lower(host)) return false;
    if (plan && run.plan !== plan) return false;
    const at = Date.parse(run.startedAt || run.finishedAt || '');
    if (from !== null && (!Number.isFinite(at) || at < from)) return false;
    if (to !== null && (!Number.isFinite(at) || at > to)) return false;
    return true;
  });
}

/** Newest first — the ordering every `list` in this CLI already uses. */
export function sortRuns(runs) {
  return [...runs].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

export function readRuns(workspace, filters = {}, options = {}) {
  return sortRuns(queryRuns(foldRuns(readJournal(workspace), options), filters));
}
