import fs from 'fs';
import path from 'path';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';

export const LOCK_NAME = '.harness-lock.json';

export function installationRoot(home) {
  const absolute = path.resolve(home);
  let ancestor = absolute;
  while (true) {
    try { return path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, absolute)); }
    catch (error) {
      const parent = path.dirname(ancestor);
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

const sameRoot = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === installationRoot(right).toLowerCase()
  : path.resolve(left) === installationRoot(right);
const invalidLock = message => Object.assign(new Error(`install lock ${message}`), { code: 'E_TARGET', exit: 1 });

export function readLock(copilotHome, { strict = false } = {}) {
  const lockPath = path.join(copilotHome, LOCK_NAME);
  try {
    if (!assertNoSymlinkAncestors(copilotHome, LOCK_NAME)) throw invalidLock('is unsafe or symlinked');
    if (!fs.lstatSync(lockPath, { throwIfNoEntry: false })) return null;
    const bytes = readFileNoFollow(lockPath, { root: copilotHome });
    if (bytes === null) throw invalidLock('is unsafe or unreadable');
    let lock;
    try { lock = JSON.parse(bytes); } catch { throw invalidLock('contains invalid JSON'); }
    if (lock?.installationRoot !== undefined && (typeof lock.installationRoot !== 'string' || !path.isAbsolute(lock.installationRoot) || !sameRoot(lock.installationRoot, copilotHome))) throw invalidLock('belongs to another home or destination root');
    if (strict && (!lock || typeof lock !== 'object' || Array.isArray(lock)
      || !['harness', 'ae-harness'].includes(lock.package) || !Array.isArray(lock.files)
      || lock.files.some(file => typeof file !== 'string' || !file || path.isAbsolute(file) || path.win32.isAbsolute(file) || file.replace(/\\/g, '/').split('/').includes('..'))
      || lock.targets !== undefined && (!Array.isArray(lock.targets) || lock.targets.some(target => !['vscode', 'cli', 'intellij'].includes(target)))
      || lock.lockVersion !== undefined && lock.lockVersion !== 2
      || lock.lockVersion === 2 && typeof lock.installationRoot !== 'string')) throw invalidLock('has invalid ownership fields');
    return lock;
  } catch (error) {
    if (strict) throw error.code === 'E_TARGET' ? error : invalidLock(`is unreadable: ${error.message}`);
    return null;
  }
}

export function writeLock(copilotHome, data, dryRun) {
  const lockPath = path.join(copilotHome, LOCK_NAME);
  const body = JSON.stringify(data, null, 2) + '\n';
  readLock(copilotHome, { strict: true });
  if (dryRun) return lockPath;
  fs.mkdirSync(copilotHome, { recursive: true });
  const mode = fs.lstatSync(lockPath, { throwIfNoEntry: false })?.mode;
  if (!writeFileContained(copilotHome, LOCK_NAME, body, { mode: mode === undefined ? 0o600 : mode & 0o777 })) throw invalidLock('could not be published safely');
  return lockPath;
}
