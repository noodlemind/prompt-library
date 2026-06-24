#!/usr/bin/env node
/**
 * @dev-kit/harness — install Adaptive Engineer Harness into global Copilot paths.
 */
import {
  cmdInstallOrUpgrade,
  cmdDoctor,
  cmdStatus,
  cmdInitRepo,
  cmdIndex,
  cmdOrient,
  cmdGate,
  cmdRecall,
  cmdEvents,
  cmdValidatePlan,
  cmdCompound,
  cmdGet,
  cmdUninstall,
  cmdResolve,
} from '../lib/commands.mjs';

const [, , command = 'help', ...args] = process.argv;

const HELP = `
@dev-kit/harness — Adaptive Engineer Harness for GitHub Copilot (VS Code, CLI, IntelliJ)

Usage:
  npx @dev-kit/harness install [options]
  npx @dev-kit/harness upgrade [options]
  npx @dev-kit/harness doctor [options]
  npx @dev-kit/harness status [options]
  npx @dev-kit/harness index [options]
  npx @dev-kit/harness orient [options] [--query "task summary"]
  npx @dev-kit/harness gate [options] [--phase implement|verify]
  npx @dev-kit/harness recall "search terms" [options]
  npx @dev-kit/harness get [options] [--docid id | --path rel/path]
  npx @dev-kit/harness validate-plan [options] [--plan docs/plans/file.md]
  npx @dev-kit/harness compound [options]
  npx @dev-kit/harness events [options]
  npx @dev-kit/harness init-repo [options]
  npx @dev-kit/harness resolve [options]   Print resolved harness CLI path for agents
  npx @dev-kit/harness uninstall [options]

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
  --plan <path>          validate-plan: specific plan file
  --no-events            Do not write .harness/events.jsonl

Docs: docs/architecture/tool-native-harness-design.md
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
      case 'orient':
        code = await cmdOrient(args);
        break;
      case 'gate':
        code = await cmdGate(args);
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
