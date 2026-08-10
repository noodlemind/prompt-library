/**
 * The ledger store — where blocks live, and why they outlive the session.
 *
 * THE DESIGN'S FIRST COMMITMENT is that a block is a journal record and Phase
 * 4a's run journal is its storage. That was not true of what shipped: the TUI
 * called `dispatch` directly, and `startRun`/`finishRun` are called by
 * `bin/harness.mjs`, so nothing a person did inside the ledger was ever
 * journaled. Every command run in the TUI was invisible to `run list`, to
 * `run tree`, and to the next session. This module closes that: the ledger
 * opens and closes a run around every dispatch, exactly as the CLI entry does.
 *
 * WHAT PERSISTS IS THE RECORD, NEVER THE TRANSCRIPT. A restored block carries
 * its command, status, exit code, duration, actor and time — and no output.
 * That is a deliberate line, held for the same reason `harness agent` holds it:
 * a transcript is where a pasted credential ends up, and the journal is
 * durable. The record is what `!!` needs to be exact, and output is what a
 * re-run regenerates.
 *
 * MARKS LIVE BESIDE THE JOURNAL rather than in it. `runs.jsonl` is append-only
 * with a fixed record vocabulary, and marking is a mutable per-workspace
 * preference — a `run.mark` record would either need rewriting (which the
 * append-only property forbids) or would accumulate one record per toggle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startRun, finishRun, newRunId, readJournal, foldRuns } from '../run-journal.mjs';
import { createBlock, newBlockId, formatActor } from './block.mjs';
import { detectActor } from '../event-registry.mjs';
import { writeFileContained } from '../fs-safe.mjs';

/** How many prior runs a fresh session restores. Enough that yesterday's work
 * is on screen; few enough that opening the ledger is not a history dump. */
export const HYDRATE_LIMIT = 8;

const MARKS_FILE = path.join('.harness', 'tui-marks.json');

function readMarks(workspace) {
  try {
    const raw = fs.readFileSync(path.join(workspace, MARKS_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed?.marked) ? parsed.marked : []);
  } catch {
    // No marks file, unreadable, or corrupt. An empty set is correct for all
    // three: a mark is an annotation, and losing one must never stop a session
    // from opening.
    return new Set();
  }
}

function writeMarks(workspace, marks) {
  try {
    writeFileContained(workspace, MARKS_FILE, `${JSON.stringify({ marked: [...marks] }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Map a run-journal status onto the block vocabulary. They agree everywhere
 * except `succeeded`, which the block layer renders as `ok` — the ledger
 * grammar's word — while the journal keeps the contract's. */
const STATUS_FROM_RUN = {
  succeeded: 'ok',
  failed: 'failed',
  cancelled: 'cancelled',
  'timed-out': 'timed-out',
  blocked: 'blocked',
  inconclusive: 'inconclusive',
  running: 'running',
};

// The exit-code fallback lives in lib/run-journal.mjs, beside the vocabulary it
// produces. This module briefly had its own narrower copy, which journaled a
// usage error as `failed` where the CLI journaled it as `inconclusive` — the
// same command, two records, depending on which surface it was typed into.
export { runStatusForExit as statusForExit } from '../run-journal.mjs';

export function createLedger({
  workspace = process.cwd(),
  // The JOURNAL gets the contract's shape (`{kind:'user'}`), exactly as
  // `bin/harness.mjs` writes it — the ledger briefly wrote the display string
  // instead, which put two actor shapes into one append-only file. Blocks get
  // the word.
  actor = detectActor(),
  harnessVersion = null,
  journaling = true,
  now = () => Date.now(),
} = {}) {
  const blocks = [];
  const marks = readMarks(workspace);

  /**
   * Restore recent runs as blocks.
   *
   * Read-class commands are dropped from the restore: a session that opens with
   * eight `search` records has spent its first screen telling you what you
   * already know. What earns the space is what changed something or failed.
   */
  function hydrate({ limit = HYDRATE_LIMIT, restoreWorthy = null } = {}) {
    // A session that is not journaling is not reading history either: the two
    // are the same switch, and restoring records a session cannot add to would
    // show a history that silently stops growing.
    if (!journaling) return [];
    let folded;
    try {
      folded = foldRuns(readJournal(workspace));
    } catch {
      return [];
    }
    // WHAT EARNS THE SPACE: failures always; successes only when the command
    // changed something. The first session against a real journal opened with
    // six restored `tui` records — the ledger's own previous sessions — and
    // two `status` reads: eight blocks that told the operator nothing. The
    // session's own runs are never interesting to the session, and a
    // succeeded read left nothing behind to point at. `restoreWorthy` is
    // injectable so the caller can consult the registry's side-effect class;
    // the default list covers the read-class commands the registry declares
    // today.
    const worthKeeping = restoreWorthy ?? ((r) => {
      if (r.command === 'tui') return false;
      if (r.status !== 'succeeded') return true;
      return !['search', 'lookup', 'tree', 'run', 'orient', 'status', 'get', 'recall', 'help', 'doctor', 'report'].includes(r.command);
    });
    const interesting = folded
      .filter((r) => r.terminal && r.command)
      .filter(worthKeeping)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
      .slice(-limit);

    const restored = interesting.map((r) => createBlock({
      id: r.run,
      run: r.run,
      command: [r.command, ...(r.argv || [])].join(' ').trim(),
      status: STATUS_FROM_RUN[r.status] || 'failed',
      exit: Number.isInteger(r.exitCode) ? r.exitCode : null,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      actor: formatActor(r.actor) || 'you',
      marked: marks.has(r.run),
      // Restored records replay from the journal's own argv rather than from
      // the display string, for the same reason live blocks do.
      argv: [r.command, ...(r.argv || [])].filter(Boolean),
      // No output: see the module note. The record line carries what is known,
      // and the tally says where the rest went.
      lines: [],
      tally: 'restored from the run journal',
      kind: 'restored',
    }));
    blocks.push(...restored);
    return restored;
  }

  /**
   * Open a block and its run.
   *
   * The run id IS the block id, which is what makes `!! 5e08c7` and
   * `run tree 5e08c7` the same identifier — the design's "blocks-as-records
   * make it exact" is this line.
   */
  function open({ command, argv = [], plan = null, kind = 'command' } = {}) {
    const run = journaling ? newRunId() : newBlockId();
    const block = createBlock({
      id: run,
      run: journaling ? run : null,
      command,
      status: 'running',
      startedAt: new Date().toISOString(),
      actor: formatActor(actor),
      kind,
      cwd: workspace,
    });
    // THE DISPATCHED ARGV, kept alongside the display string.
    //
    // `!!` used to re-tokenize `block.command`, which is what a person TYPED —
    // so re-running `!echo hi` produced `['!echo', 'hi']` and an unknown-command
    // error instead of replaying the governed `bash -- echo hi` that actually
    // ran. The display string is for reading; this is for replaying, and the
    // two stopped being the same thing the moment sigils existed.
    block.argv = [...argv];
    block._startedMs = now();
    block._plan = plan;
    blocks.push(block);
    return block;
  }

  /**
   * Write the run's opening record.
   *
   * DEFERRED PAST VALIDATION, exactly as `bin/harness.mjs` defers it through
   * `ctx.onRunStart`: a command the registry refuses never ran, and a journal
   * that opened a run for it would record work that did not happen. The run id
   * is minted in `open` regardless, because the event registry needs it before
   * dispatch — only the record waits.
   */
  function openRun(block) {
    if (!block || !journaling || !block.run || block._runOpened) return block;
    block._runOpened = true;
    try {
      startRun(workspace, {
        run: block.run,
        command: block.argv?.[0] || block.command,
        argv: block.argv?.slice(1) ?? [],
        plan: block._plan ?? null,
        host: process.env.HARNESS_HOST || 'harness-tui',
        actor,
        harnessVersion,
      });
    } catch {
      // A journal that cannot be written must not stop the command from
      // running. The block still exists in memory; only its durability is
      // lost, and `doctor` is where an unwritable `.harness` gets reported.
      block.run = null;
    }
    return block;
  }

  /** Close a block and its run. `status` is the journal vocabulary. */
  function close(block, { status, exitCode = null, tally = null, next = null } = {}) {
    if (!block) return null;
    const durationMs = block._startedMs ? now() - block._startedMs : null;
    block.status = STATUS_FROM_RUN[status] || 'failed';
    block.exit = exitCode;
    block.durationMs = durationMs;
    if (tally) block.tally = tally;
    if (next) block.next = next;
    // Only a run that actually OPENED gets a terminal record; a refused
    // command has neither, same rule as the CLI entry.
    if (block.run && block._runOpened) {
      try {
        finishRun(workspace, { run: block.run, status, exitCode, durationMs });
      } catch { /* see openRun() — durability is best effort, the session is not */ }
    }
    return block;
  }

  return {
    workspace,
    get blocks() { return blocks; },
    hydrate,
    open,
    openRun,
    close,
    /** Append an output row to a block as it streams. */
    append(block, line) {
      if (block && line !== undefined && line !== null) block.lines.push(String(line));
      return block;
    },
    /** The most recent block that actually ran something — what bare `!!`
     * repeats. Notes and restored records are skipped: repeating a note is
     * meaningless, and a restored block's command is a string we did not parse. */
    lastCommand() {
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        if (blocks[i].kind === 'command' && blocks[i].command) return blocks[i];
      }
      return null;
    },
    /** Find a block by id or unique id prefix, so `!! 5e08c7` works from what
     * is on screen rather than from a full run id. */
    byId(id) {
      const wanted = String(id ?? '').trim().replace(/^#/, '');
      if (!wanted) return null;
      const exact = blocks.find((b) => b.id === wanted || b.run === wanted);
      if (exact) return exact;
      // Prefix OR suffix, unique either way. The record line prints the id's
      // TAIL (`#5e08c7`) because the time-ordered head is the colliding part;
      // `run list` prints the full id, whose head someone may copy. Ambiguity
      // is a refusal in both directions — replaying the wrong block is worse
      // than asking for one more character.
      const matches = (v) => String(v ?? '').startsWith(wanted) || String(v ?? '').endsWith(wanted);
      const hits = blocks.filter((b) => matches(b.id) || matches(b.run));
      return hits.length === 1 ? hits[0] : null;
    },
    /** Toggle a mark, persisting it. Returns the new state, or null when the
     * block has no durable id to hang a mark on. */
    toggleMark(block) {
      // A MARK NEEDS A DURABLE ID. `block.id` is ephemeral for anything that
      // was never journaled — a note, or a block whose `startRun` failed — so
      // marking one wrote an id no later session could resolve and told the
      // operator it was "kept with the journal", which was not true. The doc
      // comment already promised this guard; only the code was missing it.
      if (!block?.run) return null;
      const key = block.run;
      block.marked = !block.marked;
      if (block.marked) marks.add(key);
      else marks.delete(key);
      writeMarks(workspace, marks);
      return block.marked;
    },
    get markCount() { return blocks.filter((b) => b.marked).length; },
    /** Drop everything on screen. The journal is untouched — `clear` is a
     * viewport gesture, and erasing history is not something a viewport does. */
    clear() { blocks.length = 0; },
  };
}
