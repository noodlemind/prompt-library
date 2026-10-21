import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { initGit, writeChecks } from './helpers/cli-fixtures.mjs';
import { recoveryDiagnostics } from '../lib/diagnostics.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');

function fixture(t) {
  const root = tempDir('recovery-diagnostics-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product with spaces');
  const home = path.join(root, 'state');
  const copilot = path.join(root, 'copilot');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Disposable product.\n');
  initGit(workspace);
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [bin, ...args, '--workspace', workspace, '--ae-home', home, '--copilot-home', copilot, '--json'], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    return { ...result, value: JSON.parse(result.stdout) };
  };
  return { workspace, home, copilot, cli };
}

test('a missing plan yields scoped inspection guidance without changing gate authority', t => {
  const f = fixture(t);
  const result = f.cli('gate', '--phase', 'implement');
  assert.equal(result.status, 1);
  assert.equal(result.value.pass, false);
  assert.equal(result.value.checks.find(check => check.id === 'C1').pass, false);
  assert.equal(result.value.diagnostics.schema, 1);
  const failure = result.value.diagnostics.failures.find(item => item.checkId === 'C1');
  assert.equal(failure.category, 'plan');
  assert.equal(failure.severity, 'blocking');
  assert.deepEqual(failure.retry, { automatic: false, when: 'after-action' });
  assert.deepEqual(failure.nextActions[0], { kind: 'command', argv: ['ae', 'orient', '--read', '--context-version', '2', '--workspace', f.workspace, '--copilot-home', f.copilot, '--ae-home', f.home] });
  assert.deepEqual(failure.evidence, { checkId: 'C1', plan: null });
  assert.equal(fs.existsSync(f.copilot), false, 'guidance must not install anything');
});

test('doctor distinguishes installation failures from optional readiness observations', t => {
  const f = fixture(t);
  const result = f.cli('doctor');
  assert.equal(result.value.pass, false);
  const failures = result.value.diagnostics.failures;
  const profile = failures.find(item => item.checkId === 'H2');
  assert.equal(profile.category, 'installation');
  assert.equal(profile.severity, 'blocking');
  assert.deepEqual(profile.nextActions[0].argv, ['ae', 'install', '--workspace', f.workspace, '--copilot-home', f.copilot, '--ae-home', f.home]);
  const pathFailure = failures.find(item => item.checkId === 'H16');
  if (pathFailure) assert.equal(pathFailure.severity, 'advisory');
  assert.equal(fs.existsSync(f.copilot), false);
});

test('a changed locked intent source requires an explicit amendment rather than a blind retry', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, 'docs/specs'), { recursive: true });
  const spec = path.join(f.workspace, 'docs/specs/product.md');
  fs.writeFileSync(spec, '# Product\n\nPreserve the catalog.\n');
  writeChecks(f.workspace, { behavior: { command: ['node', '-e', 'process.exit(0)'] } });
  assert.equal(f.cli('trust', 'approve').status, 0);
  const created = f.cli('plan-new', '--goal', 'Preserve catalog', '--acceptance', 'Catalog is preserved', '--constraint', 'No unrelated changes', '--verification-check', 'behavior', '--intent-source', 'docs/specs/product.md');
  assert.equal(created.status, 0, created.stdout);
  fs.writeFileSync(spec, '# Product\n\nChange the catalog.\n');
  const result = f.cli('gate', '--plan', created.value.path);
  assert.equal(result.status, 1);
  const failure = result.value.diagnostics.failures.find(item => item.checkId === 'C-intent-sources');
  assert.equal(failure.category, 'intent');
  assert.ok(failure.nextActions.some(action => action.kind === 'guidance' && /explicit.*amend/i.test(action.text)));
  assert.equal(failure.retry.automatic, false);
});

test('unknown readiness checks retain evidence and require inspection', () => {
  const result = recoveryDiagnostics({ source: 'doctor', checks: [{ id: 'future-check', pass: false, optional: true, hint: 'Inspect adapter readiness.' }], workspace: '/product' });
  assert.equal(result.total, 1);
  assert.equal(result.failures[0].severity, 'advisory');
  assert.equal(result.failures[0].message, 'Inspect adapter readiness.');
  assert.deepEqual(result.failures[0].retry, { automatic: false, when: 'after-inspection' });
  assert.ok(result.failures[0].nextActions.every(action => action.kind === 'guidance'));
});

test('large diagnostics report omissions and stay within their byte bound', () => {
  const checks = Array.from({ length: 80 }, (_, index) => ({ id: `H${index + 1}`, pass: false, hint: '多'.repeat(1000) }));
  const result = recoveryDiagnostics({ source: 'doctor', checks, workspace: '/product/' + 'x'.repeat(4000) });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16_384);
  assert.equal(result.total, 80);
  assert.equal(result.failures.length + result.omitted, 80);
  assert.ok(result.omitted > 0);
});
