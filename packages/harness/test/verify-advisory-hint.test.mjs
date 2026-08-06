// An advisory check cannot move verify's outcome, so it must not be counted
// as a gating failure or offered as the next fix target — otherwise a run that
// genuinely failed on a gating check points the agent at the one check that
// can never unblock it. Advisory failures stay visible as rows and in the
// evidence payload's `advisoryFailures`.

import test from 'node:test';
import assert from 'node:assert/strict';
// The PRODUCTION predicate, imported rather than restated: a copy here could go
// on passing while `harness verify`'s own counting drifted away from it.
import { isGatingCheck as gating } from '../lib/verify.mjs';

test('advisory and skipped checks are neither counted nor offered as the next fix', () => {
  const checks = [
    { id: 'structural-expectations', status: 'failed', severity: 'advisory', message: '2 structural findings' },
    { id: 'plan-schema', status: 'skipped', severity: 'enforce', message: 'no schema output planned' },
    { id: 'required-reviews', status: 'failed', severity: 'enforce', message: 'security-sentinel not completed' },
    { id: 'scope', status: 'failed', severity: 'enforce', message: 'changed file outside Impacted Files' },
  ];

  const failed = checks.filter(gating);
  assert.equal(failed.length, 2, 'only the two enforce-severity failures count');
  assert.deepEqual(
    failed.map((c) => c.id),
    ['required-reviews', 'scope'],
    'advisory and skipped are excluded from the failure count'
  );
  assert.equal(checks.find(gating).id, 'required-reviews', 'the next fix target is the first gating failure');
});

test('a run whose only failure is advisory offers no fix target', () => {
  const checks = [
    { id: 'structural-expectations', status: 'failed', severity: 'advisory', message: 'advisory finding' },
    { id: 'scope', status: 'passed', severity: 'enforce', message: 'ok' },
  ];
  assert.equal(checks.filter(gating).length, 0);
  assert.equal(checks.find(gating), undefined);
});

test('a check with no severity field is treated as gating', () => {
  // Callers that predate policy v2 pass no severity; those must keep counting.
  const checks = [{ id: 'harness-tests', status: 'failed', message: 'suite failed' }];
  assert.equal(checks.filter(gating).length, 1);
});
