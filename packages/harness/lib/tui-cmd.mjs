/**
 * `harness tui` — the Session Ledger.
 *
 * A SCROLLING TRANSCRIPT IN THE TERMINAL'S MAIN BUFFER, not an alt-screen app.
 * That is the settled design direction and it is doing real work: scrollback,
 * text selection, and the terminal's own search keep working because they were
 * never taken away (P4bAC2). Every alt-screen TUI has to re-implement those
 * three badly; this one declines to.
 *
 * Which makes the shell a read-dispatch-print loop. Every operation goes
 * through the SAME registry `bin/harness.mjs` dispatches to (P4bAC1) — there is
 * no second behavior path and nothing shells out to the CLI, so a command
 * cannot behave one way here and another way there.
 *
 * The loop reads stdin whether or not it is a TTY. That is not only for tests:
 * a ledger that accepts piped input is scriptable, and the same code path
 * serving both is what keeps the tested behavior and the interactive behavior
 * from drifting.
 *
 * All rendering goes through `lib/style.mjs`, per the design-system rule that
 * no harness surface renders unstyled — which is also how the ASCII fallback
 * (P4bAC4) comes for free, since `createStyle` already degrades glyphs on
 * limited terminals.
 */
import readline from 'node:readline';
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { dispatch, hasCommand } from './registry.mjs';
import { openPalette, promptsFor, resolveSelection } from './tui/palette.mjs';
import { createTally, interpretLine } from './tui/session.mjs';

/**
 * Flag spellings removed from prose a person reads in the palette.
 *
 * The palette's promise is that a capability is chosen, not spelled. A summary
 * written for `--help` naturally names its flags; shown here it contradicts the
 * promise the surface just made.
 */
export function stripFlagSyntax(text) {
  return String(text ?? '')
    .replace(/--[a-z][a-z0-9-]*/gi, (m) => m.replace(/^--/, ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** How many palette rows one overlay shows. An overlay taller than a glance is
 * a list, and a list is what the palette exists instead of. */
export const PALETTE_PAGE = 9;

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/**
 * One ledger session.
 *
 * `input`/`output` are injected so a test drives the whole loop over strings.
 * The interactive command passes the real streams.
 */
export async function runLedger({
  input = process.stdin,
  output = process.stdout,
  workspace = process.cwd(),
  copilotHome = null,
  argv = [],
  dispatcher = dispatch,
  now = () => new Date().toISOString(),
} = {}) {
  const ui = createStyle({ argv, stream: output });
  const write = (line = '') => output.write(`${line}\n`);
  const tally = createTally();
  const started = now();

  write(ui.paint('muted', 'harness — session ledger'));
  write(ui.paint('muted', `${ui.arrow} / to search commands · ! to run a shell command · exit to close`));
  write('');

  const rl = readline.createInterface({ input, output, terminal: false });

  // Ctrl-C cancels the RUNNING command, not the session. A ledger that exited
  // on the first interrupt would make cancellation and quitting the same
  // gesture, and they are opposite intentions.
  let activeController = null;
  const onSigint = () => {
    if (activeController) activeController.abort();
  };
  process.on('SIGINT', onSigint);

  /**
   * The session's own workspace and home, applied to every command that does
   * not name its own.
   *
   * Without this, `harness tui --workspace B` opened a ledger on B and then ran
   * every command against the process cwd — so a mutating command could act on
   * a DIFFERENT repository than the one the session was opened for, silently.
   * A session that says which project it is about has to mean it.
   */
  const withSessionContext = (commandArgv) => {
    const out = [...commandArgv];
    const boundary = out.indexOf('--');
    const scan = boundary === -1 ? out : out.slice(0, boundary);
    const insertAt = boundary === -1 ? out.length : boundary;
    const extra = [];
    if (!scan.some((a) => a === '--workspace' || a.startsWith('--workspace='))) extra.push('--workspace', workspace);
    if (copilotHome && !scan.some((a) => a === '--copilot-home' || a.startsWith('--copilot-home='))) {
      extra.push('--copilot-home', copilotHome);
    }
    out.splice(insertAt, 0, ...extra);
    return out;
  };

  const runArgv = async (rawArgv, { echo = false, quiet = false } = {}) => {
    if (!rawArgv.length) return;
    const commandArgv = withSessionContext(rawArgv);
    const [name, ...rest] = commandArgv;
    if (!hasCommand(name)) {
      write(ui.line({ state: 'error', key: 'unknown', value: name, note: 'type / to see what exists' }));
      return;
    }
    // P4bAC8: the resolved argv is echoed for every palette-initiated run, so
    // the ledger records what actually ran rather than what was clicked. A
    // transcript that shows a choice but not a command cannot be replayed or
    // reviewed.
    // Echo what the OPERATOR typed, not the argv with session flags spliced in:
    // the transcript is a record of the session, and repeating its own
    // `--workspace` on every line would bury the command in ceremony.
    if (echo) write(ui.paint('muted', `  $ harness ${rawArgv.join(' ')}`));

    if (quiet) write(ui.paint('muted', '  $ (private) — output withheld from the ledger'));
    activeController = new AbortController();
    let exitCode = 0;
    let cancelled = false;
    try {
      exitCode = await dispatcher([name, ...rest], {
        style: ui,
        signal: activeController.signal,
      });
    } catch (error) {
      exitCode = Number.isInteger(error?.exit) ? error.exit : 1;
      cancelled = error?.code === 'E_CANCELLED';
      for (const l of ui.errorBlock({
        code: error?.code || 'E_UNEXPECTED',
        message: error?.message || String(error),
        fix: error?.hint,
        exit: exitCode,
      })) write(l);
    } finally {
      activeController = null;
    }
    // EXIT.cancelled is cancellation however it arrives. Keying only off a
    // thrown E_CANCELLED counted an interrupted command as a failure, which is
    // the one distinction the tally exists to draw.
    tally.record(exitCode, { cancelled: cancelled || exitCode === EXIT.cancelled });
  };

  const showPalette = (query) => {
    const palette = openPalette({ workspace, query });
    const rows = palette.rows.slice(0, PALETTE_PAGE);
    if (!rows.length) {
      write(ui.line({ state: 'warn', key: 'palette', value: `nothing matches ${JSON.stringify(query)}` }));
      return [];
    }
    const keyWidth = keyWidthFor(['palette', ...rows.map((_, i) => String(i + 1))]);
    write(ui.line({ key: 'palette', value: `${rows.length} of ${palette.rows.length}`, note: query || undefined, keyWidth }));
    rows.forEach((row, i) => {
      write(ui.line({
        // The side-effect glyph is the palette's own contribution: no surveyed
        // tool can show what a command will do before it runs, because none
        // declares a side-effect class per command. This one does, on every
        // entry, so the row can warn before the choice rather than after.
        state: row.sideEffect === 'read' ? 'ok' : row.sideEffect === 'mutate' ? 'warn' : 'error',
        key: String(i + 1),
        value: row.label,
        // The summary is rendered text a person reads, so P4bAC6 applies to it
        // as much as to the label: `/index` was printing `--status` and
        // `--structural` at someone told they never need to type a flag.
        note: [row.sideEffect, stripFlagSyntax(row.summary)].filter(Boolean).join(' · '),
        keyWidth,
      }));
    });
    write(ui.paint('muted', '  choose a number, or keep typing to narrow'));
    return rows;
  };

  let pending = null; // palette rows awaiting a numeric choice

  for await (const rawLine of rl) {
    const line = String(rawLine);

    // A number answers an open palette. Checked before interpretation so `3`
    // means "the third row" rather than "a command called 3".
    if (pending && /^\d+$/.test(line.trim())) {
      const choice = pending[Number(line.trim()) - 1];
      pending = null;
      if (!choice) {
        write(ui.line({ state: 'warn', key: 'palette', value: 'no such row' }));
        continue;
      }
      const needed = promptsFor(choice).filter((p) => p.required);
      if (needed.length) {
        // The palette never asks a person to type flag syntax (P4bAC6) — it
        // asks for the VALUE by name and assembles the argv itself.
        write(ui.line({ state: 'warn', key: 'needs', value: needed.map((p) => p.label).join(', '), note: 'not available from a piped session — run it from the CLI with those values' }));
        continue;
      }
      const { argv: resolved, invalid } = resolveSelection(choice, {});
      if (invalid) {
        // The palette refuses to hand dispatch an argv the CLI would reject, so
        // the reason surfaces here instead of as a usage error after the fact.
        write(ui.line({ state: 'warn', key: 'needs', value: choice.label, note: invalid }));
        continue;
      }
      if (resolved) await runArgv(resolved, { echo: true });
      continue;
    }

    const parsed = interpretLine(line);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'exit') break;

    pending = null;
    if (parsed.kind === 'palette') {
      pending = showPalette(parsed.query);
    } else if (parsed.kind === 'invalid') {
      write(ui.line({ state: 'error', key: 'input', value: parsed.reason, note: parsed.hint }));
    } else if (parsed.kind === 'shell') {
      // Routed through the harness's own gated `bash`, never spawned directly:
      // the shell gate, the environment allowlist, the cwd containment, and the
      // execution audit all apply to a ledger shell-out exactly as they do to
      // `harness bash`. A TUI that spawned its own shell would be the second
      // behavior path P4bAC1 forbids.
      // `!!` is the PRIVATE form: it runs, and its output stays out of the
      // ledger. That distinction is the reason the two sigils exist — the usual
      // reason to shell out is precisely that you do not want the result in
      // context — and echoing it identically made `!!` a synonym for `!`.
      await runArgv(['bash', '--', parsed.script], { echo: !parsed.private, quiet: parsed.private });
    } else if (parsed.kind === 'reference') {
      write(ui.line({ state: 'warn', key: 'reference', value: parsed.target, note: 'file references are not wired yet' }));
    } else {
      await runArgv(parsed.argv);
    }
  }

  rl.close();
  process.off('SIGINT', onSigint);

  // The exit ritual: the closing tally and the command to pick the thread back
  // up, printed INTO scrollback so it survives the session that produced it.
  const counts = tally.snapshot();
  write('');
  write(ui.line({
    state: counts.failed ? 'warn' : 'ok',
    key: 'session',
    value: `${counts.commands} command(s)`,
    note: `${counts.ok} ok · ${counts.failed} failed · ${counts.cancelled} cancelled`,
  }));
  write(ui.paint('muted', `  started ${started} · resume with: harness run list`));
  return EXIT.ok;
}

export async function cmdTui(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  if (flags.json) {
    throw usageError('tui has no JSON output', 'the ledger is a terminal surface; use the CLI for machine-readable output');
  }
  return runLedger({ workspace, copilotHome: flags.copilotHome || null, argv });
}
