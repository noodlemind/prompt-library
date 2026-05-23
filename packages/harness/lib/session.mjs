import fs from 'fs';
import path from 'path';

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
    updatedAt: new Date().toISOString(),
    ...session,
  };
  if (!dryRun) fs.writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

export function ensureHarnessDir(workspace, dryRun) {
  const dir = harnessDir(workspace);
  const gitignore = path.join(dir, '.gitignore');
  const content = '# Ephemeral per-turn artifacts\ncontext-pack.md\nevents.jsonl\n';
  if (!fs.existsSync(gitignore)) {
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(gitignore, content, 'utf8');
    }
  } else if (!dryRun) {
    const current = fs.readFileSync(gitignore, 'utf8');
    const missing = ['context-pack.md', 'events.jsonl'].filter((entry) => !current.includes(entry));
    if (missing.length) fs.appendFileSync(gitignore, `${missing.join('\n')}\n`, 'utf8');
  }
  return dir;
}
