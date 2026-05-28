#!/usr/bin/env node
/**
 * @dev-kit/harness — install Adaptive Engineer Harness into global Copilot paths.
 */
import { CLI_BIN, PACKAGE_NAME } from '../lib/cli-hints.mjs';
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
} from '../lib/commands.mjs';

const [, , command = 'help', ...args] = process.argv;

const HELP = `
${PACKAGE_NAME} — Adaptive Engineer Harness for GitHub Copilot (VS Code, CLI, IntelliJ)

Usage (binary: ${CLI_BIN}):
  harness install [options]
  harness upgrade [options]
  harness doctor [options]
  harness status [options]
  harness index [options]
  harness orient [options] [--query "task summary"]
  harness gate [options] [--phase implement|verify]
  harness recall "search terms" [options]
  harness get [options] [--docid id | --path rel/path]
  harness validate-plan [options] [--plan docs/plans/file.md]
  harness compound [options]
  harness events [options]
  harness init-repo [options]
  harness uninstall [options]

Install without publishing:
  npm run harness:install     (from prompt-library repo root)
  npm link && harness install (after: cd packages/harness && npm run build:assets)

Registry install (when published):
  npx ${PACKAGE_NAME} install

Options:
  --dry-run              Print actions without writing
  --verbose, -v          Per-file logging
  --json                 JSON output
  --copilot-home <path>  Override ~/.copilot
  --target vscode,cli,intellij
  --autonomy full|balanced|strict
  --configure-vscode     Merge VS Code chat.* discovery settings
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
