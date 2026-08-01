#!/usr/bin/env node
/**
 * Immutable in-sandbox command runner for the Harbor bridge.
 *
 * Drains stdout/stderr concurrently into byte-bounded tail rings and emits a
 * single finite JSON envelope. This file and its Node runtime are mounted
 * read-only, so a root-capable task cannot replace the limiter between calls.
 */
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(125);
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(`invalid ${label}`);
  return parsed;
}

function appendTail(state, chunk) {
  state.total += chunk.length;
  if (chunk.length >= state.cap) {
    state.chunks = [chunk.subarray(chunk.length - state.cap)];
    state.length = state.cap;
    state.truncated = state.total > state.cap;
    return;
  }
  state.chunks.push(chunk);
  state.length += chunk.length;
  while (state.length > state.cap && state.chunks.length) {
    const excess = state.length - state.cap;
    const first = state.chunks[0];
    if (first.length <= excess) {
      state.chunks.shift();
      state.length -= first.length;
    } else {
      state.chunks[0] = first.subarray(excess);
      state.length -= excess;
    }
  }
  if (state.total > state.cap) state.truncated = true;
}

const [, , encodedCommand, stdoutCapValue, stderrCapValue, timeoutValue] = process.argv;
if (!encodedCommand || stdoutCapValue == null || stderrCapValue == null || timeoutValue == null) {
  fail('usage: bounded-exec <base64-command> <stdout-cap> <stderr-cap> <timeout-ms>');
}
let command;
try {
  command = Buffer.from(encodedCommand, 'base64').toString('utf8');
  if (Buffer.from(command, 'utf8').toString('base64').replace(/=+$/, '') !== encodedCommand.replace(/=+$/, '')) {
    fail('invalid base64 command');
  }
} catch {
  fail('invalid base64 command');
}
const stdoutCap = integer(stdoutCapValue, 'stdout cap', { min: 1, max: 2 * 1024 * 1024 });
const stderrCap = integer(stderrCapValue, 'stderr cap', { min: 1, max: 2 * 1024 * 1024 });
const timeoutMs = integer(timeoutValue, 'timeout', { min: 0, max: 24 * 60 * 60 * 1000 });
const stdout = { cap: stdoutCap, total: 0, length: 0, chunks: [], truncated: false };
const stderr = { cap: stderrCap, total: 0, length: 0, chunks: [], truncated: false };

const containmentMode = process.platform === 'linux' ? 'linux-process-census' : 'process-group-nonlinux';
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (milliseconds) => Atomics.wait(sleepArray, 0, 0, milliseconds);

/**
 * Return immutable Linux process identities from procfs. PID alone is unsafe
 * because it can be reused between the baseline and cleanup; starttime makes
 * the identity unique for the lifetime of this sandbox. Numeric entries that
 * disappear while they are read are benign. Every other read/parse failure is
 * containment uncertainty and therefore fails closed.
 */
function linuxProcessSnapshot() {
  const processes = new Map();
  let names;
  try {
    names = fs.readdirSync('/proc');
  } catch (error) {
    throw new Error(`procfs enumeration failed: ${error.code ?? error.message}`);
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let raw;
    try {
      raw = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error?.code)) continue;
      throw new Error(`procfs identity read failed for ${name}: ${error.code ?? error.message}`);
    }
    const delimiter = raw.lastIndexOf(') ');
    const fields = delimiter >= 0 ? raw.slice(delimiter + 2).trim().split(/\s+/) : [];
    const pid = Number(name);
    const state = fields[0];
    const starttime = fields[19];
    if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[A-Z]$/.test(state ?? '') || !/^\d+$/.test(starttime ?? '')) {
      // Confirm whether an apparently malformed entry merely exited between
      // read and parse. A still-present malformed identity makes reuse unsafe.
      if (!fs.existsSync(`/proc/${name}`)) continue;
      throw new Error(`procfs identity is malformed for ${name}`);
    }
    const identity = `${pid}:${starttime}`;
    processes.set(identity, { identity, pid, state });
  }
  if (![...processes.values()].some((entry) => entry.pid === process.pid)) {
    throw new Error('procfs census does not contain the trusted runner');
  }
  return processes;
}

let baseline = null;
if (process.platform === 'linux') {
  try {
    baseline = linuxProcessSnapshot();
  } catch (error) {
    fail(`command containment baseline failed: ${error.message}`);
  }
}

const child = spawn('/bin/sh', ['-c', command], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => appendTail(stdout, chunk));
child.stderr.on('data', (chunk) => appendTail(stderr, chunk));

let cleanupFailure = null;
function processGroupAbsent() {
  if (!Number.isInteger(child.pid) || child.pid <= 0 || process.platform === 'win32') return false;
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    if (error?.code !== 'EPERM' || !fs.existsSync('/bin/ps')) return false;
    // macOS can return EPERM for a just-reaped negative process group. Prove
    // absence with a bounded, absolute-path process census; never infer it
    // merely from EPERM.
    const census = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (census.status !== 0 || census.error || typeof census.stdout !== 'string') return false;
    for (const line of census.stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (match && Number(match[2]) === child.pid) return false;
    }
    return true;
  }
}

function signalProcessGroup(signal = 'SIGKILL') {
  try {
    if (!Number.isInteger(child.pid) || child.pid <= 0) throw Object.assign(new Error('missing child pid'), { code: 'EINVAL' });
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    // `exit` and `close` can race on macOS. An idempotent second cleanup may
    // report EPERM even after the first kill removed the group; accept it only
    // when an independent signal-0 probe proves that the group is absent.
    if (error?.code === 'EPERM' && processGroupAbsent()) return true;
    cleanupFailure ??= error?.code ?? 'UNKNOWN';
    return false;
  }
}

function postBaselineProcesses() {
  const current = linuxProcessSnapshot();
  return [...current.values()].filter((entry) =>
    entry.pid !== process.pid && !baseline.has(entry.identity) && !['Z', 'X'].includes(entry.state)
  );
}

function signalProcesses(entries, signal, stopped = null) {
  let complete = true;
  for (const entry of entries) {
    try {
      process.kill(entry.pid, signal);
      if (stopped) stopped.add(entry.identity);
    } catch (error) {
      if (!['ESRCH', 'ENOENT'].includes(error?.code)) {
        cleanupFailure ??= error?.code ?? 'UNKNOWN';
        complete = false;
      }
    }
  }
  return complete;
}

/**
 * A command may double-fork, reparent, or create a new session. Process-group
 * cleanup alone cannot prove those descendants are gone. In the dedicated,
 * serial Harbor sandbox every process created after this immutable runner's
 * baseline belongs to the current command. Freeze the complete post-baseline
 * set until it is stable, then kill it and require an empty active census.
 */
function containLinuxProcesses() {
  let complete = signalProcessGroup('SIGKILL');
  const stopped = new Set();
  try {
    let stabilized = false;
    for (let pass = 0; pass < 100; pass += 1) {
      const active = postBaselineProcesses();
      const unstopped = active.filter((entry) => !stopped.has(entry.identity));
      complete = signalProcesses(unstopped, 'SIGSTOP', stopped) && complete;
      const after = postBaselineProcesses();
      if (after.every((entry) => stopped.has(entry.identity))) {
        stabilized = true;
        break;
      }
      sleepSync(2);
    }
    if (!stabilized) complete = false;
    complete = signalProcesses(postBaselineProcesses(), 'SIGKILL') && complete;
    for (let pass = 0; pass < 100; pass += 1) {
      const remaining = postBaselineProcesses();
      if (remaining.length === 0) return complete;
      complete = signalProcesses(remaining, 'SIGKILL') && complete;
      sleepSync(2);
    }
    return false;
  } catch (error) {
    cleanupFailure ??= error?.code ?? error?.message ?? 'PROCFS';
    return false;
  }
}

let containmentComplete = true;
function containCommand() {
  const complete = process.platform === 'linux' ? containLinuxProcesses() : signalProcessGroup('SIGKILL');
  containmentComplete = containmentComplete && complete;
  return complete;
}

let timedOut = false;
let timer = null;
if (timeoutMs > 0) {
  timer = setTimeout(() => {
    timedOut = true;
    containCommand();
  }, timeoutMs);
  timer.unref();
}

child.on('error', (error) => fail(`command spawn failed: ${error.message}`));
// A background descendant can inherit the pipes and delay `close` after the
// command shell exits. Kill the detached group at `exit`; `close` below waits
// for the streams to drain before publishing the result.
child.on('exit', () => {
  containCommand();
});
child.on('close', (code, signal) => {
  if (timer) clearTimeout(timer);
  containCommand();
  if (cleanupFailure) appendTail(stderr, Buffer.from(`\ncommand containment cleanup failed (${cleanupFailure})\n`, 'utf8'));
  const explicitTimedOut = timedOut;
  const complete = cleanupFailure == null && containmentComplete;
  const signalNumber = signal ? os.constants.signals[signal] ?? 1 : 0;
  const exitCode = !complete ? 125 : timedOut ? 124 : Number.isInteger(code) ? code : 128 + signalNumber;
  process.stdout.write(
    JSON.stringify({
      version: 1,
      code: exitCode,
      stdoutB64: Buffer.concat(stdout.chunks, stdout.length).toString('base64'),
      stderrB64: Buffer.concat(stderr.chunks, stderr.length).toString('base64'),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut: explicitTimedOut,
      containmentMode,
      containmentComplete: complete,
    })
  );
});
