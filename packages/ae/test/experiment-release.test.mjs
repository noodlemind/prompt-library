import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { creationDecision, experimentContract, experimentFixture, hash } from './helpers/experiment-command-fixtures.mjs';

const fixture = path.join(import.meta.dirname, 'fixtures/prior-harness-domain-1265403.tgz');

function priorPackage(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prior-experiment-compat-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = JSON.parse(fs.readFileSync(fixture.replace(/\.tgz$/, '.json'), 'utf8'));
  assert.equal(metadata.sourceCommit, '1265403577e2782ef56defb1dbe5b74021d95956');
  assert.equal(metadata.packageVersion, '0.10.0');
  assert.equal(metadata.bundledYamlVersion, '2.9.0');
  assert.equal(hash(fs.readFileSync(fixture)), '05c60c4deaab44e9da70a9143385ef2f96679cc582f7e525b58a38c7685f2205');
  assert.equal(spawnSync('tar', ['-xzf', fixture, '-C', root]).status, 0);
  const workspace = path.join(root, 'product'); fs.mkdirSync(workspace); initGit(workspace);
  const bin = path.join(root, 'package/bin/ae.mjs');
  const env = { ...process.env, HARNESS_HOME: path.join(root, 'home'), COPILOT_HOME: path.join(root, 'copilot'), HARNESS_NO_EVENTS: '1' };
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', workspace, '--json', '--no-events'], { env, cwd: workspace, encoding: 'utf8', timeout: 20_000 });
  assert.equal(cli('--version').stdout.trim(), '0.10.0');
  assert.equal(cli('help', 'domain').status, 0, 'control package must already expose schema-3 domain commands');
  return { root, workspace, bin, cli };
}

test('the pre-experiment package is a live legacy writer rather than a broken executable', t => {
  const f = priorPackage(t), rel = writeVersionedPlan(f.workspace);
  const full = path.join(f.workspace, rel), before = fs.readFileSync(full);
  const result = f.cli('plan-update', '--plan', full, '--activity', 'Prior reader mutation canary');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(hash(fs.readFileSync(full)), hash(before));
});

test('the packaged schema-3 reader refuses every schema-4 work-bearing lane without changing guarantees', t => {
  const f = priorPackage(t), rel = writeVersionedPlan(f.workspace, { name: '2026-10-12-feat-experiment-plan.hplan' });
  const full = path.join(f.workspace, rel);
  const source = fs.readFileSync(full, 'utf8').replace('plan_schema: 1', 'plan_schema: 4').replace('plan_lock: true', 'plan_lock: false');
  fs.writeFileSync(full, source.replace('---\n', `---\nexperiment: ${JSON.stringify(experimentContract())}\n`));
  const before = fs.readFileSync(full), decision = path.join(f.root, 'decision.json');
  fs.writeFileSync(decision, JSON.stringify({ version: 1, id: 'unsupported-experiment', action: 'start', expect: hash(before) }));
  for (const args of [
    ['plan-update', '--plan', full, '--activity', 'Must not mutate'],
    ['plan-update', '--plan', full, '--status', 'planned'],
    ['plan-update', '--plan', full, '--lock', 'true'],
    ['plan-update', '--plan', full, '--file', decision],
    ['plan-new', '--from', full],
    ['gate', '--plan', full, '--phase', 'implement'],
    ['verify', '--plan', full, '--base', 'HEAD'],
    ['compound', '--plan', full, '--learning-decision', decision],
  ]) {
    const result = f.cli(...args);
    assert.notEqual(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(fs.readFileSync(full), before, `${args[0]} changed unsupported experiment obligations`);
  }
});

test('the prior authoring boundary refuses an experiment field instead of silently producing an ordinary plan', t => {
  const f = priorPackage(t), decision = path.join(f.root, 'creation.json');
  fs.writeFileSync(decision, JSON.stringify(creationDecision()));
  const result = f.cli('plan-new', '--file', decision);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /unsupported creation decision schema/i);
  const files = fs.existsSync(path.join(f.root, 'home')) ? fs.readdirSync(path.join(f.root, 'home'), { recursive: true }) : [];
  assert.equal(files.some(name => String(name).endsWith('.md') || String(name).endsWith('.hplan')), false);
});

test('a valid authored schema-4 conversion remains immutable under the real pre-experiment package', t => {
  const prior = priorPackage(t), current = experimentFixture(t);
  current.create({ experiment: undefined });
  const converted = current.op('convert-for-old-reader', 'convert', { rationale: 'Accept the finite numerical experiment.', authority: { scope: 'experiment-intent', basis: 'Compatibility acceptance instruction.' }, changes: { experiment: experimentContract() } });
  assert.equal(path.extname(converted.path), '.hplan');
  const before = fs.readFileSync(current.plan), decision = current.writeDecision({ version: 1, id: 'prior-reader-start', action: 'start', expect: hash(before) });
  const env = { ...process.env, HARNESS_HOME: current.home, COPILOT_HOME: current.copilotHome, HARNESS_NO_EVENTS: '1' };
  for (const args of [
    ['plan-update', '--plan', current.plan, '--activity', 'Must not ignore the experiment'],
    ['plan-update', '--plan', current.plan, '--file', decision],
    ['plan-new', '--from', current.plan],
    ['gate', '--plan', current.plan, '--phase', 'implement'],
    ['verify', '--plan', current.plan, '--base', 'HEAD'],
  ]) {
    const result = spawnSync(process.execPath, [prior.bin, ...args, '--workspace', current.workspace, '--harness-home', current.home, '--copilot-home', current.copilotHome, '--json', '--no-events'], { cwd: current.workspace, env, encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fs.readFileSync(current.plan), before);
  }
});
