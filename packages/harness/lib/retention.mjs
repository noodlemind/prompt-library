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

  const cutoff = cutoffIso(retentionDays, now);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const keep = [];
  let removed = 0;
  for (const line of lines) {
    let ts = null;
    try {
      ts = JSON.parse(line)?.ts ?? null;
    } catch {
      // Unparseable: keep. See the note above — a torn line is still evidence
      // that something happened here.
      keep.push(line);
      continue;
    }
    if (typeof ts === 'string' && ts < cutoff) {
      removed += 1;
      continue;
    }
    keep.push(line);
  }
  if (removed === 0) return { removed: 0, kept: keep.length, skipped: false };

  if (markerFor) keep.push(JSON.stringify(markerFor({ removed, cutoff })));

  // Temp-and-rename in the same directory, so a reader sees either the whole
  // old file or the whole new one. A journal half-rewritten by a crash would be
  // exactly the corruption this module exists to avoid causing.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.prune-${process.pid}`);
  fs.writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '', 'utf8');
  fs.renameSync(tmp, file);
  return { removed, kept: keep.length, skipped: false };
}
