import fs from 'fs';
import path from 'path';

export const LOCK_NAME = '.harness-lock.json';

export function readLock(copilotHome) {
  const lockPath = path.join(copilotHome, LOCK_NAME);
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeLock(copilotHome, data, dryRun) {
  const lockPath = path.join(copilotHome, LOCK_NAME);
  const body = JSON.stringify(data, null, 2) + '\n';
  if (dryRun) return lockPath;
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.writeFileSync(lockPath, body, 'utf8');
  return lockPath;
}
