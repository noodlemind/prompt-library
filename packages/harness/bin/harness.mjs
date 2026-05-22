#!/usr/bin/env node
/**
 * @dev-kit/harness CLI — Phase 1 stub.
 * Full install/upgrade/doctor: docs/architecture/npm-harness-distribution-plan.md
 */
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const [, , command = 'help', ...args] = process.argv;

const HELP = `
@dev-kit/harness — Adaptive Engineer Harness installer

Usage:
  npx @dev-kit/harness install [--dry-run] [--autonomy balanced|full|strict]
  npx @dev-kit/harness upgrade
  npx @dev-kit/harness doctor
  npx @dev-kit/harness status

Package root: ${pkgRoot}
Assets: ${path.join(pkgRoot, 'assets')} (run npm run build:assets before publish)

Implementation in progress — see packages/harness and npm-harness-distribution-plan.md
`;

switch (command) {
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP.trim());
    break;
  case 'install':
  case 'upgrade':
  case 'doctor':
  case 'status':
  case 'index':
  case 'init-repo':
    console.error(
      `[harness] "${command}" is not implemented yet. Use VS Code task Hydrate or implement Phase 1 in packages/harness.`
    );
    if (args.includes('--dry-run')) {
      console.error('[harness] dry-run: no files written.');
    }
    process.exit(2);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP.trim());
    process.exit(1);
}
