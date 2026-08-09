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
  if (harnessDirEscapes(workspace)) return null;
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

/**
 * Is `.harness` a real directory we own, or a symlink pointing somewhere else?
 *
 * Exported so every writer under `.harness` asks the same question. The
 * alternative — a check inside each writer — is a check someone eventually
 * forgets, and the one they forget is the one that writes outside the
 * workspace.
 */
export function harnessDirEscapes(workspace) {
  try {
    return fs.lstatSync(harnessDir(workspace)).isSymbolicLink();
  } catch {
    return false; // absent: nothing to escape through
  }
}

export function ensureHarnessDir(workspace, dryRun) {
  const dir = harnessDir(workspace);
  // `.harness` replaced by a symlink redirected every write this function
  // guards — the ignore file, the event log, the run journal — to wherever the
  // link pointed. Even a read-class command could then be steered into
  // appending attacker-chosen bytes outside the workspace. Refused HERE because
  // it is the one place all of those writes pass through; a check in each
  // writer is a check someone eventually forgets to add.
  if (harnessDirEscapes(workspace)) return null;
  const gitignore = path.join(dir, '.gitignore');
  // `runs.jsonl` joins the list: it is durable history containing argv, and a
  // journal committed by accident is both noise in review and a leak of what
  // someone ran locally (P2-19, Codex phase-4a review).
  const content = '# Ephemeral per-turn artifacts\nsession.json\ncontext-pack.md\nevents.jsonl\nruns.jsonl\nevidence/\n';
  if (!fs.existsSync(gitignore)) {
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(gitignore, content, 'utf8');
    }
  } else if (!dryRun) {
    const current = fs.readFileSync(gitignore, 'utf8');
    const lines = current.split(/\r?\n/);
    const missing = ['session.json', 'context-pack.md', 'events.jsonl', 'runs.jsonl', 'evidence/'].filter((entry) => !lines.includes(entry));
    if (missing.length) {
      const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(gitignore, `${separator}${missing.join('\n')}\n`, 'utf8');
    }
  }
  return dir;
}
