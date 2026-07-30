#!/usr/bin/env node
/**
 * harness — install Adaptive Engineer Harness into global Copilot paths.
 * The npm package name is @dev-kit/harness; the command users and agents run is harness.
 */
import {
  cmdInstallOrUpgrade,
  cmdDoctor,
  cmdStatus,
  cmdInitRepo,
  cmdIndex,
  cmdOrient,
  cmdGate,
  cmdVerify,
  cmdRecall,
  cmdEvents,
  cmdValidatePlan,
  cmdCompound,
  cmdConsolidate,
  cmdRemember,
  cmdLearning,
  cmdLearnings,
  cmdEvalKnowledge,
  cmdKnowledge,
  cmdGet,
  cmdUninstall,
  cmdResolve,
  cmdReport,
} from '../lib/commands.mjs';
import { cmdPlanNew } from '../lib/plan-new.mjs';
import { createStyle, keyWidthFor, EXIT } from '../lib/style.mjs';

const [, , command = 'help', ...args] = process.argv;
// This renderer only writes error blocks, which go to stderr — detect there.
const ui = createStyle({ argv: args, stream: process.stderr });
// Help writes to stdout — its own capability detection.
const out = createStyle({ argv: args });

// The catalog: every command with its group, one-line job, usage signature,
// and its own options. The overview shows groups and jobs; signatures and
// options disclose progressively via `harness help <command>`.
const GLOBAL_OPTIONS = [
  ['--json', 'JSON output for machine readers'],
  ['--dry-run', 'print actions without writing'],
  ['--verbose, -v', 'full detail: per-file logging, all checks, unclamped hints'],
  ['--no-color', 'plain ascii output (also honors NO_COLOR; auto when piped)'],
  ['--workspace <path>', 'repo root (default: cwd)'],
  ['--copilot-home <path>', 'override ~/.copilot'],
  ['--no-events', 'do not write .harness/events.jsonl'],
];

const CATALOG = [
  {
    group: 'setup',
    commands: [
      { name: 'install', desc: 'hydrate skills, agents, and team knowledge globally',
        sig: '[--configure-vscode] [--configure-path] [--target vscode,cli,intellij]',
        options: [
          ['--target <t,..>', 'vscode,cli,intellij'],
          ['--autonomy <mode>', 'full | balanced | strict'],
          ['--configure-vscode', 'merge VS Code chat.* discovery settings'],
          ['--configure-path', 'append ~/.copilot/bin to shell PATH (~/.zshrc, ~/.bashrc)'],
          ['--force-profile', 'overwrite knowledge/profile.md'],
          ['--force-knowledge-reset', 'overwrite knowledge/solutions (danger)'],
        ] },
      { name: 'upgrade', desc: 're-hydrate and purge retired primitives',
        sig: '[same options as install]',
        options: [] },
      { name: 'doctor', desc: 'health checks for install, hooks, and knowledge',
        sig: '[--host vscode]',
        options: [['--host <name>', 'run host-specific checks (vscode executes installed-hook probes)']] },
      { name: 'status', desc: 'installed version, home, tracked files', sig: '', options: [] },
      { name: 'uninstall', desc: 'remove hydrated files tracked by the lock', sig: '', options: [] },
    ],
  },
  {
    group: 'workspace',
    commands: [
      { name: 'init-repo', desc: 'seed the .harness workspace in a product repo', sig: '', options: [] },
      { name: 'index', desc: 'rebuild knowledge index · --status reports drift',
        sig: '[--status]',
        options: [['--status', 'read-only freshness report vs HEAD (never rebuilds)']] },
      { name: 'plan-new', desc: 'scaffold a gate-ready plan',
        sig: '--type feat --slug <slug> --intent "..."',
        options: [
          ['--type <t>', 'feat|fix|docs|refactor|chore'],
          ['--slug <s>', 'lowercase-hyphen slug'],
          ['--intent <text>', 'one-line intent'],
          ['--impacted <a,b>', 'comma-separated Impacted Files'],
          ['--criteria <text>', 'an acceptance criterion (repeatable)'],
          ['--gap <id>:<path>', 'capability gap → blocked-capability + governed primitive plan'],
          ['--stdout', 'print the plan instead of writing it'],
        ] },
    ],
  },
  {
    group: 'engineer loop',
    commands: [
      { name: 'orient', desc: 'context pack for a task',
        sig: '[--query "task summary"]',
        options: [
          ['--query <text>', 'agent/internal task summary'],
          ['--limit <n>', 'recall result count (default 3)'],
          ['-c, --collection <name>', 'filter by knowledge/collections.yaml'],
          ['--min-score <n>', 'minimum score (default 0.15)'],
          ['--explain', 'decompose learning ranking (deterministic)'],
        ] },
      { name: 'gate', desc: 'edit preconditions before editFiles',
        sig: '[--phase implement|verify] [--plan <path>]',
        options: [
          ['--phase <name>', 'implement | verify'],
          ['--plan <path>', 'explicit plan file'],
          ['--strict-intent', 'fail locked plans missing intent fields'],
          ['--enforcement <mode>', 'observe | warn | enforce (default enforce)'],
        ] },
      { name: 'verify', desc: 'run trusted named checks and capture evidence',
        sig: '--plan docs/plans/file.md',
        options: [
          ['--plan <path>', 'plan file whose named checks run'],
          ['--base <git-ref>', 'compare changed files to this git ref'],
          ['--enforcement <mode>', 'observe | warn | enforce (default enforce)'],
        ] },
      { name: 'validate-plan', desc: 'plan readiness checks',
        sig: '[--plan docs/plans/file.md]',
        options: [
          ['--plan <path>', 'explicit plan file'],
          ['--enforcement <mode>', 'observe | warn | enforce (default enforce)'],
        ] },
      { name: 'compound', desc: 'record learning from passed evidence · --insight captures without evidence',
        sig: '[--plan <path>] [--insight --title "..." --body "..."]',
        options: [
          ['--plan <path>', 'explicit plan file'],
          ['--insight', 'evidence-free investigation capture (kind: insight, secret-scanned)'],
          ['--title <t>', 'insight title (required with --insight)'],
          ['--body <text>', 'insight body text'],
          ['--body-file <path>', 'read insight body from a file'],
          ['--category <c>', 'docs/solutions/<category>/ (default insights)'],
          ['--tags <a,b>', 'comma-separated tags'],
          ['--trigger <t>', 'applicability condition frontmatter'],
          ['--claim <t>', 'one-line claim frontmatter'],
        ] },
      { name: 'recall', desc: 'search team knowledge',
        sig: '"search terms" [--limit <n>] [--include-plans]',
        options: [
          ['--limit <n>', 'result count (default 3)'],
          ['-c, --collection <name>', 'filter by knowledge/collections.yaml'],
          ['--min-score <n>', 'minimum score (default 0.15)'],
          ['--include-plans', 'include matching plans'],
        ] },
      { name: 'get', desc: 'bounded doc excerpt',
        sig: '[--docid <id> | --path <rel>]',
        options: [
          ['--docid <id>', 'manifest doc id'],
          ['--path <rel>', 'relative file path'],
          ['--lines <n>', 'max lines (default 40)'],
          ['--max-bytes <n>', 'max excerpt bytes (default 2048)'],
        ] },
      { name: 'events', desc: 'session telemetry',
        sig: '[--summary] [--failures] [--session <id>]',
        options: [
          ['--session <id>', 'filter by host session ID'],
          ['--summary', 'aggregate summary only'],
          ['--failures', 'failed or blocked events only'],
          ['--limit <n>', 'event count (default 20)'],
        ] },
      { name: 'report', desc: 'token-efficiency report from telemetry',
        // AC14: harness report [--sync] [--global] [--check] [--json] stays documented.
        sig: '[--sync] [--global] [--check] [--json]',
        options: [
          ['--sync', 'merge workspace events into the global store first'],
          ['--global', 'report across all synced workspaces'],
          ['--check', 'exit non-zero on a budget breach (CI)'],
        ] },
    ],
  },
  {
    group: 'knowledge',
    commands: [
      { name: 'knowledge', desc: 'knowledge layer mode switch and purge (human deletion always wins)',
        sig: '<on|suggest|off|freeze|capture-only> | --status | purge <file|--all> | commit <none|repo> | migrate-store',
        options: [
          ['--status', 'show the active mode (default)'],
          ['purge <file>', 'cascade-delete an episode and dependent learnings'],
          ['purge --all', 'reset the learnings store (episodes remain, become debt)'],
          ['commit <none|repo>', 'repo mirrors ACTIVE learnings into docs/knowledge/learnings (opt-in, never git-commits the product repo); none is the default'],
          ['migrate-store', 'move a stranded path-keyed store to this workspace\'s current (remote-keyed) store id; refuses if the target already exists'],
        ] },
      { name: 'consolidate', desc: 'episode→learning debt, work packet, and validated apply',
        sig: '[--status | --candidates | --apply --ops <path> | --rebuild --yes]',
        options: [
          ['--status', 'debt vs threshold, quarantine, promotion candidates (default)'],
          ['--candidates', 'deterministic work packet for the consolidation skill'],
          ['--apply --ops <path>', 'validate and apply an ops JSON (sole writer); suggest mode requires --yes'],
          ['--rebuild --yes', 'T2 reset for model-upgrade regeneration (git history retains learnings)'],
        ] },
      { name: 'remember', desc: 'teach the harness a durable claim (human-teaching episode + learning)',
        sig: '"<claim>" --trigger "<t>" [--domain <d>]',
        options: [
          ['--trigger <t>', 'applicability condition (required)'],
          ['--domain <d>', 'learning domain directory (default general)'],
        ] },
      { name: 'learning', desc: 'human authority over one learning: retire, dispute, confirm, or promote',
        sig: '<retire|dispute|confirm|promote> <id> [--reason "<r>"] [--to <path>]',
        options: [
          ['--reason <r>', 'required for retire/dispute; recorded in the store commit'],
          ['--to <path>', 'primitive path recorded on promote (behavior supersedes knowledge)'],
        ] },
      { name: 'learnings', desc: 'paged listing of learnings with provenance and failure annotations',
        sig: '[domain] [--why <id>]',
        options: [
          ['--why <id>', 'full provenance chain for one learning'],
        ] },
      { name: 'eval-knowledge', desc: 'deterministic retrieval eval — hit/false-surface/token cost per arm (proxy, not net-benefit)',
        sig: '[--json]',
        options: [] },
    ],
  },
  {
    group: 'utility',
    commands: [
      { name: 'resolve', desc: 'print the resolved harness CLI path for agents', sig: '', options: [] },
    ],
  },
];

const ALL_COMMANDS = CATALOG.flatMap((g) => g.commands);

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
  const keyWidth = keyWidthFor([...CATALOG.map((g) => g.group), 'options'], 8);
  for (const { group, commands } of CATALOG) {
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
  const c = ALL_COMMANDS.find((x) => x.name === name);
  if (!c) return null;
  const lines = [];
  lines.push(`${c.name} ${out.paint('muted', `— ${c.desc}`)}`);
  lines.push('');
  lines.push(`Usage: harness ${c.name}${c.sig ? ` ${out.paint('muted', c.sig)}` : ''}`);
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

async function main() {
  let code = 0;
  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h': {
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
        break;
      }
      case 'install':
        code = await cmdInstallOrUpgrade('install', args);
        break;
      case 'upgrade':
        code = await cmdInstallOrUpgrade('upgrade', args);
        break;
      case 'doctor':
        code = await cmdDoctor(args);
        break;
      case 'status':
        code = await cmdStatus(args);
        break;
      case 'init-repo':
        code = await cmdInitRepo(args);
        break;
      case 'index':
        code = await cmdIndex(args);
        break;
      case 'plan-new':
        code = await cmdPlanNew(args);
        break;
      case 'orient':
        code = await cmdOrient(args);
        break;
      case 'gate':
        code = await cmdGate(args);
        break;
      case 'verify':
        code = await cmdVerify(args);
        break;
      case 'recall':
        code = await cmdRecall(args);
        break;
      case 'get':
        code = await cmdGet(args);
        break;
      case 'validate-plan':
        code = await cmdValidatePlan(args);
        break;
      case 'compound':
        code = await cmdCompound(args);
        break;
      case 'consolidate':
        code = await cmdConsolidate(args);
        break;
      case 'remember':
        code = await cmdRemember(args);
        break;
      case 'learning':
        code = await cmdLearning(args);
        break;
      case 'learnings':
        code = await cmdLearnings(args);
        break;
      case 'eval-knowledge':
        code = await cmdEvalKnowledge(args);
        break;
      case 'knowledge':
        code = await cmdKnowledge(args);
        break;
      case 'events':
        code = await cmdEvents(args);
        break;
      case 'report':
        code = await cmdReport(args);
        break;
      case 'uninstall':
        code = await cmdUninstall(args);
        break;
      case 'resolve':
        code = await cmdResolve(args);
        break;
      default:
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
