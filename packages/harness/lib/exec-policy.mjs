import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from './style.mjs';

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

export const NEVER_ALLOWED = Object.freeze([
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
]);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

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
            `given: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}
