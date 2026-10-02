import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeRepeat } from '../lib/repeat-mistake.mjs';

test('missing when delivered or rejected is empty, blank, or null', () => {
  assert.deepEqual(
    judgeRepeat({
      testsPassed: true,
      delivered: '',
      rejected: 'raw concatenation',
      applies: 'sql concatenation',
      doesNotApply: '',
    }),
    { ok: false, reason: 'missing' },
  );
  assert.deepEqual(
    judgeRepeat({
      testsPassed: false,
      delivered: 'handler still builds sql with raw concatenation',
      rejected: '   ',
      applies: 'sql concatenation',
      doesNotApply: '',
    }),
    { ok: false, reason: 'missing' },
  );
  assert.deepEqual(
    judgeRepeat({
      testsPassed: true,
      delivered: null,
      rejected: null,
      applies: 'sql concatenation',
      doesNotApply: 'kubernetes ingress',
    }),
    { ok: false, reason: 'missing' },
  );
});

test('tests-failed when testsPassed is not true, even if the rejected text is present', () => {
  const present = {
    delivered: 'handler still builds sql with raw concatenation',
    rejected: 'raw concatenation',
    applies: 'sql concatenation',
    doesNotApply: '',
  };
  assert.deepEqual(judgeRepeat({ ...present, testsPassed: false }), {
    ok: false,
    reason: 'tests-failed',
  });
  assert.deepEqual(judgeRepeat({ ...present, testsPassed: 'true' }), {
    ok: false,
    reason: 'tests-failed',
  });
  assert.deepEqual(judgeRepeat({ ...present, testsPassed: undefined }), {
    ok: false,
    reason: 'tests-failed',
  });
});

test('out-of-scope when delivered overlaps doesNotApply at least as much as applies', () => {
  assert.deepEqual(
    judgeRepeat({
      testsPassed: true,
      delivered: 'rotate kubernetes ingress and also use raw sql concatenation',
      rejected: 'raw sql concatenation',
      applies: 'sql concatenation',
      doesNotApply: 'kubernetes ingress tls rotation',
    }),
    { ok: true, reason: 'out-of-scope' },
  );
});

test('repeated-mistake when tests passed, the trimmed rejected text is present, and applies wins the overlap', () => {
  assert.deepEqual(
    judgeRepeat({
      testsPassed: true,
      delivered: 'handler still builds sql with raw concatenation',
      rejected: 'raw concatenation',
      applies: 'sql concatenation',
      doesNotApply: '',
    }),
    { ok: false, reason: 'repeated-mistake' },
  );
  assert.deepEqual(
    judgeRepeat({
      testsPassed: true,
      delivered: 'handler still builds sql with raw concatenation and mentions kubernetes',
      rejected: '  raw concatenation  ',
      applies: 'sql concatenation query injection',
      doesNotApply: 'kubernetes ingress',
    }),
    { ok: false, reason: 'repeated-mistake' },
  );
});

test('clear when the rejected text is absent, or applies is empty', () => {
  assert.deepEqual(
    judgeRepeat({
      testsPassed: true,
      delivered: 'uses parameterized queries',
      rejected: 'raw sql concatenation',
      applies: 'sql concatenation',
      doesNotApply: 'kubernetes ingress',
    }),
    { ok: true, reason: 'clear' },
  );
  assert.deepEqual(
    judgeRepeat({
      testsPassed: true,
      delivered: 'handler uses Raw Concatenation today',
      rejected: 'raw concatenation',
      applies: 'sql concatenation',
      doesNotApply: '',
    }),
    { ok: true, reason: 'clear' },
  );
  assert.deepEqual(
    judgeRepeat({
      testsPassed: true,
      delivered: 'handler still builds sql with raw concatenation',
      rejected: 'raw concatenation',
      applies: '   ',
      doesNotApply: '',
    }),
    { ok: true, reason: 'clear' },
  );
});
