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
  cmdUninstall,
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
  npx @dev-kit/harness init-repo [options]
  npx @dev-kit/harness uninstall [options]

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
  --workspace <path>     For init-repo / index (default: cwd)

Docs: docs/onboarding/nexus-registry-setup.md
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
