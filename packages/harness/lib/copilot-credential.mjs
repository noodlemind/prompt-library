import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function copilotConfigDirs(env = process.env) {
  const dirs = [];
  if (env.XDG_CONFIG_HOME) dirs.push(path.join(env.XDG_CONFIG_HOME, 'github-copilot'));
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'github-copilot'));
  const home = env.HOME || env.USERPROFILE || os.homedir();
  dirs.push(path.join(home, '.config', 'github-copilot'));
  return [...new Set(dirs)];
}

export function copilotConfigDir(env = process.env) {
  return copilotConfigDirs(env)[0];
}

/** The OAuth token an editor login left behind, or null. Absent, unreadable,
 * or malformed all mean the same thing: not signed in this way. */
export function findEditorOauthToken(env = process.env) {
  for (const dir of copilotConfigDirs(env)) {
    for (const file of ['apps.json', 'hosts.json']) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        for (const value of Object.values(parsed ?? {})) {
          if (value && typeof value === 'object' && typeof value.oauth_token === 'string') {
            return value.oauth_token;
          }
        }
      } catch { /* try the next rung */ }
    }
  }
  return null;
}
