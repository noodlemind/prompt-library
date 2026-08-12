#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createStyle, keyWidthFor, EXIT } from '../lib/style.mjs';
import { dispatch as dispatchRegistered, hasCommand, describeCommand, getCommand } from '../lib/registry.mjs';
import { createProcessEventRegistry, detectActor } from '../lib/event-registry.mjs';
import { parseFlags, hasFlag } from '../lib/flags.mjs';
import { commandIndexEnvelope } from '../lib/command-index.mjs';
import { createRedactor, redactedJson } from '../lib/redact.mjs';
import { readPkgVersion } from '../lib/commands.mjs';
import { newRunId, startRun, finishRun, runStatusFromReported, runStatusForExit } from '../lib/run-journal.mjs';
import { setRunContext } from '../lib/run-context.mjs';

const [, , command = 'help', ...args] = process.argv;
// This renderer only writes error blocks, which go to stderr — detect there.
const ui = createStyle({ argv: args, stream: process.stderr });
// Help writes to stdout — its own capability detection.
const out = createStyle({ argv: args });

export const HELP_COMMAND_ORDER = [
  'install', 'upgrade', 'doctor', 'status', 'uninstall',
  'init-repo', 'index', 'plan-new', 'config',
  'model', 'trust', 'resources',
    'orient', 'gate', 'verify', 'checks', 'exec', 'bash', 'agent', 'validate-plan', 'compound', 'recall', 'get', 'edit', 'write', 'undo', 'search', 'lookup', 'tree', 'run', 'tui', 'events', 'report',
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
  ['--no-events', 'do not write any local record: .harness/events.jsonl or runs.jsonl'],
];

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

function emitError({ code, message, fix, exit }) {
    if (hasFlag(args, '--json')) {
    console.error(redactedJson({ ok: false, error: { code, message, hint: fix, exit } }));
  } else {
    const { redactText } = createRedactor();
    for (const l of ui.errorBlock({ code, message: redactText(message), fix: redactText(fix), exit })) console.error(l);
  }
}

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

function shouldSkipRunJournal(flags) {
  return Boolean(flags.dryRun || flags.noEvents || process.env.HARNESS_NO_EVENTS === '1');
}

async function main() {
  let code = 0;
  let runId = null;
  let runStartedAt = null;
  let runWorkspacePath = null;
  let runJournalFlags = null;
    let runOpened = false;
  // What the command said happened, if it said. Preferred over the exit map.
  let reportedStatus = null;
  try {
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
            const flags = parseFlags(args);
      console.log(redactedJson(commandIndexEnvelope({ workspace: path.resolve(flags.workspace) })));
    } else if (hasCommand(command)) {
      const { args: laneArgs, output } = extractOutputLane(args);
      const runFlags = parseFlags(args);
      const runWorkspace = path.resolve(runFlags.workspace);
      const journaling = !shouldSkipRunJournal(runFlags);
      runId = newRunId();
      runStartedAt = Date.now();
            setRunContext({ run: runId, actor: detectActor() });
      runWorkspacePath = runWorkspace;
      runJournalFlags = runFlags;
            const openRun = () => {
        if (!journaling || runOpened) return;
        runOpened = true;
        startRun(runWorkspace, {
          run: runId,
          command,
                    argv: getCommand(command)?.journalArgv?.(laneArgs) ?? laneArgs,
                    plan: command === 'run' ? null : (runFlags.plan || null),
          host: process.env.HARNESS_HOST || 'harness-cli',
          actor: detectActor(),
          harnessVersion: readPkgVersion(),
          // So run retention resolves the same configuration event retention does.
          flags: runFlags,
        });
      };
            const events = createProcessEventRegistry(args, runId);
            let signal;
            if (['verify', 'exec', 'bash', 'checks', 'agent'].includes(command)) {
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        signal = controller.signal;
      }
      code = await dispatchRegistered([command, ...laneArgs], {
        style: out,
        output,
        events,
        signal,
        onRunStart: openRun,
                reportStatus: (status) => { reportedStatus = status; },
      });
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
        if (process.env.HARNESS_DEBUG) {
      const { redactText } = createRedactor();
      console.error(redactText(inspect(err)));
    }
    code = exit;
  }
    if (runOpened && runId && runWorkspacePath && !shouldSkipRunJournal(runJournalFlags || {})) {
    try {
      finishRun(runWorkspacePath, {
        run: runId,
        status: runStatusFromReported(reportedStatus) ?? runStatusForExit(code),
        exitCode: code,
        durationMs: runStartedAt === null ? null : Date.now() - runStartedAt,
        plan: command === 'run' ? null : (runJournalFlags?.plan || null),
        flags: runJournalFlags || {},
      });
    } catch {
      /* the command's outcome matters more than the bookkeeping */
    }
  }
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
        const t = setTimeout(finish, 2000);
    t.unref?.();
  });
}

function flushStreams() {
  return Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
}

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
