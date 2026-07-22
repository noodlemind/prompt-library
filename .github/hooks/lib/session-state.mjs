import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sessionStatePath(workspace) {
  return path.join(workspace, '.harness', 'session.json');
}

export function readSessionState(workspace) {
  try {
    const statePath = sessionStatePath(workspace);
    if (!fs.existsSync(statePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSessionState(workspace, session) {
  const statePath = sessionStatePath(workspace);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, statePath);
  return session;
}
