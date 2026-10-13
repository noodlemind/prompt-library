import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { claimExperimentWorkspace, reserveExperimentAttempt, experimentStatus, markExperimentRunning, markExperimentChildStarted, recordExperimentChildResult, recordExperimentMeasurement, resolveExperimentAttempt, recoverExperimentAttempt, experimentCompletionCheck } from '../lib/experiment-state.mjs';
import { experimentFixture, git } from './helpers/experiment-state-fixtures.mjs';

function reserve(f, operation, kind = 'baseline', extra = {}) { return reserveExperimentAttempt({ ...f, operation, kind, hypothesis: kind === 'baseline' ? 'baseline' : operation, ...extra }); }
function measured(f, reservation, value, guards = true) {
  const running = markExperimentRunning({ ...f, reservation });
  for (const mode of ['score', 'guard']) {
    markExperimentChildStarted({ ...f, reservation: running, token: running.token, mode });
    recordExperimentChildResult({ ...f, reservation: running, token: running.token, mode, result: { status: 'passed', groupReaped: true } });
  }
  const result = { version: 1, attempt: reservation.id, candidate: running.evaluatedCandidate, acceptedInputsDigest: f.acceptedInputs.frozenDigest, status: 'passed', metric: { value }, correctness: { passed: guards }, groupReaped: true };
  recordExperimentMeasurement({ ...f, reservation: running, token: running.token, result });
  return running;
}
function resolve(f, attempt, decision = 'keep', extra = {}) { return resolveExperimentAttempt({ ...f, operation: `resolve-${attempt.id}`, invocation: attempt.id, decision, measurementCheck: () => ({ pass: true }), ...extra }); }

test('baseline, improvement, guard discard and target use exactly eight durable slots', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin');
  assert.equal(baseline.cost, 2);
  assert.deepEqual(Object.keys(baseline.childIds), ['score', 'guard']);
  assert.equal(experimentStatus(f).editability.pass, false);
  measured(f, baseline, 2);
  resolve(f, baseline);
  const one = reserve(f, 'improve', 'candidate');
  assert.equal(experimentStatus(f).editability.pass, true);
  f.write([1, 1]);
  measured(f, one, 1);
  resolve(f, one);
  const bad = reserve(f, 'guard-regression', 'candidate');
  f.write([2, 2]);
  measured(f, bad, 0, false);
  assert.throws(() => resolve(f, bad), /correctness|guard/);
  resolve(f, bad, 'discard');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.workspace, 'config/weights.json'), 'utf8')).weights, [1, 1]);
  const target = reserve(f, 'target', 'candidate');
  assert.equal(experimentStatus(f).spent, 8);
  f.write([1.5, 1.5]);
  measured(f, target, 0.5);
  resolve(f, target);
  assert.equal(experimentStatus(f).status, 'target-reached');
  assert.equal(experimentCompletionCheck({ ...f, measurementCheck: () => ({ pass: true }) }).pass, true);
  assert.throws(() => reserve(f, 'past-target', 'candidate'), /target|stopped/);
});

test('committed journals survive missing projections and same-operation replay never resets spend or origin', t => {
  const f = experimentFixture(t);
  const first = reserve(f, 'begin', 'baseline', { now: 1700000000000 });
  const status = experimentStatus(f);
  fs.unlinkSync(path.join(status.root, 'state.json'));
  assert.equal(experimentStatus(f).spent, 2);
  assert.equal(experimentStatus(f).origin, 1700000000000);
  assert.equal(reserve(f, 'begin', 'baseline', { now: 1700000001000 }).id, first.id);
  assert.equal(experimentStatus(f).spent, 2);
  assert.throws(() => reserve(f, 'begin', 'candidate'), /operation|replay/);
});

test('primary and second-home claims are refused without creating foreign series', t => {
  const f = experimentFixture(t);
  assert.throws(() => claimExperimentWorkspace({ ...f, workspace: f.primary, operation: 'claim' }), /linked/);
  reserve(f, 'begin');
  const otherHome = path.join(f.dir, 'other-home');
  fs.mkdirSync(otherHome);
  assert.throws(() => claimExperimentWorkspace({ ...f, home: otherHome, operation: 'other' }), /owned|claim|home/);
});

test('baseline binding cannot adopt edited bytes and an evaluated pair cannot launch twice', t => {
  const f = experimentFixture(t);
  const baselineBytes = fs.readFileSync(path.join(f.workspace, 'config/weights.json'));
  const first = reserve(f, 'begin');
  f.write([1, 1]);
  assert.throws(() => markExperimentRunning({ ...f, reservation: first }), /baseline|changed/);
  fs.writeFileSync(path.join(f.workspace, 'config/weights.json'), baselineBytes);
  const running = markExperimentRunning({ ...f, reservation: first });
  markExperimentChildStarted({ ...f, reservation: running, token: running.token, mode: 'score' });
  assert.throws(() => markExperimentChildStarted({ ...f, reservation: running, token: running.token, mode: 'score' }), /started|launch/);
  assert.throws(() => markExperimentRunning({ ...f, reservation: first }), /running|started/);
});

test('baseline authority binds exact newline bytes even when the JSON candidate is unchanged', t => {
  const f = experimentFixture(t);
  const full = path.join(f.workspace, 'config/weights.json');
  const baselineBytes = fs.readFileSync(full);
  const first = reserve(f, 'begin');
  const text = baselineBytes.toString('utf8');
  fs.writeFileSync(full, text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text.replace(/\n/g, '\r\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(full, 'utf8')).weights, [0, 0]);
  assert.throws(() => markExperimentRunning({ ...f, reservation: first }), /baseline.*changed/);
  fs.writeFileSync(full, baselineBytes);
  assert.equal(markExperimentRunning({ ...f, reservation: first }).state, 'running');
});

test('odd remaining budgets refuse a pair and accepted increases retain origin and spend', t => {
  const f = experimentFixture(t, { max_invocations: 3 });
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  resolve(f, baseline);
  const origin = experimentStatus(f).origin;
  assert.throws(() => reserve(f, 'odd', 'candidate'), /budget.*pair/);
  f.plan.fm.experiment.budget.max_invocations = 5;
  const candidate = reserve(f, 'extended', 'candidate');
  assert.equal(experimentStatus(f).spent, 4);
  assert.equal(experimentStatus(f).origin, origin);
  assert.equal(candidate.acceptedBudget.max_invocations, 5);
  measured(f, candidate, 1);
  resolve(f, candidate);
  f.plan.fm.experiment.budget.max_invocations = 4;
  assert.throws(() => reserve(f, 'decrease', 'candidate'), /decrease/);
  f.plan.fm.experiment.budget.max_invocations = 7;
  assert.throws(() => reserve(f, 'wall-expired', 'candidate', { now: origin + 300000 }), /wall-clock/);
  assert.equal(experimentStatus(f).spent, 4);
});

test('never-started attempts spend slots and nested repairs cannot reset the two-repair ceiling', t => {
  const f = experimentFixture(t, { max_invocations: 10 });
  const baseline = reserve(f, 'begin');
  resolve(f, baseline, 'discard');
  assert.equal(experimentStatus(f).spent, 2);
  const repair1 = reserve(f, 'repair-1', 'repair', { hypothesis: 'baseline', repairOf: baseline.id });
  resolve(f, repair1, 'discard');
  const repair2 = reserve(f, 'repair-2', 'repair', { hypothesis: 'baseline', repairOf: repair1.id });
  resolve(f, repair2, 'discard');
  assert.equal(experimentStatus(f).spent, 6);
  assert.equal(repair2.hypothesisId, baseline.hypothesisId);
  assert.throws(() => reserve(f, 'repair-3', 'repair', { hypothesis: 'baseline', repairOf: repair2.id }), /repair count/);
  assert.throws(() => reserve(f, 'repair-renamed', 'repair', { hypothesis: 'different', repairOf: repair2.id }), /hypothesis/);
});

test('prelaunch failures settle spent siblings and malformed metrics permit recognized rollback', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  resolve(f, baseline);
  const attempt = reserve(f, 'canary-failure', 'candidate');
  f.write([1, 1]);
  const running = markExperimentRunning({ ...f, reservation: attempt });
  recordExperimentMeasurement({ ...f, reservation: running, token: running.token, result: { version: 1, attempt: attempt.id, candidate: running.evaluatedCandidate, acceptedInputsDigest: f.acceptedInputs.frozenDigest, metric: null, correctness: { passed: false }, status: 'failed', groupReaped: true } });
  assert.throws(() => resolve(f, attempt), /trusted|correctness/);
  resolve(f, attempt, 'discard');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.workspace, 'config/weights.json'), 'utf8')).weights, [0, 0]);
  assert.equal(experimentStatus(f).status, 'evaluator-invalid');
  assert.equal(experimentStatus(f).spent, 4);
  assert.equal(experimentCompletionCheck({ ...f, measurementCheck: () => ({ pass: true }) }).pass, false);
});

test('old discard replay never restores over the current hypothesis', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  resolve(f, baseline);
  const bad = reserve(f, 'bad', 'candidate');
  f.write([2, 2]);
  measured(f, bad, 0, false);
  resolve(f, bad, 'discard');
  reserve(f, 'later', 'candidate');
  f.write([1, 1]);
  const before = fs.readFileSync(path.join(f.workspace, 'config/weights.json'));
  const replay = resolve(f, bad, 'discard');
  assert.equal(replay.state, 'discarded');
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'config/weights.json')), before);
});

function deadController(f, reservation, started = false) {
  const module = new URL('../lib/experiment-state.mjs', import.meta.url).href;
  const code = `import {markExperimentRunning,markExperimentChildStarted} from ${JSON.stringify(module)}; const options=JSON.parse(process.argv[1]); const reservation=markExperimentRunning(options); ${started ? "markExperimentChildStarted({...options,reservation,token:reservation.token,mode:'score'});" : ''}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ workspace: f.workspace, plan: f.plan, home: f.home, reservation })], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
}

test('dead controllers with no started child recover as interrupted; unknown spawn windows block', t => {
  const safe = experimentFixture(t);
  const safeAttempt = reserve(safe, 'begin');
  deadController(safe, safeAttempt);
  const recovered = recoverExperimentAttempt({ ...safe, invocation: safeAttempt.id });
  assert.equal(recovered.state, 'interrupted');
  resolve(safe, safeAttempt, 'discard');
  assert.equal(experimentStatus(safe).spent, 2);
  const unsafe = experimentFixture(t);
  const unsafeAttempt = reserve(unsafe, 'begin');
  deadController(unsafe, unsafeAttempt, true);
  assert.throws(() => recoverExperimentAttempt({ ...unsafe, invocation: unsafeAttempt.id }), /crash window.*unknown/);
  assert.throws(() => resolve(unsafe, unsafeAttempt, 'discard'), /group.*not proven/);
  assert.equal(experimentStatus(unsafe).spent, 2);
});

test('unavailable process observation cannot turn a live controller into an interrupted attempt', t => {
  const f = experimentFixture(t);
  const attempt = reserve(f, 'begin');
  markExperimentRunning({ ...f, reservation: attempt });
  const tools = path.join(f.dir, 'tools');
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
  const original = process.env.PATH, originalSystemRoot = process.env.SystemRoot;
  try {
    process.env.PATH = `${tools}${path.delimiter}${original || ''}`;
    if (process.platform === 'win32') process.env.SystemRoot = tools;
    assert.throws(() => recoverExperimentAttempt({ ...f, invocation: attempt.id }), /process identity.*unavailable|controller.*live/);
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
  }
  assert.equal(experimentStatus(f).active.state, 'running');
});

test('recovery refuses a live child PID even when its recorded creation identity is stale', t => {
  const f = experimentFixture(t), attempt = reserve(f, 'begin');
  const module = new URL('../lib/experiment-state.mjs', import.meta.url).href;
  const code = `import {markExperimentRunning,markExperimentChildStarted,recordExperimentChildSpawn} from ${JSON.stringify(module)}; const options=JSON.parse(process.argv[1]); const reservation=markExperimentRunning(options); markExperimentChildStarted({...options,reservation,token:reservation.token,mode:'score'}); recordExperimentChildSpawn({...options,reservation,token:reservation.token,mode:'score',pid:options.childPid,groupId:options.childPid,startIdentity:'stale-creation-identity'});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ workspace: f.workspace, plan: f.plan, home: f.home, reservation: attempt, childPid: process.pid })], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.throws(() => recoverExperimentAttempt({ ...f, invocation: attempt.id }), /group.*not proven.*recycled PID/);
  assert.equal(experimentStatus(f).active.state, 'running');
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('simultaneous reservations publish one committed pair', async t => {
  const f = experimentFixture(t);
  const module = new URL('../lib/experiment-state.mjs', import.meta.url).href;
  const code = `import {reserveExperimentAttempt} from ${JSON.stringify(module)}; const options=JSON.parse(process.argv[1]); reserveExperimentAttempt(options);`;
  const launch = operation => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ workspace: f.workspace, plan: f.plan, home: f.home, acceptedInputs: f.acceptedInputs, kind: 'baseline', hypothesis: 'baseline', operation })], { stdio: 'ignore' });
    child.on('exit', exit => resolve(exit));
  });
  const results = await Promise.all([launch('one'), launch('two')]);
  assert.equal(results.filter(exit => exit === 0).length, 1);
  assert.equal(experimentStatus(f).spent, 2);
  assert.equal(experimentStatus(f).attempts.length, 1);
});

test('crash after initial reservation guard preserves both slots, original UUID and wall origin', t => {
  const f = experimentFixture(t);
  const origin = Date.now();
  assert.throws(() => reserve(f, 'begin', 'baseline', { now: origin, afterGuard() { throw new Error('guard crash'); } }), /guard crash/);
  const pending = experimentStatus(f);
  assert.equal(pending.status, 'initializing');
  assert.equal(pending.spent, 2);
  assert.equal(pending.origin, origin);
  fs.rmSync(path.join(pending.root, 'state.json'), { force: true });
  assert.throws(() => reserve(f, 'new-begin', 'baseline'), /replay/);
  const resumed = reserve(f, 'begin', 'baseline', { now: origin + 1000 });
  assert.equal(resumed.id, pending.begin.id);
  assert.equal(resumed.origin, origin);
  assert.equal(experimentStatus(f).spent, 2);
});

test('settlement records owned group absence even after launch authority expires', t => {
  const f = experimentFixture(t);
  const reservation = reserve(f, 'begin');
  const running = markExperimentRunning({ ...f, reservation });
  const authorityCheck = () => ({ pass: false, message: 'gate expired' });
  for (const mode of ['score', 'guard']) {
    markExperimentChildStarted({ ...f, reservation: running, token: running.token, mode });
    recordExperimentChildResult({ ...f, reservation: running, token: running.token, mode, authorityCheck, result: { status: 'failed', groupReaped: true } });
  }
  const result = { version: 1, attempt: reservation.id, candidate: running.evaluatedCandidate, acceptedInputsDigest: f.acceptedInputs.frozenDigest, status: 'failed', metric: null, correctness: { passed: false }, groupReaped: true };
  recordExperimentMeasurement({ ...f, reservation: running, token: running.token, result, authorityCheck });
  assert.equal(experimentStatus(f).active.state, 'failed');
  resolve(f, reservation, 'discard');
  assert.equal(experimentStatus(f).active, null);
});

test('keep recovery publishes the journaled snapshot ref before reconstructing settled projection', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  assert.throws(() => resolve(f, baseline, 'keep', { afterResolution() { throw new Error('publication crash'); } }), /publication crash/);
  const pending = experimentStatus(f).active;
  assert.equal(pending.state, 'resolving');
  assert.throws(() => recoverExperimentAttempt({ ...f, invocation: baseline.id, measurementCheck: () => ({ pass: false }) }), /measurement.*stale/);
  const kept = recoverExperimentAttempt({ ...f, invocation: baseline.id, measurementCheck: () => ({ pass: true }) });
  assert.equal(kept.state, 'kept');
  assert.equal(experimentStatus(f).lastKept.id, baseline.id);
  assert.equal(experimentStatus(f).spent, 2);
});

test('artifact validation failure stops a discarded series without denying exact rollback', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  resolve(f, baseline);
  const attempt = reserve(f, 'candidate', 'candidate');
  f.write([1, 1]);
  measured(f, attempt, 1);
  resolve(f, attempt, 'discard', { measurementCheck: () => ({ pass: false, message: 'artifact drift' }) });
  assert.equal(experimentStatus(f).status, 'evaluator-invalid');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.workspace, 'config/weights.json'), 'utf8')).weights, [0, 0]);
  assert.throws(() => reserve(f, 'later', 'candidate'), /stopped/);
});

test('derived TSV corruption cannot change measurements and is regenerated from journals', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  const full = path.join(experimentStatus(f).root, 'attempts.tsv');
  fs.writeFileSync(full, 'forged\t0\tkept\twin\n');
  assert.equal(experimentStatus(f).lastKept, null);
  resolve(f, baseline, 'keep', { description: 'Establish the comparison' });
  const report = fs.readFileSync(full, 'utf8');
  assert.equal(report, `attempt\tmetric\tstatus\tdescription\n${baseline.id}\t2\tkept\tEstablish the comparison\n`);
});

test('HEAD movement blocks the accepted series without changing its records or candidate', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  resolve(f, baseline);
  const root = experimentStatus(f).root;
  const before = fs.readFileSync(path.join(root, 'state.json'));
  git(f.workspace, ['commit', '--allow-empty', '-m', 'Move HEAD']);
  assert.equal(experimentStatus(f).status, 'blocked-workspace');
  assert.equal(experimentStatus(f).editability.pass, false);
  assert.throws(() => reserve(f, 'moved', 'candidate'), /claim|identity|owned/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'state.json')), before);
  assert.equal(experimentCompletionCheck({ ...f, measurementCheck: () => ({ pass: true }) }).pass, false);
});

test('authored decision digests and descriptions are immutable across operation replay', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin', 'baseline', { authoredDigest: '1'.repeat(64) });
  assert.throws(() => reserve(f, 'begin', 'baseline', { authoredDigest: '2'.repeat(64) }), /replay/);
  measured(f, baseline, 2);
  resolve(f, baseline, 'keep', { authoredDigest: '3'.repeat(64), description: 'Original decision' });
  assert.throws(() => resolve(f, baseline, 'keep', { authoredDigest: '4'.repeat(64), description: 'Original decision' }), /replay/);
  assert.throws(() => resolve(f, baseline, 'keep', { authoredDigest: '3'.repeat(64), description: 'Changed decision' }), /replay/);
});

test('baseline reservation rejects candidate drift since the accepted live input snapshot', t => {
  const f = experimentFixture(t);
  f.acceptedInputs.candidate.sha256 = '9'.repeat(64);
  assert.throws(() => reserve(f, 'begin'), /baseline.*snapshot/);
  assert.equal(experimentStatus(f).spent, 0);
});

test('published series without its first reservation recovers the original guarded pair', t => {
  const f = experimentFixture(t);
  const originalOpen = fs.openSync;
  try {
    fs.openSync = function(full, flags, ...rest) {
      if (path.basename(path.dirname(String(full))) === 'reservations' && flags === 'wx') throw Object.assign(new Error('reservation publication crash'), { code: 'EIO' });
      return originalOpen.call(fs, full, flags, ...rest);
    };
    assert.throws(() => reserve(f, 'begin'), /replay|publication|crash/);
  } finally { fs.openSync = originalOpen; }
  const state = experimentStatus(f);
  assert.equal(state.status, 'initializing');
  assert.equal(state.spent, 2);
  const origin = state.origin;
  assert.throws(() => reserve(f, 'replacement-begin'), /replay/);
  const reservation = reserve(f, 'begin');
  assert.equal(reservation.id, state.begin.id);
  assert.equal(reservation.origin, origin);
  assert.equal(experimentStatus(f).spent, 2);
});

test('keep rejects a snapshot captured from candidate bytes changed after measurement validation', t => {
  const f = experimentFixture(t);
  const baselineBytes = fs.readFileSync(path.join(f.workspace, 'config/weights.json'));
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  const originalMkdir = fs.mkdirSync;
  let raced = false;
  try {
    fs.mkdirSync = function(full, ...args) {
      if (!raced && path.basename(String(full)) === 'snapshots') { raced = true; f.write([1, 1]); }
      return originalMkdir.call(fs, full, ...args);
    };
    assert.throws(() => resolve(f, baseline), /snapshot.*candidate|candidate.*snapshot/);
  } finally { fs.mkdirSync = originalMkdir; }
  assert.equal(raced, true);
  assert.equal(experimentStatus(f).lastKept, null);
  assert.equal(experimentStatus(f).active.state, 'measured');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.workspace, 'config/weights.json'), 'utf8')).weights, [1, 1]);
  const publication = path.join(experimentStatus(f).root, 'snapshots', `keep-${baseline.id}.publication.json`);
  assert.equal(fs.existsSync(publication), false, 'foreign candidate cannot poison the immutable publication intent');
  fs.writeFileSync(path.join(f.workspace, 'config/weights.json'), baselineBytes);
  const kept = resolve(f, baseline);
  assert.equal(kept.state, 'kept');
  assert.deepEqual(kept.retainedSnapshot.candidate, kept.evaluatedCandidate);
});

test('keep rechecks current candidate after publishing its resolution intent', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  assert.throws(() => resolve(f, baseline, 'keep', { afterResolution() { f.write([1, 1]); } }), /candidate.*changed|changed.*candidate/);
  assert.equal(experimentStatus(f).lastKept, null);
  assert.equal(experimentStatus(f).active.state, 'resolving');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.workspace, 'config/weights.json'), 'utf8')).weights, [1, 1]);
});

test('keep recovery rechecks current candidate before publishing settlement', t => {
  const f = experimentFixture(t);
  const baseline = reserve(f, 'begin');
  measured(f, baseline, 2);
  assert.throws(() => resolve(f, baseline, 'keep', { afterResolution() { throw new Error('resolution crash'); } }), /resolution crash/);
  assert.throws(() => recoverExperimentAttempt({ ...f, invocation: baseline.id, measurementCheck: () => ({ pass: true }), authorityCheck() { f.write([1, 1]); return { pass: true }; } }), /candidate.*changed|changed.*candidate/);
  assert.equal(experimentStatus(f).lastKept, null);
  assert.equal(experimentStatus(f).active.state, 'resolving');
});

test('read-only status reports the original wall budget exhausted without reserving more work', t => {
  const f = experimentFixture(t), baseline = reserve(f, 'begin');
  measured(f, baseline, 2); resolve(f, baseline);
  const before = experimentStatus(f);
  const expired = experimentStatus({ ...f, now: before.origin + f.plan.fm.experiment.budget.max_seconds * 1000 });
  assert.equal(expired.status, 'exhausted');
  assert.equal(expired.spent, before.spent);
  assert.equal(expired.origin, before.origin);
  assert.equal(expired.lastKept.id, baseline.id);
});
