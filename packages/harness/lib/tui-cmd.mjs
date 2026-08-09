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
import { openPalette, resolveSelection, selectionPlan } from './tui/palette.mjs';
import { createTally, interpretLine, stripControl } from './tui/session.mjs';

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
  write(ui.paint('muted', `${ui.arrow} / to search commands · ! to run a shell command · help for the full list · exit to close`));
  write('');

  // `terminal` follows the INPUT, and this was a real defect rather than a
  // preference. With it pinned false, readline did no line editing, so an
  // arrow key was never interpreted — the terminal echoed the raw bytes and
  // then submitted them, producing `^[[A^[[A^[[Aexit` and an "unknown command"
  // for a word the operator had typed correctly. Pressing Up for history, the
  // single most reflexive thing anyone does in a prompt, corrupted the line.
  //
  // `terminal: true` does NOT mean an alternate screen. It gives line editing,
  // history and a rendered prompt while still writing into the main buffer, so
  // the scrolling-transcript design is untouched. A piped stdin keeps the old
  // path, which is what makes the session scriptable and testable.
  const interactive = Boolean(input.isTTY);
  const rl = readline.createInterface({
    input,
    output,
    terminal: interactive,
    // A VISIBLE input affordance, and named for what it acts on. The session
    // previously showed a bare blank line: nothing said the harness was waiting
    // rather than working, nothing said which repository a command would hit,
    // and nothing distinguished the input line from the transcript above it.
    // "Is this hung?" is not a question an interactive surface should provoke.
    prompt: interactive ? `${ui.paint('info', path.basename(path.resolve(workspace)))} ${ui.paint('ok', '❯')} ` : '',
    historySize: 200,
  });
  if (interactive) rl.prompt();

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

  // pending is either:
  //   { kind: 'palette', rows }     — waiting for a number
  //   { kind: 'values', row, queue, index, values, untilResolves } — collecting
  //                                   prompt answers for a chosen row
  // The previous code refused every row that needed a value with "not available
  // from a piped session", which made the palette unusable for search, plan-new,
  // get, remember, and every other command whose argv is not empty. Collection
  // is the palette contract: choose a capability, answer for the values by name,
  // never type `--`.
  let pending = null;

  const askPrompt = (prompt) => {
    const note = prompt.description
      || (prompt.type === 'boolean' ? 'yes / no' : prompt.required ? 'required' : 'optional — leave blank to skip');
    write(ui.line({
      state: prompt.required ? 'warn' : 'muted',
      key: '?',
      value: prompt.label,
      note,
    }));
  };

  const finishSelection = async (row, values) => {
    const { argv: resolved, invalid, missing } = resolveSelection(row, values);
    if (missing?.length) {
      write(ui.line({
        state: 'warn',
        key: 'needs',
        value: missing.map((k) => String(k).replace(/^--/, '')).join(', '),
        note: 'still required',
      }));
      return;
    }
    if (invalid) {
      write(ui.line({ state: 'warn', key: 'needs', value: row.label, note: invalid }));
      return;
    }
    // Nested Session Ledger would steal the same stdin and never return cleanly.
    if (resolved?.[0] === 'tui') {
      write(ui.line({
        state: 'warn',
        key: 'tui',
        value: 'already open',
        note: 'the session ledger is this surface — pick another command',
      }));
      return;
    }
    if (resolved) await runArgv(resolved, { echo: true });
  };

  const beginSelection = async (choice) => {
    // Re-entry into the ledger from its own palette is a no-op, not a hang.
    if (choice?.argvTokens?.[0]?.value === 'tui' || choice?.noun === 'tui') {
      write(ui.line({
        state: 'warn',
        key: 'tui',
        value: 'already open',
        note: 'the session ledger is this surface — pick another command',
      }));
      return;
    }
    const plan = selectionPlan(choice);
    if (plan.ready) {
      await finishSelection(choice, {});
      return;
    }
    if (plan.invalid && !plan.queue.length) {
      write(ui.line({ state: 'warn', key: 'needs', value: choice.label, note: plan.invalid }));
      return;
    }
    if (!plan.queue.length) {
      write(ui.line({ state: 'warn', key: 'needs', value: choice.label, note: plan.invalid || 'nothing to run' }));
      return;
    }
    pending = {
      kind: 'values',
      row: choice,
      queue: plan.queue,
      index: 0,
      values: {},
      untilResolves: plan.untilResolves,
    };
    // The palette never asks a person to type flag syntax (P4bAC6) — it asks
    // for the VALUE by name and assembles the argv itself.
    write(ui.paint('muted', `  ${plan.queue.length} value(s) needed · blank skips optional · exit cancels`));
    askPrompt(plan.queue[0]);
  };

  for await (const rawLine of rl) {
    const line = stripControl(String(rawLine));

    // Collecting values for a chosen palette row. Checked first so a number
    // typed as a value (e.g. --limit) is not re-read as a palette index.
    if (pending?.kind === 'values') {
      const trimmed = line.trim();
      if (trimmed === 'exit' || trimmed === 'quit') {
        write(ui.paint('muted', '  cancelled'));
        pending = null;
        if (interactive) rl.prompt();
        continue;
      }
      const prompt = pending.queue[pending.index];
      if (trimmed === '') {
        if (prompt.required) {
          write(ui.line({ state: 'warn', key: 'needs', value: prompt.label, note: 'required — enter a value, or exit to cancel' }));
          askPrompt(prompt);
          if (interactive) rl.prompt();
          continue;
        }
        // Optional blank: skip this key entirely.
      } else if (prompt.type === 'boolean') {
        const t = trimmed.toLowerCase();
        if (!['y', 'yes', 'true', '1', 'n', 'no', 'false', '0'].includes(t)) {
          write(ui.line({ state: 'warn', key: 'needs', value: prompt.label, note: 'yes or no' }));
          askPrompt(prompt);
          if (interactive) rl.prompt();
          continue;
        }
        // Boolean, not the strings "true"/"false": resolveArgv treats any
        // truthy value as "include the flag", and the string "false" is truthy.
        pending.values[prompt.key] = ['y', 'yes', 'true', '1'].includes(t);
      } else {
        pending.values[prompt.key] = trimmed;
      }

      // either/or gates (get's --docid OR --path): stop as soon as the CLI
      // would accept what we have, rather than forcing every optional field.
      if (pending.untilResolves) {
        const attempt = resolveSelection(pending.row, pending.values);
        if (attempt.argv && !attempt.invalid && !(attempt.missing?.length)) {
          const row = pending.row;
          const values = pending.values;
          pending = null;
          await finishSelection(row, values);
          if (interactive) rl.prompt();
          continue;
        }
      }

      pending.index += 1;
      if (pending.index < pending.queue.length) {
        askPrompt(pending.queue[pending.index]);
        if (interactive) rl.prompt();
        continue;
      }
      const row = pending.row;
      const values = pending.values;
      pending = null;
      await finishSelection(row, values);
      if (interactive) rl.prompt();
      continue;
    }

    // A number answers an open palette. Checked before interpretation so `3`
    // means "the third row" rather than "a command called 3".
    if (pending?.kind === 'palette' && /^\d+$/.test(line.trim())) {
      const choice = pending.rows[Number(line.trim()) - 1];
      pending = null;
      if (!choice) {
        write(ui.line({ state: 'warn', key: 'palette', value: 'no such row' }));
        if (interactive) rl.prompt();
        continue;
      }
      await beginSelection(choice);
      if (interactive) rl.prompt();
      continue;
    }

    const parsed = interpretLine(line);
    if (parsed.kind === 'empty') { if (interactive) rl.prompt(); continue; }
    if (parsed.kind === 'exit') break;

    pending = null;
    if (parsed.kind === 'palette') {
      pending = { kind: 'palette', rows: showPalette(parsed.query) };
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
    } else if (parsed.kind === 'help') {
      // `help` is handled in bin/harness.mjs rather than registered, so the
      // palette index does not contain it and `/help` answered `nothing
      // matches "help"` — the first thing a new operator types, met with a
      // refusal.
      write(ui.line({ key: 'help', value: 'type a command directly, or:' }));
      write(ui.paint('muted', '  /            open the command palette'));
      write(ui.paint('muted', '  /<text>      filter the palette'));
      write(ui.paint('muted', '  /<text> then a number   pick a row; answer any values by name'));
      write(ui.paint('muted', '  !<command>   run a shell command through governed bash'));
      write(ui.paint('muted', '  !!<command>  the same, kept out of the ledger'));
      write(ui.paint('muted', '  exit         close the session and print the tally'));
      write(ui.paint('muted', `  ${ui.arrow} up/down recalls what you typed · Ctrl-C cancels a running command`));
    } else if (parsed.kind === 'reference') {
      write(ui.line({ state: 'warn', key: 'reference', value: parsed.target, note: 'file references are not wired yet' }));
    } else {
      await runArgv(parsed.argv);
    }
    if (interactive) rl.prompt();
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
