#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../../../../packages/ae/lib/runner.mjs';
import { GIT_ENV } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const bin = path.join(repoRoot, 'packages/ae/bin/ae.mjs');
const artifactRoot = process.env.HARNESS_CHECK_ARTIFACT_DIR || process.env.HARNESS_DRIVE_EVIDENCE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formal-flows-evidence-'));
const evidencePath = path.join(artifactRoot, 'formal-flows/drive.json');
const controller = new AbortController();
const receipt = { schema: 1, feature: 'formal-flows', passed: false, steps: [], lifecycle: { outcome: 'failed', doctor: null, resources: [], cleaned: false } };
let stage = 'arguments';
let cancellationPoll;
const cancel = () => { receipt.lifecycle.outcome = 'cancelled'; controller.abort(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, cancel);
const notice = process.env.HARNESS_RUN_CANCEL_FILE;
if (notice && path.isAbsolute(notice)) {
  cancellationPoll = setInterval(() => {
    try {
      const stat = fs.lstatSync(notice);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) return;
      const value = JSON.parse(fs.readFileSync(notice, 'utf8'));
      if (value.version === 1 && value.pid === process.pid) cancel();
    } catch { /* the owned cancellation notice appears only on interruption */ }
  }, 25);
  cancellationPoll.unref();
}

async function run(label, argv, { cwd = repoRoot, env = process.env, expected = 0, recovery = false } = {}) {
  stage = label;
  if (!recovery) assert.equal(controller.signal.aborted, false, 'drive cancelled');
  const result = await runProcess({ argv, cwd, env, timeoutMs: 30000, maxBuffer: 262144, ...(recovery ? {} : { signal: controller.signal }) });
  receipt.steps.push({ stage: label, argv, cwd, status: result.status, exitCode: result.exitCode, stdout: result.stdout.slice(0, 16384), stderr: result.stderr.slice(0, 4096) });
  assert.equal(result.exitCode, expected, `${label}: ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

const doctor = async recovery => run(recovery ? 'doctor-after-failure' : 'doctor', [process.execPath, path.join(here, 'doctor.mjs')], { recovery });

try {
  assert.equal(process.argv.length, 2, 'this helper accepts no arguments');
  const ready = await doctor(false);
  receipt.lifecycle.doctor = { exitCode: ready.exitCode, stdout: ready.stdout, stderr: ready.stderr };
  const revision = await run('source-revision', ['git', 'rev-parse', 'HEAD'], { env: { ...process.env, ...GIT_ENV } });
  const sourceFiles = ['packages/ae/lib/flow-model.mjs', 'packages/ae/lib/flow-model-cmd.mjs', 'packages/ae/lib/orientation-facts.mjs', 'packages/ae/lib/orient.mjs', 'packages/ae/lib/context-pack.mjs', '.cursor/skills/verify-harness/scripts/prove-formal-flows.mjs'];
  receipt.source = { head: revision.stdout.trim(), inputs: Object.fromEntries(sourceFiles.map(rel => [rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, rel))).digest('hex')])) };
  const owned = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formal-flows-')));
  receipt.lifecycle.resources.push(owned);
  const ws = path.join(owned, 'product'), home = path.join(owned, 'state'), copilot = path.join(owned, 'copilot');
  const env = { ...process.env, ...GIT_ENV, CI: '', HARNESS_ALLOW_INPLACE: '', HOME: owned, USERPROFILE: owned, AE_HOME: home, HARNESS_HOME: home, COPILOT_HOME: copilot };
  const git = async (...args) => (await run(`git-${args[0]}`, ['git', ...args], { cwd: ws, env })).stdout.trim();
  const cli = async (label, args, expected = 0) => {
    const result = await run(label, [process.execPath, bin, ...args, '--workspace', ws, '--copilot-home', copilot, '--ae-home', home, '--json'], { cwd: ws, env, expected });
    return JSON.parse(result.stdout || result.stderr);
  };
  write(path.join(ws, 'src/app.js'), 'export const state = "idle";\n');
  write(path.join(ws, 'README.md'), 'Disposable flow-model product.\n');
  write(path.join(ws, '.gitignore'), '.harness/\n');
  await git('init', '-q', '-b', 'main');
  await git('remote', 'add', 'origin', 'https://example.test/formal-flows.git');
  const commitDefault = async message => {
    await git('add', '.'); await git('commit', '-qm', message);
    const head = await git('rev-parse', 'HEAD');
    await git('update-ref', 'refs/remotes/origin/main', head);
    return head;
  };
  const initial = await commitDefault('initial application');
  await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.equal((await cli('cold-status', ['flows', 'status'])).state, 'absent');
  assert.equal(fs.existsSync(home), false, 'cold status must not create private state');
  const scope = '.harness/decisions/scope.json';
  write(path.join(ws, scope), JSON.stringify({ watchPaths: ['src'] }));
  const prepared = await cli('prepare', ['flows', 'prepare', '--file', scope]);
  const preparation = prepared.preparation;
  assert.equal(preparation.generationCommit, initial);
  assert.deepEqual(preparation.sources.map(source => source.path), ['src/app.js']);
  const model = { version: 1, format: 'statechart', flows: [{ id: 'checkout', title: 'Checkout', sources: ['src/app.js'], initial: 'idle', states: [{ id: 'idle' }, { id: 'done', kind: 'terminal' }], transitions: [{ from: 'idle', to: 'done', event: 'finish' }], properties: ['Completion is terminal.'] }], assumptions: ['This map describes committed source.'], limitations: ['External systems are abstracted.'] };
  const candidate = '.harness/decisions/candidate.json';
  const writeCandidate = packet => write(path.join(ws, candidate), JSON.stringify({ version: 1, preparation: packet, model }));
  writeCandidate(preparation);
  const published = await cli('publish', ['flows', 'publish', '--file', candidate]);
  assert.equal(published.state, 'current');
  assert.equal(published.generationCommit, initial);
  const publishedBytes = fs.readFileSync(published.reference);
  assert.equal(crypto.createHash('sha256').update(publishedBytes).digest('hex'), published.sha256);
  assert.deepEqual(JSON.parse(publishedBytes).model, model);
  assert.equal((await cli('repeat-publish', ['flows', 'publish', '--file', candidate])).replayed, true);
  assert.deepEqual((await cli('show', ['flows', 'show'])).model, model);
  const oriented = await cli('related-orient', ['orient', '--read', '--context-version', '2', '--file', 'src/app.js']);
  const context = oriented.slice.flowModel;
  assert.equal(context.state, 'current');
  assert.equal(context.reference, published.reference);
  assert.equal(context.sha256, published.sha256);
  assert.equal(context.scope, 'committed-default-branch');
  assert.equal(context.authority, 'descriptive-context');
  assert.deepEqual(context.flowIds, ['checkout']);
  assert.equal('model' in context, false, 'orientation must return pointers rather than model bodies');
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 4096);
  const unrelated = await cli('unrelated-orient', ['orient', '--read', '--context-version', '2', '--file', 'README.md']);
  assert.equal(unrelated.slice.flowModel ?? null, null);
  fs.appendFileSync(path.join(ws, 'README.md'), 'Unrelated default-branch documentation.\n');
  const unrelatedCommit = await commitDefault('unrelated default advance');
  const stillCurrent = await cli('unrelated-advance', ['flows', 'status']);
  assert.equal(stillCurrent.state, 'current');
  assert.equal(stillCurrent.defaultCommit, unrelatedCommit);
  write(path.join(ws, 'src/new-writer.js'), 'export function finish() {}\n');
  const changed = await commitDefault('new flow writer');
  const stale = await cli('relevant-advance', ['flows', 'status']);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.defaultCommit, changed);
  assert.deepEqual(stale.changedPaths, ['src/new-writer.js']);
  assert.equal((await cli('stale-orient', ['orient', '--read', '--context-version', '2', '--file', 'src/app.js'])).slice.flowModel.state, 'stale');
  const rejected = await cli('obsolete-publish', ['flows', 'publish', '--file', candidate], 2);
  assert.match(JSON.stringify(rejected), /stale|preparation|changed/i);
  assert.deepEqual(fs.readFileSync(published.reference), publishedBytes, 'obsolete publication must preserve the prior generation');
  const preserved = await cli('rejected-publication-status', ['flows', 'status']);
  assert.equal(preserved.state, 'stale');
  assert.equal(preserved.reference, published.reference);
  const refreshed = await cli('prepare-maintenance', ['flows', 'prepare', '--file', scope]);
  assert.equal(refreshed.preparation.generationCommit, changed);
  writeCandidate(refreshed.preparation);
  const maintained = await cli('publish-maintenance', ['flows', 'publish', '--file', candidate]);
  assert.equal(maintained.state, 'current');
  assert.equal(maintained.generationCommit, changed);
  assert.notEqual(maintained.reference, published.reference);
  receipt.generations = { initial, unrelated: unrelatedCommit, refreshed: changed };
  receipt.coverage = ['cold read', 'committed preparation', 'authored publication', 'immutable replay', 'relevant bounded orientation', 'unrelated omission', 'unrelated default advance', 'watched default advance', 'obsolete rejection', 'explicit maintenance'];
  assert.equal(controller.signal.aborted, false, 'drive cancelled');
  receipt.passed = true;
  receipt.lifecycle.outcome = 'passed';
} catch (error) {
  receipt.error = { stage, message: error.message.slice(0, 2048) };
  if (receipt.lifecycle.doctor && !controller.signal.aborted) {
    try { const checked = await doctor(true); receipt.lifecycle.doctorAfterFailure = { exitCode: checked.exitCode, stdout: checked.stdout, stderr: checked.stderr }; }
    catch (failure) { receipt.lifecycle.doctorAfterFailure = { error: failure.message.slice(0, 2048) }; }
  }
  process.exitCode = 1;
} finally {
  if (cancellationPoll) clearInterval(cancellationPoll);
  for (const resource of receipt.lifecycle.resources) fs.rmSync(resource, { recursive: true, force: true });
  receipt.lifecycle.cleaned = receipt.lifecycle.resources.every(resource => !fs.existsSync(resource));
  receipt.evidencePath = evidencePath;
  write(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.equal(fs.existsSync(evidencePath), true, 'evidence survives cleanup');
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
