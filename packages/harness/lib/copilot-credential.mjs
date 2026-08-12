/**
 * The editor's own Copilot credential store, read in ONE place.
 *
 * VS Code, JetBrains and the Copilot CLI all record a login under
 * `github-copilot/` in the user's config directory — `apps.json` in current
 * builds, `hosts.json` in older ones. Two callers need that fact: the seam
 * (`providerReadiness` reports "editor credential found" without reading the
 * value beyond the one field that says a login happened) and the adapter
 * (which reads the token to exchange it). They used to carry hand-rolled
 * copies of the same scan, which is how the seam and the adapter would
 * eventually disagree about whether someone is signed in — a path fix landing
 * in one copy and not the other.
 *
 * This module names no environment variable that holds a credential (P5AC7:
 * only the seam does that); it reads files an editor wrote, from a directory
 * derived from the environment it is handed.
 */
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
