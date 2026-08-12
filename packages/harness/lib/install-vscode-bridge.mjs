import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VSCODE_BRIDGE_ID = 'dev-kit.harness-copilot-bridge';
export const VSCODE_BRIDGE_DIR = VSCODE_BRIDGE_ID;

function manifestAt(root) {
  return path.join(root, 'package.json');
}

function readIdentity(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestAt(root), 'utf8'));
    return {
      id: `${manifest.publisher}.${manifest.name}`,
      version: manifest.version,
    };
  } catch {
    return null;
  }
}

function targetError(message) {
  return Object.assign(new Error(message), { code: 'E_TARGET', exit: 1 });
}

export function resolveVSCodeExtensionsDir({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (env.HARNESS_VSCODE_EXTENSIONS_DIR) return env.HARNESS_VSCODE_EXTENSIONS_DIR;
  if (platform === 'win32') {
    return path.win32.join(env.USERPROFILE || homedir, '.vscode', 'extensions');
  }
  return path.join(env.HOME || homedir, '.vscode', 'extensions');
}

export function installVSCodeBridge({
  packageRoot,
  extensionsDir = resolveVSCodeExtensionsDir(),
  dryRun = false,
  log = () => {},
} = {}) {
  const source = path.join(packageRoot, 'vscode-extension');
  const sourceIdentity = readIdentity(source);
  if (sourceIdentity?.id !== VSCODE_BRIDGE_ID) {
    throw targetError(`bundled VS Code bridge is missing or has the wrong identity (expected ${VSCODE_BRIDGE_ID})`);
  }

  const target = path.join(extensionsDir, VSCODE_BRIDGE_DIR);
  let existing = false;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw targetError(`refusing to replace non-directory VS Code extension target: ${target}`);
    }
    existing = true;
    if (readIdentity(target)?.id !== VSCODE_BRIDGE_ID) {
      throw targetError(`refusing to replace VS Code extension directory not owned by ${VSCODE_BRIDGE_ID}: ${target}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  log(`${dryRun ? 'would ' : ''}${existing ? 'update' : 'install'} VS Code extension: ${VSCODE_BRIDGE_ID}`);
  if (!dryRun) {
    fs.mkdirSync(extensionsDir, { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
  }
  return {
    id: VSCODE_BRIDGE_ID,
    version: sourceIdentity.version,
    path: target,
    created: existing ? 0 : 1,
    updated: existing ? 1 : 0,
    files: ['package.json', 'extension.cjs'],
  };
}

export function uninstallVSCodeBridge(record, {
  extensionsDir = resolveVSCodeExtensionsDir(),
  dryRun = false,
  log = () => {},
} = {}) {
  if (!record || record.id !== VSCODE_BRIDGE_ID || typeof record.path !== 'string') return false;
  const expected = path.resolve(extensionsDir, VSCODE_BRIDGE_DIR);
  if (path.resolve(record.path) !== expected) {
    log(`skip unsafe VS Code extension path: ${record.path}`);
    return false;
  }
  let stat;
  try {
    stat = fs.lstatSync(expected);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || readIdentity(expected)?.id !== VSCODE_BRIDGE_ID) {
    log(`skip VS Code extension path not owned by ${VSCODE_BRIDGE_ID}: ${expected}`);
    return false;
  }
  log(`${dryRun ? 'would remove' : 'remove'} VS Code extension: ${expected}`);
  if (!dryRun) fs.rmSync(expected, { recursive: true, force: true });
  return true;
}
