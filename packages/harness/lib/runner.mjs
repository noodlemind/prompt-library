/**
 * Async process runner — spawn-based replacement for the blocking
 * `execSync`/`spawnSync` call sites in this package (see verify.mjs,
 * plan-scope.mjs, knowledge/store.mjs, etc.). Those stay on spawnSync for
 * now; this module is additive and wired in by a later task.
 *
 * Contract: `runProcess` never rejects for process outcomes — it always
 * resolves with `{ status, exitCode, signalName, durationMs, stdout,
 * stderr, truncated }`. `status` is one of:
 *   - 'ok'        exited zero, not cancelled or timed out
 *   - 'failed'    exited non-zero, or died some other way we didn't ask for
 *   - 'cancelled' the caller's AbortSignal fired
 *   - 'timed-out' `timeoutMs` elapsed first
 * 'cancelled' and 'timed-out' are reported regardless of the exit code the
 * killed tree happens to produce — they must never collapse into 'failed'.
 *
 * Descendant termination: spawned detached (own process group) on POSIX so
 * a negative pid signals the whole group (SIGTERM, escalating to SIGKILL
 * after a grace period). On win32, process groups don't work the same way,
 * so termination shells out to `taskkill /T /F` for the pid's whole tree.
 *
 * Injectable deps (spawnFn, now, platform, killFn) follow createStyle's
 * pattern in style.mjs: real implementations by default, override any of
 * them for deterministic tests.
 */

import { spawn, spawnSync } from 'node:child_process';

export const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024; // 2 MiB
export const DEFAULT_KILL_GRACE_MS = 2000;

/** Bounded text accumulator: stops growing past maxBuffer, clipped at the
 * last line boundary at/before the limit so a caller never sees a
 * half-written line. Falls back to a hard clip only when a single line
 * itself exceeds maxBuffer (no boundary to clip at). */
function createBoundedSink(maxBuffer) {
  let buffer = '';
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      buffer += chunk;
      if (buffer.length > maxBuffer) {
        const cut = buffer.lastIndexOf('\n', maxBuffer);
        // Keep the newline itself so the clipped text still ends on a full
        // line; only hard-clip mid-line when a single line has no boundary
        // at or before maxBuffer to begin with.
        buffer = buffer.slice(0, cut === -1 ? maxBuffer : cut + 1);
        truncated = true;
      }
    },
    get text() {
      return buffer;
    },
    get truncated() {
      return truncated;
    },
  };
}

/**
 * Default kill implementation. POSIX: signal the process group (negative
 * pid) so descendants die with it — ESRCH (already gone) is not an error.
 * win32: process groups aren't addressable the same way, so this shells
 * out to `taskkill /T` (whole tree) `/F` (force) for the pid; /F makes it
 * unconditional, so unlike POSIX there's no SIGTERM-then-SIGKILL step.
 */
function defaultKill(pid, signal, platform) {
  if (platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    } catch {
      // best effort — process may already be gone
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/**
 * Run one process asynchronously. Never rejects for process outcomes — see
 * the module doc comment for the result shape and status contract.
 *
 * @param {object} options
 * @param {string[]} options.argv - `[command, ...args]`, never shell-parsed.
 * @param {string} [options.cwd] - passed straight through to spawn.
 * @param {object} [options.env] - the exact child environment. Omit to let
 *   spawn default to `process.env`; when provided, it is used as-is — the
 *   caller owns allowlisting, this never merges in `process.env`.
 * @param {number} [options.timeoutMs] - kill the tree if still running after this.
 * @param {AbortSignal} [options.signal] - kill the tree when it aborts.
 * @param {(chunk: string) => void} [options.onStdout] - live stdout chunks.
 * @param {(chunk: string) => void} [options.onStderr] - live stderr chunks.
 * @param {number} [options.maxBuffer] - byte-ish cap (JS string length) on
 *   the buffered stdout/stderr returned in the result; default 2 MiB.
 * @param {typeof spawn} [options.spawnFn] - injectable for tests.
 * @param {() => number} [options.now] - injectable clock for durationMs.
 * @param {NodeJS.Platform} [options.platform] - injectable for exercising
 *   the win32 termination path from any host.
 * @param {(pid: number, signal: string, platform: string) => void} [options.killFn] - injectable termination primitive.
 * @param {number} [options.killGraceMs] - SIGTERM→SIGKILL grace period (POSIX only).
 * @returns {Promise<{status: 'ok'|'failed'|'cancelled'|'timed-out', exitCode: number|null, signalName: string|null, durationMs: number, stdout: string, stderr: string, truncated: boolean}>}
 */
export function runProcess({
  argv,
  cwd,
  env,
  timeoutMs,
  signal,
  onStdout,
  onStderr,
  maxBuffer = DEFAULT_MAX_BUFFER,
  spawnFn = spawn,
  now = () => Date.now(),
  platform = process.platform,
  killFn = defaultKill,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === 'string')) {
    throw new TypeError('runProcess: argv must be a non-empty array of strings');
  }

  return new Promise((resolve) => {
    const start = now();
    const [cmd, ...args] = argv;
    const stdoutSink = createBoundedSink(maxBuffer);
    const stderrSink = createBoundedSink(maxBuffer);

    let settled = false;
    let timeoutTimer = null;
    let killGraceTimer = null;
    // Set once cancellation/timeout is requested; wins over whatever exit
    // code the killed tree happens to report (AC4/AC5 hard contract).
    let outcomeStatus = null;

    function cleanup() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    function finish(partial) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        status: partial.status,
        exitCode: partial.exitCode ?? null,
        signalName: partial.signalName ?? null,
        durationMs: now() - start,
        stdout: stdoutSink.text,
        stderr: stderrSink.text,
        truncated: stdoutSink.truncated || stderrSink.truncated,
      });
    }

    if (signal?.aborted) {
      finish({ status: 'cancelled' });
      return;
    }

    let child;
    try {
      child = spawnFn(cmd, args, {
        cwd,
        env,
        shell: false,
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish({ status: 'failed' });
      return;
    }

    function terminateTree(status) {
      if (outcomeStatus) return; // already terminating for the other reason
      outcomeStatus = status;
      killFn(child.pid, 'SIGTERM', platform);
      if (platform === 'win32') return; // taskkill /F is already unconditional
      killGraceTimer = setTimeout(() => {
        killFn(child.pid, 'SIGKILL', platform);
      }, killGraceMs);
    }

    function onAbort() {
      terminateTree('cancelled');
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => terminateTree('timed-out'), timeoutMs);
    }

    child.on('error', () => {
      finish({ status: outcomeStatus || 'failed' });
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    // P1.6 (carry-list c): a caller-supplied onStdout/onStderr that throws
    // must never take down the spawned child's own stream handling with it —
    // the buffered sink (and the process outcome itself) still has to be
    // collected regardless of what the caller's own callback does.
    child.stdout?.on('data', (chunk) => {
      stdoutSink.push(chunk);
      if (onStdout) {
        try {
          onStdout(chunk);
        } catch {
          // caller's callback failed — swallow, buffered stdout is unaffected
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrSink.push(chunk);
      if (onStderr) {
        try {
          onStderr(chunk);
        } catch {
          // caller's callback failed — swallow, buffered stderr is unaffected
        }
      }
    });

    child.on('close', (exitCode, signalName) => {
      finish({
        status: outcomeStatus || (exitCode === 0 ? 'ok' : 'failed'),
        exitCode,
        signalName,
      });
    });
  });
}
