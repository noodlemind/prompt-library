import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { approveProject } from '../lib/trust.mjs';
import { globalBin, npmCommand } from './helpers/npm-launch.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const repoRoot = path.resolve(packageRoot, '../..');

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function freshWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-doctor-ws-'));
  fs.writeFileSync(path.join(workspace, 'README.md'), 'doctor\n');
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.email', 'doctor@example.com']);
  git(workspace, ['config', 'user.name', 'Doctor']);
  git(workspace, ['add', 'README.md']);
  git(workspace, ['commit', '-qm', 'init']);
  return workspace;
}

function run(args, { home, copilot, workspace, env = {} }) {
  return spawnSync(process.execPath, [
    binPath, ...args,
    '--workspace', workspace,
    '--copilot-home', copilot,
    '--ae-home', home,
    '--no-events',
    '--json',
  ], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      AE_HOME: home,
      HARNESS_HOME: home,
      COPILOT_HOME: copilot,
      ...env,
    },
  });
}

function checks(result) {
  assert.equal(result.stdout.trim().startsWith('{'), true, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

test('doctor on an empty home fails H1-H7 instead of passing from package files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-doctor-empty-'));
  const home = path.join(root, 'home');
  const copilot = path.join(root, 'copilot');
  const workspace = freshWorkspace();
  const result = run(['doctor'], { home, copilot, workspace });
  assert.notEqual(result.status, 0, result.stdout);
  const body = checks(result);
  assert.equal(body.checks.find((check) => check.id === 'R1').pass, true, 'Node 20 or newer is present');
  assert.equal(body.checks.find((check) => check.id === 'R2').pass, true, body.checks.find((check) => check.id === 'R2')?.hint);
  const failed = new Set(body.checks.filter((check) => check.pass === false).map((check) => check.id));
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) {
    assert.equal(failed.has(id), true, `${id} should fail on an empty home; failed=${[...failed].join(',')}`);
  }
  assert.equal(fs.existsSync(path.join(packageRoot, 'corpus', 'agents', 'engineer.agent.md')), true);
  const h10 = body.checks.find((check) => check.id === 'H10');
  const h11 = body.checks.find((check) => check.id === 'H11');
  assert.equal(h10.status, 'n/a');
  assert.equal(h10.pass, true);
  assert.equal(h11.status, 'n/a');
  assert.equal(h11.pass, true);
  const p0 = body.checks.find((check) => check.id === 'P0');
  assert.equal(p0.pass, true);
  assert.match(p0.name, /enforce/);
});

test('doctor on an installed home reads the installed files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-doctor-installed-'));
  const home = path.join(root, 'home');
  const copilot = path.join(root, 'copilot');
  const workspace = freshWorkspace();
  const installed = run(['install', '--target', 'cli'], { home, copilot, workspace });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const ready = run(['doctor'], { home, copilot, workspace });
  const body = checks(ready);
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H7', 'H14']) {
    const matches = body.checks.filter((check) => check.id === id);
    assert.ok(matches.length > 0, id);
    assert.ok(matches.every((check) => check.pass), JSON.stringify(matches));
  }
  assert.equal(body.checks.find((check) => check.id === 'H10').status, 'n/a');
  assert.equal(body.checks.find((check) => check.id === 'H11').status, 'n/a');

  fs.rmSync(path.join(copilot, 'agents', 'engineer.agent.md'));
  const removed = checks(run(['doctor'], { home, copilot, workspace }));
  assert.equal(removed.checks.find((check) => check.id === 'H3').pass, false);
  assert.equal(fs.existsSync(path.join(packageRoot, 'corpus', 'agents', 'engineer.agent.md')), true);
});

test('ae index is the remedy for H10 and H11, and zero learnings are n/a', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-doctor-index-'));
  const home = path.join(root, 'home');
  const copilot = path.join(root, 'copilot');
  const workspace = freshWorkspace();
  assert.equal(run(['install', '--target', 'cli'], { home, copilot, workspace }).status, 0);
  const empty = checks(run(['doctor'], { home, copilot, workspace }));
  assert.equal(empty.checks.find((check) => check.id === 'H11').status, 'n/a');

  const solutionDir = path.join(copilot, 'knowledge', 'solutions', 'teachings');
  fs.mkdirSync(solutionDir, { recursive: true });
  fs.writeFileSync(path.join(solutionDir, 'hang.md'), `---
title: checkout hang
trigger: "when checkout waits on a lock"
claim: "retry the lock once"
---

retry the lock once
`);
  const manifestPath = path.join(copilot, 'knowledge', 'manifest.yaml');
  fs.writeFileSync(manifestPath, `version: 1
updated: 2020-01-01
entries:
  - id: global-teachings-hang
    title: checkout hang
`);
  const stale = checks(run(['doctor'], { home, copilot, workspace }));
  assert.equal(stale.checks.find((check) => check.id === 'H10').pass, false);
  assert.match(stale.checks.find((check) => check.id === 'H10').hint, /ae index/);

  const indexed = run(['index'], { home, copilot, workspace });
  assert.equal(indexed.status, 0, indexed.stdout + indexed.stderr);
  const fresh = checks(run(['doctor'], { home, copilot, workspace }));
  assert.equal(fresh.checks.find((check) => check.id === 'H10').pass, true, JSON.stringify(fresh.checks.find((check) => check.id === 'H10')));
  assert.equal(fresh.checks.find((check) => check.id === 'H11').pass, true, JSON.stringify(fresh.checks.find((check) => check.id === 'H11')));

  const indexDir = fresh.checks.find((check) => check.id === 'H11');
  assert.equal(indexDir.pass, true);
  const meta = fs.readdirSync(path.join(home, 'index'), { recursive: true }).map(String);
  const metaPath = meta.map((rel) => path.join(home, 'index', rel)).find((full) => full.endsWith(`${path.sep}meta.json`) || full.endsWith('/meta.json'));
  assert.ok(metaPath, meta.join(','));
  fs.rmSync(metaPath);
  const missing = checks(run(['doctor'], { home, copilot, workspace }));
  assert.equal(missing.checks.find((check) => check.id === 'H11').pass, false);
  assert.equal(run(['index'], { home, copilot, workspace }).status, 0);
  const rebuilt = checks(run(['doctor'], { home, copilot, workspace }));
  assert.equal(rebuilt.checks.find((check) => check.id === 'H11').pass, true);
});

test('a damaged knowledge manifest is not an empty one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-doctor-manifest-'));
  const home = path.join(root, 'home');
  const copilot = path.join(root, 'copilot');
  const workspace = freshWorkspace();
  assert.equal(run(['install', '--target', 'cli'], { home, copilot, workspace }).status, 0);
  const manifestPath = path.join(copilot, 'knowledge', 'manifest.yaml');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, 'entries: [\n');
  const damaged = checks(run(['doctor'], { home, copilot, workspace }));
  for (const id of ['H10', 'H11']) {
    const check = damaged.checks.find((row) => row.id === id);
    assert.equal(check.pass, false, JSON.stringify(check));
    assert.equal(check.status, undefined);
    assert.match(check.hint, /ae index/);
  }
  fs.writeFileSync(manifestPath, 'entries: []\n');
  const empty = checks(run(['doctor'], { home, copilot, workspace }));
  assert.equal(empty.checks.find((row) => row.id === 'H10').status, 'n/a');
  assert.equal(empty.checks.find((row) => row.id === 'H11').status, 'n/a');
});

test('P0 fails when the effective policy is observe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-doctor-p0-'));
  const home = path.join(root, 'home');
  const copilot = path.join(root, 'copilot');
  fs.mkdirSync(copilot, { recursive: true });
  const workspace = freshWorkspace();
  fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.github', 'harness', 'policy.yaml'), 'version: 1\nenforcement: observe\n');

  const ignored = checks(run(['doctor'], { home, copilot, workspace }));
  const before = ignored.checks.find((check) => check.id === 'P0');
  assert.equal(before.pass, true);
  assert.match(before.name, /enforce/);

  approveProject({ workspace, copilotHome: copilot, home });
  const trusted = run(['doctor'], { home, copilot, workspace });
  assert.notEqual(trusted.status, 0);
  const after = checks(trusted).checks.find((check) => check.id === 'P0');
  assert.equal(after.pass, false);
  assert.match(after.name, /observe/);
  assert.match(after.hint, /enforce/);
});

test('the README install command installs ae', () => {
  const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  const section = readme.split(/^## /m).find((part) => part.startsWith('Install'));
  const fence = section.match(/```bash\n([\s\S]*?)```/);
  const command = fence[1].split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
  assert.equal(command, 'npm install -g ./packages/ae');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-readme-install-'));
  const prefix = path.join(root, 'prefix');
  const launched = npmCommand(['install', '-g', './packages/ae']);
  const result = spawnSync(launched.command, launched.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180000,
    env: {
      ...process.env,
      HOME: root,
      npm_config_prefix: prefix,
      npm_config_cache: path.join(root, 'npm-cache'),
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const version = spawnSync(globalBin(prefix, 'ae'), ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.equal(version.status, 0, version.stdout + version.stderr);
  assert.match(version.stdout, new RegExp(pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
