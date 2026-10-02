import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCases, validateCase } from '../lib/acceptance.mjs';

const complete = {
  task: 'Rename the local helper that formats plan ids',
  rejected: 'The helper kept the old name at the call site',
  accepted: 'The definition and the call site both use the new name',
  why: 'A rename that leaves a call site behind fails the next build',
  stage: 'implementation',
};

function without(record, field) {
  const copy = { ...record };
  delete copy[field];
  return copy;
}

test('a complete case is ok', () => {
  assert.deepEqual(validateCase(complete), { ok: true });
});

test('each allowed stage is ok when the other fields are present', () => {
  for (const stage of ['discovery', 'context', 'implementation', 'review']) {
    assert.deepEqual(validateCase({ ...complete, stage }), { ok: true });
  }
});

test('a case missing why is not ok and names why', () => {
  assert.deepEqual(validateCase(without(complete, 'why')), {
    ok: false,
    missing: ['why'],
  });
  assert.deepEqual(validateCase({ ...complete, why: '' }), {
    ok: false,
    missing: ['why'],
  });
});

test('a case missing task is not ok and names task', () => {
  assert.deepEqual(validateCase(without(complete, 'task')), {
    ok: false,
    missing: ['task'],
  });
  assert.deepEqual(validateCase({ ...complete, task: '' }), {
    ok: false,
    missing: ['task'],
  });
});

test('a case missing rejected is not ok and names rejected', () => {
  assert.deepEqual(validateCase(without(complete, 'rejected')), {
    ok: false,
    missing: ['rejected'],
  });
  assert.deepEqual(validateCase({ ...complete, rejected: '' }), {
    ok: false,
    missing: ['rejected'],
  });
});

test('a case missing accepted is not ok and names accepted', () => {
  assert.deepEqual(validateCase(without(complete, 'accepted')), {
    ok: false,
    missing: ['accepted'],
  });
  assert.deepEqual(validateCase({ ...complete, accepted: '' }), {
    ok: false,
    missing: ['accepted'],
  });
});

test('a prototype-only field is missing', () => {
  assert.deepEqual(validateCase(Object.create(complete)), {
    ok: false,
    missing: ['task', 'rejected', 'accepted', 'why', 'stage'],
  });
});

test('a stage value of guess is not ok and names stage', () => {
  assert.deepEqual(validateCase({ ...complete, stage: 'guess' }), {
    ok: false,
    missing: ['stage'],
  });
});

test('a case missing why and stage names both fields', () => {
  assert.deepEqual(validateCase({ ...without(complete, 'why'), stage: 'guess' }), {
    ok: false,
    missing: ['why', 'stage'],
  });
});

test('runCases returns one result per case and does not throw on a bad case', () => {
  const results = runCases([
    complete,
    without(complete, 'why'),
    { ...complete, stage: 'guess' },
    null,
  ]);
  assert.deepEqual(results, [
    { ok: true },
    { ok: false, missing: ['why'] },
    { ok: false, missing: ['stage'] },
    { ok: false, missing: ['task', 'rejected', 'accepted', 'why', 'stage'] },
  ]);
});

test('runCases on a non-list returns no results and does not throw', () => {
  assert.deepEqual(runCases(undefined), []);
  assert.deepEqual(runCases(complete), []);
});
