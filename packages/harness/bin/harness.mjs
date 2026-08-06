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
import path from 'node:path';
import { createStyle, keyWidthFor, EXIT } from '../lib/style.mjs';
import { dispatch as dispatchRegistered, hasCommand, describeCommand } from '../lib/registry.mjs';
import { createEventRegistry } from '../lib/event-registry.mjs';
import { writeEvent as writeHarnessEvent } from '../lib/events.mjs';
import { parseFlags } from '../lib/flags.mjs';

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
const HELP_COMMAND_ORDER = [
  'install', 'upgrade', 'doctor', 'status', 'uninstall',
  'init-repo', 'index', 'plan-new',
  'orient', 'gate', 'verify', 'validate-plan', 'compound', 'recall', 'get', 'events', 'report',
  'knowledge', 'consolidate', 'remember', 'learning', 'learnings', 'eval-knowledge',
  'resolve',
];

const GLOBAL_OPTIONS = [
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
function emitError({ code, message, fix, exit }) {
  if (args.includes('--json')) {
    console.error(JSON.stringify({ ok: false, error: { code, message, hint: fix, exit } }));
  } else {
    for (const l of ui.errorBlock({ code, message, fix, exit })) console.error(l);
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
function createProcessEventRegistry(rawArgs) {
  const flags = parseFlags(rawArgs);
  const workspace = path.resolve(flags.workspace);
  return createEventRegistry({
    writeEvent: (payload) => writeHarnessEvent(workspace, flags, payload),
  });
}

async function main() {
  let code = 0;
  try {
    if (command === 'help' || command === '--help' || command === '-h') {
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
    } else if (hasCommand(command)) {
      const { args: laneArgs, output } = extractOutputLane(args);
      // P1.6 (carry-list, AC7 widening): the event registry now attaches for
      // EVERY registered-command dispatch, not just the envelope/agent
      // lanes — command.result telemetry (including verify's Ctrl-C
      // cancellation -> exit 130 -> result:'warn' per legacyResultForStatus,
      // AC8) must exist on the plain ledger/--json path too, not only under
      // --output. lib/registry.mjs's dispatch/dispatchLane wire both
      // branches identically whenever ctx.events is present; the earlier
      // ledger-only exclusion existed solely to keep one now-updated
      // test/harness-cli.test.mjs assertion's exact events array stable.
      const events = createProcessEventRegistry(args);
      // Ctrl-C -> AbortSignal bridge (AC8), scoped to `verify` only: every
      // other command keeps Node's default SIGINT behavior (immediate
      // process exit) rather than risk a hang for a command whose handler
      // never reads ctx.signal.
      let signal;
      if (command === 'verify') {
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        signal = controller.signal;
      }
      code = await dispatchRegistered([command, ...laneArgs], { style: out, output, events, signal });
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
    if (process.env.HARNESS_DEBUG) console.error(err);
    code = exit;
  }
  process.exit(code);
}

main();
