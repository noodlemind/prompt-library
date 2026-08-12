import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where editors keep the Copilot login, honouring XDG and the caller's own
 * environment — reading `os.homedir()` unconditionally is what once made
 * readiness untestable and let a sign-in from some other install decide what
 * the picker offers. */
export function copilotConfigDir(env = process.env) {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'github-copilot');
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.config', 'github-copilot');
}

/** The OAuth token an editor login left behind, or null. Absent, unreadable,
 * or malformed all mean the same thing: not signed in this way. */
export function findEditorOauthToken(env = process.env) {
  for (const file of ['apps.json', 'hosts.json']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(copilotConfigDir(env), file), 'utf8'));
      for (const value of Object.values(parsed ?? {})) {
        if (value && typeof value === 'object' && typeof value.oauth_token === 'string') {
          return value.oauth_token;
        }
      }
    } catch { /* try the next rung */ }
  }
  return null;
}
