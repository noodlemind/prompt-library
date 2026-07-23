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
  cmdGet,
  cmdUninstall,
  cmdResolve,
  cmdReport,
} from '../lib/commands.mjs';
import { cmdPlanNew } from '../lib/plan-new.mjs';

const [, , command = 'help', ...args] = process.argv;

const HELP = `
harness — Adaptive Engineer Harness for GitHub Copilot (VS Code, CLI, IntelliJ)

Package name: @dev-kit/harness. Command name: harness.

Usage:
  harness install [options]
  harness upgrade [options]
  harness doctor [options]
  harness status [options]
  harness index [options]           Rebuild knowledge index (stamps HEAD)
  harness index --status            Report knowledge-index freshness vs HEAD (read-only)
  harness plan-new --type feat --slug <slug> --intent "..." [options]   Scaffold a gate-ready plan
  harness orient [options] [--query "task summary"]
  harness gate [options] [--phase implement|verify]
  harness verify [options] --plan docs/plans/file.md
  harness recall "search terms" [options]
  harness get [options] [--docid id | --path rel/path]
  harness validate-plan [options] [--plan docs/plans/file.md]
  harness compound [options]
  harness events [options]
  harness report [--sync] [--global] [--check] [--json]   Token-efficiency report from telemetry
  harness init-repo [options]
  harness resolve [options]   Print resolved harness CLI path for agents
  harness uninstall [options]

Install the command:
  npm install -g @dev-kit/harness@latest
  # or from a prompt-library clone before publishing:
  npm install -g ./packages/harness
  # shim at ~/.copilot/bin/harness after harness install; add PATH: harness install --configure-path

Options:
  --dry-run              Print actions without writing
  --verbose, -v          Per-file logging
  --json                 JSON output
  --copilot-home <path>  Override ~/.copilot
  --target vscode,cli,intellij
  --autonomy full|balanced|strict
  --configure-vscode     Merge VS Code chat.* discovery settings
  --configure-path       Append ~/.copilot/bin to shell PATH (~/.zshrc, ~/.bashrc)
  --force-profile        Overwrite knowledge/profile.md
  --force-knowledge-reset  Overwrite knowledge/solutions (danger)
  --workspace <path>     Repo root (default: cwd)
  --query <text>         Agent/internal task summary for orient
  --type <t>             plan-new: feat|fix|docs|refactor|chore
  --slug <s>             plan-new: lowercase-hyphen slug
  --intent <text>        plan-new: one-line intent
  --impacted <a,b>       plan-new: comma-separated Impacted Files
  --criteria <text>      plan-new: an acceptance criterion (repeatable)
  --gap <id>:<path>      plan-new: capability gap → blocked-capability + governed primitive plan
  --stdout               plan-new: print the plan instead of writing it
  --phase <name>         gate: implement | verify
  --strict-intent        gate: fail locked plans missing intent fields
  --limit <n>            recall/orient result count (default 3)
  -c, --collection <name>  recall/orient: filter by knowledge/collections.yaml
  --min-score <n>        recall/orient minimum score (default 0.15)
  --include-plans        recall: include matching plans
  --docid <id>           get: manifest doc id
  --path <rel>           get: relative file path
  --lines <n>            get: max lines (default 40)
  --max-bytes <n>        get: max excerpt bytes (default 2048)
  --plan <path>          gate/verify/validate-plan/compound: explicit plan file
  --base <git-ref>       verify: compare changed files to this git ref
  --enforcement <mode>   observe | warn | enforce (default enforce)
  --no-events            Do not write .harness/events.jsonl
  --host <name>           doctor: run host-specific checks (vscode)
  --session <id>          events: filter by host session ID
  --summary               events: print aggregate summary only
  --failures              events: show failed or blocked events only

Docs: @dev-kit/harness README and the hydrated harness-tool-contract.md reference
`.trim();

async function main() {
  let code = 0;
  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        break;
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
        console.error(`Unknown command: ${command}\n`);
        console.log(HELP);
        code = 1;
    }
  } catch (err) {
    console.error(`[harness] ${err.message}`);
    if (process.env.HARNESS_DEBUG) console.error(err);
    code = 1;
  }
  process.exit(code);
}

main();
