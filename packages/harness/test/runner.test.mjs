import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { runProcess } from '../lib/runner.mjs';

const isWin32 = process.platform === 'win32';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessGone(pid, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!processExists(pid)) return true;
    await delay(25);
  }
  return false;
}

test('resolves with status ok on a clean zero exit', async () => {
  const result = await runProcess({ argv: [process.execPath, '-e', 'process.exit(0)'] });
  assert.equal(result.status, 'ok');
  assert.equal(result.exitCode, 0);
  assert.equal(result.signalName, null);
  assert.equal(result.truncated, false);
  assert.equal(typeof result.durationMs, 'number');
});

test('resolves with status failed on a nonzero exit', async () => {
  const result = await runProcess({ argv: [process.execPath, '-e', 'process.exit(7)'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
});

test('onStdout/onStderr stream live chunks that match the buffered result', async () => {
  const stdoutChunks = [];
  const stderrChunks = [];
  const script =
    "process.stdout.write('hello '); process.stdout.write('world\\n'); process.stderr.write('oops\\n');";
  const result = await runProcess({
    argv: [process.execPath, '-e', script],
    onStdout: (chunk) => stdoutChunks.push(chunk),
    onStderr: (chunk) => stderrChunks.push(chunk),
  });
  assert.equal(result.status, 'ok');
  assert.equal(stdoutChunks.join(''), result.stdout);
  assert.equal(stderrChunks.join(''), result.stderr);
  assert.equal(result.stdout, 'hello world\n');
  assert.equal(result.stderr, 'oops\n');
});

// P1.6 (carry-list c): a throwing onStdout/onStderr must not take the
// buffered result down with it.
test('a throwing onStdout/onStderr does not break buffering or the resolved result', async () => {
  const script = "process.stdout.write('hi\\n'); process.stderr.write('bye\\n');";
  const result = await runProcess({
    argv: [process.execPath, '-e', script],
    onStdout: () => {
      throw new Error('boom stdout');
    },
    onStderr: () => {
      throw new Error('boom stderr');
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.stdout, 'hi\n');
  assert.equal(result.stderr, 'bye\n');
});

test('maxBuffer truncates buffered stdout at a line boundary', async () => {
  const script = "for (let i = 0; i < 5000; i++) process.stdout.write('x'.repeat(50) + '\\n');";
  const result = await runProcess({
    argv: [process.execPath, '-e', script],
    maxBuffer: 500,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 500, `expected stdout <= 500 chars, got ${result.stdout.length}`);
  assert.ok(result.stdout.length > 0);
  assert.ok(result.stdout.endsWith('\n'), 'truncated stdout must end on a full line');
});

test('timed-out kills the tree and reports status timed-out, not failed', async () => {
  const startedAt = Date.now();
  const result = await runProcess({
    argv: ['sleep', '5'],
    timeoutMs: 150,
  });
  assert.equal(result.status, 'timed-out');
  assert.ok(Date.now() - startedAt < 4000, 'timeout should fire well before the 5s sleep completes');
});

test(
  'cancelled via AbortSignal kills the whole descendant tree, not just the direct child',
  { skip: isWin32 ? 'POSIX process-group semantics only' : false },
  async () => {
    const controller = new AbortController();
    let descendantPid = null;
    let signalPidSeen;
    const pidSeen = new Promise((resolve) => {
      signalPidSeen = resolve;
    });

    const resultPromise = runProcess({
      argv: ['/bin/sh', '-c', 'sleep 30 & echo $!; wait'],
      signal: controller.signal,
      onStdout: (chunk) => {
        const match = chunk.match(/(\d+)/);
        if (match && descendantPid === null) {
          descendantPid = Number(match[1]);
          signalPidSeen();
        }
      },
    });

    await pidSeen;
    controller.abort();

    const result = await resultPromise;
    assert.equal(result.status, 'cancelled');

    const gone = await waitForProcessGone(descendantPid);
    assert.ok(gone, `descendant pid ${descendantPid} should have been terminated with the tree`);
  }
);

test(
  'escalates to SIGKILL after the grace period when SIGTERM is ignored',
  { skip: isWin32 ? 'SIGTERM escalation is POSIX-only' : false },
  async () => {
    const controller = new AbortController();
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const resultPromise = runProcess({
      argv: [process.execPath, '-e', script],
      signal: controller.signal,
      killGraceMs: 150,
    });
    // Give the child a moment to install its SIGTERM handler before we abort.
    await delay(300);
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.signalName, 'SIGKILL');
  }
);

test('cancellation status wins over exit code even when the signal fires last-second', async () => {
  const controller = new AbortController();
  const resultPromise = runProcess({
    argv: [process.execPath, '-e', 'process.exit(0)'],
    signal: controller.signal,
  });
  controller.abort();
  const result = await resultPromise;
  // Either the process already exited 0 before the abort raced in, or it was
  // killed — either way, once aborted the status must never read as 'failed'.
  assert.notEqual(result.status, 'failed');
});

test('a pre-aborted signal resolves as cancelled without spawning', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runProcess({
    argv: [process.execPath, '-e', 'process.exit(0)'],
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stdout, '');
});

test('win32 termination path calls killFn once with no POSIX-style escalation', async () => {
  const controller = new AbortController();
  const calls = [];
  const resultPromise = runProcess({
    argv: ['sleep', '5'],
    signal: controller.signal,
    platform: 'win32',
    killFn: (pid, sig, plat) => {
      calls.push({ pid, sig, plat });
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    },
  });
  await delay(50);
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plat, 'win32');
});

test('env passed explicitly is used as-is, not merged with process.env', async () => {
  const result = await runProcess({
    argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
    env: { ONLY_VAR: 'present' },
  });
  assert.equal(result.status, 'ok');
  const seenEnv = JSON.parse(result.stdout);
  assert.equal(seenEnv.ONLY_VAR, 'present');
  // Proof of no implicit merge: nothing from this process's own env (e.g.
  // PATH, HOME) leaked through. (macOS's loader injects its own
  // __CF_USER_TEXT_ENCODING below the application layer regardless of the
  // env object handed to spawn, so that one key is not diagnostic here.)
  assert.equal(seenEnv.PATH, undefined);
  assert.equal(seenEnv.HOME, undefined);
  assert.deepEqual(Object.keys(seenEnv).filter((key) => key !== '__CF_USER_TEXT_ENCODING'), ['ONLY_VAR']);
});

test('throws on a malformed argv synchronously', () => {
  assert.throws(() => runProcess({ argv: [] }), TypeError);
  assert.throws(() => runProcess({ argv: 'not-an-array' }), TypeError);
});

// --- Fix-wave Important #6: abort after a failed spawn must not crash ------
//
// Verified pre-fix crash: spawning a nonexistent executable leaves
// `child.pid` undefined ('error' fires asynchronously, no pid was ever
// assigned); aborting in that window called killFn(undefined, ...) ->
// process.kill(NaN) -> ERR_INVALID_ARG_TYPE thrown from inside the abort
// listener, breaking the always-resolve contract.

test('abort right after a failed spawn settles with a structured outcome — no ERR_INVALID_ARG_TYPE crash', async () => {
  const controller = new AbortController();
  const resultPromise = runProcess({
    argv: ['/definitely/not/a/real/executable-harness-fixwave'],
    signal: controller.signal,
  });
  // Pre-fix this abort() call itself threw (the listener runs synchronously
  // inside it and killFn crashed on the invalid pid).
  controller.abort();
  const result = await resultPromise;
  // The abort was observed before the spawn error surfaced, so the outcome
  // is 'cancelled' — the point is that it SETTLES, structured, either way.
  assert.equal(result.status, 'cancelled');
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, '');
});

test('a plain failed spawn (no abort) still settles as failed', async () => {
  const result = await runProcess({ argv: ['/definitely/not/a/real/executable-harness-fixwave'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, null);
});

test('a throwing killFn never breaks the always-resolve contract', async () => {
  const controller = new AbortController();
  const resultPromise = runProcess({
    argv: ['sleep', '0.4'],
    signal: controller.signal,
    killGraceMs: 50,
    killFn: () => {
      throw new Error('faulty termination primitive');
    },
  });
  await delay(50);
  controller.abort(); // pre-fix: the throw propagated out of the abort listener
  // The child is never actually signalled (killFn throws every time, for
  // SIGTERM and the SIGKILL escalation alike) — it simply finishes its short
  // sleep, and the runner still settles with the cancelled outcome.
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
});

// --- Fix-wave Important #7 (round 2): settlement AWAITS the group reap -------
//
// Pre-fix (round 1), a cancelled/timed-out run resolved on the direct child's
// 'close' and only left an UNREF'd SIGKILL timer armed — so the CLI, which
// awaits this promise and then calls process.exit, exited before the escalation
// fired and a grandchild that ignored SIGTERM survived. A re-probe saw only
// SIGTERM at exit, never the scheduled SIGKILL. The fix: the run does not
// resolve 'cancelled'/'timed-out' until the whole process GROUP is confirmed
// gone (past the SIGKILL escalation), bounded by groupReapTimeoutMs. Both tests
// below assert settlement itself waits for the reap — neither relies on the
// test's own event loop keeping the process alive for an unref'd timer.

test('a cancelled run does not settle until the SIGKILL escalation has reaped the group (deterministic, injected probe)', async () => {
  const calls = [];
  const controller = new AbortController();
  const fakeChild = new EventEmitter();
  fakeChild.pid = 424242;
  fakeChild.stdout = null;
  fakeChild.stderr = null;

  // The injected group probe reports the group ALIVE until a SIGKILL is
  // delivered — modelling a grandchild that ignores SIGTERM. The run must keep
  // polling and must NOT resolve until the escalation has actually taken
  // effect.
  let sigkilled = false;
  const resultPromise = runProcess({
    argv: ['fake-cmd'],
    signal: controller.signal,
    platform: 'linux',
    killGraceMs: 100,
    groupReapTimeoutMs: 5000,
    spawnFn: () => fakeChild,
    killFn: (pid, sig, plat) => {
      calls.push({ pid, sig, plat });
      if (sig === 'SIGKILL') sigkilled = true;
    },
    groupAliveFn: () => !sigkilled,
  });

  controller.abort(); // SIGTERM the group, arm the 100ms SIGKILL escalation
  fakeChild.emit('close', null, 'SIGTERM'); // direct child dies immediately

  // Pre-fix this resolved right here, with calls === ['SIGTERM'] and the
  // SIGKILL escalation abandoned. Post-fix it resolves only after the group is
  // reaped, i.e. after SIGKILL — no delay()/keep-alive from the test needed.
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(
    calls.map((c) => c.sig),
    ['SIGTERM', 'SIGKILL'],
    'settlement must await the SIGKILL escalation — pre-fix it resolved on the direct-child close and abandoned it'
  );
  assert.equal(calls[1].pid, 424242, 'escalation targets the same process group');
});

test(
  'a real grandchild that ignores SIGTERM is already SIGKILLed by the time the run settles (settlement awaits the reap, not the test loop)',
  { skip: isWin32 ? 'POSIX process-group semantics only' : false },
  async () => {
    const controller = new AbortController();
    let grandchildPid = null;
    let signalPidSeen;
    const pidSeen = new Promise((resolve) => {
      signalPidSeen = resolve;
    });

    // The grandchild installs a SIGTERM handler and detaches from the stdio
    // pipes (so the parent's 'close' fires the moment the parent dies —
    // exactly the pre-fix regression window). `exec` makes $! the node pid.
    const grandchildScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const killGraceMs = 400;
    const resultPromise = runProcess({
      argv: [
        '/bin/sh',
        '-c',
        `(exec "${process.execPath}" -e "${grandchildScript}" >/dev/null 2>&1) & echo $!; wait`,
      ],
      signal: controller.signal,
      killGraceMs,
      onStdout: (chunk) => {
        const match = chunk.match(/(\d+)/);
        if (match && grandchildPid === null) {
          grandchildPid = Number(match[1]);
          signalPidSeen();
        }
      },
    });

    await pidSeen;
    // Give the grandchild time to boot node and install its SIGTERM handler.
    await delay(500);
    assert.ok(processExists(grandchildPid), 'precondition: the grandchild is alive before we cancel');
    controller.abort();

    const result = await resultPromise; // parent sh dies to SIGTERM -> close fires
    assert.equal(result.status, 'cancelled');
    // The whole point: settlement waited for the group reap, so by the time the
    // await returns the SIGTERM-ignoring grandchild is ALREADY gone. Asserted
    // immediately, with the test doing nothing to keep the loop alive — pre-fix
    // this fired while the grandchild was still very much alive (the escalation
    // was abandoned once the owning process would have exited).
    assert.ok(
      !processExists(grandchildPid),
      `grandchild pid ${grandchildPid} must be reaped BEFORE the run settles`
    );
    // And it genuinely went through the SIGKILL grace (it ignored SIGTERM), so
    // settlement spanned at least the grace period rather than resolving early.
    assert.ok(
      result.durationMs >= killGraceMs - 100,
      `settlement (${result.durationMs}ms) must span the SIGKILL grace (${killGraceMs}ms) — proof the escalation path ran`
    );
  }
);
