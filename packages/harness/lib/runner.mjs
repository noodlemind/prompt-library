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
// Fix-wave Important #7 (round 2): after termination begins on POSIX, how long
// to keep confirming the process GROUP has actually died (past the SIGKILL
// escalation) before settling anyway. The always-resolve contract still holds
// — this only bounds the wait so a truly un-reapable group can never hang the
// run forever.
export const DEFAULT_GROUP_REAP_TIMEOUT_MS = 5000;
const GROUP_REAP_POLL_MS = 50;

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
 * Default POSIX liveness probe for a process GROUP: signal 0 to the negative
 * pid succeeds while the group has any member and throws ESRCH once it is
 * empty. EPERM means the group exists but isn't ours to signal — treat as
 * alive (conservative: never declare a still-present group dead). win32 has no
 * addressable process group here (termination is taskkill /F, synchronous), so
 * there is nothing to poll.
 */
function defaultGroupAlive(pid, platform) {
  if (platform === 'win32') return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    return false;
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
 * @param {(pid: number, platform: string) => boolean} [options.groupAliveFn] -
 *   injectable process-group liveness probe (fix-wave Important #7). Defaults
 *   to a real POSIX `kill(-pid, 0)` probe ONLY when `killFn` is the default
 *   (real) terminator; a test that stubs `killFn` but not this keeps the
 *   pre-#7 immediate-settle behavior, since it is simulating signals, not a
 *   live OS group.
 * @param {number} [options.killGraceMs] - SIGTERM→SIGKILL grace period (POSIX only).
 * @param {number} [options.groupReapTimeoutMs] - bound on how long a
 *   cancelled/timed-out run waits for the group to be confirmed gone before
 *   settling anyway (POSIX only).
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
  groupAliveFn,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  groupReapTimeoutMs = DEFAULT_GROUP_REAP_TIMEOUT_MS,
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
    let groupReapTimer = null;
    let settleDeadlineTimer = null;
    // Set once cancellation/timeout is requested; wins over whatever exit
    // code the killed tree happens to report (AC4/AC5 hard contract).
    let outcomeStatus = null;

    // Fix-wave Important #7 (round 2): the group-death watch engages only when
    // the termination is REAL (default killFn against a live OS process group)
    // or a test injected an explicit probe. A test that stubs killFn but not
    // groupAliveFn keeps the pre-#7 immediate-settle path — it is simulating
    // signals, not reaping a real group.
    const groupAlive = groupAliveFn || (killFn === defaultKill ? defaultGroupAlive : null);
    const watchGroupDeath = platform !== 'win32' && typeof groupAlive === 'function';

    function cleanup() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      // Fix-wave Important #7 (round 2): the SIGKILL escalation and the
      // group-death poll are cleared only HERE, at settlement. While a
      // termination is in progress the run does NOT settle until the group is
      // confirmed gone (or the reap deadline passes — see settleAfterGroupDeath
      // and child 'close' below), so these timers stay REF'd. That is the fix
      // for the round-1 mistake: the escalation timer was unref'd, so once the
      // owning CLI process called process.exit the still-pending SIGKILL was
      // abandoned and a grandchild that ignored SIGTERM survived. Ref'd, it is
      // guaranteed to run before the process can exit; bounded, it can never
      // hang.
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (groupReapTimer) clearTimeout(groupReapTimer);
      if (settleDeadlineTimer) clearTimeout(settleDeadlineTimer);
    }

    // Fix-wave Important #7 (round 2): a cancelled/timed-out run must not
    // resolve while a grandchild that ignored SIGTERM is still alive — the
    // caller (and the CLI that awaits this promise before process.exit) would
    // otherwise exit before the SIGKILL escalation took effect. Poll the group
    // until it is confirmed gone (past the escalation) or a bounded deadline,
    // THEN settle. The poll timer is ref'd, so the process cannot exit out from
    // under the escalation.
    function settleAfterGroupDeath(partial) {
      const deadline = now() + groupReapTimeoutMs;
      const poll = () => {
        if (settled) return;
        let alive;
        try {
          alive = groupAlive(child.pid, platform);
        } catch {
          alive = false;
        }
        if (!alive || now() >= deadline) {
          finish(partial);
          return;
        }
        groupReapTimer = setTimeout(poll, GROUP_REAP_POLL_MS);
      };
      poll();
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

    // Fix-wave Important #6: `child.pid` is undefined when the spawn itself
    // failed asynchronously (a nonexistent executable emits 'error' with no
    // pid) — the pre-fix killFn(undefined, ...) crashed with
    // ERR_INVALID_ARG_TYPE (PID NaN) from inside the abort listener,
    // breaking the always-resolve contract. Guard PID validity AND wrap the
    // termination primitive: killFn is best-effort by definition, and no
    // failure inside it may ever propagate into the caller's signal
    // dispatch or a timer callback.
    function safeKill(sig) {
      if (!Number.isInteger(child.pid) || child.pid <= 0) return;
      try {
        killFn(child.pid, sig, platform);
      } catch {
        // best effort — the process/group may already be gone, or the
        // injected killFn may be faulty; the structured outcome still settles.
      }
    }

    function terminateTree(status) {
      if (outcomeStatus) return; // already terminating for the other reason
      outcomeStatus = status;
      safeKill('SIGTERM');
      // Absolute settlement backstop for the always-resolves contract. Every
      // other settlement path hangs off `child.on('close')`, which fires only
      // once the child has exited AND its stdio pipes are closed — a
      // descendant that inherited stdout/stderr and escaped the process group
      // (setsid, double-fork) holds those pipes open, so 'close' never
      // arrives, and terminateTree alone never settles anything. Bounded by
      // the same two dials the ordinary terminated path already spends
      // (SIGKILL escalation, then the group reap window), so a run that WOULD
      // have settled normally never reaches this timer; it is cleared on
      // 'close' below and again at settlement. Ref'd on purpose, like the
      // escalation timer: it is the guarantee, not a background nicety.
      settleDeadlineTimer = setTimeout(() => {
        finish({ status, exitCode: null, signalName: null });
      }, killGraceMs + groupReapTimeoutMs);
      if (platform === 'win32') return; // taskkill /F is already unconditional
      if (!Number.isInteger(child.pid) || child.pid <= 0) return; // nothing to escalate against
      // Ref'd on purpose (fix-wave Important #7 round 2): the SIGKILL
      // escalation must be guaranteed to run before the process can exit. It
      // is cleared at settlement (cleanup), and settlement is itself delayed
      // until the group is confirmed reaped, so this can neither be abandoned
      // (the round-1 unref'd bug) nor hang (the reap wait is bounded).
      killGraceTimer = setTimeout(() => {
        safeKill('SIGKILL');
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
      // 'close' arrived, so the real exit code is known and settlement is
      // already bounded (immediately, or by settleAfterGroupDeath's own
      // deadline). Disarm the backstop so it can never pre-empt that with a
      // null-exit-code result mid-reap; it exists only for the case where this
      // event never fires at all.
      if (settleDeadlineTimer) {
        clearTimeout(settleDeadlineTimer);
        settleDeadlineTimer = null;
      }
      const partial = {
        status: outcomeStatus || (exitCode === 0 ? 'ok' : 'failed'),
        exitCode,
        signalName,
      };
      // Fix-wave Important #7 (round 2): if we asked the tree to terminate,
      // don't resolve on the direct child's close alone — a grandchild that
      // ignored SIGTERM may still be alive in the group. Wait until the whole
      // group is confirmed gone (past the SIGKILL escalation), bounded, so the
      // caller/CLI never exits before the escalation has taken effect. A plain
      // (non-terminating) close resolves immediately as before.
      if (outcomeStatus && watchGroupDeath && Number.isInteger(child.pid) && child.pid > 0) {
        settleAfterGroupDeath(partial);
      } else {
        finish(partial);
      }
    });
  });
}
