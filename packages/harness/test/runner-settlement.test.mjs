import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { runProcess } from '../lib/runner.mjs';

function fakeChild(pid = 515151) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = null;
  child.stderr = null;
  return child;
}

test('a timed-out run settles even when the child never emits close', { timeout: 10000 }, async () => {
  const child = fakeChild();
  const signals = [];

    const result = await runProcess({
    argv: ['fake-cmd'],
    timeoutMs: 10,
    platform: 'linux',
    killGraceMs: 10,
    groupReapTimeoutMs: 20,
    spawnFn: () => child,
    killFn: (pid, sig) => signals.push(sig),
  });

  assert.equal(result.status, 'timed-out', 'the timeout outcome is reported, never collapsed into failed');
  assert.equal(result.exitCode, null, 'no exit code was ever observed — the child never closed');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'the escalation still ran before the backstop settled');
});

test('a cancelled run settles even when the child never emits close', { timeout: 10000 }, async () => {
  const child = fakeChild();
  const controller = new AbortController();

  const pending = runProcess({
    argv: ['fake-cmd'],
    signal: controller.signal,
    platform: 'linux',
    killGraceMs: 10,
    groupReapTimeoutMs: 20,
    spawnFn: () => child,
    killFn: () => {},
  });
  controller.abort();

  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.signalName, null);
});

test('a terminated run that DOES close reports the real exit code and signal, not the backstop shape', { timeout: 10000 }, async () => {
  const child = fakeChild();
  const pending = runProcess({
    argv: ['fake-cmd'],
    timeoutMs: 5,
    platform: 'linux',
    killGraceMs: 50,
    groupReapTimeoutMs: 50,
    spawnFn: () => child,
    killFn: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the timeout fire and terminate
  child.emit('close', 143, 'SIGTERM');

  const result = await pending;
  assert.equal(result.status, 'timed-out');
  assert.equal(result.exitCode, 143, 'the close-reported exit code survives — the backstop did not settle first');
  assert.equal(result.signalName, 'SIGTERM');
});

test('an ordinary (never-terminated) run is untouched: close still settles with its own outcome', { timeout: 10000 }, async () => {
  const child = fakeChild();
  const pending = runProcess({
    argv: ['fake-cmd'],
    platform: 'linux',
    spawnFn: () => child,
    killFn: () => {
      throw new Error('nothing may be killed on a clean run');
    },
  });
  child.emit('close', 0, null);

  const result = await pending;
  assert.equal(result.status, 'ok');
  assert.equal(result.exitCode, 0);
});
