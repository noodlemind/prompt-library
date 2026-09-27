import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export function resolveCopilotHome(override) {
  if (override) return path.resolve(override);
  if (process.env.COPILOT_HOME) return path.resolve(process.env.COPILOT_HOME);
  if (process.env.XDG_CONFIG_HOME) {
    const xdg = path.join(process.env.XDG_CONFIG_HOME, 'copilot');
        if (fs.existsSync(xdg)) return xdg;
  }
  return path.join(os.homedir(), '.copilot');
}

export function resolveIntelliJHome() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'github-copilot', 'intellij');
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'github-copilot',
      'intellij'
    );
  }
  return path.join(os.homedir(), '.local', 'share', 'github-copilot', 'intellij');
}

export function resolveVSCodeSettingsPaths() {
  const paths = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    paths.push(path.join(appData, 'Code', 'User', 'settings.json'));
    paths.push(path.join(appData, 'Code - Insiders', 'User', 'settings.json'));
  } else if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support');
    paths.push(path.join(base, 'Code', 'User', 'settings.json'));
    paths.push(path.join(base, 'Code - Insiders', 'User', 'settings.json'));
  } else {
    const base = path.join(os.homedir(), '.config');
    paths.push(path.join(base, 'Code', 'User', 'settings.json'));
    paths.push(path.join(base, 'Code - Insiders', 'User', 'settings.json'));
  }
  return paths.filter((p) => fs.existsSync(path.dirname(p)));
}

export function pkgRootFromImportMeta(metaUrl) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..');
}

/** Harness-owned root. ~/.harness by default. HARNESS_HOME overrides it. --harness-home wins for one command. */
export function harnessGlobalHome() {
  if (process.env.HARNESS_HOME) return path.resolve(process.env.HARNESS_HOME);
  return path.join(os.homedir(), '.harness');
}

/** Apply --harness-home before any command reads the home. The flag wins over HARNESS_HOME. A repeated flag uses the last path, matching parseFlags. */
export function applyHarnessHomeFlag(argv) {
  const scan = argv.slice(0, argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--'));
  let chosen = null;
  for (let i = 0; i < scan.length; i++) {
    const token = scan[i];
    let value;
    if (token.startsWith('--harness-home=')) value = token.slice('--harness-home='.length);
    else if (token === '--harness-home') value = scan[++i];
    else continue;
    if (!value || value.startsWith('--')) {
      throw Object.assign(new Error('invalid --harness-home: requires a directory path'), {
        code: 'E_USAGE',
        hint: 'harness help',
        exit: 2,
      });
    }
    chosen = value;
  }
  if (!chosen) return null;
  process.env.HARNESS_HOME = path.resolve(chosen);
  return process.env.HARNESS_HOME;
}
