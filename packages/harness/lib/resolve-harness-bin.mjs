import fs from 'fs';
import os from 'os';
import path from 'path';
import { findHarnessOnPath, globalHarnessShimPath, INSTALL_FIX_HINT } from './global-bin.mjs';

const HARNESS_REL = path.join('packages', 'harness', 'bin', 'harness.mjs');
const NM_REL = path.join('node_modules', '@dev-kit', 'harness', 'bin', 'harness.mjs');

export function resolveHarnessBin({ workspace = process.cwd(), copilotHome } = {}) {
  const tried = [];
  const home = copilotHome || path.join(os.homedir(), '.copilot');

  if (process.env.HARNESS_BIN) {
    const envBin = path.resolve(process.env.HARNESS_BIN);
    tried.push({ source: 'HARNESS_BIN', path: envBin });
    if (fs.existsSync(envBin)) {
      return { bin: envBin, source: 'HARNESS_BIN', tried, globalShim: null, onPath: false };
    }
  }

  const shim = globalHarnessShimPath(home);
  tried.push({ source: 'global-shim', path: shim });
  if (fs.existsSync(shim)) {
    const onPath = findHarnessOnPath() === shim;
    return { bin: shim, source: 'global-shim', tried, globalShim: shim, onPath };
  }

  const globalBin = path.join(home, '.harness-bin', 'bin', 'harness.mjs');
  tried.push({ source: 'global-runtime', path: globalBin });
  if (fs.existsSync(globalBin)) {
    return { bin: globalBin, source: 'global-runtime', tried, globalShim: null, onPath: false };
  }

  const pathHarness = findHarnessOnPath();
  if (pathHarness && fs.existsSync(pathHarness)) {
    tried.push({ source: 'path', path: pathHarness });
    return {
      bin: pathHarness,
      source: 'path',
      tried,
      globalShim: pathHarness,
      onPath: true,
    };
  }

  let dir = path.resolve(workspace);
  for (let depth = 0; depth < 12; depth++) {
    const monorepo = path.join(dir, HARNESS_REL);
    tried.push({ source: 'monorepo', path: monorepo });
    if (fs.existsSync(monorepo)) {
      return { bin: monorepo, source: 'monorepo', tried, globalShim: null, onPath: false };
    }

    const nm = path.join(dir, NM_REL);
    tried.push({ source: 'node_modules', path: nm });
    if (fs.existsSync(nm)) {
      return { bin: nm, source: 'node_modules', tried, globalShim: null, onPath: false };
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { bin: null, source: null, tried, globalShim: null, onPath: false };
}

/** Preferred agent invocation string (global, works from any cwd). */
export function agentHarnessCommand(resolved) {
  if (!resolved.bin) return null;
  if (resolved.onPath) return 'harness';
  if (resolved.source === 'global-shim') return `node "${resolved.bin}"`;
  if (resolved.globalShim && fs.existsSync(resolved.globalShim)) {
    return `node "${resolved.globalShim}"`;
  }
  return `node "${resolved.bin}"`;
}

export const RUNNER_VERSION = 5;

export function harnessRunnerSource() {
  const home = os.homedir().replace(/\\/g, '/');
  return `#!/usr/bin/env node
/**
 * Workspace harness runner — delegates to globally installed harness.
 * @harness-runner-version ${RUNNER_VERSION}
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(__dirname, '..');
const COPILOT_HOME = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');

function whichHarness() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['harness'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout?.trim()) return r.stdout.trim().split(/\\r?\\n/)[0].trim();
  return null;
}

function resolveTarget() {
  if (process.env.HARNESS_BIN && fs.existsSync(process.env.HARNESS_BIN)) {
    return { cmd: process.execPath, args: [process.env.HARNESS_BIN], mode: 'HARNESS_BIN' };
  }
  const shim = path.join(COPILOT_HOME, 'bin', 'harness');
  if (fs.existsSync(shim)) return { cmd: process.execPath, args: [shim], mode: 'global-shim' };
  const runtime = path.join(COPILOT_HOME, '.harness-bin', 'bin', 'harness.mjs');
  if (fs.existsSync(runtime)) return { cmd: process.execPath, args: [runtime], mode: 'global-runtime' };
  const onPath = whichHarness();
  if (onPath) return { cmd: onPath, args: [], mode: 'path' };
  return null;
}

const target = resolveTarget();
if (!target) {
  console.error('[x] E_NO_HARNESS_BIN');
  console.error('  global harness not installed');
  console.error('  -> fix   ' + ${JSON.stringify(INSTALL_FIX_HINT)});
  console.error('  exit 1');
  process.exit(1);
}

const args = process.argv.slice(2);
// Fix-wave C1: honor the literal-argument boundary — a --workspace appearing
// after a bare -- is free-text content, not a flag, so it must not suppress
// the default --workspace injection (same rule as lib/flags.mjs#hasFlag).
const boundary = args.indexOf('--');
const flagArgs = boundary === -1 ? args : args.slice(0, boundary);
// Both spellings count as "the caller chose a workspace": lib/flags.mjs parses
// --workspace <path> AND --workspace=<path>. Matching only the separated token
// let the equals form fall through to injection, and because parseFlags reads
// argv in order the appended pair WON the tie — so an explicit
// \`--workspace=/a\` silently ran against the runner's own workspace instead.
const hasWorkspace = flagArgs.some((a) => a === '--workspace' || a.startsWith('--workspace='));
// The injection must land BEFORE the boundary too, for the same reason the
// detection reads before it: lib/flags.mjs#parseFlags slices argv at \`--\`, so
// an appended --workspace would never be parsed — it would just become two
// spurious literal tokens in the command's free-text content
// (\`learnings --why -- --json\` -> content \`--json --workspace <ws>\`).
const finalArgs = hasWorkspace
  ? args
  : boundary === -1
    ? [...args, '--workspace', workspace]
    : [...args.slice(0, boundary), '--workspace', workspace, ...args.slice(boundary)];
const spawnArgs = target.args.length
  ? [...target.args, ...finalArgs]
  : finalArgs;

const result = spawnSync(target.cmd, spawnArgs, {
  stdio: 'inherit',
  cwd: workspace,
  env: process.env,
});
process.exit(result.status ?? 1);
`;
}

export function writeHarnessRunner(workspace, dryRun) {
  const dir = path.join(workspace, '.harness');
  const runnerPath = path.join(dir, 'run.mjs');
  let stale = true;
  const existedBefore = fs.existsSync(runnerPath);
  if (existedBefore) {
    const existing = fs.readFileSync(runnerPath, 'utf8');
    stale = !existing.includes(`@harness-runner-version ${RUNNER_VERSION}`);
  }
  if (existedBefore && !stale && !process.env.HARNESS_FORCE_RUNNER) {
    return { path: runnerPath, created: false, updated: false };
  }
  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(runnerPath, harnessRunnerSource(), 'utf8');
    try {
      fs.chmodSync(runnerPath, 0o755);
    } catch {
      /* windows */
    }
  }
  return { path: runnerPath, created: !existedBefore, updated: existedBefore && stale };
}
