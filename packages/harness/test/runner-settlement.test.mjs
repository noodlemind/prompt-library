/**
 * lib/runner.mjs's always-resolves contract, for the one path that had no
 * settlement guarantee at all.
 *
 * Every settlement route hung off `child.on('close')`, which fires only once
 * the child has exited AND its stdio pipes are closed. A descendant that
 * inherited stdout/stderr and escaped the process group (setsid, double-fork)
 * keeps those pipes open, so 'close' never arrives — and `timeoutTimer` only
 * calls `terminateTree`, which kills but never settles. `runProcess` then
 * never resolved, contradicting its own module contract.
 *
 * The fix is a bounded backstop armed when termination begins, spending the
 * same two dials the ordinary terminated path already spends (killGraceMs for
 * the SIGKILL escalation, then groupReapTimeoutMs for the reap window). It is
 * disarmed on 'close', so a run that settles normally never touches it.
 *
 * Every test here uses an injected fake child, so nothing depends on real
 * process-group behavior or wall-clock luck.
 */
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

  // No 'close' is ever emitted: the direct child is gone, but a descendant
  // outside the process group still holds the inherited stdout/stderr pipes.
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

// The backstop must never pre-empt a real outcome: once 'close' arrives the
// exit code is known and settlement is already bounded, so the deadline is
// disarmed rather than racing the group-reap poll.
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
