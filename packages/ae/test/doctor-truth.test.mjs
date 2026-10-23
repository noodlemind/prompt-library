import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { binPath, packageRoot } from './helpers/cli.mjs';
import { tempDir } from './helpers/temp.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';

function run(args, { home, workspace, env = process.env } = {}) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', workspace, '--copilot-home', home, '--json'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...env, NO_COLOR: '1', HARNESS_BIN: '', AE_BIN: '' },
  });
}

function check(report, id) {
  const found = report.checks.filter((item) => item.id === id);
  assert.ok(found.length, `missing ${id}`);
  return found;
}

test('doctor on an empty home fails the install checks instead of the package corpus', () => {
  const workspace = tempDir('doctor-empty-ws-');
  const home = tempDir('doctor-empty-home-');
  fs.rmSync(home, { recursive: true, force: true });
  const result = run(['doctor'], { home, workspace, env: { ...process.env, HOME: tempDir('doctor-empty-user-') } });
  assert.notEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pass, false);
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) {
    for (const item of check(report, id)) {
      assert.equal(item.pass, false, `${id} passed from a package file: ${item.hint}`);
    }
  }
  assert.equal(check(report, 'H7').length, 4);
  assert.equal(check(report, 'H8')[0].pass, true, 'the running package corpus is a separate check');
  for (const id of ['H10', 'H11']) {
    const item = check(report, id)[0];
    assert.equal(item.pass, true, item.hint);
    assert.match(item.hint, /n\/a/);
  }
  const policy = check(report, 'P0')[0];
  assert.equal(policy.pass, true, policy.hint);
  assert.match(policy.name, /enforce/);
});

test('doctor passes on a copilot home installed into a temp home', () => {
  const userHome = tempDir('doctor-installed-user-');
  const workspace = tempDir('doctor-installed-ws-');
  const home = tempDir('doctor-installed-home-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome };
  const installed = run(['install', '--target', 'cli'], { home, workspace, env });
  assert.equal(installed.status, 0, installed.stderr);
  const result = run(['doctor'], { home, workspace, env });
  const report = JSON.parse(result.stdout);
  const required = report.checks.filter((item) => item.pass === false && !item.optional);
  assert.equal(result.status, 0, `${result.stderr}\n${required.map((item) => `${item.id} ${item.hint}`).join('\n')}`);
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H14']) {
    for (const item of check(report, id)) assert.equal(item.pass, true, `${id} ${item.hint}`);
  }
});

test('observe is a real P0 failure and enforce is not', () => {
  const workspace = tempDir('doctor-policy-ws-');
  const home = tempDir('doctor-policy-home-');
  fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.github', 'harness', 'policy.yaml'), 'version: 1\nenforcement: observe\n');
  const untrusted = run(['doctor', '--no-events'], { home, workspace });
  const ignored = check(JSON.parse(untrusted.stdout), 'P0')[0];
  assert.equal(ignored.pass, true, ignored.hint);
  assert.match(ignored.name, /enforce/);

  const trusted = spawnSync(process.execPath, [binPath, 'trust', 'approve', '--workspace', workspace, '--copilot-home', home, '--json'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(trusted.status, 0, trusted.stderr);
  const observed = run(['doctor'], { home, workspace });
  const p0 = check(JSON.parse(observed.stdout), 'P0')[0];
  assert.equal(observed.status, 6, observed.stderr);
  assert.equal(p0.pass, false);
  assert.match(p0.name, /observe/);
  assert.match(p0.hint, /requires enforce/);
  assert.equal(fs.readFileSync(path.join(workspace, '.github', 'harness', 'policy.yaml'), 'utf8').includes('enforcement: observe'), true);
});

test('ae index backfills symptom from trigger so the H10 hint clears', () => {
  const workspace = tempDir('doctor-index-ws-');
  const home = tempDir('doctor-index-home-');
  const solution = path.join(home, 'knowledge', 'solutions', 'teachings', 'non-atomic.md');
  fs.mkdirSync(path.dirname(solution), { recursive: true });
  fs.writeFileSync(solution, `---
title: "non-atomic mark"
trigger: "when a check and a later mark are separate"
---

The mark can land twice.
`);
  fs.writeFileSync(path.join(home, 'knowledge', 'manifest.yaml'), `version: 1
updated: 2026-01-01
entries:
  - id: global-teachings-non-atomic
    path: solutions/teachings/non-atomic.md
    title: "non-atomic mark"
    trigger: "when a check and a later mark are separate"
`);
  const before = JSON.parse(run(['doctor'], { home, workspace }).stdout);
  const h10 = check(before, 'H10')[0];
  assert.equal(h10.pass, false, h10.hint);
  assert.match(h10.hint, /ae index/);
  const indexed = run(['index'], { home, workspace });
  assert.equal(indexed.status, 0, indexed.stderr);
  const manifest = fs.readFileSync(path.join(home, 'knowledge', 'manifest.yaml'), 'utf8');
  assert.match(manifest, /symptom:/);
  const after = JSON.parse(run(['doctor'], { home, workspace }).stdout);
  assert.equal(check(after, 'H10')[0].pass, true, check(after, 'H10')[0].hint);
  assert.equal(check(after, 'H11')[0].pass, true, check(after, 'H11')[0].hint);
});

test('a learning with no trigger needs symptom or module before ae index can clear H10', () => {
  const workspace = tempDir('doctor-thin-ws-');
  const home = tempDir('doctor-thin-home-');
  const solution = path.join(home, 'knowledge', 'solutions', 'teachings', 'bare.md');
  fs.mkdirSync(path.dirname(solution), { recursive: true });
  fs.writeFileSync(solution, `---
title: "bare note"
---

No retrieval fields.
`);
  const indexed = run(['index'], { home, workspace });
  assert.equal(indexed.status, 0, indexed.stderr);
  const before = check(JSON.parse(run(['doctor'], { home, workspace }).stdout), 'H10')[0];
  assert.equal(before.pass, false);
  assert.match(before.hint, /solutions\/teachings\/bare\.md/);
  assert.match(before.hint, /symptom or module/);
  fs.writeFileSync(solution, `---
title: "bare note"
symptom: "retrieval fields were missing"
---

No retrieval fields.
`);
  assert.equal(run(['index'], { home, workspace }).status, 0);
  assert.equal(check(JSON.parse(run(['doctor'], { home, workspace }).stdout), 'H10')[0].pass, true);
});

test('remember then index leaves H10 and H11 passing', () => {
  const workspace = trackWorkspaceSolutions(tempDir('doctor-remember-ws-'));
  const home = tempDir('doctor-remember-home-');
  const harnessHome = tempDir('doctor-remember-hh-');
  const env = { ...process.env, HARNESS_HOME: harnessHome };
  const remembered = spawnSync(process.execPath, [
    binPath, 'remember', 'Separate the mark from the check only inside one transaction.',
    '--trigger', 'when a success mark is written after the check',
    '--workspace', workspace, '--copilot-home', home, '--json',
  ], { cwd: workspace, encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
  assert.equal(remembered.status, 0, remembered.stderr + remembered.stdout);
  const indexed = run(['index'], { home, workspace, env });
  assert.equal(indexed.status, 0, indexed.stderr);
  const report = JSON.parse(run(['doctor'], { home, workspace, env }).stdout);
  assert.equal(check(report, 'H10')[0].pass, true, check(report, 'H10')[0].hint);
  assert.equal(check(report, 'H11')[0].pass, true, check(report, 'H11')[0].hint);
});
