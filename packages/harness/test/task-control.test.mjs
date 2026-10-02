import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideNext } from '../lib/task-control.mjs';

test('an unchanged non-empty attempt is blocked', () => {
  assert.deepEqual(
    decideNext({
      lastAttempt: 'edit src/a.js',
      nextAttempt: 'edit src/a.js',
      failedCheck: '',
    }),
    { action: 'block', reason: 'unchanged-retry' },
  );
});

test('an unchanged attempt blocks even when a failed check is also set', () => {
  assert.deepEqual(
    decideNext({
      lastAttempt: 'edit src/a.js',
      nextAttempt: 'edit src/a.js',
      failedCheck: 'unit',
    }),
    { action: 'block', reason: 'unchanged-retry' },
  );
});

test('a failed check resumes at that check when the attempt changed', () => {
  assert.deepEqual(
    decideNext({
      lastAttempt: 'edit src/a.js',
      nextAttempt: 'edit src/b.js',
      failedCheck: 'unit',
    }),
    { action: 'resume', checkpoint: 'unit' },
  );
});

test('a failed check resumes when the next attempt is empty', () => {
  assert.deepEqual(
    decideNext({
      lastAttempt: 'edit src/a.js',
      nextAttempt: '',
      failedCheck: 'lint',
    }),
    { action: 'resume', checkpoint: 'lint' },
  );
});

test('a changed attempt with no failed check continues', () => {
  assert.deepEqual(
    decideNext({
      lastAttempt: 'edit src/a.js',
      nextAttempt: 'edit src/b.js',
      failedCheck: '',
    }),
    { action: 'continue' },
  );
});

test('empty strings are not an attempt or a failed check', () => {
  assert.deepEqual(
    decideNext({ lastAttempt: '', nextAttempt: '', failedCheck: '' }),
    { action: 'continue' },
  );
});

test('only a non-empty string counts as an attempt or a failed check', () => {
  assert.deepEqual(
    decideNext({ lastAttempt: 1, nextAttempt: 1, failedCheck: 1 }),
    { action: 'continue' },
  );
});
