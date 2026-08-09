#!/usr/bin/env node
/**
 * harness — install Adaptive Engineer Harness into global Copilot paths.
 * The npm package name is @dev-kit/harness; the command users and agents run is harness.
 *
 * P1.6: every command dispatches through lib/registry.mjs — the
 * hand-written switch (and its hand-written CATALOG help data) is retired.
 * `dispatch`/`hasCommand` (lib/registry.mjs) are the only command surface;
 * `help`/`--help`/`-h` is the one remaining non-registered branch, handled
 * directly below since it isn't a command with a side-effect class of its
 * own — it renders data ABOUT the registry, sourced from
 * `describeAll`/`describeCommand`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createStyle, keyWidthFor, EXIT } from '../lib/style.mjs';
import { dispatch as dispatchRegistered, hasCommand, describeCommand } from '../lib/registry.mjs';
import { createEventRegistry } from '../lib/event-registry.mjs';
import { writeEvent as writeHarnessEvent } from '../lib/events.mjs';
import { parseFlags, hasFlag } from '../lib/flags.mjs';
import { commandIndexEnvelope } from '../lib/command-index.mjs';
import { createRedactor, redactedJson } from '../lib/redact.mjs';
// The single package-version reader (lib/commands.mjs) — `cmdStatus`'s own
// read and registry.mjs#readHarnessVersion were deliberately consolidated into
// it, so `--version` reuses that one rather than reintroducing a third.
// registry.mjs already imports this module, so it costs no extra load.
import { readPkgVersion } from '../lib/commands.mjs';
import { newRunId, startRun, finishRun } from '../lib/run-journal.mjs';

const [, , command = 'help', ...args] = process.argv;
// This renderer only writes error blocks, which go to stderr — detect there.
const ui = createStyle({ argv: args, stream: process.stderr });
// Help writes to stdout — its own capability detection.
const out = createStyle({ argv: args });

// Explicit display order for `harness help` — mirrors the retired
// hand-written CATALOG's ordering exactly (setup, workspace, engineer loop,
// knowledge, utility; commands within each group in the same sequence).
// Grouping itself is read from each registry entry's own `group` field
// (single source of truth) — this array only controls display SEQUENCE,
// since a `Map`'s insertion order is otherwise incidental to registration
// order across files, not the curated order a human reads top to bottom.
// Exported (Minor fix) so test/harness-cli.test.mjs can assert this list
// covers exactly `listCommands()` — a command registered in
// lib/registry.mjs but never added here would otherwise vanish from
// `harness help` silently (orderedCommandEntries below just skips any name
// that doesn't resolve), with no test failure to catch the drift.
export const HELP_COMMAND_ORDER = [
  'install', 'upgrade', 'doctor', 'status', 'uninstall',
  'init-repo', 'index', 'plan-new', 'config', 'trust',
  'orient', 'gate', 'verify', 'checks', 'exec', 'bash', 'validate-plan', 'compound', 'recall', 'get', 'search', 'lookup', 'tree', 'run', 'events', 'report',
  'knowledge', 'consolidate', 'remember', 'learning', 'learnings', 'eval-knowledge',
  'resolve',
];

const GLOBAL_OPTIONS = [
  ['--version, -V', 'print the package version and exit'],
  ['--json', 'JSON output for machine readers'],
  ['--dry-run', 'print actions without writing'],
  ['--verbose, -v', 'full detail: per-file logging, all checks, unclamped hints'],
  ['--no-color', 'plain ascii output (also honors NO_COLOR; auto when piped)'],
  ['--workspace <path>', 'repo root (default: cwd)'],
  ['--copilot-home <path>', 'override ~/.copilot'],
  ['--no-events', 'do not write .harness/events.jsonl'],
];

/** `describeCommand` for every name in HELP_COMMAND_ORDER, in that order,
 * skipping anything not actually registered (defensive — every name in the
 * list above is expected to be registered; this just avoids a hard crash if
 * the two ever drift). */
function orderedCommandEntries() {
  return HELP_COMMAND_ORDER.map((name) => describeCommand(name)).filter(Boolean);
}

/** Bucket ordered entries by group, preserving first-seen group order and
 * within-group order — reproduces the retired CATALOG's exact grouping
 * without a second, separately-maintained group->commands map. */
function groupedForHelp() {
  const groups = [];
  const byGroup = new Map();
  for (const entry of orderedCommandEntries()) {
    let bucket = byGroup.get(entry.group);
    if (!bucket) {
      bucket = [];
      byGroup.set(entry.group, bucket);
      groups.push({ group: entry.group, commands: bucket });
    }
    bucket.push(entry);
  }
  return groups;
}

// Help is the front door: the same ledger grammar as every command, and it
// fits in a glance. One row per group; `harness help <command>` holds the
// job, usage, and options of each command.
function renderHelp() {
  const lines = [];
  lines.push(`harness ${out.paint('muted', '— Adaptive Engineer Harness for GitHub Copilot')}`);
  lines.push(out.paint('muted', '@dev-kit/harness · VS Code · CLI · IntelliJ'));
  lines.push('');
  lines.push(`Usage: harness ${out.paint('muted', '<command> [options]')}`);
  lines.push('');
  const groups = groupedForHelp();
  const keyWidth = keyWidthFor([...groups.map((g) => g.group), 'options'], 8);
  for (const { group, commands } of groups) {
    lines.push(
      out.line({ key: group, value: commands.map((c) => c.name).join(' · '), keyWidth })
    );
  }
  lines.push(
    out.line({
      key: 'options',
      value: GLOBAL_OPTIONS.map(([o]) => o.split(/[, ]/)[0]).join(' · '),
      keyWidth,
    })
  );
  lines.push('');
  lines.push(out.paint('muted', `${out.arrow} harness help <command>   job, usage, and options for one command`));
  lines.push(out.paint('muted', `${out.arrow} docs   @dev-kit/harness README · harness-tool-contract.md`));
  return lines.join('\n');
}

function renderCommandHelp(name) {
  const c = describeCommand(name);
  if (!c) return null;
  const lines = [];
  lines.push(`${c.name} ${out.paint('muted', `— ${c.summary}`)}`);
  lines.push('');
  lines.push(`Usage: harness ${c.name}${c.usage ? ` ${out.paint('muted', c.usage)}` : ''}`);
  if (c.options.length) {
    lines.push('');
    const optWidth = Math.max(...c.options.map(([o]) => o.length));
    for (const [opt, desc] of c.options) {
      lines.push(`  ${opt.padEnd(optWidth)}  ${out.paint('muted', desc)}`);
    }
  }
  lines.push('');
  lines.push(out.paint('muted', `${out.arrow} global options   harness help`));
  return lines.join('\n');
}

// Single error surface for both readers: the JSON envelope under --json,
// the styled error block otherwise. Keeps the two failure paths from drifting.
// Fix-wave C2: an error's message/fix frequently echoes caller input (an
// unknown command name, a bad flag value), so BOTH renderings pass through
// the shared redacting emission boundary (lib/redact.mjs) before stderr.
function emitError({ code, message, fix, exit }) {
  // Fix-wave C1: `--json` after a literal `--` is free-text content, not a
  // flag — route this check through the boundary-aware hasFlag so a
  // top-level error for `harness bogus -- --json` renders the human error
  // block, never a JSON envelope (pre-fix `args.includes('--json')` matched
  // the post-boundary token and emitted JSON).
  if (hasFlag(args, '--json')) {
    console.error(redactedJson({ ok: false, error: { code, message, hint: fix, exit } }));
  } else {
    const { redactText } = createRedactor();
    for (const l of ui.errorBlock({ code, message: redactText(message), fix: redactText(fix), exit })) console.error(l);
  }
}

// P1.2 lane flag plumbing: `--output json-envelope|agent|jsonl` (or
// `--output=...`) selects a NEW opt-in rendering (lib/envelope.mjs,
// lib/agent-lane.mjs) for registry-dispatched commands. It is parsed and
// stripped OUT of the args a registered command sees before anything else
// runs, so `--json` and every existing flag stay byte-identical for every
// command whether or not this flag exists — the pre-existing handler code
// paths never observe `--output` at all. Throws the same structured
// E_USAGE shape as every other harness usage error, caught by main()'s
// existing top-level catch — no new error-rendering path required.
//
// Honors the codebase's `--` literal-argument boundary (lib/argv.mjs:24,
// lib/registry.mjs's `validateArgs`): scanning stops at the first literal
// `--` token, so `--output` appearing after it is free-text content, not a
// flag — e.g. `orient --json -- --output agent` must keep emitting the
// legacy JSON envelope, exactly like every other flag-shaped token after `--`.
//
// P1.6: `jsonl` joins `json-envelope`/`agent` — currently exercised only by
// `verify` (AC8's streaming row-per-event lane); every other registered
// command without a `resultOf` falls through dispatch's legacy-handler path
// for `--output jsonl` exactly like it does today for an unrecognized lane
// value on a non-lane-aware entry — a no-op selector, not an error.
const OUTPUT_LANES = { 'json-envelope': 'json', agent: 'agent', jsonl: 'jsonl' };

function extractOutputLane(rawArgs) {
  let idx = -1;
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--') break; // literal-argument boundary — nothing past this is a flag
    if (rawArgs[i] === '--output' || rawArgs[i].startsWith('--output=')) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return { args: rawArgs, output: 'ledger' };

  const token = rawArgs[idx];
  const eq = token.indexOf('=');
  const hasInlineValue = eq !== -1;
  const value = hasInlineValue ? token.slice(eq + 1) : rawArgs[idx + 1];
  const consumed = hasInlineValue ? 1 : 2;
  const lane = OUTPUT_LANES[value];
  if (!lane) {
    const shown = value === undefined ? '(missing)' : JSON.stringify(value);
    throw Object.assign(new Error(`invalid --output: ${shown} — must be json-envelope, agent, or jsonl`), {
      code: 'E_USAGE',
      hint: 'harness help',
      exit: EXIT.usage,
    });
  }
  return { args: [...rawArgs.slice(0, idx), ...rawArgs.slice(idx + consumed)], output: lane };
}

// P1.5 (lib/event-registry.mjs) — "registry construction plumbing" per the
// task-5 file-ownership boundary: build the central event registry, bound to
// this invocation's resolved workspace/flags via the existing lib/events.mjs
// `writeEvent(workspace, flags, payload)` sink. `lib/registry.mjs`'s
// dispatch/dispatchLane (not this file) own WHEN an event actually gets
// emitted — this function only constructs the instance. `rawArgs` may still
// contain `--output ...`; parseFlags ignores unrecognized flags (verified:
// it silently skips both `--output` and its value token), so passing the
// pre-extraction args here is equivalent to passing the stripped ones.
function createProcessEventRegistry(rawArgs, run) {
  const flags = parseFlags(rawArgs);
  const workspace = path.resolve(flags.workspace);
  return createEventRegistry({
    run,
    writeEvent: (payload) => writeHarnessEvent(workspace, flags, payload),
  });
}

// Phase 4a (P4aAC1/P4aAC2): a run brackets one CLI invocation. The id is minted
// ONCE here, before dispatch, and threaded into the event registry so every
// event the invocation produces carries it — that is what lets `run show` join
// a command to the work it caused.
//
// Journal writes honor the same `--no-events`/`--dry-run` suppression as every
// other record, through `shouldSkipRunJournal`. A dry run performs nothing, so
// journaling it would record work that did not happen.
function shouldSkipRunJournal(flags) {
  return Boolean(flags.dryRun || flags.noEvents || process.env.HARNESS_NO_EVENTS === '1');
}

/**
 * Map a process exit code onto the run vocabulary.
 *
 * Only the codes the harness itself reserves are given a specific meaning; a
 * child's passed-through code (see `exitFor` in lib/exec-cmd.mjs) is a generic
 * failure from the journal's point of view, because the journal cannot tell
 * `exec`'s child exiting 8 from a harness timeout — the same ambiguity recorded
 * there, resolved the same way rather than guessed at differently here.
 */
function runStatusForExit(code) {
  if (code === EXIT.ok) return 'succeeded';
  if (code === EXIT.cancelled) return 'cancelled';
  if (code === EXIT.timedOut) return 'timed-out';
  if (code === EXIT.needsApproval) return 'blocked';
  if (code === EXIT.usage) return 'inconclusive';
  return 'failed';
}

/** The actor that opened this run. Mirrors the event registry's own detection
 * so a run and its events never disagree about who was driving. */
function detectRunActor() {
  if (process.env.CI || process.env.GITHUB_ACTIONS) return { kind: 'ci' };
  if (process.env.HARNESS_HOST) return { kind: 'host', host: process.env.HARNESS_HOST };
  return { kind: 'user' };
}

async function main() {
  let code = 0;
  let runId = null;
  let runStartedAt = null;
  let runWorkspacePath = null;
  let runJournalFlags = null;
  // Only a run that actually OPENED gets a terminal record; a refused
  // invocation has neither.
  let runOpened = false;
  try {
    // `--version` is universal CLI convention and was the one place the harness
    // did not honor it: the version was reachable only through `harness status`,
    // so the reflex every user has produced `unknown command: --version`.
    // `-V`, not `-v`: `-v` has always meant `--verbose` here, and quietly
    // repurposing it would break every existing caller (curl draws the same
    // line for the same reason). Handled here beside `help` because both are
    // data ABOUT the CLI rather than commands with a side-effect class, so
    // neither dispatches through the registry or writes an event.
    if (command === '--version' || command === '-V') {
      console.log(readPkgVersion());
    } else if (command === 'help' || command === '--help' || command === '-h') {
      const topic = args.find((a) => !a.startsWith('-'));
      if (topic) {
        const detail = renderCommandHelp(topic);
        if (detail) {
          console.log(detail);
        } else {
          emitError({
            code: 'E_USAGE',
            message: `unknown command: ${topic}`,
            fix: 'harness help',
            exit: EXIT.usage,
          });
          code = EXIT.usage;
        }
      } else {
        console.log(renderHelp());
      }
    } else if (command === 'palette') {
      // Same class as `help` above, and handled the same way: data ABOUT the
      // registry rather than a command with a side-effect class of its own, so
      // it is not registered and never dispatches. `help` sources its rows
      // from describeAll/describeCommand; this sources the palette index from
      // lib/command-index.mjs.
      //
      // It deliberately does NOT go through extractOutputLane. The palette has
      // exactly one audience by contract (architecture doc, §Command palette:
      // the model "never sees the palette"; a person in a shell keeps --help
      // and completion), so the envelope is its only rendering — there is no
      // ledger or agent lane to select between. Emitted through the same
      // redacting boundary every other JSON surface uses.
      const flags = parseFlags(args);
      console.log(redactedJson(commandIndexEnvelope({ workspace: path.resolve(flags.workspace) })));
    } else if (hasCommand(command)) {
      const { args: laneArgs, output } = extractOutputLane(args);
      const runFlags = parseFlags(args);
      const runWorkspace = path.resolve(runFlags.workspace);
      const journaling = !shouldSkipRunJournal(runFlags);
      runId = newRunId();
      runStartedAt = Date.now();
      runWorkspacePath = runWorkspace;
      runJournalFlags = runFlags;
      // Deferred to `ctx.onRunStart`, which lib/registry.mjs calls once the
      // command has passed validation and is about to run — see the note there.
      const openRun = () => {
        if (!journaling || runOpened) return;
        runOpened = true;
        startRun(runWorkspace, {
          run: runId,
          command,
          // The argv WITHOUT the lane flag, matching what dispatch actually
          // received — a journal that records a command the harness did not run
          // is the same class of lie as an audit that names the wrong argv.
          argv: laneArgs,
          plan: runFlags.plan || null,
          host: runFlags.host || process.env.HARNESS_HOST || 'harness-cli',
          actor: detectRunActor(),
          harnessVersion: readPkgVersion(),
        });
      };
      // P1.6 (carry-list, AC7 widening): the event registry now attaches for
      // EVERY registered-command dispatch, not just the envelope/agent
      // lanes — command.result telemetry (including verify's Ctrl-C
      // cancellation -> exit 130 -> result:'warn' per legacyResultForStatus,
      // AC8) must exist on the plain ledger/--json path too, not only under
      // --output. lib/registry.mjs's dispatch/dispatchLane wire both
      // branches identically whenever ctx.events is present; the earlier
      // ledger-only exclusion existed solely to keep one now-updated
      // test/harness-cli.test.mjs assertion's exact events array stable.
      const events = createProcessEventRegistry(args, runId);
      // Ctrl-C -> AbortSignal bridge (AC8), scoped to `verify` only: every
      // other command keeps Node's default SIGINT behavior (immediate
      // process exit) rather than risk a hang for a command whose handler
      // never reads ctx.signal.
      let signal;
      if (['verify', 'exec', 'bash', 'checks'].includes(command)) {
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        signal = controller.signal;
      }
      code = await dispatchRegistered([command, ...laneArgs], { style: out, output, events, signal, onRunStart: openRun });
    } else {
      emitError({
        code: 'E_USAGE',
        message: `unknown command: ${command}`,
        fix: 'harness help',
        exit: EXIT.usage,
      });
      code = EXIT.usage;
    }
  } catch (err) {
    const exit = Number.isInteger(err.exit) ? err.exit : 1;
    emitError({ code: err.code || 'E_UNEXPECTED', message: err.message, fix: err.hint, exit });
    // Fix-wave P1 (human/debug output leaks): the sanitized error block above
    // must NOT be followed by an unredacted raw dump. A thrown error's stack
    // embeds its message (which routinely echoes caller input) and can surface
    // env-derived secrets in frames — route the whole HARNESS_DEBUG dump
    // through the redactor, same guarantee as every other emission boundary.
    if (process.env.HARNESS_DEBUG) {
      const { redactText } = createRedactor();
      console.error(redactText(inspect(err)));
    }
    code = exit;
  }
  // Close the run on EVERY path out of the try, success and error alike. A
  // journal whose terminal records only appear when nothing went wrong would
  // leave exactly the runs an operator cares about looking like they never
  // finished. A failure to journal is swallowed: the command's own outcome is
  // the answer the caller is waiting for, and losing it to a bookkeeping error
  // would be a worse trade than an incomplete journal.
  if (runOpened && runId && runWorkspacePath && !shouldSkipRunJournal(runJournalFlags || {})) {
    try {
      finishRun(runWorkspacePath, {
        run: runId,
        status: runStatusForExit(code),
        exitCode: code,
        durationMs: runStartedAt === null ? null : Date.now() - runStartedAt,
        plan: runJournalFlags?.plan || null,
      });
    } catch {
      /* the command's outcome matters more than the bookkeeping */
    }
  }
  // Fix-wave P2 (JSONL backpressure): flush buffered stdout/stderr before the
  // hard exit. `process.exit` does not wait for async pipe writes, so a
  // terminal JSONL `result` row (or any tail of streamed output) written under
  // backpressure could be discarded — drain first so it is never lost.
  await flushStreams();
  process.exit(code);
}

/** Resolve once a writable stream's buffered bytes have been handed to the OS
 * — the reliable "drained" signal to wait on before a hard process.exit. */
function flushStream(stream) {
  return new Promise((resolve) => {
    if (!stream || typeof stream.write !== 'function' || stream.writableLength === 0) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    // The empty-write callback fires after the preceding buffered bytes flush.
    try {
      stream.write('', finish);
    } catch {
      finish();
      return;
    }
    // Safety valve: never let a stuck pipe hang the CLI. Unref'd so the timer
    // itself can't keep the process alive past the drain.
    const t = setTimeout(finish, 2000);
    t.unref?.();
  });
}

function flushStreams() {
  return Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
}

// Only auto-run when this file is executed directly (`node bin/harness.mjs
// ...`, the shebang, or any of the harness/global-bin install paths that
// all invoke it the same way) — not when imported as a module (Minor fix:
// test/harness-cli.test.mjs imports HELP_COMMAND_ORDER above). Every real
// invocation still sets `process.argv[1]` to this file's own path, so this
// guard is a no-op for every existing production entry point.
//
// `fs.realpathSync` on `process.argv[1]` before the comparison matters: the
// ESM loader resolves `import.meta.url` through any symlinks in the path
// (e.g. macOS's `/tmp` -> `/private/tmp`, `/var` -> `/private/var`, both
// routinely on the resolved path when the CLI is invoked via a copied
// runtime under `os.tmpdir()` — lib/install-harness-bin.mjs's own copy
// target in test/production), while `process.argv[1]` is the raw,
// unresolved argv string — a bare string comparison between the two
// mismatches on any such symlinked path even though this genuinely IS the
// entry module, which silently skipped `main()` entirely (reproduced: the
// installed global harness shim ran with exit 0 and empty stdout).
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
