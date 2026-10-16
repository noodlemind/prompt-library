import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { initGit } from './helpers/cli-fixtures.mjs';
import { readOrientSlice } from '../lib/orient-read.mjs';
import { runOrient } from '../lib/orient.mjs';
import { reviewPreparation, preparationIsCurrent } from '../lib/review-preparation.mjs';

function fixture(t) {
  const root = tempDir('performance-context-'), workspace = path.join(root, 'product'), home = path.join(root, 'home'), copilotHome = path.join(root, 'copilot');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(workspace); fs.mkdirSync(copilotHome); initGit(workspace);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/checkout.js'), 'export function checkout() { return 1; }\n');
  const profile = { version: 1, sources: [{ id: 'checkout-code', repo: 'self', path: 'src/checkout.js', kind: 'code' }], nodes: [{ id: 'checkout', label: 'Checkout', kind: 'service', sources: ['checkout-code'] }], edges: [], journeys: [{ id: 'buy', title: 'Buy a product', entry: 'checkout', completion: 'checkout', nodes: ['checkout'], environment: 'fixture', workload: 'one item', maxAgeSeconds: 3600, goals: [{ metric: 'latency', statistic: 'p95', unit: 'ms', basis: 'checkout completion', target: 200 }], constraints: [{ id: 'bounded-query', text: 'Use a bounded number of queries per basket.', sources: ['checkout-code'] }] }] };
  const write = () => { fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true }); fs.writeFileSync(path.join(workspace, '.github/harness/performance.json'), JSON.stringify(profile)); };
  const prepare = () => reviewPreparation({ workspace, scope: { base: 'HEAD', changedFiles: ['src/checkout.js'] }, plan: null, kind: 'code', reviewers: [] }).preparation;
  return { workspace, home, copilotHome, profile, write, prepare };
}

test('orientation retrieves applicable performance constraints before editing', t => {
  const f = fixture(t); f.write();
  const context = readOrientSlice({ ...f, flags: { home: f.home, dryRun: true }, files: ['src/checkout.js'] });
  assert.equal(context.performance.state, 'available');
  assert.equal(context.performance.journeys[0].id, 'buy');
  assert.match(JSON.stringify(context.performance), /bounded number of queries/);
  const oriented = runOrient({ ...f, flags: { home: f.home, dryRun: false }, files: ['src/checkout.js'] });
  assert.equal(oriented.performance.reportId, context.performance.reportId);
  const pack = fs.readFileSync(path.join(f.workspace, oriented.contextPack), 'utf8');
  assert.match(pack, /Performance/);
  assert.match(pack, /performance.json/);
  assert.ok(Buffer.byteLength(pack) <= 2048);
});

test('review binds performance context and invalidates it on dirty source, profile or profile addition', t => {
  const f = fixture(t);
  const absent = f.prepare();
  assert.equal(preparationIsCurrent(f.workspace, absent), true);
  f.write();
  assert.equal(preparationIsCurrent(f.workspace, absent), false, 'a newly added profile must be reviewed');
  const prepared = f.prepare();
  assert.equal(prepared.performance.journeys[0].id, 'buy');
  assert.equal(preparationIsCurrent(f.workspace, prepared), true);
  fs.writeFileSync(path.join(f.workspace, 'src/checkout.js'), 'export function checkout() { return 2; }\n');
  assert.equal(preparationIsCurrent(f.workspace, prepared), false);
  const fresh = f.prepare();
  fs.unlinkSync(path.join(f.workspace, '.github/harness/performance.json'));
  assert.equal(preparationIsCurrent(f.workspace, fresh), false);
});

test('unreadable or malformed performance contracts are explicit in orientation and review', t => {
  const f = fixture(t); f.write();
  fs.writeFileSync(path.join(f.workspace, '.github/harness/performance.json'), '{"version":1,"version":2}');
  const oriented = readOrientSlice({ ...f, flags: { dryRun: true }, files: ['src/checkout.js'] });
  assert.equal(oriented.performance.state, 'invalid');
  const prepared = f.prepare();
  assert.equal(prepared.performance.state, 'invalid');
  assert.ok(prepared.failures.some(message => /performance/i.test(message)));
});

test('oversized journey context exposes omissions and retrieves every constraint through the advertised command', t => {
  const f = fixture(t);
  f.profile.journeys[0].constraints = Array.from({ length: 4 }, (_, index) => ({ id: `constraint-${index}`, text: `${index} ${'Bound each query to the selected basket. '.repeat(40)}`, sources: ['checkout-code'] }));
  f.write();
  const oriented = runOrient({ ...f, flags: { home: f.home, dryRun: false }, files: ['src/checkout.js'] });
  assert.equal(oriented.performance.omitted.journeys, 1);
  assert.equal(oriented.performance.journeys.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(oriented.performance)) <= 4096);
  const pack = fs.readFileSync(path.join(f.workspace, oriented.contextPack), 'utf8');
  assert.match(pack, /1 journey\(s\) omitted[^\n]+Read full declared goals and constraints from \.github\/harness\/performance\.json/);
  const command = pack.match(/Retrieve all current goals and constraints: `(harness [^`]+)`/)?.[1];
  assert.equal(command, 'harness performance analyze --dry-run --json');
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/harness.mjs'), ...command.split(' ').slice(1), '--workspace', f.workspace, '--harness-home', f.home, '--no-events'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).report.journeys[0].constraints, f.profile.journeys[0].constraints);
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness/performance')), false);
  assert.ok(Buffer.byteLength(pack) <= 2048);
});

test('the context pack counts journeys omitted by its own two-journey preview', t => {
  const f = fixture(t);
  f.profile.journeys.push(...['sell', 'refund'].map(id => ({ ...f.profile.journeys[0], id })));
  f.write();
  const oriented = runOrient({ ...f, flags: { home: f.home, dryRun: false }, files: ['src/checkout.js'] });
  assert.equal(oriented.performance.journeys.length, 3);
  assert.equal(oriented.performance.omitted.journeys, 0);
  const pack = fs.readFileSync(path.join(f.workspace, oriented.contextPack), 'utf8');
  assert.match(pack, /1 journey\(s\) omitted/);
  assert.ok(Buffer.byteLength(pack) <= 2048);
});
