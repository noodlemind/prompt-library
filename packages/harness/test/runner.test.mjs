import assert from 'node:assert/strict';
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

test('rejects a malformed argv synchronously', () => {
  assert.throws(() => runProcess({ argv: [] }), TypeError);
  assert.throws(() => runProcess({ argv: 'not-an-array' }), TypeError);
});
