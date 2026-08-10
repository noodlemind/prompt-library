/**
 * `harness tui` — the Session Ledger.
 *
 * A SCROLLING TRANSCRIPT IN THE TERMINAL'S MAIN BUFFER, not an alt-screen app.
 * Scrollback, text selection and the terminal's own search keep working because
 * they were never taken away. Every alt-screen TUI re-implements those three
 * badly; this one declines to, and offers `tui.alt_screen` for the minority who
 * want the trade the other way.
 *
 * EVERY COMMAND PRINTS A BLOCK, and a block is a journal record. That sentence
 * is the whole design and it is what phase 4b did not build: commands printed
 * through `console.log` with the composer suspended, so output arrived as
 * undifferentiated text that could not be tinted, folded, marked, re-run or
 * restored, and nothing a person did inside the ledger reached `run list`. Here
 * a dispatch opens a run, streams its output into a block, closes the run with
 * a real status, and commits the rendered block to scrollback.
 *
 * ONE KERNEL, ONE PATH. Every operation goes through the same registry
 * `bin/harness.mjs` dispatches to. Nothing shells out to the CLI and the TUI
 * adds no capability the CLI lacks — the difference between the two surfaces is
 * only how much has to be said out loud.
 *
 * VERBS INTERACTIVELY, FLAGS FOR MACHINES. A person types `search lease
 * fencing`; a script types `harness search "lease fencing" --scope code
 * --output json-envelope`. Both reach the same registry entry. The palette
 * resolves verbs onto argv and echoes the resolved form into the ledger, so the
 * shell spelling is learned by observation rather than by being typed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInput } from './tui/input.mjs';
import { parseFlags } from './flags.mjs';
import { createStyle, EXIT } from './style.mjs';
import { dispatch, hasCommand, getCommand } from './registry.mjs';
import { openPalette, resolveSelection, selectionPlan } from './tui/palette.mjs';
import { createTally, interpretLine, stripControl, tokenize } from './tui/session.mjs';
import { createOverlay, splitPrefix, applyPrefix, treeRows } from './tui/overlay.mjs';
import { createLedger, statusForExit } from './tui/ledger.mjs';
import { renderBlock, foldState } from './tui/block.mjs';
import { renderHeader, renderExit } from './tui/chrome.mjs';
import { completePath } from './tui/complete.mjs';
import { deriveGitContext } from './git-context.mjs';
import { readSession } from './session.mjs';
import { resolveConfig } from './config.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';
import { readJournal, foldRuns, runStatusFromReported } from './run-journal.mjs';
import { createProcessEventRegistry, detectActor } from './event-registry.mjs';
import { setRunContext, currentRunContext } from './run-context.mjs';

/** `/Users/me/x` reads better as `~/x`, and the header has one row. */
const tildePath = (full) => {
  const home = os.homedir();
  return home && full.startsWith(home) ? `~${full.slice(home.length)}` : full;
};

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

/** Repaint the live region at most this often while output streams. A command
 * printing 500 lines does not need 500 repaints, and a terminal asked for them
 * spends the whole run scrolling. */
const LIVE_REPAINT_MS = 60;

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/** The registry declares a side-effect class per command; the palette shows it
 * so the consequence of a row is visible before it runs. */
const effectToken = (effect) => (effect === 'read' ? 'ok' : effect === 'mutate' ? 'warn' : 'error');

/**
 * One ledger session.
 *
 * `input`/`output` are injected so a test drives the whole loop over strings;
 * the interactive command passes the real streams.
 */
export async function runLedger({
  input = process.stdin,
  output = process.stdout,
  workspace = process.cwd(),
  copilotHome = null,
  argv = [],
  dispatcher = dispatch,
  now = () => new Date().toISOString(),
  config = null,
} = {}) {
  // Declared before `createInput`, which closes over it for `onInterrupt`.
  let activeController = null;
  const settings = config ?? safeConfig({ copilotHome, workspace });
  const version = readVersion();
  const ui = createStyle({ argv, stream: output, tintMode: settings['tui.tint'] ?? 'auto' });
  const screenReader = settings['tui.verbosity'] === 'screen-reader';
  const tally = createTally();
  const started = now();
  // Journaling follows the SAME rule the CLI entry uses (`shouldSkipRunJournal`
  // in bin/harness.mjs): `--dry-run`, `--no-events`, or `HARNESS_NO_EVENTS=1`.
  // A surface that journaled under conditions the CLI does not would make the
  // run history depend on which door a command came through.
  const ledgerFlags = parseFlags(argv);
  const journaling = !(ledgerFlags.dryRun || ledgerFlags.noEvents || process.env.HARNESS_NO_EVENTS === '1');
  const ledger = createLedger({ workspace, harnessVersion: version, journaling });
  // The numbered palette a piped session falls back to. Scoped to the session,
  // not the module: a module-level binding would leak one session's rows into
  // the next, which matters as soon as two ledgers share a process (a test
  // suite, an embedded host).
  let pipedPalette = null;

  const session = createInput({
    input,
    output,
    ui,
    ascii: !ui.unicode,
    footerItems: settings['tui.statusline'],
    paletteChord: settings['tui.palette_chord'] ?? 'ctrl+p',
    altScreen: settings['tui.alt_screen'] === true,
    // Ctrl-C and Esc during a running command reach the abort controller here,
    // not through SIGINT: raw mode stays on for the whole dispatch so the live
    // block can repaint, and in raw mode the terminal never raises the signal.
    onInterrupt: () => { if (activeController) activeController.abort(); },
    // A screen reader announces a repainting region on every repaint, so the
    // live tail is suppressed and the block is announced once, when it is done.
    interactive: screenReader ? false : Boolean(input.isTTY),
  });
  const interactive = session.interactive;
  const termWidth = () => Math.max(40, output.columns || 80);

  /**
   * What goes between two blocks.
   *
   * Density is taste, and the mock's §6 argues — from Warp's own settings
   * schema — that the things people argue about are the things to make
   * configurable rather than decide for them. The harness default is compact
   * with no divider, because the tint already separates the blocks and a rule
   * on top of a tint is the same information twice.
   */
  const separator = () => {
    if (settings['tui.dividers'] === true) return [ui.paint('muted', (ui.unicode ? '─' : '-').repeat(termWidth()))];
    return settings['tui.density'] === 'comfortable' ? [''] : [];
  };

  /** Commit a block to scrollback, in the design's grammar. */
  const emit = (block) => {
    const rows = renderBlock(block, { ui, width: termWidth(), fold: {} });
    session.commit([...rows, ...separator()]);
  };
  /**
   * A message that is not a command — help, a palette refusal, a prompt.
   *
   * PLAIN ROWS, NOT BLOCKS. An earlier version wrapped each one in a note
   * block, which put a stripe and a tint on informational text — so `help`
   * rendered as eleven separate one-row blocks while the startup shortcuts
   * line, the same class of content, rendered plain. A block is a record of
   * something that RAN; a message carries no status, so it gets the ledger
   * grammar and nothing else. Accepts an array so a multi-row message commits
   * as one unit with one trailing separator rather than eleven.
   */
  const say = (rows) => {
    session.commit([...(Array.isArray(rows) ? rows : [rows]), ...separator()]);
  };

  // ── session chrome ────────────────────────────────────────────────────
  const git = safeGit(workspace);
  const startup = new Set(settings['tui.startup'] ?? ['context', 'knowledge', 'shortcuts']);

  const gateOf = () => {
    try { return readSession(workspace)?.gateStatus || null; } catch { return null; }
  };
  const planOf = () => {
    try { return readSession(workspace)?.plan || null; } catch { return null; }
  };

  const refreshStatus = () => {
    const gate = gateOf();
    const plan = planOf();
    const last = ledger.lastCommand();
    session.setStatus({
      workspace: tildePath(workspace),
      branch: git.branch,
      gate,
      plan: plan ? path.basename(plan) : null,
      run: last?.run ? last.run.slice(0, 6) : null,
      runStatus: last?.status ?? null,
    });
    session.setHint({
      gate,
      shell: settings['exec.bash_enabled'] === false ? 'denied' : 'allowed',
      rerun: last?.command ? shortCommand(last.command) : null,
    });
  };

  /** The session header. Printed once at the top and again after `clear`,
   * because those are the two moments where nothing above it says what this
   * session is about. */
  const writeHeader = () => {
    if (!startup.has('context')) return;
    session.commit(renderHeader({
      ui,
      width: termWidth(),
      workspace: tildePath(workspace),
      branch: git.branch,
      commit: git.commit,
      version,
      plan: planOf() ? path.basename(planOf()) : null,
      gate: gateOf(),
    }));
  };
  writeHeader();

  // Restore what happened before this session. The record persists; the
  // transcript deliberately does not — see lib/tui/ledger.mjs.
  // HISTORY HYDRATES SILENTLY. The first pass printed every restored record
  // as a block, so a session opened onto a screenful of its own past — while
  // every reference surface in the survey (Amp, Claude Code, Grok, opencode)
  // opens onto identity, a hint or two, and an EMPTY transcript. The records
  // still load: `ctrl+↑` walks them, `!! <id>` replays one, `run list` prints
  // the full history as a block when asked. What the first screen gets is one
  // muted line saying the history exists — or nothing, when there is none.
  const restoreLimit = Number.isInteger(settings['tui.restore']) ? settings['tui.restore'] : 8;
  if (restoreLimit > 0) {
    const restored = ledger.hydrate({
      limit: restoreLimit,
      // The registry already declares every command's side-effect class, so
      // the judgment is looked up rather than listed: a succeeded READ left
      // nothing behind to point at, and the session's own `tui` runs are
      // never interesting to the session.
      restoreWorthy: (r) => {
        if (r.command === 'tui') return false;
        if (r.status !== 'succeeded') return true;
        return getCommand(r.command)?.sideEffect !== 'read';
      },
    });
    if (restored.length) {
      const failed = restored.filter((b) => b.status !== 'ok').length;
      const parts = [`${restored.length} prior run${restored.length === 1 ? '' : 's'}`];
      if (failed) parts.push(`${failed} failed`);
      session.commit([
        ui.paint('muted', `  ${ui.arrow} ${parts.join(' · ')} · ctrl+↑ to browse · run list for history`),
        ...separator(),
      ]);
    }
  }

  if (startup.has('shortcuts')) {
    // Two short lines, the way the field does it. The full grammar lives in
    // `help`; a startup that lists every sigil is a manual, not a hint.
    session.commit([
      ui.paint('muted', '  / for commands'),
      ui.paint('muted', '  ? for shortcuts'),
      ...separator(),
    ]);
  }
  refreshStatus();

  // ── cancellation ──────────────────────────────────────────────────────
  // A SIGINT still reaches a PIPED session, which never enters raw mode; the
  // interactive path is handled by `onInterrupt` above. Both abort the running
  // command and neither closes the session — cancellation and quitting are
  // opposite intentions, and a ledger that exited on the first interrupt would
  // make them the same gesture.
  const onSigint = () => { if (activeController) activeController.abort(); };
  process.on('SIGINT', onSigint);

  const closeSession = () => {
    try { session.close(); } catch { /* nothing left to restore */ }
    process.off('SIGINT', onSigint);
  };

  /**
   * The session's own workspace and home, applied to every command that does
   * not name its own.
   *
   * Without this, `harness tui --workspace B` opened a ledger on B and then ran
   * every command against the process cwd — so a mutating command could act on
   * a DIFFERENT repository than the one the session was opened for, silently.
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

  /**
   * Run one argv and produce one block.
   *
   * `display` is what the block shows as its command — what the operator typed,
   * not the argv with session flags spliced in. The transcript is a record of
   * the session, and repeating `--workspace` on every line would bury the
   * command in ceremony.
   */
  const runArgv = async (rawArgv, { display = null } = {}) => {
    if (!rawArgv.length) return null;
    const commandArgv = withSessionContext(rawArgv);
    const [name, ...rest] = commandArgv;
    if (!hasCommand(name)) {
      const block = ledger.open({ command: display ?? rawArgv.join(' '), argv: rawArgv });
      ledger.append(block, ui.line({ state: 'error', key: 'unknown', value: name, note: 'type / to see what exists' }));
      ledger.close(block, { status: 'failed', exitCode: EXIT.usage, tally: ui.summary({ ok: 0, err: 1, exit: EXIT.usage }) });
      tally.record(EXIT.usage, {});
      emit(block);
      return block;
    }

    // The DISPATCHED argv is what the block keeps for replay — `!echo hi` is
    // one string to read and another to run.
    const block = ledger.open({ command: display ?? rawArgv.join(' '), argv: rawArgv });
    activeController = new AbortController();
    session.beginLive(block);

    // EVERY COMMAND GETS ITS OWN RUN, and the run has to reach the writes.
    //
    // `bin/harness.mjs` sets the ambient context and builds an event registry
    // before dispatch so every event an invocation produces carries its run —
    // that is what lets `run show` join a command to the work it caused. A
    // ledger dispatch that skipped both wrote events with no run, and left
    // whatever context the outer `tui` invocation had set to claim them. The
    // previous context is restored afterwards rather than cleared, because the
    // session itself is still running inside one.
    const outerContext = currentRunContext();
    setRunContext({ run: block.run, actor: detectActor() });
    const events = block.run ? createProcessEventRegistry(commandArgv, block.run) : undefined;
    let reportedStatus = null;

    // Output is CAPTURED, not passed through: a line that reaches the terminal
    // directly is not part of any block and cannot be folded, marked, re-run or
    // restored. See lib/tui/input.mjs#capture.
    let lastPaint = 0;
    const capture = session.capture((line) => {
      ledger.append(block, line);
      const t = Date.now();
      if (t - lastPaint >= LIVE_REPAINT_MS) { lastPaint = t; session.refreshLive(); }
    });

    let exitCode = 0;
    let cancelled = false;
    let timedOut = false;
    try {
      exitCode = await dispatcher([name, ...rest], {
        style: ui,
        signal: activeController.signal,
        events,
        // Deferred past validation, exactly as the CLI defers it: a command the
        // registry refuses never ran, and opening a run for it would journal
        // work that did not happen.
        onRunStart: () => ledger.openRun(block),
        // The command's own account of what happened, preferred over inferring
        // it from the exit code — a child exiting 8 through `exec` is not a
        // harness timeout, and only the command knows which it was.
        reportStatus: (reported) => { reportedStatus = reported; },
      });
    } catch (error) {
      exitCode = Number.isInteger(error?.exit) ? error.exit : 1;
      cancelled = error?.code === 'E_CANCELLED';
      timedOut = error?.code === 'E_TIMEOUT' || exitCode === EXIT.timedOut;
      for (const l of ui.errorBlock({
        code: error?.code || 'E_UNEXPECTED',
        message: error?.message || String(error),
        fix: error?.hint,
        exit: exitCode,
      })) ledger.append(block, l);
    } finally {
      capture.release();
      activeController = null;
      session.endLive();
      setRunContext(outerContext);
    }

    // `EXIT.cancelled` is cancellation however it arrives. Keying only off a
    // thrown `E_CANCELLED` counted an interrupted command as a failure, which
    // is the one distinction the tally exists to draw.
    cancelled = cancelled || exitCode === EXIT.cancelled;
    const status = runStatusFromReported(reportedStatus)
      ?? statusForExit(exitCode, { cancelled, timedOut: timedOut && !cancelled });
    ledger.close(block, {
      status,
      exitCode,
      tally: closingTally(block, exitCode, cancelled),
      next: nextAction(name, status),
    });
    tally.record(exitCode, { cancelled });
    emit(block);
    refreshStatus();
    return block;
  };

  /**
   * The closing tally — only where it adds something the record line does not.
   *
   * `4 lines → exit 0` under `ok · exit 0 · …` said the exit code twice and the
   * line count once too often; the mock's tallies carry information (`1 err →
   * exit 6`, `3 hits · complete`), and a tally that merely restates the record
   * line is ceremony. A success ends on its own output; failures and folds get
   * the count, because there the count IS the summary.
   */
  const closingTally = (block, exitCode, cancelled) => {
    const rows = block.lines.length;
    if (cancelled) return `cancelled · ${rows} line${rows === 1 ? '' : 's'} · journal entry appended`;
    if (exitCode !== 0) return `${rows} line${rows === 1 ? '' : 's'} ${ui.arrow} exit ${exitCode}`;
    const fold = foldState(block);
    return fold.folded ? `${rows} lines · ${fold.hidden} folded` : null;
  };

  /** The one action that follows. Suggested only where the registry makes it
   * unambiguous — a wrong next action is worse than none. */
  const nextAction = (name, status) => {
    if (status === 'succeeded') return null;
    if (name === 'verify' || name === 'checks') return 'run tree <id>';
    if (name === 'gate') return 'plan show';
    return null;
  };

  // ── the palette ───────────────────────────────────────────────────────
  /**
   * The session's own words, as palette rows.
   *
   * `exit` worked three ways — the word, `/exit`, `ctrl+d` — and appeared
   * NOWHERE on screen, which is the difference between existing and being
   * discoverable. Amp lists `quit` in its palette with its chord; the ledger
   * does the same for the words the session owns. They rank after the real
   * commands unless the query asks for them.
   */
  const SESSION_ROWS = Object.freeze([
    { label: 'exit', session: 'exit', note: 'close the session · also ctrl+d', sideEffect: null },
    { label: 'clear', session: 'clear', note: 'clear the viewport · scrollback survives', sideEffect: null },
    { label: 'help', session: 'help', note: 'the sigils and the keys', sideEffect: null },
  ]);

  const paletteRows = (query) => {
    const { prefix, rest } = splitPrefix(query);
    const palette = openPalette({ workspace, query: rest });
    const rows = applyPrefix(palette.rows, prefix).map((row) => ({
      ...row,
      note: stripFlagSyntax(row.summary),
      reason: row.unavailable || null,
    }));
    if (!prefix) {
      const q = rest.trim().toLowerCase();
      const matching = SESSION_ROWS.filter((r) => !q || r.label.includes(q));
      // A session word the query PREFIXES outranks a fuzzy command match:
      // someone three letters into `exit` means exit, not `orient explain`.
      // With no query, the session words sit at the bottom where Amp keeps
      // its own housekeeping rows.
      for (const row of matching) {
        if (q && row.label.startsWith(q)) rows.unshift(row);
        else rows.push(row);
      }
    }
    return rows;
  };

  const openPaletteOverlay = (query = '') => {
    const overlay = createOverlay({
      title: '',
      query,
      rows: paletteRows(query),
      filter: (q) => paletteRows(q),
      footer: `${ui.unicode ? '↑↓' : 'up/down'} walk · ${ui.unicode ? '↵' : 'enter'} choose · esc closes · prefixes: run: plan: search: check: res: learn:`,
      page: PALETTE_PAGE,
    });
    session.openOverlay(overlay);
    return overlay;
  };

  /** Collecting values for a chosen palette row. The palette never asks anyone
   * to type flag syntax — it asks for the VALUE by name and assembles the argv
   * itself. */
  let pending = null;

  const askPrompt = (prompt) => {
    const note = prompt.description
      || (prompt.type === 'boolean' ? 'yes / no' : prompt.required ? 'required' : 'optional — leave blank to skip');
    say(ui.line({ state: prompt.required ? 'warn' : 'pending', key: '?', value: prompt.label, note }));
  };

  const finishSelection = async (row, values) => {
    const { argv: resolved, invalid, missing } = resolveSelection(row, values);
    if (missing?.length) {
      say(ui.line({ state: 'warn', key: 'needs', value: missing.map((k) => String(k).replace(/^--/, '')).join(', '), note: 'still required' }));
      return;
    }
    if (invalid) {
      say(ui.line({ state: 'warn', key: 'needs', value: row.label, note: invalid }));
      return;
    }
    // A nested ledger would steal the same stdin and never return cleanly.
    if (resolved?.[0] === 'tui') {
      say(ui.line({ state: 'warn', key: 'tui', value: 'already open', note: 'the session ledger is this surface — pick another command' }));
      return;
    }
    if (resolved) await runArgv(resolved);
  };

  const beginSelection = async (choice) => {
    if (choice?.unavailable) {
      // Listed and greyed, with its reason — choosing one explains rather than
      // runs. Hiding it would teach that the capability does not exist.
      say(ui.line({ state: 'warn', key: 'blocked', value: choice.label, note: choice.unavailable }));
      return;
    }
    if (choice?.argvTokens?.[0]?.value === 'tui' || choice?.noun === 'tui') {
      say(ui.line({ state: 'warn', key: 'tui', value: 'already open', note: 'the session ledger is this surface — pick another command' }));
      return;
    }
    const plan = selectionPlan(choice);
    if (plan.ready) { await finishSelection(choice, {}); return; }
    if (!plan.queue.length) {
      say(ui.line({ state: 'warn', key: 'needs', value: choice.label, note: plan.invalid || 'nothing to run' }));
      return;
    }
    pending = { row: choice, queue: plan.queue, index: 0, values: {}, untilResolves: plan.untilResolves };
    say(ui.paint('muted', `${plan.queue.length} value(s) needed · blank skips optional · exit cancels`));
    askPrompt(plan.queue[0]);
  };

  // ── block navigation & the run tree ───────────────────────────────────
  const blockRows = () => ledger.blocks
    .filter((b) => b.kind !== 'note')
    .slice(-40)
    .reverse()
    .map((b) => ({
      label: `${b.marked ? (ui.unicode ? '★ ' : '* ') : ''}${shortCommand(b.command) || '(note)'}`,
      note: [b.status, b.id.slice(0, 6)].filter(Boolean).join(' · '),
      sideEffect: null,
      block: b,
    }));

  /**
   * Block navigation, as an overlay.
   *
   * The design's keyboard table says `ctrl+↑` leaves the editor and then the
   * arrows walk blocks in place. In the main buffer that is not implementable
   * and pretending otherwise would be worse than adapting: a block that has
   * scrolled past the top of the viewport cannot be highlighted where it sits,
   * and re-drawing it lower would duplicate it in scrollback. So walking
   * happens in an ephemeral overlay — which is the design's own rule for every
   * other picker — and the block keys act on the selection.
   */
  const openBlockNav = () => {
    const rows = blockRows();
    if (!rows.length) { say(ui.paint('muted', 'nothing in the ledger yet')); return null; }
    const overlay = createOverlay({
      title: 'blocks',
      rows,
      actions: { y: 'copy', m: 'mark', r: 'rerun', q: 'quit', 'ctrl+o': 'fold', t: 'tree' },
      footer: `${ui.unicode ? '↑↓' : 'up/down'} walk · ${ui.unicode ? '↵' : 'enter'} inspect · ctrl+o fold · y copy · m mark · r re-run · t tree · q quit · esc closes`,
    });
    session.openOverlay(overlay);
    return overlay;
  };

  const openRunTree = (runId = null) => {
    let runs;
    try { runs = foldRuns(readJournal(workspace)); } catch { runs = []; }
    // A run with a result record and no start record folds to `command: null`;
    // `runs.at(-1)` can select one, and interpolating it printed the literal
    // word "null" as the command. Skip those rather than render them.
    const named = runs.filter((r) => r.command);
    const target = runId
      ? named.find((r) => r.run === runId || String(r.run).startsWith(runId))
      : named.at(-1);
    if (!target) {
      // SAY WHICH IT IS. Reporting "no runs in the journal yet" for a block that
      // simply was not journaled — a note, or a session running `--no-events` —
      // claimed an empty journal while the journal was not empty.
      say(ui.line({
        state: 'warn',
        key: 'run tree',
        value: runId ? String(runId).slice(0, 12) : 'latest',
        note: runId
          ? (named.length ? 'no run with that id — this block was never journaled' : 'no runs in the journal yet')
          : 'no runs in the journal yet',
      }));
      return null;
    }
    const node = {
      label: `${ui.paint('muted', 'run')} ${target.run.slice(0, 6)} ${ui.paint(target.status === 'succeeded' ? 'ok' : 'error', target.status)}`,
      status: target.status,
      duration: target.durationMs ? `${Math.round(target.durationMs / 1000)}s` : null,
      children: [{
        label: `${target.command} ${(target.argv || []).join(' ')}`.trim(),
        status: target.status,
        duration: null,
        children: [],
      }],
    };
    const overlay = createOverlay({
      title: `run tree · ${target.run.slice(0, 6)}`,
      rows: treeRows(node, { ui }),
      actions: { q: 'quit' },
      footer: `${ui.unicode ? '↑↓' : 'up/down'} walk · ${ui.unicode ? '↵' : 'enter'} inspect · esc closes`,
    });
    session.openOverlay(overlay);
    return overlay;
  };

  /** Re-run a block: same argv, fresh record. Never edits the one it replays —
   * the journal is append-only and history is not a draft. */
  const rerun = async (block) => {
    if (!block?.command) { say(ui.line({ state: 'warn', key: 'rerun', value: 'nothing to re-run' })); return; }
    // THE STORED ARGV FIRST. Re-tokenizing the display string replayed what was
    // TYPED, which is only the same thing when no sigil was involved: `!echo hi`
    // came back as `['!echo', 'hi']` and failed as an unknown command instead of
    // re-running the governed `bash -- echo hi` that actually ran. Tokenizing is
    // the fallback for a block that predates the stored argv.
    let argv = block.argv?.length ? [...block.argv] : null;
    if (!argv) {
      try { argv = tokenize(block.command); } catch { argv = null; }
    }
    if (!argv?.length) { say(ui.line({ state: 'warn', key: 'rerun', value: block.command, note: 'cannot be parsed back into a command' })); return; }
    await runArgv(argv, { display: block.command });
  };

  /** Clear the viewport (never scrollback), then restore the two things a
   * bare screen needs: the header saying which repository this is, and a
   * footer not pointing at blocks that are no longer in the ledger. */
  const doClear = () => {
    if (typeof session.clearScreen === 'function') session.clearScreen();
    else if (output.isTTY) output.write('\x1b[2J\x1b[H');
    ledger.clear();
    writeHeader();
    refreshStatus();
  };

  // ── the loop ──────────────────────────────────────────────────────────
  let lastEscape = 0;
  try {
    for (;;) {
      const event = await session.next();

      if (event.intent === 'exit') break;

      if (event.intent === 'escape') {
        if (activeController) { activeController.abort(); continue; }
        const t = Date.now();
        // Esc-Esc opens the run tree. The pairing is timed here because only
        // the loop knows whether the first Esc was consumed by a cancellation.
        if (t - lastEscape < 600) { lastEscape = 0; openRunTree(); } else lastEscape = t;
        continue;
      }

      if (event.intent === 'cancel') {
        if (!event.hadInput) say(ui.paint('muted', '(nothing running — type exit to close)'));
        continue;
      }

      if (event.intent === 'palette') { openPaletteOverlay(''); continue; }
      if (event.intent === 'navigate') { openBlockNav(); continue; }

      if (event.intent === 'fold') {
        const last = ledger.lastCommand();
        if (last) { last.folded = !foldState(last).folded; emit(last); }
        continue;
      }

      if (event.intent === 'complete') {
        const hits = completePath(event.prefix ?? '', { workspace });
        session.composer.setCompletion(hits);
        continue;
      }

      if (event.intent === 'choose') {
        session.closeOverlay();
        const row = event.row;
        if (row?.session === 'exit') break;
        if (row?.session === 'clear') { doClear(); continue; }
        if (row?.session === 'help') { emitHelp(); continue; }
        if (row?.block) { emit({ ...row.block, folded: false }); continue; }
        if (row?.node) continue; // a tree row is a view, not a command
        if (row) await beginSelection(row);
        continue;
      }

      if (event.intent === 'action') {
        const block = event.row?.block ?? null;
        if (event.action === 'quit') { session.closeOverlay(); break; }
        if (event.action === 'fold' && block) { block.folded = !foldState(block).folded; session.closeOverlay(); emit(block); continue; }
        if (event.action === 'mark' && block) {
          const on = ledger.toggleMark(block);
          session.closeOverlay();
          say(ui.line({ state: on ? 'ok' : 'pending', key: 'mark', value: shortCommand(block.command), note: on ? 'kept with the journal' : 'unmarked' }));
          continue;
        }
        if (event.action === 'copy' && block) {
          session.closeOverlay();
          // The ledger cannot reach the system clipboard without a spawn, and a
          // spawn here would be a second execution path outside the governed
          // one. Printing the command plainly is what a person can act on with
          // the terminal's own selection, which the main buffer preserves.
          say(ui.line({ key: 'copy', value: block.command, note: 'select with the terminal — scrollback is intact' }));
          continue;
        }
        if (event.action === 'rerun' && block) { session.closeOverlay(); await rerun(block); continue; }
        if (event.action === 'tree' && block) { session.closeOverlay(); openRunTree(block.run || block.id); continue; }
        session.closeOverlay();
        continue;
      }

      const line = stripControl(String(event.line ?? ''));
      // NO SEPARATE ECHO. The block's first row IS the command, verbatim — see
      // the design's block anatomy — so echoing the line here printed it twice,
      // once bare and once inside the block that followed. Lines that produce
      // no block (`help`, `clear`, a palette filter) answer for themselves.

      // Collecting values for a chosen palette row. Checked first so a value
      // that looks like a command is not re-read as one.
      if (pending) {
        const trimmed = line.trim();
        if (trimmed === 'exit' || trimmed === 'quit') { say(ui.paint('muted', 'cancelled')); pending = null; continue; }
        const prompt = pending.queue[pending.index];
        if (trimmed === '') {
          if (prompt.required) {
            say(ui.line({ state: 'warn', key: 'needs', value: prompt.label, note: 'required — enter a value, or exit to cancel' }));
            askPrompt(prompt);
            continue;
          }
        } else if (prompt.type === 'boolean') {
          const t = trimmed.toLowerCase();
          if (!['y', 'yes', 'true', '1', 'n', 'no', 'false', '0'].includes(t)) {
            say(ui.line({ state: 'warn', key: 'needs', value: prompt.label, note: 'yes or no' }));
            askPrompt(prompt);
            continue;
          }
          // Boolean, not the strings "true"/"false": resolveArgv treats any
          // truthy value as "include the flag", and the string "false" is truthy.
          pending.values[prompt.key] = ['y', 'yes', 'true', '1'].includes(t);
        } else {
          pending.values[prompt.key] = trimmed;
        }

        // Either/or gates (`get`'s --docid OR --path): stop as soon as the CLI
        // would accept what we have, rather than forcing every optional field.
        if (pending.untilResolves) {
          const attempt = resolveSelection(pending.row, pending.values);
          if (attempt.argv && !attempt.invalid && !(attempt.missing?.length)) {
            const { row, values } = pending;
            pending = null;
            await finishSelection(row, values);
            continue;
          }
        }

        pending.index += 1;
        if (pending.index < pending.queue.length) { askPrompt(pending.queue[pending.index]); continue; }
        const { row, values } = pending;
        pending = null;
        await finishSelection(row, values);
        continue;
      }

      const parsed = interpretLine(line);
      if (parsed.kind === 'empty') {
        // A bare Enter under an open numbered palette is not a choice. Saying
        // so beats leaving the operator staring at a prompt that silently
        // dropped their rows; the rows are still held, so nothing is re-ranked.
        if (pipedPalette) say(ui.paint('muted', `type 1–${pipedPalette.length} to pick a row, /text to refilter, or a command`));
        continue;
      }
      if (parsed.kind === 'exit') break;

      if (parsed.kind === 'palette') {
        if (interactive) { openPaletteOverlay(parsed.query); continue; }
        // Piped sessions have no overlay to walk, so the palette prints its
        // rows and takes a number — the phase-4b behaviour, kept for exactly
        // the case it suits.
        const rows = paletteRows(parsed.query).slice(0, PALETTE_PAGE);
        if (!rows.length) { say(ui.line({ state: 'warn', key: 'palette', value: `nothing matches ${JSON.stringify(parsed.query)}` })); continue; }
        rows.forEach((row, i) => say(ui.line({
          // No side-effect class means no glyph — a session word is not an
          // execute-class hazard, and painting it with the error glyph said
          // exactly that.
          state: row.sideEffect === 'read' ? 'ok' : row.sideEffect === 'mutate' ? 'warn' : row.sideEffect ? 'error' : undefined,
          key: String(i + 1),
          value: row.label,
          note: [row.sideEffect, row.note].filter(Boolean).join(' · '),
        })));
        pipedPalette = rows;
        continue;
      }

      if (pipedPalette && /^\d+$/.test(line.trim())) {
        const choice = pipedPalette[Number(line.trim()) - 1];
        pipedPalette = null;
        if (!choice) { say(ui.line({ state: 'warn', key: 'palette', value: 'no such row' })); continue; }
        if (choice.session === 'exit') break;
        if (choice.session === 'clear') { doClear(); continue; }
        if (choice.session === 'help') { emitHelp(); continue; }
        await beginSelection(choice);
        continue;
      }
      pipedPalette = null;

      if (parsed.kind === 'invalid') {
        say(ui.line({ state: 'error', key: 'input', value: parsed.reason, note: parsed.hint }));
      } else if (parsed.kind === 'rerun') {
        const target = parsed.target ? ledger.byId(parsed.target) : ledger.lastCommand();
        if (!target) {
          say(ui.line({ state: 'warn', key: 'rerun', value: parsed.target || 'last', note: parsed.target ? 'no block with that id in this session' : 'nothing has run yet' }));
        } else {
          await rerun(target);
        }
      } else if (parsed.kind === 'shell') {
        // Routed through the harness's own gated `bash`, never spawned
        // directly: the shell gate, the environment allowlist, the cwd
        // containment and the execution audit all apply to a ledger shell-out
        // exactly as they do to `harness bash`. A TUI that spawned its own
        // shell would be a second behaviour path.
        await runArgv(['bash', '--', parsed.script], { display: `!${parsed.script}` });
      } else if (parsed.kind === 'help') {
        emitHelp();
      } else if (parsed.kind === 'clear') {
        doClear();
      } else if (parsed.kind === 'reference') {
        const hits = completePath(parsed.target, { workspace });
        if (!hits.length) say(ui.line({ state: 'warn', key: 'file', value: parsed.target, note: 'no match in this workspace' }));
        else hits.forEach((h) => say(ui.line({ state: 'pending', key: h.kind, value: h.path })));
      } else {
        await runArgv(parsed.argv);
      }
    }
  } finally {
    closeSession();
  }

  // The exit ritual: the closing tally and the command to pick the thread back
  // up, printed INTO scrollback so it survives the session that produced it.
  const counts = { ...tally.snapshot(), marked: ledger.markCount };
  for (const row of renderExit({ ui, counts, started, width: termWidth() })) output.write(`${row}\n`);
  return EXIT.ok;

  // ── helpers that need the closure ─────────────────────────────────────
  function emitHelp() {
    // ONE message, ONE key width. Emitting a row at a time gave the first row
    // the default gutter (10) and the rest an explicit 12, so the columns
    // stepped sideways after the first line — visible in any capture.
    const rows = [
      ['help', 'type a command directly, or:'],
      ['/', 'open the command palette'],
      ['/<text>', 'filter the palette (run: plan: search: check: res: learn:)'],
      ['!<command>', 'run a shell command through governed bash'],
      ['!!', 're-run the previous block'],
      ['!! <id>', 're-run any block by id'],
      ['@<path>', 'complete a file path'],
      ['ctrl+↑', 'walk the ledger blocks'],
      ['esc esc', 'open the run tree'],
      ['clear', 'clear the viewport (keeps scrollback)'],
      ['exit / quit', 'close the session and print the tally'],
    ];
    const keyWidth = Math.max(...rows.map(([k]) => k.length));
    say(rows.map(([k, v]) => ui.line({ key: k, value: v, keyWidth })));
  }
}

/** `bash -- npm test` reads as `!npm test` in a hint row with one line. */
function shortCommand(command, max = 34) {
  const text = String(command ?? '').replace(/^bash\s+--\s+/, '!');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeGit(workspace) {
  try {
    const git = deriveGitContext({ workspace });
    return {
      branch: git?.branch || (git?.detached ? 'detached' : null),
      commit: git?.commit ? String(git.commit).slice(0, 7) : null,
    };
  } catch {
    // A container may have no repository; the header simply omits the fields.
    return { branch: null, commit: null };
  }
}

/**
 * The ledger's settings.
 *
 * FAILS OPEN, deliberately, and this is the one place in the harness where
 * that is right. `checks` and `exec` fail CLOSED on a bad config because the
 * dropped key can be a control — `exec.network` defaulting back to `allow` is
 * a real widening. Every key read here is presentation: a tint, a chord, a
 * footer order. Refusing to open a session because the density setting has a
 * typo would trade a cosmetic fault for a total one, and the fault still gets
 * reported by `harness config` and `doctor`.
 *
 * THE HOME IS RESOLVED FIRST, like every other resolveConfig caller. This
 * function used to pass the raw flag value straight through, which is null in
 * any session that did not spell `--copilot-home` — so `configPathFor` threw
 * inside `path.join`, the catch below swallowed it, and EVERY `tui.*` key was
 * silently dead in real sessions: the whole settings surface tested green and
 * did nothing. Found by a test that asserted a default's visible effect rather
 * than its declared value.
 */
function safeConfig({ copilotHome, workspace }) {
  try {
    const home = resolveCopilotHome(copilotHome);
    const resolved = resolveConfig({
      copilotHome: home,
      workspace,
      projectTrusted: isProjectTrusted({ workspace, copilotHome: home }),
    });
    return resolved?.values ?? {};
  } catch {
    return {};
  }
}

/** The version shown in the header. Absent rather than guessed when the
 * package cannot be read. */
function readVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

export async function cmdTui(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  if (flags.json) {
    throw usageError('tui has no JSON output', 'the ledger is a terminal surface; use the CLI for machine-readable output');
  }
  return runLedger({ workspace, copilotHome: flags.copilotHome || null, argv });
}
