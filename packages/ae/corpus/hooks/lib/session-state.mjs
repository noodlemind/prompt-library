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
  for (const file of [path.join(workspace, '.harness'), sessionStatePath(workspace)]) {
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe Harness session path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const statePath = sessionStatePath(workspace);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, statePath);
  return session;
}

export function syncSessionIdentity(workspace, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const current = readSessionState(workspace);
  if (!current || current.sessionId === sessionId) return current;
  return writeSessionState(workspace, { ...current, sessionId, sessionStartedAt: new Date().toISOString() });
}
