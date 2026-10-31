import fs from 'fs';
import os from 'os';
import path from 'path';
import { findHarnessOnPath, globalHarnessShimPath, INSTALL_FIX_HINT } from './global-bin.mjs';
import { runtimeSetting } from '../corpus/hooks/lib/runtime-identity.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';

const HARNESS_REL = path.join('packages', 'ae', 'bin', 'ae.mjs');
const NM_REL = path.join('node_modules', 'ae-harness', 'bin', 'ae.mjs');

export function resolveHarnessBin({ workspace = process.cwd(), copilotHome } = {}) {
  const tried = [];
  const home = copilotHome || path.join(os.homedir(), '.copilot');

  const override = runtimeSetting('BIN');
  if (override) {
    const envBin = path.resolve(override);
    tried.push({ source: 'HARNESS_BIN', path: envBin });
    try {
      if (fs.statSync(envBin).isFile()) return { bin: envBin, source: 'HARNESS_BIN', tried, globalShim: null, onPath: false };
    } catch {}
    return { bin: null, source: 'HARNESS_BIN', tried, globalShim: null, onPath: false, error: 'The explicitly selected AE_BIN/HARNESS_BIN runtime is unavailable' };
  }

  const shim = globalHarnessShimPath(home);
  tried.push({ source: 'global-shim', path: shim });
  if (fs.existsSync(shim)) {
    const onPath = findHarnessOnPath() === shim;
    return { bin: shim, source: 'global-shim', tried, globalShim: shim, onPath };
  }

  const globalBin = path.join(home, '.ae-bin', 'bin', 'ae.mjs');
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
  if (resolved.onPath) return 'ae';
  if (resolved.source === 'global-shim') return `node "${resolved.bin}"`;
  if (resolved.globalShim && fs.existsSync(resolved.globalShim)) {
    return `node "${resolved.globalShim}"`;
  }
  return `node "${resolved.bin}"`;
}

export const RUNNER_VERSION = 8;

export function harnessRunnerSource() {
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
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
  const entries = String(process.env[pathKey] || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['ae.cmd', 'ae.exe', 'ae.mjs', 'ae'] : ['ae'];
  for (const dir of entries) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform === 'win32' && name.endsWith('.cmd')) {
          // npm's command shim is a batch file, not a spawnable executable.
          // Run its standard package entry directly; never enable a shell.
          const entry = path.join(dir, 'node_modules', 'ae-harness', 'bin', 'ae.mjs');
          if (fs.statSync(entry).isFile()) return { cmd: process.execPath, args: [entry], mode: 'npm-path' };
          continue;
        }
        if (name.endsWith('.mjs')) return { cmd: process.execPath, args: [candidate], mode: 'path' };
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return { cmd: candidate, args: [], mode: 'path' };
      } catch {
        // This PATH entry does not contain the shim.
      }
    }
  }
  return null;
}

function resolveTarget() {
  const canonical = process.env.AE_BIN;
  const legacy = process.env.HARNESS_BIN;
  if (canonical && legacy && path.resolve(canonical) !== path.resolve(legacy)) {
    console.error('[x] E_USAGE: AE_BIN conflicts with HARNESS_BIN');
    process.exit(2);
  }
  const override = canonical || legacy;
  if (override) {
    const selected = path.resolve(override);
    try {
      if (fs.statSync(selected).isFile()) return { cmd: process.execPath, args: [selected], mode: 'AE_BIN' };
    } catch {}
    console.error('[x] E_NO_HARNESS_BIN: selected AE_BIN/HARNESS_BIN is not a readable runtime file');
    process.exit(1);
  }
  const shim = path.join(COPILOT_HOME, 'bin', 'ae');
  if (fs.existsSync(shim)) return { cmd: process.execPath, args: [shim], mode: 'global-shim' };
  const runtime = path.join(COPILOT_HOME, '.ae-bin', 'bin', 'ae.mjs');
  if (fs.existsSync(runtime)) return { cmd: process.execPath, args: [runtime], mode: 'global-runtime' };
  const onPath = whichHarness();
  if (onPath) return onPath;
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
if (result.error || result.signal) {
  console.error('[x] E_RUNTIME_START: ' + (result.error?.code || result.signal));
  console.error('  -> fix   ' + ${JSON.stringify(INSTALL_FIX_HINT)});
}
process.exit(result.status ?? 1);
`;
}

export function workspaceRunnerStatus(workspace) {
  const rel = path.join('.harness', 'run.mjs');
  const runnerPath = path.join(workspace, rel);
  if (!assertNoSymlinkAncestors(workspace, rel)) return { path: runnerPath, state: 'unsafe' };
  let stat;
  try { stat = fs.lstatSync(runnerPath); }
  catch (error) { return { path: runnerPath, state: error.code === 'ENOENT' ? 'missing' : 'unsafe' }; }
  if (!stat.isFile() || stat.isSymbolicLink()) return { path: runnerPath, state: 'unsafe' };
  const source = readFileNoFollow(runnerPath, { root: workspace, maxBytes: 64 * 1024 });
  if (source === null) return { path: runnerPath, state: 'unsafe' };
  const markers = [...source.matchAll(/^\s*\*\s+@harness-runner-version ([1-9][0-9]*)\s*$/gm)];
  if (markers.length !== 1) return { path: runnerPath, state: 'custom' };
  const version = Number(markers[0][1]);
  return { path: runnerPath, version, state: version > RUNNER_VERSION ? 'newer' : source === harnessRunnerSource() ? 'current' : 'stale' };
}

export function writeHarnessRunner(workspace, dryRun) {
  const { path: runnerPath, state } = workspaceRunnerStatus(workspace);
  if (state === 'unsafe' || state === 'custom') {
    throw Object.assign(new Error(`refusing to replace an unsafe or unrelated runner at ${runnerPath}`), {
      code: 'E_TARGET', exit: 1, hint: 'inspect and preserve the existing path; use the installed ae command directly or move the conflicting custom runner before initialization',
    });
  }
  if (state === 'newer') {
    throw Object.assign(new Error(`workspace runner requires a newer AE installation: ${runnerPath}`), {
      code: 'E_RUNNER_NEWER', exit: 1, hint: 'upgrade the selected AE installation before regenerating this runner',
    });
  }
  if (state === 'current') {
    return { path: runnerPath, created: false, updated: false };
  }
  if (!dryRun && !writeFileContained(workspace, path.join('.harness', 'run.mjs'), harnessRunnerSource(), { mode: 0o755, exclusive: state === 'missing' })) {
    throw Object.assign(new Error(`runner target is unsafe or unavailable: ${runnerPath}`), { code: 'E_TARGET', exit: 1 });
  }
  return { path: runnerPath, created: state === 'missing', updated: state === 'stale' };
}
