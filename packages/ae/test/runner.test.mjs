import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
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
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
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

for (const termination of [
  { status: 'confirmed', exitCode: 0 },
  { status: 'failed', exitCode: 1 },
  undefined,
]) {
  test(`Windows reap requires confirmed tree termination and child closure (${termination?.status || 'unknown'})`, async () => {
    const child = new EventEmitter();
    child.pid = 424244;
    const controller = new AbortController();
    const pending = runProcess({ argv: ['fake'], spawnFn: () => child, platform: 'win32', signal: controller.signal,
      killFn: () => termination, killGraceMs: 1, groupReapTimeoutMs: 10 });
    controller.abort();
    child.emit('close', 0, null);
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.groupReaped, termination?.status === 'confirmed' ? true : termination?.status === 'failed' ? false : null);
    assert.equal(result.treeTermination?.status, termination?.status || 'unknown');
  });
}

test('Windows successful taskkill without child closure does not prove reap', async () => {
  const child = new EventEmitter();
  child.pid = 424245;
  const controller = new AbortController();
  const pending = runProcess({ argv: ['fake'], spawnFn: () => child, platform: 'win32', signal: controller.signal,
    killFn: () => ({ status: 'confirmed', exitCode: 0 }), killGraceMs: 1, groupReapTimeoutMs: 10 });
  controller.abort();
  assert.equal((await pending).groupReaped, false);
});

test('Windows cooperative notice reaches the owned process before the bounded force-kill fallback', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cooperative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cancellationFile = path.join(root, 'cancel.json');
  const child = new EventEmitter();
  child.pid = 424246;
  const controller = new AbortController();
  let killCalls = 0;
  let spawnedEnv;
  const pending = runProcess({ argv: ['fake'], platform: 'win32', cancellationFile, signal: controller.signal,
    spawnFn: (_cmd, _args, options) => { spawnedEnv = options.env; return child; }, killFn: () => { killCalls++; return { status: 'confirmed' }; }, killGraceMs: 30, groupReapTimeoutMs: 10 });
  controller.abort();
  assert.equal(spawnedEnv.HARNESS_RUN_CANCEL_FILE, cancellationFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(cancellationFile)), { version: 1, pid: child.pid });
  assert.equal(killCalls, 0);
  child.emit('close', 1, null);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.groupReaped, null);
  assert.equal(result.cancellationNotice.requested, true);
  await delay(40);
  assert.equal(killCalls, 0, 'a closed cooperative process must never be killed later by its recycled PID');
});

test('Windows uncooperative notice falls back to a confirmed tree kill after grace', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-force-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 424247;
  const controller = new AbortController();
  let killed = false;
  const pending = runProcess({ argv: ['fake'], platform: 'win32', cancellationFile: path.join(root, 'cancel.json'), signal: controller.signal,
    spawnFn: () => child, killFn: () => { killed = true; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return { status: 'confirmed' }; }, killGraceMs: 10, groupReapTimeoutMs: 100 });
  controller.abort();
  assert.equal(killed, false);
  const result = await pending;
  assert.equal(killed, true);
  assert.equal(result.groupReaped, true);
});

test('an existing cancellation notice cannot be overwritten and force-kill failure stays visible', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-notice-conflict-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cancellationFile = path.join(root, 'cancel.json');
  fs.writeFileSync(cancellationFile, 'foreign bytes');
  const child = new EventEmitter();
  child.pid = 424248;
  const controller = new AbortController();
  const pending = runProcess({ argv: ['fake'], platform: 'win32', cancellationFile, signal: controller.signal,
    spawnFn: () => child, killFn: () => { queueMicrotask(() => child.emit('close', 0, null)); return { status: 'failed', exitCode: 1 }; } });
  controller.abort();
  const result = await pending;
  assert.equal(result.cancellationNotice.requested, false);
  assert.equal(result.cancellationNotice.errorCode, 'EEXIST');
  assert.equal(fs.readFileSync(cancellationFile, 'utf8'), 'foreign bytes');
  assert.equal(result.groupReaped, false);
});

test('native Windows cancellation kills the owned process', { skip: !isWin32 }, async t => {
  const controller = new AbortController();
  let ready;
  const readiness = new Promise(resolve => { ready = resolve; });
  let childPid;
  let grandchildPid;
  const script = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);";
  const pending = runProcess({ argv: [process.execPath, '-e', script], signal: controller.signal,
    onSpawn: details => { childPid = details.pid; }, onStdout: chunk => { const pid = Number(String(chunk).trim()); if (Number.isInteger(pid) && pid > 0) { grandchildPid = pid; ready(); } } });
  t.after(() => controller.abort());
  await Promise.race([readiness, pending.then(result => { throw new Error(`tree ended before probe: ${JSON.stringify(result)}`); })]);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(await waitForProcessGone(childPid), true);
  if (grandchildPid) {
    try { process.kill(grandchildPid); } catch { /* already gone */ }
  }
});

const PLATFORM_INJECTED_ENV_KEYS = {
  darwin: ['__CF_USER_TEXT_ENCODING'],
  win32: [
    'HOMEDRIVE',
    'HOMEPATH',
    'LOGONSERVER',
    'PATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
  ],
};

test('env passed explicitly is used as-is, not merged with process.env', async () => {
    process.env.HARNESS_RUNNER_ENV_LEAK_PROBE = 'parent-only';
  try {
    const result = await runProcess({
      argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
      env: { ONLY_VAR: 'present' },
    });
    assert.equal(result.status, 'ok');
    const seenEnv = JSON.parse(result.stdout);
    assert.equal(seenEnv.ONLY_VAR, 'present');
    assert.equal(
      seenEnv.HARNESS_RUNNER_ENV_LEAK_PROBE,
      undefined,
      'runProcess must never merge process.env into an explicitly supplied env'
    );
        const fold = isWin32 ? (key) => key.toUpperCase() : (key) => key;
    const injected = new Set((PLATFORM_INJECTED_ENV_KEYS[process.platform] || []).map(fold));
    const leaked = Object.keys(seenEnv).filter((key) => key !== 'ONLY_VAR' && !injected.has(fold(key)));
    assert.deepEqual(leaked, [], `only ONLY_VAR plus platform-injected keys may reach the child; leaked: ${leaked.join(', ')}`);
    if (isWin32) {
            const seenPathKey = Object.keys(seenEnv).find((key) => key.toUpperCase() === 'PATH');
      assert.ok(seenPathKey, 'win32: libuv must inject PATH into the child environment block');
      assert.equal(seenEnv[seenPathKey], process.env.PATH, "win32 PATH must be libuv's verbatim copy of the parent PATH");
    } else {
      assert.equal(seenEnv.PATH, undefined);
      assert.equal(seenEnv.HOME, undefined);
    }
  } finally {
    delete process.env.HARNESS_RUNNER_ENV_LEAK_PROBE;
  }
});

test('throws on a malformed argv synchronously', () => {
  assert.throws(() => runProcess({ argv: [] }), TypeError);
  assert.throws(() => runProcess({ argv: 'not-an-array' }), TypeError);
});

test('abort right after a failed spawn settles with a structured outcome — no ERR_INVALID_ARG_TYPE crash', async () => {
  const controller = new AbortController();
  const resultPromise = runProcess({
    argv: ['/definitely/not/a/real/executable-harness-fixwave'],
    signal: controller.signal,
  });
    controller.abort();
  const result = await resultPromise;
    assert.equal(result.status, 'cancelled');
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, '');
});

test('a plain failed spawn (no abort) still settles as failed', async () => {
  const result = await runProcess({ argv: ['/definitely/not/a/real/executable-harness-fixwave'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, null);
});

test('a provenance callback failure terminates and reaps the owned process group', async () => {
  let pid;
  const result = await runProcess({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'], onSpawn: details => { pid = details.pid; throw new Error('durable provenance failed'); }, killGraceMs: 20 });
  assert.equal(result.status, 'failed');
  assert.equal(result.groupReaped, true);
  assert.equal(processExists(pid), false);
  assert.match(result.provenanceError, /durable provenance failed/);
});

test('group reap deadline reports a surviving group without inventing safe recovery', async () => {
  const child = new EventEmitter(); child.pid = 424243; child.stdout = null; child.stderr = null;
  const controller = new AbortController();
  const pending = runProcess({ argv: ['fake'], spawnFn: () => child, platform: 'linux', signal: controller.signal, killFn: () => {}, groupAliveFn: () => true, killGraceMs: 1, groupReapTimeoutMs: 10 });
  controller.abort(); child.emit('close', null, 'SIGTERM');
  assert.equal((await pending).groupReaped, false);
});

test('a throwing killFn never breaks the always-resolve contract', async () => {
  const controller = new AbortController();
  const resultPromise = runProcess({
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 400)'],
    signal: controller.signal,
    killGraceMs: 50,
    killFn: () => {
      throw new Error('faulty termination primitive');
    },
  });
  await delay(50);
  controller.abort(); // pre-fix: the throw propagated out of the abort listener
    const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
});

test('a cancelled run does not settle until the SIGKILL escalation has reaped the group (deterministic, injected probe)', async () => {
  const calls = [];
  const controller = new AbortController();
  const fakeChild = new EventEmitter();
  fakeChild.pid = 424242;
  fakeChild.stdout = null;
  fakeChild.stderr = null;

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
        assert.ok(
      !processExists(grandchildPid),
      `grandchild pid ${grandchildPid} must be reaped BEFORE the run settles`
    );
        assert.ok(
      result.durationMs >= killGraceMs - 100,
      `settlement (${result.durationMs}ms) must span the SIGKILL grace (${killGraceMs}ms) — proof the escalation path ran`
    );
  }
);
