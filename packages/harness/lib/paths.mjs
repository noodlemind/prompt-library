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

/** Global harness home for cross-project telemetry. HARNESS_HOME overrides for tests. */
export function harnessGlobalHome() {
  if (process.env.HARNESS_HOME) return path.resolve(process.env.HARNESS_HOME);
  return path.join(os.homedir(), '.harness');
}
