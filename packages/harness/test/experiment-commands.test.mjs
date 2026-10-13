import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { getCommand } from '../lib/registry.mjs';
import { harnessControlCommand } from '../corpus/hooks/lib/tool-payload.mjs';
import { beforeDeliveryTool, runDeliveryCommand } from '../lib/agent-delivery.mjs';
import { DELIVER_PROFILE, dispatchToolCall, renderToolResult } from '../lib/agent-loop.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { experimentStatus, resolveExperimentAttempt } from '../lib/experiment-state.mjs';
import { experimentMeasurementCheck } from '../lib/experiment-authority.mjs';
import { experimentDigest } from '../lib/experiment-contract.mjs';
import { creationDecision, experimentBin, experimentContract, experimentFixture, workload } from './helpers/experiment-command-fixtures.mjs';

const supportedHost = process.platform === 'darwin';
const invocation = '45898367-7547-4eab-adb9-e2769a8d2146';
const attemptId = result => {
  assert.equal(result.attempt.cost, 2);
  assert.equal(result.attempt_id, result.attempt.id);
  assert.equal(typeof result.attempt.id, 'string');
  return result.attempt.id;
};

function retainedBaseline(f) {
  const reserved = f.begin('baseline', 'Measure the untouched accepted baseline.');
  assert.equal(reserved.attempt.kind, 'baseline');
  const id = attemptId(reserved), measured = f.evaluate(id);
  assert.equal(measured.measurement.metric.value, 2);
  assert.equal(measured.measurement.correctness.passed, true);
  f.resolve('baseline-keep', id, 'keep');
  return id;
}

test('full authored experiment plans preserve schema-4 obligations through the real CLI', t => {
  const f = experimentFixture(t); f.create();
  const fm = YAML.parse(fs.readFileSync(f.plan, 'utf8').split('---')[1]);
  assert.equal(fm.plan_schema, 4);
  assert.equal(path.extname(f.plan), '.hplan');
  assert.equal(fm.experiment.workload, 'linear-json-v1');
  assert.deepEqual(fm.experiment.editable_files, ['config/weights.json']);
  assert.equal(fm.domain_binding, undefined);
  assert.equal(f.start().pass, true);
});

test('authored conversion preserves one UUID and publishes one schema-4 plan without downgrading it', t => {
  const f = experimentFixture(t); f.create({ experiment: undefined });
  const previous = f.plan, before = YAML.parse(fs.readFileSync(previous, 'utf8').split('---')[1]);
  assert.equal(before.plan_schema, 2);
  const input = { version: 1, id: 'accept-experiment', action: 'convert', expect: f.revision(), rationale: 'Accept the finite JSON measurement and retention obligations.', authority: { scope: 'experiment-intent', basis: 'Acceptance fixture instruction.' }, changes: { experiment: experimentContract() } };
  const converted = f.invoke('plan-update', '--plan', previous, '--file', f.writeDecision(input));
  assert.equal(converted.previousPath, previous);
  assert.equal(fs.existsSync(previous), false);
  assert.equal(path.extname(converted.path), '.hplan');
  const fm = YAML.parse(fs.readFileSync(converted.path, 'utf8').split('---')[1]);
  assert.equal(fm.plan_schema, 4);
  assert.equal(fm.plan_id, before.plan_id);
  assert.deepEqual(fm.experiment, experimentContract());
  const replay = f.invoke('plan-update', '--plan', previous, '--file', f.writeDecision(input));
  assert.equal(replay.path, converted.path);
  assert.equal(replay.replayed, true);
  const downgrade = f.cli('plan-update', '--plan', converted.path, '--file', f.writeDecision({ version: 1, id: 'remove-contract', action: 'amend', expect: converted.revision, rationale: 'Attempt a forbidden removal.', authority: { scope: 'experiment-intent', basis: 'Test rejection.' }, changes: { experiment: null } }));
  assert.notEqual(downgrade.status, 0, downgrade.stdout + downgrade.stderr);
  assert.equal(YAML.parse(fs.readFileSync(converted.path, 'utf8').split('---')[1]).plan_schema, 4);
});

test('experiment creation rejects duplicate authored keys and nonfinite numerical obligations', t => {
  const f = experimentFixture(t);
  for (const raw of [
    JSON.stringify(creationDecision({ slug: 'duplicate-contract' })).replace('"version":1', '"version":1,"version":1'),
    JSON.stringify(creationDecision({ slug: 'nonfinite-contract' })).replace('"target":0.5', '"target":1e999'),
  ]) {
    fs.writeFileSync(f.input, raw);
    const result = f.cli('plan-new', '--file', f.input);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /duplicat|finite|JSON|numeric|number/i);
  }
});

test('static experiment status creates no home, plan, workspace or isolation probe', t => {
  const f = experimentFixture(t), absentHome = path.join(f.root, 'absent-home');
  const before = f.git(f.workspace, 'status', '--porcelain');
  const result = spawnSync(process.execPath, [experimentBin, 'experiment', 'status', '--workspace', f.workspace, '--harness-home', absentHome, '--copilot-home', f.copilotHome, '--json', '--no-events'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.match(JSON.stringify(value), /linear-json-v1/);
  assert.match(JSON.stringify(value), /unprobed/);
  assert.equal(fs.existsSync(absentHome), false);
  assert.equal(f.git(f.workspace, 'status', '--porcelain'), before);
});

test('an experiment cannot begin in a primary checkout through ordinary in-place or CI exemptions', t => {
  const f = experimentFixture(t, { linked: false }); f.create();
  f.op('primary-start', 'start');
  const result = f.cli('experiment', 'begin', '--plan', f.plan, '--file', f.writeDecision(f.beginInput('primary-begin', 'Establish baseline.')));
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /linked|issue worktree|primary|isolation/i);
  assert.deepEqual(f.weights(), [0, 0]);
});

test('ordinary check execution cannot run an experiment scorer outside its one-shot reservation', t => {
  const f = experimentFixture(t); f.create();
  const result = f.cli('checks', 'run', 'weights-loss');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /experiment|capability|reservation/i);
  assert.deepEqual(f.weights(), [0, 0]);
});

test('malformed or stale experiment authority cannot reserve budget or claim the workspace', t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true);
  const decision = f.beginInput('invalid-authority', 'Observe unchanged reservation authority.');
  for (const input of [{ ...decision, expect: '0'.repeat(64) }, { ...decision, repair_of: 'not-an-invocation' }, { ...decision, score: 0 }]) {
    const result = f.cli('experiment', 'begin', '--plan', f.plan, '--file', f.writeDecision(input));
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  }
  fs.writeFileSync(f.input, JSON.stringify(decision).replace('"version":1', '"version":1,"version":1'));
  assert.notEqual(f.cli('experiment', 'begin', '--plan', f.plan, '--file', f.input).status, 0);
  const duplicated = f.cli('experiment', 'begin', '--plan', f.plan, '--plan', f.plan, '--file', f.writeDecision(decision));
  assert.notEqual(duplicated.status, 0, duplicated.stdout + duplicated.stderr);
  const unsupported = f.cli('experiment', 'begin', '--plan', f.plan, '--file', f.input, '--allow-inplace');
  assert.notEqual(unsupported.status, 0, unsupported.stdout + unsupported.stderr);
  const absent = f.status();
  assert.equal(absent.status, 'absent');
  assert.equal(absent.spent, 0);
  assert.equal(fs.existsSync(absent.root), false);
  assert.equal(fs.existsSync(path.join(f.git(f.workspace, 'rev-parse', '--absolute-git-dir'), 'harness-experiment-owner.json')), false);
});

test('experiment command effects distinguish durable reservation, evaluation, resolution and read-only status', () => {
  const entry = getCommand('experiment');
  assert.ok(entry, 'experiment commands need explicit registry ownership');
  const effects = Object.fromEntries(entry.verbs.map(row => [row.verb, row.sideEffect || entry.sideEffect]));
  assert.deepEqual(effects, { begin: 'mutate', evaluate: 'execute', resolve: 'mutate', status: 'read' });
});

test('native experiment controls admit exact authored transitions and reject authority bypasses', async () => {
  for (const tail of ['status', `status --plan p.hplan --attempt ${invocation}`, 'begin --plan p.hplan --file decision.json', `evaluate --plan p.hplan --attempt ${invocation}`, 'resolve --plan p.hplan --file decision.json']) {
    assert.equal(harnessControlCommand(`harness experiment ${tail} --json`.split(' '), '/tmp/workspace'), 'experiment', tail);
  }
  for (const tail of ['begin --plan p.hplan', 'begin --file decision.json', 'begin --plan p.hplan --file a.json --file b.json', 'evaluate --plan p.hplan', 'evaluate --plan p.hplan --attempt abc', `evaluate --plan p.hplan --attempt ${invocation} --allow-inplace`, 'resolve --plan p.hplan --decision keep', 'status --workspace /elsewhere', 'begin --plan p.hplan --file d.json && touch unsafe']) {
    assert.equal(harnessControlCommand(`harness experiment ${tail}`.split(' '), '/tmp/workspace'), null, tail);
  }
  for (const verb of ['begin', 'resolve']) {
    const input = { argv: ['experiment', verb, '--plan', 'p.hplan'], decision: { version: 1, id: `native-${verb}` } };
    assert.equal(beforeDeliveryTool({ name: 'harness', input }, { workspace: '/tmp/workspace' }).pass, true, verb);
    let staged;
    await runDeliveryCommand(input, async argv => {
      staged = argv[argv.indexOf('--file') + 1];
      assert.deepEqual(JSON.parse(fs.readFileSync(staged, 'utf8')), input.decision);
      return { status: 'ok' };
    });
    assert.equal(fs.existsSync(staged), false);
  }
});

test('real bounded CLI measurement retains an improvement, restores a guard failure, reaches target and completes normally', { skip: !supportedHost }, t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true);
  const head = f.git(f.workspace, 'rev-parse', 'HEAD');
  const index = f.git(f.workspace, 'rev-parse', '--git-path', 'index');
  const indexPath = path.resolve(f.workspace, index), indexBytes = fs.readFileSync(indexPath);
  retainedBaseline(f);
  const improvement = attemptId(f.begin('improve', 'Increase both accepted weights to one.'));
  f.setWeights([1, 1]);
  const improved = f.evaluate(improvement);
  assert.equal(improved.measurement.metric.value, 1);
  assert.equal(improved.measurement.correctness.passed, true);
  f.resolve('improve-keep', improvement, 'keep');
  assert.deepEqual(fs.readFileSync(indexPath), indexBytes);
  const rejected = attemptId(f.begin('bad-guard', 'Probe exact objective fit against hard bounds.'));
  f.setWeights([2, 2]);
  fs.writeFileSync(path.join(f.workspace, 'unrelated.txt'), 'Preserve this staged unrelated change.\n');
  f.git(f.workspace, 'add', 'unrelated.txt');
  const stagedIndex = fs.readFileSync(indexPath);
  const failed = f.cli('experiment', 'evaluate', '--plan', f.plan, '--attempt', rejected);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  const measured = JSON.parse(failed.stdout).measurement;
  assert.equal(measured.metric.value, 0);
  assert.equal(measured.correctness.passed, false);
  const keep = f.cli('experiment', 'resolve', '--plan', f.plan, '--file', f.writeDecision({ version: 1, id: 'bad-guard-keep', expect: f.revision(), attempt: rejected, decision: 'keep', description: 'Request that must fail hard correctness.' }));
  assert.notEqual(keep.status, 0, keep.stdout + keep.stderr);
  assert.deepEqual(f.weights(), [2, 2]);
  f.resolve('bad-guard-discard', rejected, 'discard');
  assert.deepEqual(f.weights(), [1, 1]);
  assert.deepEqual(fs.readFileSync(indexPath), stagedIndex);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'unrelated.txt'), 'utf8'), 'Preserve this staged unrelated change.\n');
  f.git(f.workspace, 'restore', '--staged', '--', 'unrelated.txt');
  fs.rmSync(path.join(f.workspace, 'unrelated.txt'));
  const cleanedIndex = fs.readFileSync(indexPath);
  const target = attemptId(f.begin('target', 'Retain one-and-a-half weights within the hard bounds.'));
  f.setWeights([1.5, 1.5]);
  const targetMeasurement = f.evaluate(target);
  assert.equal(targetMeasurement.measurement.metric.value, 0.5);
  assert.equal(targetMeasurement.measurement.correctness.passed, true);
  f.resolve('target-keep', target, 'keep');
  assert.deepEqual(f.weights(), [1.5, 1.5]);
  const settled = f.status();
  assert.equal(settled.spent, 8);
  assert.equal(settled.status, 'target-reached');
  assert.equal(settled.lastKept.id, target);
  assert.equal(settled.active, null);
  const statusOutput = f.cli('experiment', 'status', '--plan', f.plan);
  assert.equal(statusOutput.status, 0, statusOutput.stderr);
  assert.ok(Buffer.byteLength(statusOutput.stdout) <= 16384, `Default status consumed ${Buffer.byteLength(statusOutput.stdout)} bytes.`);
  const summary = JSON.parse(statusOutput.stdout);
  assert.equal(summary.lastKept.measurement.metric.value, 0.5);
  assert.equal(summary.lastKept.measurement.correctness.passed, true);
  assert.equal(summary.spent, 8);
  assert.equal(typeof summary.origin, 'number');
  assert.equal(f.git(f.workspace, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readFileSync(indexPath), cleanedIndex);
  const stopped = f.cli('experiment', 'begin', '--plan', f.plan, '--file', f.writeDecision(f.beginInput('after-target', 'Must not launch another pair.')));
  assert.notEqual(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout + stopped.stderr, /target|exhaust/i);
  f.op('progress', 'progress', { progress: { tasks: ['P1T1'], criteria: ['AC1'], phase: 1 } });
  f.review();
  const proof = f.invoke('verify', '--plan', f.plan, '--base', 'HEAD');
  assert.equal(proof.outcome, 'passed');
  assert.equal(proof.checks.find(check => check.id === 'experiment-target')?.status, 'passed');
  assert.equal(proof.checks.some(check => ['weights-loss', 'weights-guards'].includes(check.id)), false, 'final proof must not launch an unbudgeted scorer');
  f.invoke('compound', '--plan', f.plan, '--learning-decision', f.writeDecision({ operation: 'no-learning', decision: 'no-learning', rationale: 'Disposable numerical acceptance case is fully represented by its tests.' }));
  f.op('complete', 'complete');
  assert.equal(YAML.parse(fs.readFileSync(f.plan, 'utf8').split('---')[1]).status, 'done');
  assert.equal(f.invoke('status', '--validate-evidence', '--plan', f.plan).pass, true);
  assert.equal(f.invoke('status', '--validate-completion', '--plan', f.plan).pass, true);
  const evidencePath = path.join(f.workspace, proof.evidencePath), evidenceBytes = fs.readFileSync(evidencePath);
  const evidence = JSON.parse(evidenceBytes);
  assert.equal(evidence.version, 7);
  for (const checkId of ['experiment-target', 'experiment-retention-stability']) {
    assert.equal(evidence.checks.some(check => check.id === checkId), true);
    try {
      fs.writeFileSync(evidencePath, JSON.stringify({ ...evidence, checks: evidence.checks.filter(check => check.id !== checkId) }));
      assert.equal(f.invoke('status', '--validate-evidence', '--plan', f.plan).pass, false, checkId);
      assert.equal(f.invoke('status', '--validate-completion', '--plan', f.plan).pass, false, checkId);
    } finally { fs.writeFileSync(evidencePath, evidenceBytes); }
    assert.equal(f.invoke('status', '--validate-completion', '--plan', f.plan).pass, true);
  }
});

test('native edits require a retained baseline and expose the exact currently reserved hypothesis', { skip: !supportedHost }, async t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true);
  const denied = () => {
    const hook = f.hook('config/weights.json').hookSpecificOutput;
    assert.ok(hook && (hook.permissionDecision === 'deny' || hook.decision === 'block'));
  };
  denied(); retainedBaseline(f); denied();
  const id = attemptId(f.begin('editable-hypothesis', 'Edit only during this unresolved reservation.'));
  const dispatch = await dispatchToolCall({ name: 'harness', input: { argv: ['experiment', 'status', '--plan', f.plan, '--attempt', id] } }, { workspace: f.workspace, copilotHome: f.copilotHome, harnessHome: f.home, profile: DELIVER_PROFILE, remainingSeconds: 30, timeoutSeconds: 30 });
  assert.equal(dispatch.dispatched, true, dispatch.reason);
  assert.equal(dispatch.result.exitCode, 0, JSON.stringify(dispatch.result));
  const rendered = renderToolResult(dispatch.result);
  assert.match(rendered, new RegExp(id));
  assert.match(rendered, /"active":/);
  assert.match(rendered, /"spent":/);
  assert.match(rendered, /Edit only during this unresolved reservation/);
  assert.equal(f.hook('config/weights.json').continue, true);
  const outside = f.hook('fixtures/weights-workload.json').hookSpecificOutput;
  assert.ok(outside && (outside.permissionDecision === 'deny' || outside.decision === 'block'));
  f.setWeights([1, 1]); f.evaluate(id); denied(); f.resolve('editability-keep', id, 'keep'); denied();
});

test('default experiment status stays bounded with many raw correctness observations', { skip: !supportedHost }, t => {
  const workloadData = { ...workload, guards: Array.from({ length: 128 }, () => ({ features: [1, 1], min: 0, max: 3 })) };
  const f = experimentFixture(t, { candidate: [1.5, 1.5], workloadData }); f.create(); assert.equal(f.start().pass, true);
  const id = attemptId(f.begin('bounded-status-baseline', 'Observe a baseline which already reaches the target.'));
  const measurement = f.evaluate(id).measurement;
  assert.equal(measurement.metric.value, 0.5);
  assert.equal(measurement.correctness.passed, true);
  f.resolve('bounded-status-keep', id, 'keep');
  const output = f.cli('experiment', 'status', '--plan', f.plan);
  assert.equal(output.status, 0, output.stderr);
  assert.ok(Buffer.byteLength(output.stdout) <= 16384, `Default status consumed ${Buffer.byteLength(output.stdout)} bytes.`);
  const status = JSON.parse(output.stdout);
  assert.equal(status.status, 'target-reached');
  assert.equal(status.spent, 2);
  assert.equal(status.lastKept.id, id);
  assert.equal(status.lastKept.measurement.metric.value, 0.5);
  assert.equal(status.lastKept.measurement.correctness.passed, true);
});

test('an unmet experiment target prevents proof and completion despite green ordinary behavior', { skip: !supportedHost }, t => {
  const contract = experimentContract({ budget: { max_invocations: 2, max_seconds: 300, timeout_seconds: 10, max_repair_reruns: 2 } });
  const f = experimentFixture(t, { contract }); f.create(); assert.equal(f.start().pass, true);
  retainedBaseline(f);
  const before = f.revision();
  const exhausted = f.cli('experiment', 'begin', '--plan', f.plan, '--file', f.writeDecision(f.beginInput('exhausted', 'A third invocation cannot fit the pair budget.')));
  assert.notEqual(exhausted.status, 0, exhausted.stdout + exhausted.stderr);
  assert.match(exhausted.stdout + exhausted.stderr, /budget|exhaust/i);
  assert.equal(f.revision(), before);
  f.op('progress', 'progress', { progress: { tasks: ['P1T1'], criteria: ['AC1'] } }); f.review();
  const result = f.cli('verify', '--plan', f.plan, '--base', 'HEAD');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.notEqual(proof.outcome, 'passed');
  assert.equal(proof.checks.find(check => check.id === 'experiment-target')?.status, 'failed');
  const completion = f.cli('plan-update', '--plan', f.plan, '--file', f.writeDecision({ version: 1, id: 'unfinished-completion', expect: f.revision(), action: 'complete' }));
  assert.notEqual(completion.status, 0, completion.stdout + completion.stderr);
  assert.notEqual(YAML.parse(fs.readFileSync(f.plan, 'utf8').split('---')[1]).status, 'done');
});

test('reservation replay does not spend twice and edited baseline bytes cannot become a measured baseline', { skip: !supportedHost }, t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true);
  const input = f.beginInput('baseline-replay', 'Bind untouched baseline bytes at reservation.');
  const reserve = () => f.invoke('experiment', 'begin', '--plan', f.plan, '--file', f.writeDecision(input));
  const first = reserve(), second = reserve();
  assert.equal(attemptId(second), attemptId(first));
  assert.equal(f.status().spent, 2);
  const conflict = f.cli('experiment', 'begin', '--plan', f.plan, '--file', f.writeDecision({ ...input, hypothesis: 'Changed authored payload under the same operation.' }));
  assert.notEqual(conflict.status, 0, conflict.stdout + conflict.stderr);
  assert.equal(f.status().spent, 2);
  f.setWeights([1, 1]);
  const result = f.cli('experiment', 'evaluate', '--plan', f.plan, '--attempt', first.attempt.id);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /baseline|candidate|changed|identity/i);
  assert.deepEqual(f.weights(), [1, 1], 'rejection does not overwrite unrecognized bytes');
});

test('resolve replays only the identical authored payload and preserves the retained receipt', { skip: !supportedHost }, t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true);
  const id = attemptId(f.begin('resolve-replay-baseline', 'Measure the exact untouched baseline.'));
  f.evaluate(id);
  const input = { version: 1, id: 'resolve-replay', expect: f.revision(), attempt: id, decision: 'keep', description: 'Accept this trusted baseline once.' };
  const run = decision => f.cli('experiment', 'resolve', '--plan', f.plan, '--file', f.writeDecision(decision));
  assert.equal(run(input).status, 0);
  assert.equal(run(input).status, 0);
  const changed = run({ ...input, description: 'Changed description under the same operation.' });
  assert.notEqual(changed.status, 0, changed.stdout + changed.stderr);
  const status = f.status();
  assert.equal(status.spent, 2);
  assert.equal(status.lastKept.id, id);
  assert.deepEqual(f.weights(), [0, 0]);
});

test('public keep replay recovers a committed resolution journal through the trusted measurement boundary', { skip: !supportedHost }, t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true);
  const id = attemptId(f.begin('keep-recovery-baseline', 'Retain an untouched baseline after an interrupted keep.'));
  const measured = f.evaluate(id).measurement;
  const plan = loadPlan(f.workspace, f.plan, { home: f.home });
  const common = { workspace: f.workspace, plan, home: f.home, copilotHome: f.copilotHome, recordRoot: projectStoreDir(f.workspace, { home: f.home }) };
  const input = { version: 1, id: 'keep-recovery', expect: f.revision(), attempt: id, decision: 'keep', description: 'Retain the measured baseline from the already committed journal.' };
  assert.throws(() => resolveExperimentAttempt({ ...common, invocation: id, operation: input.id, decision: input.decision, description: input.description, authoredDigest: experimentDigest(input), measurementCheck: experimentMeasurementCheck(common), afterResolution() { throw new Error('Injected interruption after the resolution journal.'); } }), /Injected interruption/);
  assert.equal(f.status().active.state, 'resolving');
  f.invoke('experiment', 'resolve', '--plan', f.plan, '--file', f.writeDecision(input));
  const kept = f.status();
  assert.equal(kept.active, null);
  assert.equal(kept.spent, 2);
  assert.equal(kept.lastKept.id, id);
  assert.deepEqual(kept.lastKept.measurement.metric, measured.metric);
  assert.equal(kept.lastKept.measurement.correctness.passed, true);
  const selected = f.status(id).attempt.measurement;
  assert.deepEqual(selected.metric, measured.metric);
  assert.deepEqual(selected.artifacts, measured.checks.flatMap(check => check.artifacts));
  assert.deepEqual(experimentStatus(common).lastKept.measurement, measured);
  assert.deepEqual(f.weights(), [0, 0]);
});

test('accepted frozen dependency drift blocks evaluation while preserving the candidate', { skip: !supportedHost }, t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true); retainedBaseline(f);
  const id = attemptId(f.begin('changed-workload', 'Probe frozen dependency currentness.'));
  f.setWeights([1, 1]);
  fs.appendFileSync(path.join(f.workspace, 'fixtures/weights-workload.json'), '\n');
  const result = f.cli('experiment', 'evaluate', '--plan', f.plan, '--attempt', id);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /frozen|dependenc|input|workload|scope/i);
  assert.deepEqual(f.weights(), [1, 1]);
});

test('a tampered measured artifact blocks retention while safe discard restores the recognized candidate', { skip: !supportedHost }, t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true); retainedBaseline(f);
  const id = attemptId(f.begin('artifact-tamper', 'Measure a candidate whose receipt will be corrupted.'));
  f.setWeights([1, 1]);
  const measured = f.evaluate(id).measurement;
  const artifact = measured.checks[0].artifacts[0];
  const owned = path.join(path.dirname(path.dirname(f.plan)), artifact.path);
  assert.equal(fs.existsSync(owned), true, owned);
  fs.appendFileSync(owned, '\n');
  const keep = f.cli('experiment', 'resolve', '--plan', f.plan, '--file', f.writeDecision({ version: 1, id: 'tampered-keep', expect: f.revision(), attempt: id, decision: 'keep', description: 'This request must fail artifact integrity.' }));
  assert.notEqual(keep.status, 0, keep.stdout + keep.stderr);
  assert.match(keep.stdout + keep.stderr, /artifact|receipt|integrity|changed/i);
  f.resolve('tampered-discard', id, 'discard');
  assert.deepEqual(f.weights(), [0, 0]);
  assert.equal(f.status().status, 'evaluator-invalid');
});

test('safe rollback refuses an unknown candidate written after measurement and preserves those bytes', { skip: !supportedHost }, t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true); retainedBaseline(f);
  const id = attemptId(f.begin('unknown-candidate', 'Bind one exact candidate before a later foreign edit.'));
  f.setWeights([1, 1]); f.evaluate(id); f.setWeights([1.25, 1.25]);
  const result = f.cli('experiment', 'resolve', '--plan', f.plan, '--file', f.writeDecision({ version: 1, id: 'unknown-discard', expect: f.revision(), attempt: id, decision: 'discard', description: 'Recognized identity is required before rollback.' }));
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /unknown|recogniz|candidate|changed|identity/i);
  assert.deepEqual(f.weights(), [1.25, 1.25]);
});

test('a real controller crash keeps its charged pair and only a new repair invocation can measure', { skip: !supportedHost }, async t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true);
  const hypothesis = 'Establish the untouched baseline before any candidate edit.';
  const id = attemptId(f.begin('crash-baseline', hypothesis));
  const before = f.status();
  const child = f.startProcess('experiment', 'evaluate', '--plan', f.plan, '--attempt', id);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '', killed = false;
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-65536); });
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-65536); });
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const common = { workspace: f.workspace, plan: loadPlan(f.workspace, f.plan, { home: f.home }), home: f.home, copilotHome: f.copilotHome };
  const lock = path.join(path.dirname(f.plan), `.${path.basename(f.plan)}.lock`);
  let resumeAt = 0;
  const observe = () => {
    if (killed || child.exitCode !== null || child.signalCode !== null || Date.now() < resumeAt) return;
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(before.root, 'state.json'), 'utf8')).value; } catch { return; }
    if (state.active !== id || state.status !== 'running' || !child.kill('SIGSTOP')) return;
    try {
      const stopped = experimentStatus(common).active;
      const childrenSafe = stopped && Object.values(stopped.children).every(child => child.state === 'reserved' || child.state === 'settled' && child.result?.groupReaped === true);
      if (stopped?.id === id && stopped.state === 'running' && childrenSafe && !fs.existsSync(lock)) killed = child.kill('SIGKILL');
    } finally {
      if (!killed) { resumeAt = Date.now() + 50; child.kill('SIGCONT'); }
    }
  };
  const watcher = fs.watch(before.root, observe);
  const interval = setInterval(observe, 10);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  let exit;
  try { exit = await completion; } finally { clearTimeout(timeout); clearInterval(interval); watcher.close(); }
  assert.equal(killed, true, `Controller never published running state before exit. ${output} ${errors}`);
  assert.equal(exit.signal, 'SIGKILL');
  const replay = f.cli('experiment', 'evaluate', '--plan', f.plan, '--attempt', id);
  assert.notEqual(replay.status, 0, replay.stdout + replay.stderr);
  const crashed = f.status();
  assert.equal(crashed.spent, 2);
  assert.equal(crashed.origin, before.origin);
  assert.equal(crashed.active.state, 'interrupted', replay.stdout + replay.stderr);
  assert.equal(crashed.active.measurement, undefined);
  f.resolve('crash-discard', id, 'discard');
  const repair = f.begin('charged-repair', hypothesis, { repair_of: id });
  assert.equal(repair.attempt.kind, 'repair');
  assert.notEqual(attemptId(repair), id);
  assert.equal(f.status().spent, 4);
  const measured = f.evaluate(repair.attempt.id);
  assert.equal(measured.measurement.metric.value, 2);
  assert.equal(measured.measurement.correctness.passed, true);
  f.resolve('repair-keep', repair.attempt.id, 'keep');
  assert.deepEqual(f.weights(), [0, 0]);
  assert.equal(f.status().origin, before.origin);
});

test('explicit cancellation preserves the spent reservation and stops further candidate work', { skip: !supportedHost }, t => {
  const f = experimentFixture(t); f.create(); assert.equal(f.start().pass, true);
  const id = attemptId(f.begin('cancel-baseline', 'Reserve an untouched baseline that the user cancels.'));
  f.resolve('cancel', id, 'cancel');
  const cancelled = f.status();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.spent, 2);
  assert.equal(cancelled.active, null);
  assert.equal(cancelled.lastKept, null);
  const next = f.cli('experiment', 'begin', '--plan', f.plan, '--file', f.writeDecision(f.beginInput('after-cancel', 'Cancelled work must not restart through another operation.')));
  assert.notEqual(next.status, 0, next.stdout + next.stderr);
  assert.deepEqual(f.weights(), [0, 0]);
});

test('an accepted same-plan budget increase preserves the baseline and spent reservations', { skip: !supportedHost }, t => {
  const contract = experimentContract({ budget: { max_invocations: 2, max_seconds: 300, timeout_seconds: 10, max_repair_reruns: 2 } });
  const f = experimentFixture(t, { contract }); f.create(); assert.equal(f.start().pass, true);
  const baseline = retainedBaseline(f);
  const priorStatus = f.status();
  const planId = YAML.parse(fs.readFileSync(f.plan, 'utf8').split('---')[1]).plan_id;
  const increased = { ...contract, budget: { ...contract.budget, max_invocations: 4, max_seconds: 600 } };
  f.op('more-budget', 'amend', { rationale: 'Accept one more measured hypothesis on the existing series.', authority: { scope: 'experiment-intent', basis: 'Test acceptance instruction.' }, changes: { experiment: increased } });
  assert.equal(YAML.parse(fs.readFileSync(f.plan, 'utf8').split('---')[1]).plan_id, planId);
  assert.equal(f.invoke('gate', '--plan', f.plan, '--phase', 'implement').pass, true);
  const continued = f.status();
  assert.equal(continued.origin, priorStatus.origin);
  assert.equal(continued.spent, 2);
  assert.equal(continued.lastKept.id, baseline);
  const second = f.begin('second-pair', 'Use the additional accepted pair without resetting baseline.');
  assert.equal(second.attempt.kind, 'candidate');
  assert.equal(second.attempt.ordinal, 2);
  assert.notEqual(attemptId(second), baseline);
  f.setWeights([1, 1]);
  assert.equal(f.evaluate(second.attempt.id).measurement.metric.value, 1);
  f.resolve('second-keep', second.attempt.id, 'keep');
  const exhausted = f.cli('experiment', 'begin', '--plan', f.plan, '--file', f.writeDecision(f.beginInput('reset-budget-probe', 'A new pair would exceed the preserved four slots.')));
  assert.notEqual(exhausted.status, 0, exhausted.stdout + exhausted.stderr);
  assert.match(exhausted.stdout + exhausted.stderr, /budget|exhaust/i);
});
