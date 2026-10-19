import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { runScopedTodo } from '../lib/scoped-todo.mjs';
import { bindPlaybook, validatePlaybookBinding } from '../lib/playbook-binding.mjs';
import { planUpdateLockDir } from '../lib/plan-update.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { runTodo, todoResultOf } from '../lib/todo-cmd.mjs';

const cli = fileURLToPath(new URL('../bin/harness.mjs', import.meta.url));
const recipe = '# Feature\n\n1. Read the current behavior.\n2. Verify the accepted change.\n';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-todo-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'product');
  const home = path.join(dir, 'harness');
  const copilotHome = path.join(dir, 'copilot');
  const source = path.join(copilotHome, 'skills/references/playbooks/feature.md');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, recipe);
  const binding = bindPlaybook('feature', { copilotHome });
  const plan = { fm: { plan_id: randomUUID(), playbook: 'feature', playbook_binding: binding } };
  const args = { workspace, home, copilotHome, plan };
  const store = () => path.join(projectStoreDir(workspace, { home }), 'todos', `${plan.fm.plan_id}.json`);
  return { ...args, dir, source, store };
}

function writePlan(f) {
  const full = path.join(projectStoreDir(f.workspace, { home: f.home }), 'plans', '2026-10-12-feat-example-plan.md');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const fm = { plan_format: 'short-v2', intent_source_policy: 'content-v1', intent_sources: [], status: 'planned', plan_lock: true, phase: 1, acceptance_ids: ['AC1'], acceptance_text: { AC1: 'Behavior is proved' }, verification: { required: ['unit-tests'], criteria: { AC1: ['unit-tests'] } }, reviews: { required: [], completed: [], critical_open: [] }, ...f.plan.fm };
  fs.writeFileSync(full, `---\n${YAML.stringify(fm)}---\n${JSON.stringify({ goal: 'Prove the behavior', acceptance: ['Behavior is proved'], constraints: ['Keep scope bounded'] })}\n`);
  return full;
}

function cliArgs(f, verb, planPath, extra = []) {
  return [cli, 'todo', verb, '--workspace', f.workspace, '--harness-home', f.home, '--copilot-home', f.copilotHome, '--plan', planPath, '--json', ...extra];
}

test('scoped list creates no storage and sync preserves completed work on replay', t => {
  const f = fixture(t);
  assert.equal(runScopedTodo({ ...f, verb: 'list' }).status, 'ok');
  assert.equal(fs.existsSync(projectStoreDir(f.workspace, { home: f.home })), false);
  const first = runScopedTodo({ ...f, verb: 'sync' });
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.items.map(i => i.text), ['Read the current behavior.', 'Verify the accepted change.']);
  assert.equal(first.pendingCount, 2);
  const finished = runScopedTodo({ ...f, verb: 'complete', id: first.items[0].id });
  assert.equal(finished.item.status, 'done');
  const bytes = fs.readFileSync(f.store(), 'utf8');
  const replay = runScopedTodo({ ...f, verb: 'sync' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.performedCount, 1);
  assert.equal(replay.pendingCount, 1);
  assert.equal(fs.readFileSync(f.store(), 'utf8'), bytes);
  assert.deepEqual(f.plan.fm, { plan_id: f.plan.fm.plan_id, playbook: 'feature', playbook_binding: f.plan.fm.playbook_binding });
});

test('two plans keep distinct worklists and legacy todos survive scoped commands', t => {
  const f = fixture(t);
  runTodo({ workspace: f.workspace, verb: 'add', text: 'unrelated legacy work' });
  const legacy = fs.readFileSync(path.join(f.workspace, '.harness/todo.json'), 'utf8');
  const first = runScopedTodo({ ...f, verb: 'sync' });
  runScopedTodo({ ...f, verb: 'complete', id: first.items[0].id });
  const other = { fm: { ...f.plan.fm, plan_id: randomUUID() } };
  const second = runScopedTodo({ ...f, plan: other, verb: 'sync' });
  assert.equal(second.performedCount, 0);
  assert.equal(second.pendingCount, 2);
  assert.equal(runScopedTodo({ ...f, verb: 'list' }).performedCount, 1);
  assert.equal(fs.readFileSync(path.join(f.workspace, '.harness/todo.json'), 'utf8'), legacy);
  assert.equal(runScopedTodo({ ...f, verb: 'clear' }).status, 'failed');
  assert.equal(runScopedTodo({ ...f, verb: 'add' }).status, 'failed');
});

test('accepted workflow inapplicability stays visibly open and separate from performed work', t => {
  const f = fixture(t);
  f.plan.fm.workflow_not_applicable = [{ playbook: 'feature', sha256: f.plan.fm.playbook_binding.sha256, step: 'S2', reason: 'No runtime behavior changed.' }];
  const synced = runScopedTodo({ ...f, verb: 'sync' });
  assert.equal(synced.inapplicableCount, 1);
  assert.equal(synced.performedCount, 0);
  assert.equal(synced.pendingCount, 1);
  assert.equal(synced.items[1].status, 'open');
  assert.equal(synced.items[1].disposition, 'accepted-inapplicable');
  assert.equal(f.plan.fm.acceptance_criteria, undefined);
});

test('playbook drift fails until an accepted binding changes and retains old items', t => {
  const f = fixture(t);
  const first = runScopedTodo({ ...f, verb: 'sync' });
  runScopedTodo({ ...f, verb: 'complete', id: first.items[0].id });
  const before = fs.readFileSync(f.store(), 'utf8');
  fs.writeFileSync(f.source, recipe + '3. Record the result.\n');
  const rejected = runScopedTodo({ ...f, verb: 'sync' });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.output[0].line, /playbook|binding|changed|hash/i);
  assert.equal(fs.readFileSync(f.store(), 'utf8'), before);
  f.plan.fm.playbook_binding = bindPlaybook('feature', { copilotHome: f.copilotHome });
  const next = runScopedTodo({ ...f, verb: 'sync' });
  assert.equal(next.items.length, 5);
  assert.equal(next.items.find(i => i.id === first.items[0].id).status, 'done');
  assert.equal(next.pendingCount, 3);
});

test('malformed, oversized, wrong-plan and duplicate stores fail without overwriting bytes', async t => {
  for (const mutate of [
    () => '{',
    () => 'x'.repeat(1024 * 1024 + 1),
    value => JSON.stringify({ ...value, schema: 2 }),
    value => JSON.stringify({ ...value, planId: randomUUID() }),
    value => JSON.stringify({ ...value, items: [...value.items, value.items[0]] }),
    value => JSON.stringify({ ...value, items: [{ ...value.items[0], status: 'skipped' }] }),
    value => JSON.stringify({ ...value, items: [{ ...value.items[0], playbookHash: '../escape' }] }),
  ]) await t.test(String(mutate), st => {
    const f = fixture(st);
    runScopedTodo({ ...f, verb: 'sync' });
    const bad = mutate(JSON.parse(fs.readFileSync(f.store(), 'utf8')));
    fs.writeFileSync(f.store(), bad);
    assert.equal(runScopedTodo({ ...f, verb: 'sync' }).status, 'failed');
    assert.equal(runScopedTodo({ ...f, verb: 'list' }).status, 'failed');
    assert.equal(fs.readFileSync(f.store(), 'utf8'), bad);
  });
});

test('unsafe storage ancestors and leaves refuse reads and writes', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  runScopedTodo({ ...f, verb: 'sync' });
  const outside = path.join(f.dir, 'outside.json');
  fs.writeFileSync(outside, 'unrelated bytes');
  fs.unlinkSync(f.store());
  fs.symlinkSync(outside, f.store());
  assert.equal(runScopedTodo({ ...f, verb: 'list' }).status, 'failed');
  assert.equal(runScopedTodo({ ...f, verb: 'sync' }).status, 'failed');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unrelated bytes');
  fs.unlinkSync(f.store());
  const todos = path.dirname(f.store());
  fs.rmdirSync(todos);
  const outsideDir = path.join(f.dir, 'outside');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, todos, 'dir');
  assert.equal(runScopedTodo({ ...f, verb: 'sync' }).status, 'failed');
  assert.equal(runScopedTodo({ ...f, verb: 'list' }).status, 'failed');
  assert.deepEqual(fs.readdirSync(outsideDir), []);
});

test('missing or escaping plan identities cannot create worklists', t => {
  const f = fixture(t);
  for (const planId of [undefined, '../outside', 'not-a-uuid']) {
    const plan = { fm: { ...f.plan.fm, plan_id: planId } };
    const result = runScopedTodo({ ...f, plan, verb: 'sync' });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /plan_id UUID/);
  }
  assert.equal(fs.existsSync(projectStoreDir(f.workspace, { home: f.home })), false);
});

test('dry-run sync leaves no directory and completion is replayable', t => {
  const f = fixture(t);
  const preview = runScopedTodo({ ...f, verb: 'sync', dryRun: true });
  assert.equal(preview.items.length, 2);
  assert.equal(fs.existsSync(f.store()), false);
  const synced = runScopedTodo({ ...f, verb: 'sync' });
  const id = synced.items[0].id;
  assert.equal(runScopedTodo({ ...f, verb: 'complete', id, dryRun: true }).item.status, 'done');
  assert.equal(runScopedTodo({ ...f, verb: 'list' }).performedCount, 0);
  runScopedTodo({ ...f, verb: 'complete', id });
  const bytes = fs.readFileSync(f.store(), 'utf8');
  assert.equal(runScopedTodo({ ...f, verb: 'complete', id }).replayed, true);
  assert.equal(fs.readFileSync(f.store(), 'utf8'), bytes);
});

test('direct command honors explicit Harness and Copilot homes', t => {
  const f = fixture(t);
  const full = writePlan(f);
  const result = todoResultOf(['sync', '--workspace', f.workspace, '--harness-home', f.home, '--copilot-home', f.copilotHome, '--plan', full]);
  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 2);
  assert.equal(fs.existsSync(f.store()), true);
});

test('actual CLI concurrent syncs converge and completed state survives resume', async t => {
  const f = fixture(t);
  const full = writePlan(f);
  const processes = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs(f, 'sync', full), { env: { ...process.env, HARNESS_HOME: f.home } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  }));
  for (const result of await Promise.all(processes)) {
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).items.length, 2);
  }
  const store = JSON.parse(fs.readFileSync(f.store(), 'utf8'));
  assert.equal(store.items.length, 2);
  const completed = spawnSync(process.execPath, cliArgs(f, 'complete', full, ['--id', store.items[0].id]), { encoding: 'utf8' });
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  const replay = spawnSync(process.execPath, cliArgs(f, 'sync', full), { encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.equal(JSON.parse(replay.stdout).performedCount, 1);
});

test('linked worktrees use one stable plan worklist', t => {
  const f = fixture(t);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture');
  const linked = path.join(f.dir, 'linked');
  git('worktree', 'add', '--detach', linked, 'HEAD');
  const first = runScopedTodo({ ...f, verb: 'sync' });
  runScopedTodo({ ...f, verb: 'complete', id: first.items[0].id });
  const listed = runScopedTodo({ ...f, workspace: linked, verb: 'list' });
  assert.equal(listed.status, 'ok');
  assert.equal(listed.performedCount, 1);
  assert.equal(listed.items.length, 2);
});


test('equal-content named playbooks retain distinct workflow identities', t => {
  const f = fixture(t);
  const first = runScopedTodo({ ...f, verb: 'sync' });
  fs.writeFileSync(path.join(f.copilotHome, 'skills/references/playbooks/bug-fix.md'), recipe);
  const plan = { fm: { ...f.plan.fm, playbook: 'bug-fix', playbook_binding: bindPlaybook('bug-fix', { copilotHome: f.copilotHome }) } };
  const next = runScopedTodo({ ...f, plan, verb: 'sync' });
  assert.equal(next.status, 'ok', next.reason);
  assert.equal(next.items.length, 4);
  assert.equal(next.pendingCount, 2);
  assert.equal(next.items.filter(item => item.disposition === 'previous-workflow').length, 2);
  assert.notEqual(first.items[0].id, next.items[2].id);
});

test('scoped CLI refuses unsupported or unlocked draft plans before creating a worklist', t => {
  const f = fixture(t), full = writePlan(f);
  const accepted = fs.readFileSync(full, 'utf8');
  for (const before of [accepted.replace('plan_lock: true', 'plan_lock: false'), accepted.replace('short-v2', 'short-v999')]) {
    fs.writeFileSync(full, before);
    const invalid = spawnSync(process.execPath, cliArgs(f, 'sync', full), { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.equal(fs.existsSync(f.store()), false);
    assert.equal(fs.readFileSync(full, 'utf8'), before);
  }
});


test('scoped CLI holds the accepted plan lock while waiting for its store transaction', async t => {
  const f = fixture(t), full = writePlan(f);
  assert.equal(runScopedTodo({ ...f, verb: 'sync' }).status, 'ok');
  const storeLock = planUpdateLockDir(f.store());
  fs.mkdirSync(storeLock);
  const child = spawn(process.execPath, cliArgs(f, 'sync', full), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ended = new Promise(resolve => child.on('exit', code => resolve(code)));
  t.after(() => { child.kill(); fs.rmSync(storeLock, { recursive: true, force: true }); });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(planUpdateLockDir(full)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(planUpdateLockDir(full)), true, 'plan read must remain locked before the store transaction');
  fs.rmdirSync(storeLock);
  assert.equal(await ended, 0, stderr);
  assert.equal(fs.existsSync(planUpdateLockDir(full)), false);
});


test('playbook bindings hash original bytes rather than lossy text decoding', t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, Buffer.concat([Buffer.from(recipe), Buffer.from([0xff])]));
  const plan = { fm: { ...f.plan.fm, playbook_binding: bindPlaybook('feature', { copilotHome: f.copilotHome }) } };
  fs.writeFileSync(f.source, Buffer.concat([Buffer.from(recipe), Buffer.from([0xfe])]));
  assert.equal(validatePlaybookBinding(plan, { copilotHome: f.copilotHome }).pass, false);
});
