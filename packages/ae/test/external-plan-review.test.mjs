import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { initGit } from './helpers/cli-fixtures.mjs';
import { runHarness } from './helpers/cli.mjs';
import YAML from 'yaml';
import { resolveDomainContext, authorizeDomainPlan } from '../lib/domain-context.mjs';
import { planFromText, loadPlan } from '../lib/plan-parse.mjs';
import { readReviewFile, preparationIsCurrent } from '../lib/review-preparation.mjs';
import { planContractText } from '../lib/work-contract.mjs';

const clean = reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-external-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'product'), home = path.join(dir, 'home');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\n');
  initGit(ws);
  const cli = (...args) => runHarness([...args, '--workspace', ws, '--copilot-home', path.join(dir, 'copilot'), '--harness-home', home, '--json'], { cwd: ws, env: { HARNESS_NO_EVENTS: '1' } });
  const input = path.join(ws, '.harness/create.json');
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, JSON.stringify({ version: 1, format: 'full', type: 'docs', slug: 'review-draft', goal: 'Refresh the project README.', acceptance: ['The README reflects current behavior.'], scope: ['README.md'], status: 'open' }));
  const created = cli('plan-new', '--file', input);
  assert.equal(created.status, 0, created.stderr + created.stdout);
  const plan = JSON.parse(created.stdout).path;
  const prepare = (bound = false) => {
    const prepared = cli('review', 'prepare', '--domain', 'document', '--file', plan, '--base', 'HEAD', ...(bound ? ['--plan', plan] : []));
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    return JSON.parse(prepared.stdout);
  };
  const assemble = (packet, results = packet.required.map(clean), bound = false) => {
    const file = path.join(ws, '.harness/results.json');
    fs.writeFileSync(file, JSON.stringify({ packet: packet.id, results }));
    return cli('review', 'assemble', '--packet', packet.id, '--file', file, ...(bound ? ['--plan', plan] : []));
  };
  return { dir, ws, home, plan, cli, prepare, assemble };
}

test('ordinary external review retains selected-store authority across legacy and native path spellings', t => {
  const f = fixture(t);
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = f.home;
  t.after(() => { if (previous === undefined) delete process.env.HARNESS_HOME; else process.env.HARNESS_HOME = previous; });
  const plan = loadPlan(f.ws, f.plan, { home: f.home });
  assert.ok(plan);
  const text = fs.readFileSync(f.plan, 'utf8');
  const ref = { origin: 'project-plan', path: f.plan.replace(/\\/g, '/'), state: 'regular', sha256: hash(text) };
  assert.equal(readReviewFile(f.ws, ref, { plan }), text);
  const realpath = fs.realpathSync, native = realpath.native;
  t.mock.method(fs, 'realpathSync', (file, ...args) => path.resolve(String(file)) === path.resolve(f.plan)
    ? path.join(path.parse(f.plan).root, 'LEGACY~1', path.basename(f.plan))
    : realpath(file, ...args));
  fs.realpathSync.native = native;
  assert.equal(readReviewFile(f.ws, ref, { plan }), text, 'a retained raw alias cannot make an unchanged current-store source unreadable');
  const preparation = { kind: 'document', refs: [ref], sources: [], checks: [] };
  assert.equal(preparationIsCurrent(f.ws, preparation, { plan }), true);
  const outside = path.join(f.home, 'projects/another-project/plans', path.basename(f.plan));
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, text);
  assert.equal(readReviewFile(f.ws, { ...ref, path: outside }, { plan }), null);
  fs.appendFileSync(f.plan, '\nUnreviewed content.\n');
  assert.equal(preparationIsCurrent(f.ws, preparation, { plan }), false);
});

test('serialized domain review paths preserve only the selected opaque parent authority', t => {
  const f = fixture(t), workspace = fs.realpathSync.native(f.ws), home = fs.realpathSync.native(f.home);
  fs.mkdirSync(path.join(home, 'domains'), { recursive: true });
  fs.writeFileSync(path.join(home, 'domains/catalogue.yaml'), YAML.stringify({ domain_version: 2, name: 'catalogue', repos: [{ id: 'product', local_identity: { id: 'product', approved: true } }], sources: [], bindings: { repos: { product: workspace }, sources: {} } }));
  const context = resolveDomainContext({ workspace, home, name: 'catalogue' });
  const full = path.join(home, 'domains/catalogue/plans/2026-10-12-feat-parent-plan.hplan');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = '---\nplan_schema: 3\ndomain_parent: {name: catalogue}\n---\n\n# Accepted catalogue goal\n';
  fs.writeFileSync(full, text);
  const plan = authorizeDomainPlan(context, planFromText(text, { path: full, fullPath: full }));
  const ref = { origin: 'domain-plan', path: full.replace(/\\/g, '/'), state: 'regular', sha256: hash(planContractText(text)), hashPolicy: 'work-contract-v3' };
  assert.equal(readReviewFile(workspace, ref, { plan }), text);
  const preparation = { kind: 'document', refs: [ref], sources: [], checks: [] };
  assert.equal(preparationIsCurrent(workspace, preparation, { plan }), true);
  const sibling = path.join(path.dirname(full), '2026-10-12-feat-sibling-plan.hplan');
  fs.writeFileSync(sibling, text);
  assert.equal(readReviewFile(workspace, { ...ref, path: sibling.replace(/\\/g, '/') }, { plan }), null);
  assert.throws(() => readReviewFile(workspace, ref, { plan: { ...plan } }), /authority|context/);
  fs.writeFileSync(full, text.replace('Accepted catalogue goal', 'Unreviewed catalogue goal'));
  assert.equal(preparationIsCurrent(workspace, preparation, { plan }), false);
});

for (const bound of [false, true]) test(`${bound ? 'plan-bound' : 'standalone'} document review accepts a plan-new external draft and its findings`, t => {
  const f = fixture(t);
  const status = f.cli('status', '--plan', f.plan, '--contract-digest');
  assert.equal(status.status, 0, status.stderr + status.stdout);
  assert.equal(JSON.parse(status.stdout).schema.pass, true);
  const packet = f.prepare(bound);
  const ref = packet.preparation.refs.find(source => source.origin === 'project-plan');
  assert.equal(ref.path, f.plan.replace(/\\/g, '/'));
  assert.equal(ref.sha256, hash(fs.readFileSync(f.plan)));
  assert.ok(packet.preparation.files.some(source => source.path === ref.path && source.excerpt.includes('plan_schema: 2')));
  const results = packet.required.map(clean);
  results[0].findings.push({ file: ref.path, line: 2, severity: 'P2', confidence: 0.8, title: 'Clarify the README assertion', description: 'The draft needs a concrete assertion for its README claims.', suggested_fix: 'Bind a named README assertion when accepting the plan.', autofix_class: 'manual', evidence: [`${ref.path}:2`] });
  const assembled = f.assemble(packet, results, bound);
  assert.equal(assembled.status, 0, assembled.stderr + assembled.stdout);
  const record = JSON.parse(assembled.stdout);
  assert.equal(record.coverage.complete, true);
  assert.equal(record.findings[0].file, ref.path);
  const amendment = path.join(f.ws, '.harness/amend.json');
  fs.writeFileSync(amendment, JSON.stringify({ version: 1, id: 'accept-review-context', action: 'amend', expect: hash(fs.readFileSync(f.plan)), rationale: 'Record the reviewed README assertion requirement.', changes: { notes: { context: 'README delivery needs a named assertion of its documented claims.' } } }));
  const amended = f.cli('plan-update', '--plan', f.plan, '--file', amendment);
  assert.equal(amended.status, 0, amended.stderr + amended.stdout);
  assert.match(fs.readFileSync(f.plan, 'utf8'), /README delivery needs a named assertion/);
  const stale = f.assemble(packet, results, bound);
  assert.equal(stale.status, 2, stale.stderr + stale.stdout);
  assert.match(stale.stderr + stale.stdout, /stale|changed/);
});

for (const change of ['changed', 'missing', 'symlinked']) test(`external document packet becomes stale when its plan is ${change}`, t => {
  const f = fixture(t), packet = f.prepare();
  if (change === 'changed') fs.appendFileSync(f.plan, '\nUnreviewed content.\n');
  else {
    fs.unlinkSync(f.plan);
    if (change === 'symlinked') {
      const outside = path.join(f.dir, 'replacement.md');
      fs.writeFileSync(outside, '# Unrelated document\n');
      try { fs.symlinkSync(outside, f.plan); } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Symlink creation unavailable');
        throw error;
      }
    }
  }
  const assembled = f.assemble(packet);
  assert.equal(assembled.status, 2, assembled.stderr + assembled.stdout);
  assert.match(assembled.stderr + assembled.stdout, /stale|changed/);
});

test('document review rejects unrelated external paths rather than resolving their basename', t => {
  const f = fixture(t);
  for (const outside of [path.join(f.dir, path.basename(f.plan)), path.join(f.home, 'projects/another-project/plans', path.basename(f.plan)), path.join(path.dirname(f.plan), 'missing.md')]) {
    if (!outside.endsWith('missing.md')) {
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.copyFileSync(f.plan, outside);
    }
    const output = f.cli('review', 'prepare', '--domain', 'document', '--file', outside, '--base', 'HEAD');
    assert.notEqual(output.status, 0, output.stderr + output.stdout);
  }
  const code = f.cli('review', 'prepare', '--domain', 'code', '--file', f.plan, '--base', 'HEAD');
  assert.notEqual(code.status, 0, code.stderr + code.stdout);
});

test('external document review rejects symlinked plan paths and plan directories', t => {
  const f = fixture(t), root = path.dirname(f.plan), original = `${root}-original`;
  fs.renameSync(root, original);
  try { fs.symlinkSync(original, root, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Symlink creation unavailable');
    throw error;
  }
  const ancestor = f.cli('review', 'prepare', '--domain', 'document', '--file', f.plan, '--base', 'HEAD');
  assert.notEqual(ancestor.status, 0, ancestor.stderr + ancestor.stdout);
  fs.unlinkSync(root);
  fs.renameSync(original, root);
  const link = path.join(root, 'linked.md');
  fs.symlinkSync(f.plan, link);
  const leaf = f.cli('review', 'prepare', '--domain', 'document', '--file', link, '--base', 'HEAD');
  assert.notEqual(leaf.status, 0, leaf.stderr + leaf.stdout);
});

test('external document review rejects nonregular plan sources without blocking', t => {
  const f = fixture(t), directory = path.join(path.dirname(f.plan), 'directory.md');
  fs.mkdirSync(directory);
  const output = f.cli('review', 'prepare', '--domain', 'document', '--file', directory, '--base', 'HEAD');
  assert.notEqual(output.status, 0, output.stderr + output.stdout);
  if (process.platform !== 'win32') {
    const fifo = path.join(path.dirname(f.plan), 'pipe.md');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const pipe = f.cli('review', 'prepare', '--domain', 'document', '--file', fifo, '--base', 'HEAD');
    assert.notEqual(pipe.status, 0, pipe.stderr + pipe.stdout);
  }
});

test('external document findings are restricted to exact captured project-plan references', t => {
  const f = fixture(t), packet = f.prepare(), outside = path.join(f.dir, 'unrelated.md');
  fs.writeFileSync(outside, '# Unrelated document\n');
  const results = packet.required.map(clean);
  results[0].findings.push({ file: outside.replace(/\\/g, '/'), line: 1, severity: 'P2', confidence: 0.8, title: 'Uncaptured claim', description: 'This document was not captured.', suggested_fix: 'Review only captured documents.', autofix_class: 'manual', evidence: ['Uncaptured document.'] });
  const assembled = f.assemble(packet, results);
  assert.equal(assembled.status, 1, assembled.stderr + assembled.stdout);
  assert.equal(JSON.parse(assembled.stdout).coverage.complete, false);
  assert.ok(JSON.parse(assembled.stdout).failures.some(failure => failure.errors.includes('Invalid finding file')));
});

test('external document packets are stale when the selected project identity changes', t => {
  const f = fixture(t), packet = f.prepare();
  const remote = spawnSync('git', ['remote', 'add', 'origin', 'https://example.test/team/different-project.git'], { cwd: f.ws, encoding: 'utf8' });
  assert.equal(remote.status, 0, remote.stderr);
  const assembled = f.assemble(packet);
  assert.equal(assembled.status, 2, assembled.stderr + assembled.stdout);
  assert.match(assembled.stderr + assembled.stdout, /stale|changed/);
});

test('external plan bytes above the excerpt limit still invalidate document packets', t => {
  const f = fixture(t);
  fs.appendFileSync(f.plan, 'A'.repeat(1024 * 1024));
  const packet = f.prepare(), ref = packet.preparation.refs.find(source => source.origin === 'project-plan');
  assert.equal(ref.sha256, hash(fs.readFileSync(f.plan)));
  assert.ok(packet.preparation.omitted.some(source => source.path === ref.path));
  fs.appendFileSync(f.plan, 'B');
  const assembled = f.assemble(packet);
  assert.equal(assembled.status, 2, assembled.stderr + assembled.stdout);
  assert.match(assembled.stderr + assembled.stdout, /stale|changed/);
});
