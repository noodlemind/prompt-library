/**
 * Execution policy for `exec` and `bash`: which environment a child sees, and
 * where it is allowed to run.
 *
 * `runProcess` has always taken an explicit `env`, documented as "the caller
 * owns allowlisting, this never merges in process.env" — but no caller ever
 * supplied one, so every named check has run with the full parent environment.
 * The seam was correct and unused. This module is the policy that fills it.
 *
 * DEFAULT-DENY, deliberately. The alternative — denylisting known-secret names
 * — fails on the first variable nobody thought of, and the things that end up
 * in a developer's environment (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, NPM_TOKEN,
 * a database URL with inline credentials) are exactly what a compromised or
 * merely careless check command would exfiltrate. An allowlist fails the other
 * way: a build that needs a variable breaks loudly and the operator adds it,
 * which is a conversation rather than a breach.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from './style.mjs';

/**
 * The base allowlist: what a process genuinely needs to locate its runtime and
 * behave correctly, and nothing that carries authority.
 *
 * PATH is here because without it a child cannot find its own interpreter.
 * HOME/USERPROFILE because toolchains resolve caches and configs from it.
 * The locale and terminal variables because their absence silently changes
 * output encoding and width, which turns a passing check into a failing one for
 * reasons no one will connect to this list.
 */
export const BASE_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Windows needs these to resolve system libraries at all; without them a
  // child process fails to start rather than failing a check.
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // Terminal shape only — never terminal AUTHORITY.
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'CI',
]);

/**
 * Names that are never allowlistable, whatever policy says. A allowlist entry
 * is an operator decision, but these three are not decisions: they change what
 * code a child LOADS, so permitting one hands the child's behavior to whoever
 * set the variable rather than to the argv the operator reviewed.
 */
export const NEVER_ALLOWED = Object.freeze([
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
]);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/**
 * Build the child environment from an allowlist.
 *
 * Returns `{ env, allowed, dropped, refused }` — `dropped` is what the parent
 * had and the child will not, and it is REPORTED rather than silently applied:
 * a check that fails because a variable vanished is otherwise a mystery, and
 * the audit record of an execution should state what the process could see.
 * Names only; a value never enters the report.
 */
export function buildChildEnv({ parentEnv = process.env, allow = [] } = {}) {
  const requested = [...BASE_ENV_ALLOWLIST, ...allow.map((n) => String(n).trim()).filter(Boolean)];
  const refused = [];
  const allowed = [];
  const seen = new Set();

  for (const name of requested) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (NEVER_ALLOWED.includes(name.toUpperCase())) {
      refused.push(name);
      continue;
    }
    allowed.push(name);
  }

  const env = {};
  for (const name of allowed) {
    if (Object.hasOwn(parentEnv, name) && parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }

  const dropped = Object.keys(parentEnv)
    .filter((name) => !Object.hasOwn(env, name))
    .sort();

  return { env, allowed: allowed.filter((n) => Object.hasOwn(env, n)), dropped, refused };
}

/**
 * Resolve the working directory a child may run in.
 *
 * Containment is not inherited from lib/fs-safe.mjs: that module contains FILE
 * paths, and `runProcess` passes `cwd` straight to spawn with no validation at
 * all. A cwd outside the workspace is how an execution escapes every other
 * boundary the harness maintains — the check config is repo-authored and
 * reviewed on the assumption that it acts on this repo.
 *
 * Symlinks are resolved before the containment test, so a link inside the
 * workspace pointing out of it is refused rather than trusted for its spelling.
 */
export function resolveExecCwd({ workspace, cwd = null, realpath }) {
  const root = path.resolve(workspace);
  if (!cwd) return root;
  const candidate = path.resolve(root, cwd);
  const realRoot = realpath(root);
  const realCandidate = realpath(candidate);
  if (realRoot === null || realCandidate === null) {
    throw usageError(`--cwd does not exist: ${cwd}`, 'the directory must exist inside the workspace before it can be used');
  }
  const contained = realCandidate === realRoot || realCandidate.startsWith(realRoot + path.sep);
  if (!contained) {
    throw usageError(
      `--cwd escapes the workspace: ${cwd}`,
      'execution is confined to the workspace, and a symlink out of it is resolved before this check',
    );
  }
  return realCandidate;
}

/**
 * Which shell `harness bash` resolves to (P3AC4).
 *
 * On POSIX this is `/bin/sh -c`, unremarkably.
 *
 * On Windows it is NOT `cmd.exe`, which is what an earlier version did. A
 * script written for `bash` is written in a different language from `cmd`, so
 * running it there does not degrade — it MISBEHAVES. `harness bash -- 'echo
 * $HOME'` under `cmd.exe` prints the literal `$HOME` and exits 0, which is a
 * wrong answer reported as success, the worst of the available outcomes.
 *
 * So Windows resolves a real `bash.exe` — Git for Windows and WSL both provide
 * one — and REFUSES when there is none. A refusal is recoverable: the operator
 * installs a shell or switches to `harness exec`, which never needed one. A
 * silent language substitution is not.
 */
export function resolveShell({ platform = process.platform, lookup = defaultShellLookup } = {}) {
  if (platform !== 'win32') return { argv: ['/bin/sh', '-c'], shell: '/bin/sh' };
  const found = lookup();
  if (!found) {
    throw Object.assign(new Error('bash is unavailable: no bash.exe found on PATH'), {
      code: 'E_DENIED',
      exit: EXIT.needsApproval,
      hint: 'install Git for Windows or enable WSL, or use `harness exec`, which never invokes a shell — cmd.exe is deliberately NOT substituted, because a POSIX script running under cmd fails silently rather than loudly',
    });
  }
  return { argv: [found, '-c'], shell: found };
}

/** Locate `bash.exe` on PATH. Split out so the resolution above is testable on
 * any platform without a Windows runner. */
function defaultShellLookup() {
  const exts = ['.exe', ''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `bash${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here — keep looking */
      }
    }
  }
  return null;
}

export const TIMEOUT_MIN_SECONDS = 1;
export const TIMEOUT_MAX_SECONDS = 3600;
export const TIMEOUT_DEFAULT_SECONDS = 600;

export function resolveTimeoutSeconds(raw) {
  if (raw === null || raw === undefined || raw === '') return TIMEOUT_DEFAULT_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < TIMEOUT_MIN_SECONDS || n > TIMEOUT_MAX_SECONDS) {
    throw usageError(
      `--timeout must be an integer from ${TIMEOUT_MIN_SECONDS} to ${TIMEOUT_MAX_SECONDS} seconds`,
      // An unbounded timeout is how an execute-classed command becomes a hang
      // with no operator recourse, so there is no "no limit" spelling.
      `given: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}
