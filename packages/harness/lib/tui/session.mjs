/**
 * The Session Ledger's interpretation layer — what one typed line MEANS.
 *
 * Separated from the terminal wiring on purpose: every rule about how input is
 * understood is a pure function here, so the whole grammar is testable without
 * a pty. The interactive module does I/O and nothing else.
 *
 * THE SIGILS ARE `/`, `!`, `!!`, `@`.
 *
 * `!!` MEANS RE-RUN, not "run privately". Phase 4b took pi's meaning — run
 * without telling the model — and the final design mock rejects it in as many
 * words: pi's reading is meaningless here, because the harness never talks to a
 * model, so there is no context to keep something out of. The shell's own
 * meaning is the useful one, and blocks-as-records make it exact: `!!` replays
 * the previous block's argv, `!! 5e08c7` replays any block by id, and each
 * appends a NEW record rather than editing the one it replayed.
 */

/** Split a command line into argv, honoring single and double quotes so a
 * value with a space survives. Deliberately not a shell: no expansion, no
 * substitution, no globbing — the ledger dispatches through the registry, and
 * anything that looked like shell here would be a lie about what runs. */
export function tokenize(line) {
  const argv = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of String(line)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) {
    // Dispatching an unterminated quote would silently run something other than
    // what was typed — the closing quote is where the value was meant to end.
    throw Object.assign(new Error(`unterminated ${quote === '"' ? 'double' : 'single'} quote`), {
      code: 'E_USAGE', exit: 2, hint: 'close the quote, or drop it',
    });
  }
  if (started || current) argv.push(current);
  return argv;
}

/**
 * What a line means.
 *
 * `exit`/`quit` are words rather than only Ctrl-D because the exit ritual is
 * part of the design — a session that ends should print its tally, and a person
 * who types `exit` deserves that as much as one who presses a key.
 */
/**
 * Control bytes an operator never meant to type.
 *
 * A terminal that is not doing line editing echoes an arrow key as `\x1b[A`
 * and hands it to us as part of the line, so `exit` preceded by three Up
 * presses arrived as `^[[A^[[A^[[Aexit` and was rejected as an unknown command.
 * The readline fix stops that at the source; this stops it reaching a
 * DISPATCH decision at all, which matters for piped input too — a stray escape
 * in a script should not silently change which command runs.
 */
const CONTROL_SEQUENCES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripControl(text) {
  return String(text ?? '').replace(CONTROL_SEQUENCES, '');
}

/**
 * Session-owned words — not harness commands, not palette queries.
 *
 * Operators type these with or without a leading `/` because every other
 * agent CLI treats `/exit` and `/clear` as slash-commands, and answering
 * "nothing matches" for the session's own words is the same discoverability
 * failure `/help` used to have. Reserved here so a slash never ships them to
 * the palette filter.
 */
const SESSION_WORDS = Object.freeze({
  exit: 'exit',
  quit: 'exit',
  help: 'help',
  '?': 'help',
  clear: 'clear',
});

/** `replay` and `replay <id>` — re-run a block by name rather than by sigil. */
const REPLAY_WORDS = new Set(['replay', 'rerun', 're-run']);

export function interpretLine(rawLine) {
  const line = stripControl(rawLine).trim();
  if (!line) return { kind: 'empty' };

  // Session words win over every other reading, with or without `/`.
  // `/exit` must not open a palette filter for "exit"; `clear` must not be
  // dispatched as an unknown harness command; `/help` must not say
  // "nothing matches". Checked before `!` so `!clear` stays a real shell
  // escape (and still fails under ghostty's terminfo — which is why the
  // session owns a native clear).
  const sessionKey = line.startsWith('/') ? line.slice(1).trim() : line;
  if (Object.hasOwn(SESSION_WORDS, sessionKey) && !sessionKey.includes(' ')) {
    return { kind: SESSION_WORDS[sessionKey] };
  }

  // `replay`, `replay <id>` — with or without a leading slash.
  const replayParts = sessionKey.split(/\s+/);
  if (REPLAY_WORDS.has(replayParts[0])) {
    const target = replayParts[1] ? replayParts[1].replace(/^#/, '') : null;
    if (!target) return { kind: 'rerun', target: null };
    if (/^[0-9a-z]+(-[0-9a-z]+)*$/i.test(target) && target.replace(/-/g, '').length >= 4) {
      return { kind: 'rerun', target };
    }
    return {
      kind: 'invalid',
      reason: `replay takes a block id, and ${JSON.stringify(target)} is not one`,
      hint: 'replay on its own repeats the last block; replay <id> takes an id from a record line',
    };
  }

  // `!!` KEPT ONLY AS A QUIET ALIAS. Pi and Claude Code both read `!` and
  // `!!` as the shell, so spending the doubled sigil on re-run put two
  // meanings behind one gesture every operator's muscle memory had already
  // assigned. Re-running is now `replay`, a named session word that appears
  // in the palette with its own signature; `!!` still works for the fingers
  // that learned it, and `help` no longer advertises it.
  if (line.startsWith('!!')) {
    const target = line.slice(2).trim();
    // A bare `!!` repeats the last block. An argument is a block id — the same
    // id `run tree` and `run resume` take, which is the point of blocks being
    // records. Anything that is not id-shaped is a mistake worth naming rather
    // than a command worth guessing at.
    if (!target) return { kind: 'rerun', target: null };
    // HYPHENS ARE PART OF A RUN ID. `newRunId()` produces
    // `msmtwjuy-98f5bdc77b` — a time-ordered head, a hyphen, then random
    // bytes — and this pattern refused it, so copying an id straight off a
    // record line, which is the only way anyone gets one, was rejected as "not
    // a block id". The primary path for the feature was the one that failed.
    if (/^[0-9a-z]+(-[0-9a-z]+)*$/i.test(target) && target.replace(/-/g, '').length >= 4) {
      return { kind: 'rerun', target };
    }
    return {
      kind: 'invalid',
      reason: `!! re-runs a block, and ${JSON.stringify(target)} is not a block id`,
      hint: 'use !! on its own for the last block, or !! <id> from the record line',
    };
  }
  if (line.startsWith('!')) {
    return { kind: 'shell', script: line.slice(1).trim() };
  }

  if (line.startsWith('/')) {
    // A bare `/` opens the palette; `/something` is a filtered palette query.
    // It is NOT a command invocation — the palette is how a capability is
    // chosen, so a slash always lands there and never dispatches directly.
    // Session words are already handled above; everything else is a filter.
    return { kind: 'palette', query: line.slice(1).trim() };
  }

  if (line.startsWith('@')) {
    return { kind: 'reference', target: line.slice(1).trim() };
  }

  try {
    return { kind: 'command', argv: tokenize(line) };
  } catch (error) {
    return { kind: 'invalid', reason: error.message, hint: error.hint };
  }
}

/**
 * The ledger's running tally, printed by the exit ritual.
 *
 * A session that ends with nothing to show teaches nothing; one that closes
 * with what it did — and the command to pick the thread back up — is the
 * difference between a transcript and a record.
 */
export function createTally() {
  const counts = { commands: 0, ok: 0, failed: 0, cancelled: 0 };
  return {
    record(exitCode, { cancelled = false } = {}) {
      counts.commands += 1;
      if (cancelled) counts.cancelled += 1;
      else if (exitCode === 0) counts.ok += 1;
      else counts.failed += 1;
      return counts;
    },
    snapshot() {
      return { ...counts };
    },
  };
}
