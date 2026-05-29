#!/usr/bin/env node
/**
 * harness — install Adaptive Engineer Harness into global Copilot paths.
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
} from '../lib/commands.mjs';
import { printGuide } from '../lib/guide.mjs';
import { printHelp } from '../lib/help.mjs';

const [, , rawCommand, ...args] = process.argv;
const command = rawCommand ?? 'guide';

async function main() {
  let code = 0;
  try {
    switch (command) {
      case 'guide':
      case 'getting-started':
      case 'start':
        printGuide();
        break;
      case 'chronicle':
        printGuide({ section: 'chronicle' });
        break;
      case 'help':
      case '--help':
      case '-h': {
        const advanced =
          args[0] === 'advanced' || args.includes('--advanced') || args.includes('advanced');
        printHelp(advanced ? 'advanced' : 'commands');
        break;
      }
      case 'setup':
        code = await cmdInstallOrUpgrade('setup', args);
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
        console.error('Run harness or harness getting-started for the onboarding guide.\n');
        printHelp('commands');
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
