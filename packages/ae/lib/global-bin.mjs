import fs from 'fs';
import os from 'os';
import path from 'path';
import { readLock } from './lock.mjs';

const PATH_MARKER = '# harness global bin';
const PATH_EXPORT = 'export PATH="$HOME/.copilot/bin:$PATH"';

export const INSTALL_FIX_HINT =
  'ae install  (from a repository checkout: npm install -g ./packages/ae && ae install; local: node packages/ae/bin/ae.mjs install)';

export function globalBinDir(copilotHome) {
  return path.join(copilotHome, 'bin');
}

export function globalHarnessShimPath(copilotHome) {
  return path.join(globalBinDir(copilotHome), 'ae');
}

function harnessShimSource(copilotHome) {
  const home = copilotHome.replace(/\\/g, '/');
  return `#!/usr/bin/env node
/**
 * Global harness shim — installed by ae install.
 * Delegates to ~/.copilot/.ae-bin/bin/ae.mjs
 * Invoke: ae …  or  node ~/.copilot/bin/ae …
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COPILOT_HOME = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
const bin = path.join(COPILOT_HOME, '.ae-bin', 'bin', 'ae.mjs');

if (!fs.existsSync(bin)) {
  console.error('[x] E_NO_RUNTIME');
  console.error('  global harness runtime missing at ' + bin);
  console.error('  -> fix   ' + ${JSON.stringify(INSTALL_FIX_HINT)});
  console.error('  exit 1');
  process.exit(1);
}

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [bin, ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});
process.exit(result.status ?? 1);
`;
}

export function installGlobalHarnessShim(copilotHome, flags, log) {
  const shimPath = globalHarnessShimPath(copilotHome);
  const stats = { path: shimPath, created: false, updated: false };
  let existed = false;
  try {
    const stat = fs.lstatSync(shimPath);
    existed = true;
    if (!stat.isFile() || stat.isSymbolicLink()
        || !/Global harness shim[\s\S]*installed by ae install/.test(fs.readFileSync(shimPath, 'utf8'))) {
      throw Object.assign(new Error(`refusing to replace an unrelated command at ${shimPath}`), { code: 'E_TARGET', exit: 1 });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (flags.dryRun) {
    log(`would write global harness shim: ${shimPath}`);
    stats.updated = true;
    return stats;
  }

  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  fs.writeFileSync(shimPath, harnessShimSource(copilotHome), 'utf8');
  try {
    fs.chmodSync(shimPath, 0o755);
  } catch {
    /* windows */
  }
  stats[existed ? 'updated' : 'created'] = true;
  const legacy = path.join(globalBinDir(copilotHome), 'harness');
  const lock = readLock(copilotHome);
  if (['harness', 'ae-harness'].includes(lock?.package) && lock.files?.includes('bin/harness')) {
    try {
      const stat = fs.lstatSync(legacy);
      if (stat.isFile() && !stat.isSymbolicLink()
          && /Global harness shim[\s\S]*installed by (?:harness|ae) install/.test(fs.readFileSync(legacy, 'utf8'))) {
        fs.writeFileSync(legacy, harnessShimSource(copilotHome), 'utf8');
        stats.legacyPath = legacy;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  log(`${existed ? 'updated' : 'created'} global harness shim: ${shimPath}`);
  return stats;
}

export function findHarnessOnPath() {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
  const entries = String(process.env[pathKey] || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['ae.cmd', 'ae.exe', 'ae.mjs', 'ae'] : ['ae'];
  for (const dir of entries) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // This PATH entry does not contain the shim.
      }
    }
  }
  return null;
}

export function configureShellPath(copilotHome, flags, log) {
  const binDir = globalBinDir(copilotHome);
  const home = os.homedir();
  const candidates = ['.zshrc', '.bashrc', '.bash_profile', '.profile'];
  let updated = 0;

  for (const rc of candidates) {
    const rcPath = path.join(home, rc);
    if (!fs.existsSync(rcPath)) continue;
    const content = fs.readFileSync(rcPath, 'utf8');
    if (content.includes('.copilot/bin') || content.includes(PATH_MARKER)) {
      if (flags.verbose) log(`skip PATH (already configured): ${rcPath}`);
      continue;
    }
    const block = `\n${PATH_MARKER}\n${PATH_EXPORT}\n`;
    if (flags.dryRun) {
      log(`would append PATH to ${rcPath}`);
      updated++;
      continue;
    }
    fs.appendFileSync(rcPath, block, 'utf8');
    log(`appended ~/.copilot/bin to PATH via ${rc}`);
    updated++;
  }

  if (updated === 0 && !flags.dryRun) {
    log(`ensure ${binDir} is on PATH (run with --configure-path or add manually)`);
  }
  return { updated, binDir };
}
