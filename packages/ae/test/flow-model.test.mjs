import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { prepareFlowModel, publishFlowModel, showFlowModel, flowModelStatus, flowModelContext, flowMaintenance } from '../lib/flow-model.mjs';

function fixture(t) {
  const root = tempDir('ae-flow-model #-'), workspace = path.join(root, 'product'), home = path.join(root, 'private');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'trunk');
  git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
  git('remote', 'add', 'origin', 'https://example.test/application.git');
  fs.writeFileSync(path.join(workspace, 'src/app.js'), 'export const state = "idle";\n');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Application\n');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const initial = commit();
  git('update-ref', 'refs/remotes/origin/trunk', initial);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, home, git, commit, initial };
}

function candidate(f, watchPaths = ['src']) {
  const preparation = prepareFlowModel({ ...f, watchPaths });
  return { version: 1, preparation, model: { version: 1, format: 'statechart', flows: [{
    id: 'checkout', title: 'Checkout', sources: ['src/app.js'], initial: 'idle',
    states: [{ id: 'idle' }, { id: 'active' }, { id: 'done', kind: 'terminal' }],
    transitions: [{ from: 'idle', to: 'active', event: 'start' }, { from: 'active', to: 'done', event: 'finish' }],
    properties: ['Only an active checkout can finish.'],
  }], assumptions: ['The map describes committed application source.'], limitations: ['External services are abstracted.'] } };
}

test('cold reads create no private state and never assume the current branch is the default', t => {
  const f = fixture(t);
  assert.equal(flowModelStatus(f).state, 'absent');
  assert.equal(showFlowModel(f).model, null);
  assert.equal(flowModelContext({ ...f, files: [], query: '' }), null);
  assert.equal(flowMaintenance(f), null);
  assert.equal(fs.existsSync(f.home), false);
  f.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  assert.throws(() => prepareFlowModel(f), /default branch/i);
  assert.equal(fs.existsSync(f.home), false);
});

test('preparation binds default-branch bytes, including while a feature worktree differs', t => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(f.workspace, 'src/app.js'), 'uncommitted feature state\n');
  const packet = prepareFlowModel({ ...f, watchPaths: ['src', 'future-writers'] });
  assert.equal(packet.generationCommit, f.initial);
  assert.equal(packet.defaultBranch.name, 'trunk');
  assert.equal(packet.defaultBranch.ref, 'refs/remotes/origin/trunk');
  assert.deepEqual(packet.sources.map(source => source.path), ['src/app.js']);
  assert.match(packet.sources[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(f.home), false);
  const published = publishFlowModel({ ...f, input: candidate(f) });
  assert.equal(published.state, 'current');
});

test('narrow watch paths remain usable when unrelated committed inventory exceeds the tree budget', t => {
  const f = fixture(t), published = publishFlowModel({ ...f, input: candidate(f) });
  const blob = f.git('rev-parse', `${f.initial}:src/app.js`);
  const inventory = Array.from({ length: 25_000 }, (_, i) =>
    `100644 blob ${blob}\tunrelated-${String(i).padStart(6, '0')}-${'x'.repeat(130)}\n`).join('');
  assert.ok(Buffer.byteLength(inventory) > 4 * 1024 * 1024);
  const large = spawnSync('git', ['mktree'], { cwd: f.workspace, input: inventory, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(large.error); assert.equal(large.status, 0, large.stderr);
  const top = spawnSync('git', ['mktree'], {
    cwd: f.workspace, input: `${f.git('ls-tree', f.initial)}\n040000 tree ${large.stdout.trim()}\tunrelated\n`, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(top.error); assert.equal(top.status, 0, top.stderr);
  const advanced = f.git('commit-tree', top.stdout.trim(), '-p', f.initial, '-m', 'Large unrelated inventory');
  f.git('update-ref', 'refs/remotes/origin/trunk', advanced);
  const prepared = prepareFlowModel({ ...f, watchPaths: ['src'] });
  assert.equal(prepared.generationCommit, advanced);
  assert.deepEqual(prepared.sources.map(source => source.path), ['src/app.js']);
  const status = flowModelStatus(f);
  assert.equal(status.state, 'current');
  assert.equal(status.generationCommit, published.generationCommit);
  assert.equal(status.defaultCommit, advanced);
  assert.equal(flowModelContext({ ...f, files: ['src/app.js'] }).state, 'current');
});

test('watch paths with glob characters select literal committed paths', t => {
  const f = fixture(t);
  // Build Git objects so this also covers names Windows cannot materialize.
  const sourceTree = f.git('rev-parse', `${f.initial}:src`);
  const directories = ['src[ab]', 'src*', 'src?', 'srca', 'srcb'];
  const top = spawnSync('git', ['mktree'], {
    cwd: f.workspace,
    input: `${f.git('ls-tree', f.initial)}\n${directories.map(directory => `040000 tree ${sourceTree}\t${directory}\n`).join('')}`,
    encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(top.error); assert.equal(top.status, 0, top.stderr);
  const advanced = f.git('commit-tree', top.stdout.trim(), '-p', f.initial, '-m', 'Literal watch names');
  f.git('update-ref', 'refs/remotes/origin/trunk', advanced);
  const watchPaths = ['src[ab]', 'src*', 'src?'];
  const prepared = prepareFlowModel({ ...f, watchPaths });
  assert.deepEqual(prepared.sources.map(source => source.path), watchPaths.map(directory => `${directory}/app.js`).sort((a, b) => a.localeCompare(b, 'en')));
  assert.equal(prepareFlowModel({ ...f, watchPaths: ['.'] }).sources.length, 7);
});

test('publication is immutable, repeatable and available through one validated reader', t => {
  const f = fixture(t), input = candidate(f);
  const dry = publishFlowModel({ ...f, input, dryRun: true });
  assert.equal(dry.dryRun, true); assert.equal(fs.existsSync(f.home), false);
  const first = publishFlowModel({ ...f, input });
  assert.equal(first.state, 'current');
  assert.equal(first.generationCommit, f.initial);
  assert.equal(fs.existsSync(first.reference), true);
  const bytes = fs.readFileSync(first.reference), mtime = fs.statSync(first.reference).mtimeMs;
  assert.equal(publishFlowModel({ ...f, input }).replayed, true);
  assert.equal(fs.statSync(first.reference).mtimeMs, mtime);
  assert.deepEqual(fs.readFileSync(first.reference), bytes);
  const shown = showFlowModel(f);
  assert.deepEqual(shown.model, input.model);
  assert.deepEqual(shown.preparation, input.preparation);
  const different = structuredClone(input); different.model.flows[0].title = 'Changed map';
  assert.throws(() => publishFlowModel({ ...f, input: different }), /conflict/i);
  assert.deepEqual(fs.readFileSync(first.reference), bytes);
});

test('publication rejects obsolete or forged preparation and invalid statechart edges', t => {
  const f = fixture(t), input = candidate(f);
  const invalid = structuredClone(input); invalid.model.flows[0].transitions[0].to = 'missing';
  assert.throws(() => publishFlowModel({ ...f, input: invalid }), /state|transition/i);
  const coercedId = structuredClone(input); coercedId.model.flows[0].id = ['checkout'];
  assert.throws(() => publishFlowModel({ ...f, input: coercedId }), /flow ID/i);
  const forged = structuredClone(input); forged.preparation.sources[0].sha256 = '0'.repeat(64);
  assert.throws(() => publishFlowModel({ ...f, input: forged }), /preparation|binding|digest/i);
  fs.appendFileSync(path.join(f.workspace, 'README.md'), 'advance\n');
  f.git('update-ref', 'refs/remotes/origin/trunk', f.commit());
  assert.throws(() => publishFlowModel({ ...f, input }), /changed|stale|preparation/i);
  assert.equal(fs.existsSync(f.home), false);
});

test('linked worktrees share one project model without accepting their feature HEAD as the baseline', t => {
  const f = fixture(t), published = publishFlowModel({ ...f, input: candidate(f) });
  const linked = path.join(f.root, 'linked');
  f.git('worktree', 'add', '-qb', 'feature-linked', linked);
  fs.writeFileSync(path.join(linked, 'src/app.js'), 'feature implementation\n');
  const fromLinked = { workspace: linked, home: f.home };
  assert.equal(flowModelStatus(fromLinked).reference, published.reference);
  assert.equal(prepareFlowModel(fromLinked).generationCommit, f.initial);
  assert.equal(flowModelContext({ ...fromLinked, files: ['src/app.js'] }).state, 'current');
});

test('an interrupted publication can retry immutable bytes but cannot advance a pointer after the default tip changes', t => {
  const f = fixture(t), input = candidate(f), originalLink = fs.linkSync;
  let advanced = false;
  fs.linkSync = function (from, to) {
    const result = originalLink.call(this, from, to);
    if (!advanced && String(to).endsWith(`${path.sep}model.json`)) {
      advanced = true;
      fs.appendFileSync(path.join(f.workspace, 'README.md'), 'advance during publication\n');
      f.git('update-ref', 'refs/remotes/origin/trunk', f.commit());
    }
    return result;
  };
  try { assert.throws(() => publishFlowModel({ ...f, input }), /default tip changed/i); }
  finally { fs.linkSync = originalLink; }
  const root = path.join(projectStoreDir(f.workspace, { home: f.home }), 'knowledge/flow-models');
  assert.equal(fs.existsSync(path.join(root, 'current.json')), false);
  assert.equal(fs.existsSync(path.join(root, f.initial, 'model.json')), true);
  const next = candidate(f), published = publishFlowModel({ ...f, input: next });
  fs.rmSync(path.join(root, 'current.json'));
  const bytes = fs.readFileSync(published.reference);
  assert.equal(publishFlowModel({ ...f, input: next }).state, 'current');
  assert.deepEqual(fs.readFileSync(published.reference), bytes);
});

test('racing writers cannot replace a newer generation pointer with an older publication', async t => {
  const f = fixture(t), firstInput = candidate(f), marker = path.join(f.root, 'before-pointer');
  const firstFile = path.join(f.root, 'first.json'), secondFile = path.join(f.root, 'second.json');
  fs.writeFileSync(firstFile, JSON.stringify(firstInput));
  const module = pathToFileURL(path.resolve(import.meta.dirname, '../lib/flow-model.mjs')).href;
  const script = `import fs from 'node:fs';
import { publishFlowModel } from ${JSON.stringify(module)};
if (process.env.FLOW_PAUSE) {
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (String(to).endsWith('current.json')) {
      fs.writeFileSync(process.env.FLOW_MARKER, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    }
    return rename.call(this, from, to);
  };
}
console.log(JSON.stringify(publishFlowModel({ workspace: process.env.FLOW_WORKSPACE, home: process.env.FLOW_HOME, input: JSON.parse(fs.readFileSync(process.env.FLOW_INPUT, 'utf8')) })));`;
  const children = [];
  const launch = (input, pause = false) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, FLOW_WORKSPACE: f.workspace, FLOW_HOME: f.home, FLOW_INPUT: input, FLOW_MARKER: marker, FLOW_PAUSE: pause ? '1' : '' } });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr })); });
  };
  t.after(() => children.forEach(child => child.kill()));
  const first = launch(firstFile, true), deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await delay(10);
  assert.equal(fs.existsSync(marker), true, 'first writer must reach pointer publication');
  fs.appendFileSync(path.join(f.workspace, 'README.md'), 'new default generation\n');
  const nextCommit = f.commit(); f.git('update-ref', 'refs/remotes/origin/trunk', nextCommit);
  const next = candidate(f); next.model.flows[0].title = 'Newer authored generation';
  fs.writeFileSync(secondFile, JSON.stringify(next));
  const second = launch(secondFile);
  for (const result of await Promise.all([first, second])) assert.equal(result.status, 0, result.stderr);
  const current = showFlowModel(f);
  assert.equal(current.generationCommit, nextCommit);
  assert.equal(current.model.flows[0].title, 'Newer authored generation');
});

test('freshness ignores unrelated commits and detects newly committed writers in watched directories', t => {
  const f = fixture(t);
  publishFlowModel({ ...f, input: candidate(f) });
  fs.appendFileSync(path.join(f.workspace, 'README.md'), 'unrelated\n');
  const unrelated = f.commit(); f.git('update-ref', 'refs/remotes/origin/trunk', unrelated);
  const current = flowModelStatus(f);
  assert.equal(current.state, 'current'); assert.equal(current.defaultCommit, unrelated);
  assert.equal(flowMaintenance(f), null);
  fs.writeFileSync(path.join(f.workspace, 'src/new-writer.js'), 'export function complete() {}\n');
  const changed = f.commit(); f.git('update-ref', 'refs/remotes/origin/trunk', changed);
  const stale = flowModelStatus(f);
  assert.equal(stale.state, 'stale'); assert.deepEqual(stale.changedPaths, ['src/new-writer.js']);
  const maintenance = flowMaintenance(f);
  assert.equal(maintenance.state, 'refresh-required'); assert.equal(maintenance.defaultCommit, changed);
  assert.equal(fs.readFileSync(stale.reference, 'utf8').includes('new-writer.js'), false);
});

test('removing every watched source still requests regeneration instead of hiding the change as unknown', t => {
  const f = fixture(t); publishFlowModel({ ...f, input: candidate(f) });
  fs.rmSync(path.join(f.workspace, 'src'), { recursive: true });
  f.git('update-ref', 'refs/remotes/origin/trunk', f.commit());
  assert.equal(flowModelStatus(f).state, 'stale');
  assert.deepEqual(flowMaintenance(f).changedPaths, ['src/app.js']);
});

test('a rewritten default history or unresolved default is unknown rather than reusable proof', t => {
  const f = fixture(t); publishFlowModel({ ...f, input: candidate(f) });
  f.git('checkout', '--orphan', 'rewritten');
  f.git('add', '.'); f.git('commit', '-qm', 'unrelated history');
  f.git('update-ref', 'refs/remotes/origin/trunk', f.git('rev-parse', 'HEAD'));
  assert.equal(flowModelStatus(f).state, 'unknown'); assert.equal(flowMaintenance(f), null);
  f.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  assert.equal(flowModelStatus(f).state, 'unknown');
});

test('unmatched orientation reads only bounded metadata; relevant orientation returns a descriptive reference', t => {
  const f = fixture(t); const stored = publishFlowModel({ ...f, input: candidate(f) });
  const originalOpen = fs.openSync; let bodyReads = 0;
  fs.openSync = function (file, ...args) { if (path.resolve(String(file)) === stored.reference) bodyReads++; return originalOpen.call(this, file, ...args); };
  try {
    assert.equal(flowModelContext({ ...f, files: [], query: '' }), null);
    assert.equal(flowModelContext({ ...f, files: ['README.md'], query: 'explain the repository' }), null);
    assert.equal(bodyReads, 0);
    const context = flowModelContext({ ...f, files: ['src/app.js'] });
    assert.equal(context.state, 'current'); assert.deepEqual(context.flowIds, ['checkout']);
    assert.equal(context.authority, 'descriptive-context'); assert.equal('model' in context, false);
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 4096);
    assert.equal(flowModelContext({ ...f, query: 'inspect checkout' }).flowIds[0], 'checkout');
    assert.ok(bodyReads > 0);
  } finally { fs.openSync = originalOpen; }
});

test('orientation normalizes equivalent task paths while keeping outside requests omitted', t => {
  const f = fixture(t); publishFlowModel({ ...f, input: candidate(f) });
  const expected = flowModelContext({ ...f, files: ['src/app.js'] });
  assert.equal(expected.state, 'current');
  for (const file of ['./src/app.js', 'src\\app.js', '.\\src\\app.js', path.join(f.workspace, 'src', 'app.js')]) {
    assert.deepEqual(flowModelContext({ ...f, files: [file] }), expected, file);
  }
  for (const file of ['../outside', 'src/../../outside', path.join(f.root, 'outside.js')]) {
    assert.equal(flowModelContext({ ...f, files: [file] }), null, file);
  }
});

test('tampered models, unsafe pointers and stale source bindings remain advisory unknowns', t => {
  const f = fixture(t), stored = publishFlowModel({ ...f, input: candidate(f) });
  fs.appendFileSync(stored.reference, 'tamper');
  assert.equal(flowModelContext({ ...f, files: ['README.md'] }), null);
  assert.equal(flowModelStatus(f).state, 'unknown'); assert.equal(showFlowModel(f).model, null);
  assert.equal(flowModelContext({ ...f, files: ['src/app.js'] }).state, 'unknown');
  const pointer = path.join(projectStoreDir(f.workspace, { home: f.home }), 'knowledge/flow-models/current.json');
  fs.writeFileSync(pointer, JSON.stringify({ version: 1, generationCommit: '../../outside' }));
  assert.equal(flowModelStatus(f).state, 'unknown');
});

test('watch selections and stored paths cannot escape their owners', t => {
  const f = fixture(t);
  for (const watchPaths of [['../outside'], ['/absolute'], ['src\\outside'], []]) {
    assert.throws(() => prepareFlowModel({ ...f, watchPaths }), /watch|path/i);
  }
  assert.equal(fs.existsSync(f.home), false);
});

test('symlinked private namespaces and committed source links are refused', { skip: process.platform === 'win32' ? 'symlink privileges are not guaranteed on Windows' : false }, t => {
  const f = fixture(t), input = candidate(f), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside); fs.mkdirSync(f.home); fs.symlinkSync(outside, path.join(f.home, 'projects'));
  assert.throws(() => publishFlowModel({ ...f, input }), /unsafe|symlink/i);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmSync(path.join(f.home, 'projects'));
  fs.symlinkSync('../README.md', path.join(f.workspace, 'src/link.js'));
  f.git('update-ref', 'refs/remotes/origin/trunk', f.commit());
  assert.throws(() => prepareFlowModel({ ...f, watchPaths: ['src'] }), /regular|symlink|source/i);
});

test('a symlinked current pointer is never followed or replaced', { skip: process.platform === 'win32' ? 'symlink privileges are not guaranteed on Windows' : false }, t => {
  const f = fixture(t), input = candidate(f); publishFlowModel({ ...f, input });
  const pointer = path.join(projectStoreDir(f.workspace, { home: f.home }), 'knowledge/flow-models/current.json');
  const outside = path.join(f.root, 'outside.json'); fs.writeFileSync(outside, 'private unrelated bytes');
  fs.rmSync(pointer); fs.symlinkSync(outside, pointer);
  assert.equal(flowModelStatus(f).state, 'unknown');
  assert.throws(() => publishFlowModel({ ...f, input }), /unsafe|symlink/i);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private unrelated bytes');
  assert.equal(fs.lstatSync(pointer).isSymbolicLink(), true);
});
