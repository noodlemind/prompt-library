#!/usr/bin/env node
/**
 * Immutable in-sandbox command runner for the Harbor bridge.
 *
 * Drains stdout/stderr concurrently into byte-bounded tail rings and emits a
 * single finite JSON envelope. This file and its Node runtime are mounted
 * read-only, so a root-capable task cannot replace the limiter between calls.
 */
import { spawn } from 'node:child_process';

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

const child = spawn('/bin/sh', ['-c', command], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => appendTail(stdout, chunk));
child.stderr.on('data', (chunk) => appendTail(stderr, chunk));

let timedOut = false;
let timer = null;
if (timeoutMs > 0) {
  timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }, timeoutMs);
  timer.unref();
}

child.on('error', (error) => fail(`command spawn failed: ${error.message}`));
child.on('close', (code, signal) => {
  if (timer) clearTimeout(timer);
  const exitCode = timedOut ? 124 : Number.isInteger(code) ? code : 128 + (signal ? 1 : 0);
  process.stdout.write(
    JSON.stringify({
      version: 1,
      code: exitCode,
      stdoutB64: Buffer.concat(stdout.chunks, stdout.length).toString('base64'),
      stderrB64: Buffer.concat(stderr.chunks, stderr.length).toString('base64'),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    })
  );
});
