/**
 * `harness edit`, `harness write`, and `harness undo` — the governed file
 * mutation surface.
 *
 * WHY THESE ARE COMMANDS AND NOT AGENT TOOLS. The turn loop maps every tool
 * call onto a harness command argv (lib/agent-loop.mjs#dispatchToolCall), so a
 * tool IS a command: it inherits the audit event, the run journal, the
 * side-effect class and the palette row for free. Implementing file edits
 * inside the loop instead would have created a second write path that
 * `controls` never sees — the one property that file says it cannot give up.
 * Declaring them here fixes three surfaces at once: an operator gets
 * `harness edit`, the palette gets a row with value prompts, and the model gets
 * a tool.
 *
 * WHY THE HARNESS NEEDED THEM AT ALL. Before this, the only way to change a
 * file under the harness was to express it as shell — `sed -i`, a heredoc, a
 * redirect. That works for a person who already knows the file, and it is a
 * trap for a model: a live run spent ten turns emitting malformed shell and
 * wrote nothing. `get` could read a file and nothing could write one, which is
 * a missing capability rather than a missing convenience.
 *
 * THE FOUR CONTROLS, each taken from a shipped implementation rather than
 * invented here:
 *   1. UNIQUE MATCH (Claude Code's `Edit`). `--old` must occur exactly once.
 *      An edit that matched three places and changed all three, or matched the
 *      first, is an edit nobody can review from its arguments.
 *   2. READ BEFORE WRITE, ENFORCED STRUCTURALLY. `edit` needs a unique `--old`,
 *      which cannot be produced without having seen the file. `write` over an
 *      EXISTING file needs `--expect <sha256 prefix>` of the current content,
 *      which `get` reports. The proof travels IN THE ARGUMENT — there is no
 *      hidden per-session receipt, so the rule reads the same from the CLI, the
 *      palette and the loop, and a concurrent modification between the read and
 *      the write is caught rather than silently overwritten.
 *   3. UNDO (Amp ships it). Every mutation snapshots what was there first, so
 *      the answer to "that was wrong" is one command and not a git argument.
 *   4. PER-FILE SERIALIZATION (pi's file mutation queue). A read-verify-write
 *      is not atomic; two of them interleaved lose one of the edits. Each
 *      mutation holds an exclusive lock on its own path for the duration.
 *
 * WHAT AN EXPECTED FAILURE IS. A path outside the workspace, a missing file, no
 * match, an ambiguous match, a stale `--expect` — these return a `failed`
 * RESULT, they do not throw. The distinction matters at exactly one caller: the
 * turn loop treats a thrown refusal as fatal to the run (it means the harness
 * said no and will keep saying no), and a failed result as information handed
 * back to the model. A model naming a file that does not exist should be told
 * so and allowed to correct itself, which is the whole point of a loop; only a
 * policy refusal should end the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { parseFlags } from './flags.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { readFileNoFollow, writeFileContained, appendFileContained } from './fs-safe.mjs';
import { ensureHarnessDir } from './session.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const EDIT_SCHEMA = 1;

/** How long a lock may be held before a later mutation may break it. A lock is
 * only ever held across one read-verify-write of one file, which is
 * milliseconds; anything older belongs to a process that died holding it, and
 * refusing forever because of a crash three days ago is not a control, it is a
 * dead file nobody knows to delete. */
const LOCK_STALE_MS = 30_000;

/** The minimum `--expect` prefix. Eight hex characters is 32 bits — enough that
 * a caller cannot pass a plausible-looking stub by accident, short enough to
 * type from a `get` result. */
const MIN_EXPECT_CHARS = 8;

const UNDO_LOG = '.harness/undo.jsonl';
const UNDO_DIR = '.harness/undo';
const LOCK_DIR = '.harness/locks';

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A flag whose value is arbitrary text.
 *
 * `parseFlags` knows a fixed vocabulary and cannot carry file content, and
 * `exec-cmd.mjs`'s `singleFlag` refuses any value starting with `-` — correct
 * for a timeout or a directory, wrong for a line of a markdown list. This takes
 * the next token VERBATIM, which is the only rule under which a diff can be
 * passed at all. `--old=<value>` remains available for a value that begins with
 * `--`, and is the form to use there: the registry's own argument walk stops
 * skipping at a `--`-shaped token, so the space form cannot express one.
 *
 * Repetition is refused rather than resolved. Two `--old` values mean the
 * caller believes something about this invocation that is not true, and picking
 * one silently edits a file on a guess.
 */
export function literalFlag(argv, name) {
  const seen = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') break;
    if (token === name) {
      if (argv[i + 1] === undefined) throw usageError(`${name} requires a value`, `e.g. ${name} <text>`);
      seen.push(argv[i + 1]);
      i += 1;
    } else if (token.startsWith(`${name}=`)) {
      seen.push(token.slice(name.length + 1));
    }
  }
  if (!seen.length) return null;
  if (seen.length > 1) {
    throw usageError(`${name} was given more than once`, 'pass it once so there is no question which value applies');
  }
  return seen[0];
}

/** What a mutation reports when `--dry-run` stopped it at the last step. The
 * digests are of what IS and what WOULD BE, so a caller can diff them without
 * the command having touched anything. */
function dryRunResult(mode, relPath, before, after) {
  return {
    schema: EDIT_SCHEMA,
    mode,
    path: relPath,
    status: 'ok',
    exitCode: 0,
    reason: null,
    dryRun: true,
    created: before === null,
    matches: null,
    bytesBefore: before === null ? null : Buffer.byteLength(before, 'utf8'),
    bytesAfter: Buffer.byteLength(after, 'utf8'),
    sha256Before: before === null ? null : sha256(before),
    sha256After: sha256(after),
    undo: null,
    output: [],
  };
}

/** The shared failure shape. Every refusal names a machine-readable `reason`
 * next to the sentence a person reads, so a caller can branch on the cause
 * without parsing prose — the loop shows the prose to the model, the palette
 * shows it to a person, and a test asserts on the reason. */
function failed(mode, relPath, reason, message, hint) {
  return {
    schema: EDIT_SCHEMA,
    mode,
    path: relPath,
    status: 'failed',
    exitCode: 1,
    reason,
    created: false,
    matches: null,
    bytesBefore: null,
    bytesAfter: null,
    sha256Before: null,
    sha256After: null,
    undo: null,
    output: hint ? [{ line: message }, { line: hint }] : [{ line: message }],
  };
}

/**
 * Take an exclusive lock on one path, or report why not.
 *
 * A directory entry created with `wx` is the lock: `O_CREAT|O_EXCL` is atomic
 * across processes, needs no daemon, and leaves a file whose mtime says when it
 * was taken. The lock name is a hash of the relative path rather than the path
 * itself so that a nested file cannot need a nested lock directory, and so a
 * path with a separator in it cannot escape `.harness/locks/`.
 */
function acquireLock(workspace, relPath) {
  const dir = path.join(workspace, LOCK_DIR);
  // Hash the RESOLVED path, not the spelling the caller used: `a.txt`,
  // `./a.txt` and `sub/../a.txt` are one file, and hashing the raw string gave
  // each of them its own lock — serialization that fails exactly when two
  // callers disagree about how to write the path, which is the likeliest way
  // for two callers to arrive at all.
  const key = path.resolve(workspace, relPath);
  const file = path.join(dir, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 32)}.lock`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // No lock directory means no serialization, and refusing every edit because
    // `.harness` is unwritable would make the harness useless in a read-only
    // checkout for a reason unrelated to the edit. Proceed unlocked and say so.
    return { held: false, degraded: 'no lock directory', release: () => {} };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return { held: true, degraded: null, release: () => { try { fs.unlinkSync(file); } catch { /* already released */ } } };
    } catch {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        // It vanished between the failed create and the stat — the holder
        // finished. Loop once more and take it.
        continue;
      }
      if (age < LOCK_STALE_MS) {
        return { held: false, degraded: null, busy: true, release: () => {} };
      }
      try {
        fs.unlinkSync(file);
      } catch {
        /* someone else broke it first; the retry below settles it */
      }
    }
  }
  // Both attempts lost the race to re-create a lock we had judged stale, which
  // means another process is actively taking it. Report BUSY so the caller
  // refuses: proceeding here would be a read-verify-write running unserialized
  // against a writer we have positive evidence is live — the exact interleaving
  // the lock exists to prevent. Only a missing lock DIRECTORY degrades to
  // proceeding, because that says nothing about contention.
  return { held: false, degraded: 'could not take the lock', busy: true, release: () => {} };
}

/** Resolve a workspace-relative path, or null when it escapes. Kept as one
 * function so `edit`, `write` and `undo` cannot drift into three different
 * ideas of what is inside the workspace. */
function resolveTarget(workspace, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return null;
  return safeResolveUnderRoot(path.resolve(workspace), relPath);
}

/** Read a file as text, or report why it cannot be edited as text. `null`
 * content with `exists: false` is an absent file; `binary: true` is a file the
 * harness refuses to rewrite through a string API, because a NUL byte means a
 * utf8 round-trip is not lossless and an "edit" would corrupt it. */
function readTarget(fullPath, workspaceResolved) {
  if (!fs.existsSync(fullPath)) return { exists: false, content: null, binary: false };
  const raw = readFileNoFollow(fullPath, { root: workspaceResolved });
  if (raw === null) return { exists: false, content: null, binary: false };
  if (raw.includes('\u0000')) return { exists: true, content: null, binary: true };
  return { exists: true, content: raw, binary: false };
}

/**
 * Record what a path held before this mutation, so `undo` can put it back.
 *
 * The snapshot is written BEFORE the mutation and the journal line AFTER it, so
 * a crash between the two leaves an orphan snapshot (harmless) rather than a
 * journal entry pointing at a file that was never written (an undo that would
 * restore nothing and report success).
 */
function snapshot(workspace, relPath, previous) {
  if (ensureHarnessDir(workspace, false) === null) {
    return { id: null, reason: '.harness is not a real directory — this change was not made undoable' };
  }
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  if (previous.exists) {
    if (writeFileContained(workspace, `${UNDO_DIR}/${id}.bak`, previous.content) === null) {
      return { id: null, reason: 'the undo snapshot could not be written — this change was not made undoable' };
    }
  }
  return { id, reason: null, existedBefore: previous.exists };
}

function commitUndo(workspace, mode, relPath, snap, sha256After) {
  if (!snap.id) return null;
  const line = `${JSON.stringify({
    id: snap.id,
    type: 'mutation',
    mode,
    path: relPath,
    existedBefore: snap.existedBefore,
    sha256After,
    at: new Date().toISOString(),
  })}\n`;
  if (appendFileContained(workspace, UNDO_LOG, line, { newlineGuard: true }) === null) return null;
  return { id: snap.id };
}

/** The undo stack, newest first, with everything already undone removed. The
 * log is append-only — an undo appends a marker rather than rewriting history —
 * so "what would undo do next" is a fold over it and never a file rewrite. */
export function readUndoStack(workspace) {
  const full = resolveTarget(workspace, UNDO_LOG);
  if (!full || !fs.existsSync(full)) return [];
  const raw = readFileNoFollow(full, { root: path.resolve(workspace) });
  if (raw === null) return [];
  const entries = [];
  const undone = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated last line is the normal shape of a crash during an append,
      // not a corrupt store. Skipping it loses one undo, not the stack.
      continue;
    }
    if (parsed?.type === 'undone' && parsed.ref) undone.add(parsed.ref);
    else if (parsed?.type === 'mutation' && parsed.id) entries.push(parsed);
  }
  return entries.filter((e) => !undone.has(e.id)).reverse();
}

// --- edit -----------------------------------------------------------------

/**
 * Replace one exact, unique occurrence of `old` with `next`.
 *
 * Exact strings rather than a regex or a line range, deliberately: a regex is a
 * second language to get wrong at the moment of writing to disk, and a line
 * number is stale the instant anything above it moves. An exact substring that
 * must appear exactly once is the only form where the ARGUMENTS THEMSELVES
 * prove which edit was intended.
 */
export function runEdit({ workspace, path: relPath, old, next, dryRun = false }) {
  const workspaceResolved = path.resolve(workspace);
  const full = resolveTarget(workspaceResolved, relPath);
  if (!full) {
    return failed('edit', relPath, 'escapes-workspace', `refusing to edit outside the workspace: ${relPath}`, 'paths are relative to the workspace root, and may not traverse above it or through a symlink');
  }
  if (old === next) {
    return failed('edit', relPath, 'no-change', '--old and --new are identical, so this edit would change nothing', 'pass the replacement text in --new');
  }

  const lock = acquireLock(workspaceResolved, relPath);
  if (lock.busy) {
    return failed('edit', relPath, 'locked', `another mutation is in progress on ${relPath}`, 'retry once it completes');
  }
  try {
    const target = readTarget(full, workspaceResolved);
    if (!target.exists) {
      return failed('edit', relPath, 'not-found', `no such file: ${relPath}`, 'use `harness write` to create it');
    }
    if (target.binary) {
      return failed('edit', relPath, 'binary', `${relPath} contains NUL bytes, so it is not editable as text`, null);
    }

    // Counted, not just found: "how many" is the whole control, and `indexOf`
    // alone cannot tell one match from four.
    let matches = 0;
    let at = target.content.indexOf(old);
    const first = at;
    while (at !== -1) {
      matches += 1;
      if (matches > 1) break;
      at = target.content.indexOf(old, at + old.length);
    }
    if (matches === 0) {
      return failed('edit', relPath, 'no-match', `--old does not appear in ${relPath}`, 'read the file first — the match must be byte-exact, including indentation');
    }
    if (matches > 1) {
      return failed('edit', relPath, 'ambiguous', `--old appears more than once in ${relPath}`, 'extend --old with surrounding lines until it identifies exactly one place');
    }

    const before = target.content;
    const after = before.slice(0, first) + next + before.slice(first + old.length);
    // `--dry-run` promises to show what would happen without doing it, and a
    // flag that writes anyway is worse than no flag — `exec` learned the same
    // lesson. Everything above has already run, so the report is the real
    // answer to "would this work": the file was found, and the match was unique.
    if (dryRun) {
      return {
        ...dryRunResult('edit', relPath, before, after),
        matches: 1,
        output: [{ line: `would edit ${relPath}` }, { line: `1 replacement · ${Buffer.byteLength(before, 'utf8')} → ${Buffer.byteLength(after, 'utf8')} bytes` }],
      };
    }
    const snap = snapshot(workspaceResolved, relPath, target);
    if (writeFileContained(workspaceResolved, relPath, after) === null) {
      return failed('edit', relPath, 'write-refused', `the write to ${relPath} was refused`, 'the path resolved outside the workspace at write time, or the file is not writable');
    }
    const sha256After = sha256(after);
    const undo = commitUndo(workspaceResolved, 'edit', relPath, snap, sha256After);
    return {
      schema: EDIT_SCHEMA,
      mode: 'edit',
      path: relPath,
      status: 'ok',
      exitCode: 0,
      reason: null,
      created: false,
      matches: 1,
      bytesBefore: Buffer.byteLength(before, 'utf8'),
      bytesAfter: Buffer.byteLength(after, 'utf8'),
      sha256Before: sha256(before),
      sha256After,
      undo,
      degraded: lock.degraded,
      output: [
        { line: `edited ${relPath}` },
        { line: `1 replacement · ${Buffer.byteLength(before, 'utf8')} → ${Buffer.byteLength(after, 'utf8')} bytes` },
        ...(snap.reason ? [{ line: snap.reason }] : []),
      ],
    };
  } finally {
    lock.release();
  }
}

// --- write ----------------------------------------------------------------

/**
 * Create a file, or replace one whose current content the caller can prove.
 *
 * `expect` is the compare-and-swap. Overwriting an existing file without it is
 * refused — not because writing is dangerous, but because a caller who has not
 * read the file cannot know what they are destroying, and "I meant to create
 * this" is indistinguishable from "I did not know it was there" once the bytes
 * are gone. A NEW file needs nothing: there is no content to be ignorant of.
 */
export function runWrite({ workspace, path: relPath, content, expect = null, dryRun = false }) {
  const workspaceResolved = path.resolve(workspace);
  const full = resolveTarget(workspaceResolved, relPath);
  if (!full) {
    return failed('write', relPath, 'escapes-workspace', `refusing to write outside the workspace: ${relPath}`, 'paths are relative to the workspace root, and may not traverse above it or through a symlink');
  }
  // A digest is a hex string, and hex has no case. A caller who pasted an
  // uppercase one was told the file had changed, which sent them to look for a
  // concurrent writer that did not exist.
  const expected = expect === null ? null : expect.trim().toLowerCase();
  if (expected !== null && expected.length < MIN_EXPECT_CHARS) {
    return failed('write', relPath, 'expect-too-short', `--expect needs at least ${MIN_EXPECT_CHARS} characters of the sha256`, 'harness get --path <file> --json reports the full digest');
  }

  const lock = acquireLock(workspaceResolved, relPath);
  if (lock.busy) {
    return failed('write', relPath, 'locked', `another mutation is in progress on ${relPath}`, 'retry once it completes');
  }
  try {
    const target = readTarget(full, workspaceResolved);
    if (target.exists && target.binary) {
      return failed('write', relPath, 'binary', `${relPath} contains NUL bytes; refusing to replace it through a text API`, null);
    }
    if (target.exists && expected === null) {
      return failed(
        'write',
        relPath,
        'exists',
        `${relPath} already exists, and no --expect was given`,
        `read it first, then pass --expect ${sha256(target.content).slice(0, 12)} to replace exactly what you read`,
      );
    }
    if (target.exists) {
      const current = sha256(target.content);
      if (!current.startsWith(expected)) {
        return failed(
          'write',
          relPath,
          'stale',
          `${relPath} has changed since it was read`,
          `--expect was ${expected}, the file is now ${current.slice(0, 12)} — read it again before replacing it`,
        );
      }
    } else if (expected !== null) {
      // A digest for a file that is not there. The caller believes they are
      // replacing something, and creating it instead would satisfy the letter
      // of the request while doing the opposite of what they checked for — the
      // file they meant to update has been deleted or renamed, and they should
      // find out from the command rather than from the next reader.
      return failed(
        'write',
        relPath,
        'stale',
        `${relPath} does not exist, but --expect says it should hold known content`,
        'the file was removed or renamed since it was read — drop --expect to create it fresh',
      );
    }

    if (dryRun) {
      return {
        ...dryRunResult('write', relPath, target.exists ? target.content : null, content),
        output: [{ line: `would ${target.exists ? 'replace' : 'create'} ${relPath}` }, { line: `${Buffer.byteLength(content, 'utf8')} bytes` }],
      };
    }
    const snap = snapshot(workspaceResolved, relPath, target);
    if (writeFileContained(workspaceResolved, relPath, content) === null) {
      return failed('write', relPath, 'write-refused', `the write to ${relPath} was refused`, 'the path resolved outside the workspace at write time, or the file is not writable');
    }
    const sha256After = sha256(content);
    const undo = commitUndo(workspaceResolved, 'write', relPath, snap, sha256After);
    return {
      schema: EDIT_SCHEMA,
      mode: 'write',
      path: relPath,
      status: 'ok',
      exitCode: 0,
      reason: null,
      created: !target.exists,
      matches: null,
      bytesBefore: target.exists ? Buffer.byteLength(target.content, 'utf8') : null,
      bytesAfter: Buffer.byteLength(content, 'utf8'),
      sha256Before: target.exists ? sha256(target.content) : null,
      sha256After,
      undo,
      degraded: lock.degraded,
      output: [
        { line: `${target.exists ? 'replaced' : 'created'} ${relPath}` },
        { line: `${Buffer.byteLength(content, 'utf8')} bytes` },
        ...(snap.reason ? [{ line: snap.reason }] : []),
      ],
    };
  } finally {
    lock.release();
  }
}

// --- undo -----------------------------------------------------------------

/**
 * Put back what the most recent `edit` or `write` replaced.
 *
 * An undo is NOT itself pushed onto the stack. Running `undo` twice therefore
 * reverses the two most recent mutations, which is what the word means
 * everywhere else; pushing would make the second call redo the first and turn
 * the command into a toggle nobody asked for.
 *
 * It refuses when the file has changed since the mutation it would reverse.
 * Restoring over someone else's later work is not an undo, it is a second,
 * unreviewed overwrite — and the caller cannot see it happen.
 */
export function runUndo({ workspace, dryRun = false }) {
  const workspaceResolved = path.resolve(workspace);
  const stack = readUndoStack(workspaceResolved);
  if (!stack.length) {
    return failed('undo', null, 'nothing-to-undo', 'nothing to undo — no recorded edit or write is outstanding', null);
  }
  const entry = stack[0];
  const full = resolveTarget(workspaceResolved, entry.path);
  if (!full) {
    return failed('undo', entry.path, 'escapes-workspace', `the recorded path no longer resolves inside the workspace: ${entry.path}`, null);
  }

  const lock = acquireLock(workspaceResolved, entry.path);
  if (lock.busy) {
    return failed('undo', entry.path, 'locked', `another mutation is in progress on ${entry.path}`, 'retry once it completes');
  }
  try {
    const target = readTarget(full, workspaceResolved);
    if (!target.exists) {
      return failed('undo', entry.path, 'not-found', `${entry.path} no longer exists, so there is nothing to put back`, null);
    }
    if (target.binary || sha256(target.content) !== entry.sha256After) {
      return failed(
        'undo',
        entry.path,
        'drifted',
        `${entry.path} has changed since the edit being undone`,
        'undoing now would overwrite that later change — inspect it first',
      );
    }

    if (dryRun) {
      return {
        ...dryRunResult('undo', entry.path, target.content, target.content),
        output: [{ line: `would undo ${entry.mode} ${entry.id} on ${entry.path}` }],
      };
    }

    let restored;
    if (entry.existedBefore) {
      const backup = resolveTarget(workspaceResolved, `${UNDO_DIR}/${entry.id}.bak`);
      const previous = backup ? readFileNoFollow(backup, { root: workspaceResolved }) : null;
      if (previous === null) {
        return failed('undo', entry.path, 'snapshot-missing', `the snapshot for ${entry.path} is gone`, null);
      }
      if (writeFileContained(workspaceResolved, entry.path, previous) === null) {
        return failed('undo', entry.path, 'write-refused', `restoring ${entry.path} was refused`, null);
      }
      restored = { bytes: Buffer.byteLength(previous, 'utf8'), removed: false, sha256: sha256(previous) };
    } else {
      // The mutation CREATED this file, so undoing it means the file should not
      // exist. The content check above already proved nothing has been added to
      // it since.
      try {
        fs.unlinkSync(full);
      } catch (error) {
        return failed('undo', entry.path, 'write-refused', `removing ${entry.path} was refused: ${error.message}`, null);
      }
      restored = { bytes: 0, removed: true, sha256: null };
    }

    appendFileContained(workspaceResolved, UNDO_LOG, `${JSON.stringify({ type: 'undone', ref: entry.id, at: new Date().toISOString() })}\n`, { newlineGuard: true });
    return {
      schema: EDIT_SCHEMA,
      mode: 'undo',
      path: entry.path,
      status: 'ok',
      exitCode: 0,
      reason: null,
      created: false,
      matches: null,
      bytesBefore: Buffer.byteLength(target.content, 'utf8'),
      bytesAfter: restored.bytes,
      sha256Before: entry.sha256After,
      sha256After: restored.sha256,
      undo: { id: entry.id, undone: true },
      degraded: lock.degraded,
      output: [
        { line: restored.removed ? `removed ${entry.path}, which that change created` : `restored ${entry.path}` },
        { line: `undid ${entry.mode} ${entry.id}` },
      ],
    };
  } finally {
    lock.release();
  }
}

// --- command surface ------------------------------------------------------

/**
 * The audit entry, written for EVERY mutation — including the refused ones.
 *
 * It is emitted here, in the one function both the handler and the `resultOf`
 * producer call, for the same reason `exec`'s is: emitting from the handler
 * alone would mean `--output json-envelope|agent` changed a file and left no
 * record, and an audit a caller can skip by choosing an output format is not an
 * audit. Refusals are recorded too — "what did this agent try to change" is a
 * question the log has to be able to answer.
 */
function emitAudit(ctx, result) {
  // A dry run changed nothing, so there is nothing to audit. Recording it would
  // put a passing `write` in the log for a file that was never touched, which
  // is the one thing an execution log must never do. `exec` returns before its
  // own audit for the same reason.
  if (result.dryRun) return;
  const events = ctx?.events;
  const sink = typeof events?.withCommand === 'function' ? events.withCommand(result.mode) : events;
  sink?.emit?.(result.mode, {
    result: result.status === 'ok' ? 'pass' : 'fail',
    status: result.status,
    exitCode: result.exitCode,
    // The invocation descriptor: which file, what happened to it, and the
    // digests that let a reviewer tie this record to the bytes on disk. The
    // CONTENT is deliberately absent — a durable log of every line the harness
    // ever wrote is the most likely place for a pasted credential to survive.
    file: {
      path: result.path,
      reason: result.reason,
      created: result.created,
      matches: result.matches,
      bytesBefore: result.bytesBefore,
      bytesAfter: result.bytesAfter,
      sha256Before: result.sha256Before,
      sha256After: result.sha256After,
      undoId: result.undo?.id ?? null,
    },
  });
}

function requirePath(relPath, mode) {
  if (typeof relPath === 'string' && relPath.trim()) return;
  throw usageError(`${mode} requires --path <relative-path>`, `harness ${mode} --path <file> …`);
}

function planEdit(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const relPath = literalFlag(argv, '--path');
  requirePath(relPath, 'edit');
  const old = literalFlag(argv, '--old');
  const next = literalFlag(argv, '--new');
  // Empty is refused with the same message as absent, deliberately. An empty
  // search string matches at every position, so the unique-match rule reported
  // it as "appears more than once" — a true statement that sends the caller
  // looking for a duplicate in their file instead of at their own argument.
  // `--new` and `--content` may legitimately be empty (deleting text, an empty
  // file), so only this one carries the check.
  if (!old) throw usageError('edit requires --old <text>', 'harness edit --path <file> --old <text> --new <text>');
  if (next === null) throw usageError('edit requires --new <text>', 'harness edit --path <file> --old <text> --new <text>');
  return { flags, workspace, relPath, old, next };
}

function planWrite(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const relPath = literalFlag(argv, '--path');
  requirePath(relPath, 'write');
  const content = literalFlag(argv, '--content');
  if (content === null) throw usageError('write requires --content <text>', 'harness write --path <file> --content <text>');
  return { flags, workspace, relPath, content, expect: literalFlag(argv, '--expect') };
}

export async function editResultOf(argv, ctx = {}) {
  const p = planEdit(argv);
  const result = runEdit({ workspace: p.workspace, path: p.relPath, old: p.old, next: p.next, dryRun: p.flags.dryRun });
  emitAudit(ctx, result);
  return result;
}

export async function writeResultOf(argv, ctx = {}) {
  const p = planWrite(argv);
  const result = runWrite({ workspace: p.workspace, path: p.relPath, content: p.content, expect: p.expect, dryRun: p.flags.dryRun });
  emitAudit(ctx, result);
  return result;
}

export async function undoResultOf(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const result = runUndo({ workspace: path.resolve(flags.workspace), dryRun: flags.dryRun });
  emitAudit(ctx, result);
  return result;
}

function render(result, flags) {
  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return;
  }
  const keyWidth = keyWidthFor(['status', result.mode]);
  console.log(ui.line({
    state: result.status === 'ok' ? 'ok' : 'error',
    key: result.mode,
    value: result.path ?? '—',
    keyWidth,
  }));
  // inertLine per row: a summary line quotes a path the caller supplied, and a
  // path may carry an ANSI escape that would otherwise reach the terminal.
  for (const row of result.output) console.log(`  ${inertLine(row.line)}`);
  // A mutation that ran without its lock is still a mutation, but the operator
  // should know serialization was not in force — a degradation nobody records
  // is a control nobody can audit.
  if (result.degraded) {
    console.log(ui.line({ state: 'warn', key: 'control', value: `unserialized: ${result.degraded}`, keyWidth }));
  }
  if (result.status === 'ok' && result.undo?.id) {
    console.log(ui.line({ key: 'undo', value: 'harness undo', note: result.undo.id, keyWidth }));
  }
}

export function exitFor(result) {
  return result.status === 'ok' ? EXIT.ok : result.exitCode || 1;
}

async function runCommand(argv, ctx, resultOf) {
  const result = await resultOf(argv, ctx);
  render(result, parseFlags(argv));
  ctx.reportStatus?.(result.status);
  return exitFor(result);
}

export const cmdEdit = (argv, ctx = {}) => runCommand(argv, ctx, editResultOf);
export const cmdWrite = (argv, ctx = {}) => runCommand(argv, ctx, writeResultOf);
export const cmdUndo = (argv, ctx = {}) => runCommand(argv, ctx, undoResultOf);
