/**
 * The Session Ledger's interpretation layer — what one typed line MEANS.
 *
 * Separated from the terminal wiring on purpose: every rule about how input is
 * understood is a pure function here, so the whole grammar is testable without
 * a pty. The interactive module does I/O and nothing else.
 *
 * THE SIGILS ARE `/`, `!`, `!!`, `@`, settled from the eight-CLI survey. The
 * `!`/`!!` split — output in context vs. output kept out of it — is pi's, and
 * is better than the single `!` four other tools ship, because the reason to
 * shell out is often exactly that you do NOT want the result in the model's
 * context.
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

export function interpretLine(rawLine) {
  const line = stripControl(rawLine).trim();
  if (!line) return { kind: 'empty' };

  if (line === 'exit' || line === 'quit') return { kind: 'exit' };
  // Asked for constantly and previously answered with `nothing matches "help"`,
  // because `help` is handled in bin/harness.mjs and never registered, so the
  // palette index genuinely does not contain it. Discoverability is the one
  // thing a blank prompt cannot afford to get wrong.
  if (line === 'help' || line === '/help' || line === '?' || line === '/?') return { kind: 'help' };

  // `!!` before `!`: the longer sigil has to win, or the private form would
  // parse as the public one with a `!` in the script.
  if (line.startsWith('!!')) {
    return { kind: 'shell', script: line.slice(2).trim(), private: true };
  }
  if (line.startsWith('!')) {
    return { kind: 'shell', script: line.slice(1).trim(), private: false };
  }

  if (line.startsWith('/')) {
    // A bare `/` opens the palette; `/something` is a filtered palette query.
    // It is NOT a command invocation — the palette is how a capability is
    // chosen, so a slash always lands there and never dispatches directly.
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
