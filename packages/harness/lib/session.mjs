import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';

export const SESSION_DIR = '.harness';
export const SESSION_FILE = 'session.json';

export function harnessDir(workspace) {
  return path.join(workspace, SESSION_DIR);
}

export function sessionPath(workspace) {
  return path.join(harnessDir(workspace), SESSION_FILE);
}

export function readSession(workspace) {
  const p = sessionPath(workspace);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(workspace, session, dryRun) {
  const dir = harnessDir(workspace);
  if (!dryRun) fs.mkdirSync(dir, { recursive: true });
  const p = sessionPath(workspace);
  const payload = {
    version: 1,
    ...session,
    sessionId: session.sessionId || crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  if (!dryRun) {
    const temporary = `${p}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, p);
  }
  return payload;
}

export function ensureHarnessDir(workspace, dryRun) {
  const dir = harnessDir(workspace);
  const gitignore = path.join(dir, '.gitignore');
  const content = '# Ephemeral per-turn artifacts\nsession.json\ncontext-pack.md\nevents.jsonl\nevidence/\n';
  if (!fs.existsSync(gitignore)) {
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(gitignore, content, 'utf8');
    }
  } else if (!dryRun) {
    const current = fs.readFileSync(gitignore, 'utf8');
    const lines = current.split(/\r?\n/);
    const missing = ['session.json', 'context-pack.md', 'events.jsonl', 'evidence/'].filter((entry) => !lines.includes(entry));
    if (missing.length) {
      const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(gitignore, `${separator}${missing.join('\n')}\n`, 'utf8');
    }
  }
  return dir;
}
