/**
 * Retention for the append-only journals (P4aAC7).
 *
 * The 200-event limit this replaces was never retention — it bounded how many
 * events a READ returned, while the file itself grew without limit. That is the
 * worst of both: a reader who wanted history could not get it, and a disk that
 * wanted relief never got any either.
 *
 * PRUNING AND APPEND-ONLY ARE NOT IN CONFLICT, because append-only means no
 * entry is ever MODIFIED. A journal that grows forever is one that eventually
 * gets deleted by hand, which loses far more history than a stated policy does.
 * So pruning writes a fresh file and appends a `journal.pruned` record saying
 * how many entries went and why: a journal that silently shrinks is worse than
 * one that admits it, because only the silent one can be mistaken for complete.
 *
 * COST. This runs on a write path, so it must not read a large file on every
 * append. It is gated twice: at most once per process, and only when the file
 * has actually grown past a threshold. A workspace whose journal is small — the
 * overwhelming majority — never pays more than one `statSync`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Below this the file is not worth reading to prune. ~1 MiB of JSONL is on the
 * order of ten thousand entries; nobody is served by rewriting less. */
export const PRUNE_MIN_BYTES = 1024 * 1024;

export const DEFAULT_RETENTION_DAYS = 30;

/** The lock a prune holds and an append respects. Same path derivation on both
 * sides, so the two cannot disagree about which file they are coordinating on. */
export function pruneLockPath(file) {
  return `${file}.prune-lock`;
}

/**
 * Append a line while a prune is not mid-rewrite.
 *
 * The first version of the lock was held only by the pruner, which left the
 * race exactly where it started: a writer appending between the pruner's read
 * and its rename had its record discarded — measured at 54,070 appends
 * acknowledged and 52,450 surviving. A lock only one side takes is not a lock.
 *
 * A writer that cannot acquire it within the window appends ANYWAY. That is the
 * deliberate direction: the pruner verifies the file is unchanged immediately
 * before renaming and abandons the prune if it is not, so the worst case is an
 * unpruned file. Losing an audit record to save disk is the wrong trade.
 */
export function appendGuarded(file, line, { retries = 20, waitMs = 5, fsImpl = fs } = {}) {
  const lockPath = pruneLockPath(file);
  let held = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      held = fsImpl.openSync(lockPath, 'wx');
      break;
    } catch {
      // Busy-wait briefly. These are millisecond-scale rewrites, and a promise
      // here would make every append path async for a case that almost never
      // happens.
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    fsImpl.appendFileSync(file, line, 'utf8');
  } finally {
    if (held !== null) {
      try { fsImpl.closeSync(held); } catch { /* already closed */ }
      try { fsImpl.unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }
}

// At most one prune per file per process. Pruning is a maintenance action, not
// something to repeat between two appends of the same command.
const pruned = new Set();

export function resetRetentionState() {
  pruned.clear();
}

function cutoffIso(retentionDays, now) {
  return new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Drop entries older than the retention window.
 *
 * Returns `{ removed, kept, skipped }`. `skipped` is the ordinary case and is
 * not a failure — it means the file was small enough that pruning would cost
 * more than it saved.
 *
 * An entry with no parseable timestamp is KEPT. Deleting a record because its
 * date could not be read is the wrong direction for an audit log: the cost of
 * keeping it is bytes, and the cost of dropping it is evidence.
 */
export function pruneJournalFile(file, {
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = Date.now(),
  minBytes = PRUNE_MIN_BYTES,
  oncePerProcess = true,
  markerFor = null,
} = {}) {
  if (oncePerProcess && pruned.has(file)) return { removed: 0, kept: 0, skipped: true };
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { removed: 0, kept: 0, skipped: true };
  }
  if (oncePerProcess) pruned.add(file);
  if (size < minBytes) return { removed: 0, kept: 0, skipped: true };

  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = cutoffIso(retentionDays, now);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

  // Parse once. A timestamp is an INSTANT, not a spelling: comparing ISO
  // strings lexically got `{"ts":"0"}` deleted and would mis-order any offset
  // timestamp against a UTC bound. A value that will not parse is KEPT, which
  // is what the module doc promised and the string compare quietly broke.
  const parsed = lines.map((line) => {
    try {
      const record = JSON.parse(line);
      const at = Date.parse(record?.ts);
      return { line, record, at: Number.isFinite(at) ? at : null };
    } catch {
      return { line, record: null, at: null };
    }
  });

  // A run's records are pruned as a GROUP or not at all. Removing only the
  // older half of a run rewrote history: a run with an old `succeeded` result
  // and a newer `failed` one folded as succeeded, and pruning the first made it
  // fold as failed. Retention may forget a run; it may never change what one
  // says. Found by the Codex phase-4a review.
  const newestByRun = new Map();
  for (const entry of parsed) {
    const id = entry.record?.run;
    if (!id) continue;
    const current = newestByRun.get(id);
    if (entry.at === null) newestByRun.set(id, Infinity);
    else if (current === undefined || entry.at > current) newestByRun.set(id, entry.at);
  }

  const keep = [];
  let removed = 0;
  for (const entry of parsed) {
    const id = entry.record?.run;
    const age = id ? newestByRun.get(id) : entry.at;
    if (age !== null && age !== undefined && Number.isFinite(age) && age < cutoffMs) {
      removed += 1;
      continue;
    }
    keep.push(entry.line);
  }
  if (removed === 0) return { removed: 0, kept: keep.length, skipped: false };

  // P1-1 (Codex phase-4a review): another process appending between the read
  // above and the rename below had its record silently discarded — audit data
  // lost, and not even counted by the marker. An exclusive lock file makes the
  // read-modify-rename one critical section; a process that cannot take the
  // lock simply does not prune, which costs disk rather than history.
  const lockPath = pruneLockPath(file);
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch {
    // Someone else is pruning, or a previous prune died holding the lock. Both
    // resolve to "not now" — a stale lock costs an unpruned file, which is the
    // safe direction for an audit log.
    return { removed: 0, kept: 0, skipped: true };
  }

  try {
    // Re-read INSIDE the lock: anything appended while we were parsing is still
    // on disk, and must survive.
    const snapshot = fs.statSync(file);
    const currentLines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const dropped = new Set();
    for (const entry of parsed) {
      if (!keep.includes(entry.line)) dropped.add(entry.line);
    }
    const finalLines = currentLines.filter((line) => !dropped.has(line));
    if (markerFor) finalLines.push(JSON.stringify(markerFor({ removed, cutoff })));

    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.prune-${process.pid}`);
    fs.writeFileSync(tmp, finalLines.length ? `${finalLines.join('\n')}\n` : '', 'utf8');

    // Last check before the swap: if anything landed since the read above, this
    // rewrite would discard it. Abandon the prune instead — an unpruned file
    // costs disk, and a discarded append costs evidence.
    const now = fs.statSync(file);
    if (now.size !== snapshot.size || now.mtimeMs !== snapshot.mtimeMs) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      return { removed: 0, kept: 0, skipped: true, abandoned: 'the journal changed while pruning' };
    }
    fs.renameSync(tmp, file);
    return { removed, kept: finalLines.length, skipped: false };
  } finally {
    fs.closeSync(lockFd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
  }
}
