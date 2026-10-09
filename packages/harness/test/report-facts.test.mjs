import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildContextPack } from '../lib/context-pack.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { recordHash } from '../lib/review.mjs';
import { initGit, writeVersionedPlan, writeChecks } from './helpers/cli-fixtures.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'product'), copilot = path.join(base, 'copilot');
  fs.mkdirSync(workspace); fs.mkdirSync(copilot);
  const write = (rel, text, root = workspace) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write('package.json', '{"name":"product","version":"1.0.0","dependencies":{"example":"^2"}}');
  write('package-lock.json', '{"lockfileVersion":3,"packages":{"node_modules/example":{"version":"2.4.0"}}}');
  write('.github/agents/product.agent.md', '---\nname: product\nagents: [worker, absent]\nhandoffs: [{agent: worker}]\n---\nProduct judgment.');
  write('.github/agents/worker.agent.md', '---\nname: worker\nagents: []\n---\nWorker judgment.');
  write('agents/installed.agent.md', '---\nname: installed\nagents: [ghost]\n---\nInstalled capability.', copilot);
  initGit(workspace);
  const cli = (...args) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/harness.mjs'), 'report', '--facts', '--workspace', workspace, '--copilot-home', copilot, '--json', ...args], { encoding: 'utf8', env: { ...process.env, HARNESS_NO_EVENTS: '1' } });
  return { workspace, copilot, write, cli };
}

test('facts are source-bound and stable; product declarations exclude installed Harness agents', t => {
  const f = fixture(t), first = f.cli(), again = f.cli();
  assert.equal(first.status, 0, first.stderr);
  const facts = JSON.parse(first.stdout);
  assert.equal(facts.schema, 1);
  assert.deepEqual(JSON.parse(again.stdout), facts);
  assert.ok(facts.files.total >= 4);
  assert.equal(facts.productGraph.nodes.some(n => n.name === 'installed'), false);
  assert.equal(facts.harnessGraph.nodes.some(n => n.name === 'installed'), true);
  assert.ok(facts.productGraph.edges.some(e => e.target === 'absent' && e.resolution === 'missing'));
  assert.ok(facts.versions.some(v => v.name === 'example' && v.version === '2.4.0' && v.assurance === 'resolved-lock'));
  for (const row of [...facts.versions, ...facts.productGraph.nodes]) assert.match(row.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(facts.index.knowledge.state, 'missing');
});

test('bounded reports retain work coverage and disclose omitted factual rows', t => {
  const f = fixture(t);
  writeChecks(f.workspace, { behavior: { command: [process.execPath, '-e', 'process.exit(0)'] } });
  const plan = writeVersionedPlan(f.workspace, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  for (let i = 0; i < 80; i++) f.write(`.github/agents/more-${i}.agent.md`, `---\nname: more-${i}\nagents: []\n---\n`);
  const r = f.cli('--plan', plan, '--max-bytes', '4096');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout) <= 4096);
  const facts = JSON.parse(r.stdout);
  assert.equal(facts.work.plan.path, plan);
  assert.equal(facts.work.proof.pass, false);
  assert.ok(facts.work.review);
  assert.ok(facts.omitted.productNodes > 0);
  assert.equal(facts.completions.length, 0);
  assert.match(facts.retrieval, /lookup|report/);
});

test('gate intent and coverage survive long multibyte context with and without a selected source', () => {
  for (const intentSources of [[], [{ path: 'docs/spec.md', kind: 'spec' }]]) {
    const body = buildContextPack({ recall: [], plans: [], activePlan: { path: 'p.md', status: 'planned', memoryExcerpt: '界'.repeat(4000) }, planGoal: { intent: '界'.repeat(4000) }, gatePreview: { pass: false, blockedReason: 'x'.repeat(3000) }, reviewCoverage: { pass: false, requiredCount: 4, missingCount: 2 }, intentSources });
    assert.ok(Buffer.byteLength(body) <= 2048);
    assert.match(body, /pass: false/);
    assert.match(body, /coverage: incomplete; required=4; missing=2/);
    assert.match(body, /Intent sources/);
    assert.match(body, /omitted|truncated/);
  }
});

test('observed passed strings and completion timestamps never assert current proof', t => {
  const f = fixture(t);
  const plan = writeVersionedPlan(f.workspace, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(f.workspace, plan), fs.readFileSync(path.join(f.workspace, plan), 'utf8').replace('status: in-progress', 'status: done'));
  writeEvidence(f.workspace, { plan, outcome: 'passed', checks: [], binding: {} });
  f.write(`.harness/completions/${recordHash(plan)}.json`, JSON.stringify({ version: 2, id: 'fake', completedAt: '2026-01-01', value: {} }));
  const facts = JSON.parse(f.cli('--plan', plan).stdout);
  assert.equal(facts.work.proof.observedOutcome, 'passed');
  assert.equal(facts.work.proof.pass, false);
  assert.equal(facts.work.completion.pass, false);
  assert.equal(facts.completions[0].current, false);
  assert.equal(facts.completions[0].completedAt, '2026-01-01');
});

test('unsupported manifests and unavailable inventory are explicit, never invented versions', t => {
  const f = fixture(t);
  f.write('pom.xml', '<project><version>9</version></project>');
  const result = JSON.parse(f.cli().stdout);
  assert.ok(result.diagnostics.some(d => d.path === 'pom.xml' && /unsupported/.test(d.reason)));
  assert.equal(result.versions.some(v => v.version === '9'), false);
  fs.rmSync(path.join(f.workspace, '.git'), { recursive: true, force: true });
  const missing = JSON.parse(f.cli().stdout);
  assert.equal(missing.files.total, null);
  assert.equal(missing.files.state, 'unavailable');
});
