import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { snapshotExperimentInputs, experimentInputsCheck, runExperimentMeasurement, validateExperimentMeasurement, validateExperimentArtifact } from '../lib/experiment-measurement.mjs';
import { runNamedCheck } from '../lib/checks.mjs';
import { approveProject } from '../lib/trust.mjs';
import { experimentDigest, createExperimentInvocation } from '../lib/experiment-contract.mjs';
import { measurementFixture, measurementReservation } from './helpers/experiment-measurement-fixtures.mjs';
import { discoverIntent } from '../lib/intent-sources.mjs';

test('candidate tracking never executes a configured Git filesystem monitor', t => {
  const f = measurementFixture(t), helper = path.join(f.root, 'monitor.sh'), marker = path.join(f.root, 'monitor-called');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf called > '${marker}'\n`, { mode: 0o700 });
  assert.equal(spawnSync('git', ['config', 'core.fsmonitor', helper], { cwd: f.workspace }).status, 0);
  snapshotExperimentInputs(f);
  discoverIntent(f.workspace);
  assert.equal(fs.existsSync(marker), false, 'metadata reads must not execute product-configured helpers');
});

test('frozen identity excludes candidate values and global budget extension but binds target and timeout', t => {
  const f = measurementFixture(t); const accepted = snapshotExperimentInputs(f);
  fs.writeFileSync(path.join(f.workspace, f.plan.fm.experiment.candidate), '{"version":1,"weights":[1,1]}');
  f.plan.fm.experiment.budget.max_invocations = 10; f.plan.fm.experiment.budget.max_seconds = 600; f.plan.digest = 'b'.repeat(64);
  assert.equal(experimentInputsCheck({ ...f, accepted }).pass, true);
  f.plan.fm.experiment.target = 0.25;
  assert.equal(experimentInputsCheck({ ...f, accepted }).pass, false);
});

test('accepted frozen snapshot tampering cannot change trusted invocation while retaining its digest', t => {
  const f = measurementFixture(t); const accepted = structuredClone(snapshotExperimentInputs(f));
  accepted.checks.score.config.command = [process.execPath, '-e', 'console.log(0)'];
  assert.equal(experimentInputsCheck({ ...f, accepted }).pass, false);
});

test('frozen identity binds actual host isolation implementation', t => {
  const f = measurementFixture(t); const accepted = snapshotExperimentInputs(f);
  assert.equal(accepted.isolation.platform, process.platform);
  assert.match(accepted.isolation.sandbox.sha256, /^[a-f0-9]{64}$/);
  assert.equal(accepted.isolation.profileVersion, 1);
});

test('trusted scorer declarations refuse ordinary execution and arbitrary trusted commands cannot impersonate the evaluator', async t => {
  const f = measurementFixture(t);
  assert.equal((await runNamedCheck(f.workspace, 'weights-loss', f.checks['weights-loss'], f)).status, 'unavailable');
  f.checks['weights-loss'].command = [process.execPath, '-e', 'console.log(0)'];
  fs.writeFileSync(path.join(f.workspace, '.github/harness/checks.yaml'), JSON.stringify({ version: 1, checks: f.checks }));
  approveProject(f);
  assert.throws(() => snapshotExperimentInputs(f), /trusted|evaluator|invocation/i);
});

test('strict input snapshots reject duplicates, changed dimensions, dependency edit authority and executable modes', t => {
  const f = measurementFixture(t); const candidate = path.join(f.workspace, 'config/weights.json');
  fs.writeFileSync(candidate, '{"version":1,"weights":[0,0],"weights":[1,1]}');
  assert.throws(() => snapshotExperimentInputs(f), /duplicate/i);
  fs.writeFileSync(candidate, '{"version":1,"weights":[0]}');
  assert.throws(() => snapshotExperimentInputs(f), /dimension/i);
  fs.writeFileSync(candidate, '{"version":1,"weights":[0,0]}'); fs.chmodSync(candidate, 0o755);
  assert.throws(() => snapshotExperimentInputs(f), /executable/i);
});

test('real sandboxed checks retain score and hard guard without candidate stdout authority', { skip: process.platform !== 'darwin' }, async t => {
  const f = measurementFixture(t); const accepted = snapshotExperimentInputs(f); const callbacks = [];
  const reservation = measurementReservation(f, accepted, [1, 1]);
  const result = await runExperimentMeasurement({ ...f, reservation, onEvent: (kind, value) => callbacks.push({ kind, mode: value.mode }) });
  assert.equal(result.status, 'passed', JSON.stringify(result)); assert.equal(result.metric.value, 1); assert.equal(result.correctness.passed, true); assert.equal(result.groupReaped, true);
  assert.deepEqual(callbacks.map(entry => `${entry.mode}:${entry.kind}`), ['score:beforeLaunch', 'score:spawn', 'score:settled', 'guard:beforeLaunch', 'guard:spawn', 'guard:settled']);
  assert.equal(validateExperimentMeasurement({ ...f, accepted, attempt: { ...reservation, measurement: result } }).pass, true);
  f.plan.digest = 'c'.repeat(64); f.plan.fm.experiment.budget.max_invocations = 10;
  assert.equal(validateExperimentMeasurement({ ...f, accepted, attempt: { ...reservation, measurement: result } }).pass, true, 'budget amendment preserves prior frozen-evaluator receipts');
  const artifact = result.checks[0].artifacts[0];
  const raw = fs.readFileSync(path.join(f.recordRoot, artifact.path), 'utf8');
  fs.writeFileSync(path.join(f.recordRoot, artifact.path), raw.replace('"version":1', '"version":1,"version":1'));
  assert.equal(validateExperimentMeasurement({ ...f, accepted, attempt: { ...reservation, measurement: result } }).pass, false);
});

test('improved loss with failed hard guards remains measured but cannot pass correctness', { skip: process.platform !== 'darwin' }, async t => {
  const f = measurementFixture(t); const accepted = snapshotExperimentInputs(f);
  const result = await runExperimentMeasurement({ ...f, reservation: measurementReservation(f, accepted, [2, 2]) });
  assert.equal(result.status, 'passed'); assert.equal(result.metric.value, 0); assert.equal(result.correctness.passed, false);
});

test('dependency drift and pre-cancelled execution acquire no metric but expose candidate identity for restoration', async t => {
  const f = measurementFixture(t); const accepted = snapshotExperimentInputs(f); const reservation = measurementReservation(f, accepted, [1, 1]);
  fs.appendFileSync(path.join(f.workspace, 'fixtures/weights-workload.json'), ' ');
  const result = await runExperimentMeasurement({ ...f, reservation });
  assert.equal(result.metric, null); assert.equal(result.status, 'failed'); assert.ok(result.candidate);
  const controller = new AbortController(); controller.abort();
  const cancelled = await runExperimentMeasurement({ ...f, reservation, signal: controller.signal });
  assert.equal(cancelled.metric, null); assert.equal(cancelled.status, 'interrupted');
});

test('raw metric validation rejects duplicate, missing, nonfinite and inconsistent artifacts', { skip: process.platform !== 'darwin' }, async t => {
  const f = measurementFixture(t); const accepted = snapshotExperimentInputs(f); const result = await runExperimentMeasurement({ ...f, reservation: measurementReservation(f, accepted) });
  assert.equal(result.status, 'passed', result.message);
  const valid = result.checks[0].receipt; const { durationMs, ...expected } = valid;
  for (const malformed of [
    JSON.stringify(valid).replace('"version":1', '"version":1,"version":1'),
    JSON.stringify({ ...valid, metric: null }),
    JSON.stringify(valid).replace('"value":2', '"value":1e999'),
    JSON.stringify({ ...valid, repetitions: 2 }),
    JSON.stringify({ ...valid, durationMs: -1 }),
    JSON.stringify({ ...valid, invocation: 'foreign' }),
    JSON.stringify({ ...valid, metric: { ...valid.metric, value: 0, samples: [0] } }),
  ]) assert.throws(() => validateExperimentArtifact(malformed, expected, 10), /measurement|JSON|finite|duplicate/i);
  assert.throws(() => validateExperimentArtifact('0 printed on stdout', expected, 10), /JSON/i);
});

test('copied or serialized internal capability cannot authorize a named scorer', async t => {
  const f = measurementFixture(t), config = f.checks['weights-loss'];
  const capability = createExperimentInvocation({ workspace: f.workspace, recordRoot: f.recordRoot, name: 'weights-loss', configDigest: experimentDigest(config), prepare: () => { throw new Error('should not reach execution'); } });
  const forged = JSON.parse(JSON.stringify(capability));
  const result = await runNamedCheck(f.workspace, 'weights-loss', config, { ...f, experimentInvocation: forged });
  assert.equal(result.status, 'unavailable'); assert.match(result.message, /authority/);
});

test('live cancellation reaps the score group and never launches its reserved guard', { skip: process.platform !== 'darwin' }, async t => {
  const f = measurementFixture(t); const accepted = snapshotExperimentInputs(f); const controller = new AbortController(); const modes = [];
  const result = await runExperimentMeasurement({ ...f, reservation: measurementReservation(f, accepted), signal: controller.signal, onEvent: (kind, details) => { if (kind === 'beforeLaunch') modes.push(details.mode); if (kind === 'spawn') controller.abort(); } });
  assert.equal(result.status, 'interrupted'); assert.equal(result.metric, null); assert.equal(result.groupReaped, true); assert.deepEqual(modes, ['score']);
});

test('candidate bytes changed between score and guard invalidate proof and preserve measured candidate identity', { skip: process.platform !== 'darwin' }, async t => {
  const f = measurementFixture(t); const accepted = snapshotExperimentInputs(f); const reservation = measurementReservation(f, accepted, [1, 1]);
  const result = await runExperimentMeasurement({ ...f, reservation, onEvent: (kind, details) => { if (kind === 'settled' && details.mode === 'score') fs.writeFileSync(path.join(f.workspace, 'config/weights.json'), '{"version":1,"weights":[2,2]}\n'); } });
  assert.equal(result.status, 'failed'); assert.equal(result.metric, null); assert.equal(result.checks.length, 1); assert.match(result.message, /candidate changed/i);
  assert.notEqual(result.candidate.files[0].sha256, experimentDigest(fs.readFileSync(path.join(f.workspace, 'config/weights.json'))));
});

test('expired wall deadline after slow launch authorization cannot start a scorer', { skip: process.platform !== 'darwin' }, async t => {
  const f = measurementFixture(t); f.plan.fm.experiment.budget.max_seconds = 1;
  const accepted = snapshotExperimentInputs(f); const reservation = measurementReservation(f, accepted); reservation.origin = Date.now() - 500;
  let spawned = 0;
  const result = await runExperimentMeasurement({ ...f, reservation, onEvent: kind => { if (kind === 'beforeLaunch') { const end = Date.now() + 700; while (Date.now() < end) {} } if (kind === 'spawn') spawned++; } });
  assert.equal(result.status, 'failed'); assert.equal(result.metric, null); assert.equal(spawned, 0); assert.match(result.message, /wall.*budget|deadline/i);
});
