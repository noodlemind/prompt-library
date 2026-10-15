import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const bin = path.resolve(import.meta.dirname, '../../bin/harness.mjs');
const hash = text => createHash('sha256').update(text).digest('hex');

export function runPerformancePilot({ artifactDir } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-performance-pilot-')));
  const gateway = path.join(root, 'gateway'), worker = path.join(root, 'worker'), home = path.join(root, 'home'), copilot = path.join(root, 'copilot');
  const invocations = [];
  const write = (repo, rel, text) => { const file = path.join(repo, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const git = (repo, ...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  };
  const cli = (...args) => {
    const argv = [bin, ...args, '--workspace', gateway, '--harness-home', home, '--copilot-home', copilot, '--json', '--no-events'];
    const result = spawnSync(process.execPath, argv, { cwd: gateway, encoding: 'utf8', timeout: 30_000, env: { ...process.env, HARNESS_HOME: home } });
    invocations.push({ command: 'harness', argv: args, exit: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const sourcePaths = { gateway: [gateway, 'gateway.mjs'], worker: [worker, 'worker.mjs'], manifest: [worker, 'package.json'] };
  const sourceHashes = () => Object.fromEntries(Object.entries(sourcePaths).map(([id, [repo, rel]]) => [id, hash(fs.readFileSync(path.join(repo, rel)))]));
  const expectedRows = Array.from({ length: 12 }, (_, index) => ({ item: index + 1, value: (index + 1) * 10 }));
  const workerFixture = `const items = Array.from({ length: 12 }, (_, index) => index + 1);
const database = new Map(items.map(item => [item, { item, value: item * 10 }]));
let calls = 0, errors = 0;
const query = ids => { calls++; return ids.map(id => { const row = database.get(id); if (!row) errors++; return row; }); };
`;
  const workerSources = {
    before: `${workerFixture}const rows = items.flatMap(item => query([item]));\nconsole.log(JSON.stringify({ calls, rows, errors }));\n`,
    after: `${workerFixture}const rows = query(items);\nconsole.log(JSON.stringify({ calls, rows, errors }));\n`,
  };
  const measure = () => {
    const measured = spawnSync(process.execPath, [path.join(worker, 'worker.mjs')], { encoding: 'utf8', timeout: 5000 });
    assert.equal(measured.status, 0, measured.stderr);
    const { calls, rows, errors } = JSON.parse(measured.stdout);
    assert.deepEqual(rows, expectedRows, 'pilot must return every expected item row');
    assert.equal(errors, 0, 'pilot must complete without query errors');
    return { calls, rows: rows.length, errors };
  };
  const observe = () => {
    const { calls } = measure();
    const observation = { version: 1, provenance: { kind: 'synthetic', description: 'Disposable twelve-item journey. Cost is an illustrative USD 0.001 per counted database call; no production billing or latency claim.' }, capturedAt: new Date().toISOString(), environment: 'disposable-fixture', workload: 'twelve items, one journey', sourceHashes: sourceHashes(), metrics: [{ journey: 'checkout', metric: 'cost', statistic: 'mean', unit: 'USD/journey', basis: 'database calls at USD 0.001 per call', value: calls * 0.001, samples: 1 }] };
    write(gateway, 'observations.json', JSON.stringify(observation));
    return calls;
  };
  let receipt;
  try {
    for (const [repo, name] of [[gateway, 'gateway'], [worker, 'worker']]) {
      fs.mkdirSync(repo, { recursive: true }); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Performance fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'remote', 'add', 'origin', `https://example.invalid/${name}.git`);
      write(repo, '.gitignore', '.harness/\n');
    }
    fs.mkdirSync(copilot);
    write(gateway, 'gateway.mjs', 'export const worker = "checkout-worker";\n');
    write(worker, 'worker.mjs', workerSources.before);
    write(worker, 'package.json', JSON.stringify({ dependencies: { 'legacy-client': '1.0.0' } }));
    for (const repo of [gateway, worker]) { git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Create disposable fixture'); }
    const domain = { domain_version: 2, name: 'checkout', repos: ['gateway', 'worker'].map(id => ({ id, origin: `https://example.invalid/${id}.git` })), sources: [], bindings: { repos: { gateway, worker }, sources: {} }, shared_specs: [], shared_conventions: [] };
    write(home, 'domains/checkout.yaml', YAML.stringify(domain));
    const profile = { version: 1, domain: 'checkout', sources: [{ id: 'gateway', repo: 'gateway', path: 'gateway.mjs', kind: 'code' }, { id: 'worker', repo: 'worker', path: 'worker.mjs', kind: 'code' }, { id: 'manifest', repo: 'worker', path: 'package.json', kind: 'manifest' }, { id: 'measurements', repo: 'gateway', path: 'observations.json', kind: 'evidence' }], nodes: [{ id: 'gateway', label: 'Checkout gateway', kind: 'service', sources: ['gateway'] }, { id: 'worker', label: 'Checkout worker', kind: 'service', sources: ['worker', 'manifest'] }, { id: 'complete', label: 'Checkout complete', kind: 'operation', sources: [] }], edges: [{ id: 'request', from: 'gateway', to: 'worker', mode: 'sync', sources: ['gateway'] }], journeys: [{ id: 'checkout', title: 'Complete a checkout', entry: 'gateway', completion: 'complete', nodes: ['gateway', 'worker', 'complete'], environment: 'disposable-fixture', workload: 'twelve items, one journey', maxAgeSeconds: 3600, goals: [{ metric: 'cost', statistic: 'mean', unit: 'USD/journey', basis: 'database calls at USD 0.001 per call', target: 0.005 }], constraints: [{ id: 'batch-calls', text: 'Batch database reads so calls stay bounded per checkout.', sources: ['worker', 'gateway'] }] }], rules: [{ id: 'completion-path', kind: 'requires-path', journey: 'checkout', from: 'gateway', to: 'complete', rationale: 'The journey requires a declared completion flow.' }, { id: 'avoid-client', kind: 'forbidden-package', journey: 'checkout', source: 'manifest', package: 'legacy-client', rationale: 'The accepted design uses the shared client.' }], observations: ['measurements'] };
    profile.journeys.push({ id: 'health', title: 'Read gateway health', entry: 'gateway', completion: 'gateway', nodes: ['gateway'], environment: 'disposable-fixture', workload: 'one health request', maxAgeSeconds: 3600, goals: [], constraints: [] });
    const saveProfile = () => write(gateway, '.github/harness/performance.json', JSON.stringify(profile));
    saveProfile();
    const probes = [];
    try {
      for (let run = 0; run < 5; run++) {
        for (const variant of ['before', 'after']) {
          write(worker, 'worker.mjs', workerSources[variant]);
          const measured = measure();
          assert.equal(measured.calls, variant === 'before' ? 12 : 1);
          probes.push({ variant, ...measured, sourceHash: sourceHashes().worker });
        }
      }
    } finally { write(worker, 'worker.mjs', workerSources.before); }
    const summary = Object.fromEntries(['before', 'after'].map(variant => {
      const calls = probes.filter(probe => probe.variant === variant).map(probe => probe.calls).sort((a, b) => a - b);
      return [variant, { samples: calls.length, median: calls[2], range: [calls[0], calls.at(-1)] }];
    }));
    const beforeCalls = observe();
    const before = cli('performance', 'analyze');
    assert.equal(before.report.journeys[0].goals.find(goal => goal.metric === 'cost').status, 'missed');
    assert.ok(before.report.diagnostics.some(item => item.id.includes('completion-path')));
    assert.ok(before.report.diagnostics.some(item => item.id.includes('avoid-client')));
    assert.equal(fs.readFileSync(path.join(gateway, before.artifacts.json), 'utf8').trim(), JSON.stringify(before.report, null, 2));
    const dry = cli('performance', 'analyze', '--dry-run');
    assert.equal(dry.report.id, before.report.id); assert.equal(dry.artifacts, null);
    const oriented = cli('orient', '--read', '--file', 'gateway.mjs');
    assert.match(JSON.stringify(oriented.performance), /Batch database reads/);
    const review = cli('review', 'prepare', '--file', 'gateway.mjs');
    assert.match(JSON.stringify(review.preparation.performance), /Batch database reads/);
    write(worker, 'worker.mjs', workerSources.after);
    write(worker, 'package.json', JSON.stringify({ dependencies: {} }));
    const stale = cli('performance', 'analyze', '--dry-run');
    assert.equal(stale.report.journeys[0].goals.find(goal => goal.metric === 'cost').status, 'stale');
    profile.edges.push({ id: 'result', from: 'worker', to: 'complete', mode: 'async', sources: ['worker'] }); saveProfile();
    const afterCalls = observe(), after = cli('performance', 'analyze');
    assert.equal(after.report.journeys[0].goals.find(goal => goal.metric === 'cost').status, 'met');
    assert.equal(after.report.diagnostics.some(item => item.kind === 'structural-violation'), false);
    assert.notEqual(after.report.id, before.report.id); assert.equal(beforeCalls, 12); assert.equal(afterCalls, 1);
    if (artifactDir) {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.copyFileSync(path.join(gateway, before.artifacts.html), path.join(artifactDir, 'before.html'));
      fs.copyFileSync(path.join(gateway, after.artifacts.html), path.join(artifactDir, 'after.html'));
      fs.writeFileSync(path.join(artifactDir, 'before.json'), JSON.stringify(before.report, null, 2));
      fs.writeFileSync(path.join(artifactDir, 'after.json'), JSON.stringify(after.report, null, 2));
    }
    receipt = { version: 1, feature: 'performance', scope: 'synthetic disposable domain; no production proof', measurement: { metric: 'database calls per twelve-item journey', before: beforeCalls, after: afterCalls, probes, summary }, before: before.report.id, after: after.report.id, invocations, cleanup: false };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  receipt.cleanup = !fs.existsSync(root);
  return receipt;
}
