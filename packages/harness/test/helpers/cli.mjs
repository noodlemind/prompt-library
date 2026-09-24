/**
 * Shared harness CLI spawn helper.
 *
 * Semantics match the historical harness-cli.test.mjs runHarness:
 * - auto-injects --copilot-home when --workspace is present and home is missing
 * - auto-approves trust unless options.trust === false
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { approveTrust } from './trust.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

/** One temp harness root per test process, so index and recall share it without touching ~/.harness. */
let sharedHarnessHome;
export function cliHarnessHome() {
  if (!sharedHarnessHome) sharedHarnessHome = tempDir('harness-data-');
  return sharedHarnessHome;
}

/** Read a flag's value out of an argv, honoring `--flag=value`. */
export function valueOf(argv, name) {
  const eq = argv.find((a) => typeof a === 'string' && a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
}

/**
 * @param {string[]} args
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   trust?: boolean,
 *   injectHome?: boolean,
 *   encoding?: string | null,
 * }} [options]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function runHarness(args, options = {}) {
  const full = [...args];
  const workspace = valueOf(full, '--workspace');
  let copilotHome = valueOf(full, '--copilot-home');
  const injectHome = options.injectHome !== false;
  if (injectHome && !copilotHome && workspace) {
    copilotHome = tempDir('harness-home-');
    full.push('--copilot-home', copilotHome);
  }
  const env = { ...process.env, ...(options.env || {}) };
  const flaggedHome = valueOf(full, '--harness-home');
  if (!options.env?.HARNESS_HOME && !flaggedHome) {
    env.HARNESS_HOME = cliHarnessHome();
  }
  if (workspace && copilotHome && options.trust !== false) {
    approveTrust({ workspace, copilotHome, home: flaggedHome || env.HARNESS_HOME });
  }
  return spawnSync(process.execPath, [binPath, ...full], {
    cwd: options.cwd || packageRoot,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    env,
  });
}

export { packageRoot, binPath };
