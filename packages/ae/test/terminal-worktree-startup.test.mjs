import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { installGlobalHarnessShim } from '../lib/global-bin.mjs';
import { binPath, packageRoot, runHarness } from './helpers/cli.mjs';
import { writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { git } from './helpers/store.mjs';
import { tempDir } from './helpers/temp.mjs';

function fixture(t) {
  const root = tempDir('terminal-worktree-startup-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: undefined,
    CI: '',
    HARNESS_ALLOW_INPLACE: '',
    HARNESS_HOME: home,
    HARNESS_BIN: binPath,
    HARNESS_ENFORCEMENT: 'enforce',
  };
  const runGit = (args) => git(workspace, args, { env });
  assert.equal(runGit(['init', '-b', 'main']).status, 0);
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/example.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.harness/\n.worktrees/\n');
  const plan = writeVersionedPlan(workspace);
  assert.equal(runGit(['add', '.']).status, 0);
  assert.equal(runGit(['commit', '-qm', 'worktree startup fixture']).status, 0);
  assert.equal(runGit(['remote', 'add', 'origin', 'https://example.test/worktree-startup.git']).status, 0);
  assert.equal(runGit(['update-ref', 'refs/remotes/origin/main', 'HEAD']).status, 0);
  assert.equal(runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']).status, 0);
  const cli = (args, cwd = workspace) => runHarness([...args, '--workspace', cwd, '--json', '--no-events'], {
    cwd, env, trust: false, injectHome: false,
  });
  const hook = (command, extraEnv = {}, hookPath = path.join(packageRoot, 'corpus/hooks/require-plan-gate.mjs')) => {
    const result = spawnSync(process.execPath, [hookPath], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...env, ...extraEnv },
      input: JSON.stringify({ workspace, session_id: 'worktree-startup', tool_name: 'run_in_terminal', tool_input: { command } }),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  };
  return { root, workspace, home, env, plan, cli, hook, runGit };
}

function assertAllowed(response, command) {
  assert.equal(response.continue, true, `${command}: ${JSON.stringify(response)}`);
  assert.notEqual(response.permissionDecision, 'deny', command);
}

function installedEnvironment(env, shim, hydratedBin, copilotHome) {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  return {
    HARNESS_BIN: hydratedBin,
    COPILOT_HOME: copilotHome,
    [pathKey]: `${path.dirname(shim)}${path.delimiter}${env[pathKey] || ''}`,
  };
}

test('installed shim preserves the inherited executable search path with either key spelling', () => {
  const inheritedPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const shim = path.join('fixture', 'bin', 'harness');
  for (const pathKey of ['PATH', 'Path']) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env[pathKey] = inheritedPath;
    const installedEnv = installedEnvironment(env, shim, 'fixture/ae.mjs', 'fixture/copilot');
    const child = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([key]) => key.toLowerCase() === 'path')))"], {
      encoding: 'utf8', env: { ...env, ...installedEnv },
    });
    assert.equal(child.status, 0, child.stderr);
    const searchPaths = JSON.parse(child.stdout);
    assert.equal(searchPaths.length, 1, `${pathKey}: child must receive one executable search path`);
    assert.equal(searchPaths[0][1], `${path.dirname(shim)}${path.delimiter}${inheritedPath}`, `${pathKey}: inherited executable directories must survive`);
  }
});

test('default-branch delivery can create its authoritative worktree before the implement gate', (t) => {
  const f = fixture(t);
  const blocked = f.cli(['gate', '--phase', 'implement', '--plan', f.plan]);
  assert.equal(blocked.status, 1, blocked.stderr + blocked.stdout);
  const isolation = JSON.parse(blocked.stdout).checks.find(check => check.id === 'C-worktree');
  assert.equal(isolation.pass, false);
  assert.match(isolation.message, /ae worktree --slug/);
  const command = `node "${binPath}" worktree --slug startup-repair`;
  assertAllowed(f.hook(command), command);
  const created = f.cli(['worktree', '--slug', 'startup-repair']);
  assert.equal(created.status, 0, created.stderr + created.stdout);
  const isolated = JSON.parse(created.stdout);
  assert.equal(isolated.created, true);
  assert.equal(isolated.branch, 'harness/startup-repair');
  assert.equal(fs.statSync(path.join(isolated.path, '.git')).isFile(), true);
  const gate = f.cli(['gate', '--phase', 'implement', '--plan', f.plan], isolated.path);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  const isolatedGate = JSON.parse(gate.stdout).checks.find(check => check.id === 'C-worktree');
  assert.equal(isolatedGate.pass, true);
  assert.match(isolatedGate.message, /issue worktree isolated/);
});

test('canonical PATH and exact source aliases admit the worktree control command', (t) => {
  const f = fixture(t);
  for (const prefix of ['harness', `node "${binPath}"`, `"${process.execPath}" "${binPath}"`]) {
    const command = `${prefix} worktree --slug alias-repair`;
    assertAllowed(f.hook(command), command);
  }
});

test('failed-gate worktree recovery admits only a standalone canonical control command', (t) => {
  const f = fixture(t);
  assert.equal(f.cli(['gate', '--phase', 'implement', '--plan', f.plan]).status, 1);
  for (const command of [
    'ae worktree --slug mixed && git status',
    'ae worktree --slug mixed; ae gate',
    'ae worktree --slug mixed > src/hidden.txt',
    'env ae worktree --slug wrapped',
  ]) {
    const response = f.hook(command);
    assert.equal(response.permissionDecision, 'deny', command);
    assert.match(response.permissionDecisionReason, /changed-check-config/);
  }
});

test('hydrated hooks admit the installed worktree CLI and it creates a real isolated checkout', (t) => {
  const f = fixture(t);
  const copilotHome = path.join(f.root, 'copilot');
  installHarnessBin(packageRoot, copilotHome, {}, () => {});
  const shim = installGlobalHarnessShim(copilotHome, {}, () => {}).path;
  const hydratedBin = path.join(copilotHome, '.ae-bin/bin/ae.mjs');
  const hydratedHook = path.join(copilotHome, '.ae-bin/corpus/hooks/require-plan-gate.mjs');
  const installedEnv = installedEnvironment(f.env, shim, hydratedBin, copilotHome);
  for (const command of ['ae worktree --slug installed-repair', `node "${hydratedBin}" worktree --slug installed-repair`]) {
    assertAllowed(f.hook(command, installedEnv, hydratedHook), command);
  }
  const gitLookup = spawnSync('git', ['--version'], {
    cwd: f.workspace, encoding: 'utf8', env: { ...f.env, ...installedEnv },
  });
  assert.equal(gitLookup.status, 0, gitLookup.error?.message || gitLookup.stderr);
  assert.match(gitLookup.stdout, /^git version /);
  const execution = spawnSync(process.execPath, [shim, 'worktree', '--slug', 'installed-repair', '--workspace', f.workspace, '--json'], {
    cwd: f.workspace, encoding: 'utf8', env: { ...f.env, ...installedEnv },
  });
  assert.equal(execution.status, 0, execution.stderr + execution.stdout);
  const created = JSON.parse(execution.stdout);
  assert.equal(created.created, true);
  assert.equal(created.branch, 'harness/installed-repair');
  assert.equal(fs.statSync(path.join(created.path, '.git')).isFile(), true);
});

test('forged worktree binaries, wrappers and mixed commands still need an implement gate', (t) => {
  const f = fixture(t);
  const forged = path.join(f.workspace, 'forged/ae.mjs');
  fs.mkdirSync(path.dirname(forged));
  fs.writeFileSync(forged, 'process.exit(0);\n');
  for (const command of [
    `node "${forged}" worktree --slug forged`,
    './ae worktree --slug forged',
    'env ae worktree --slug forged',
    'command ae worktree --slug forged',
    "sh -c 'ae worktree --slug forged'",
    'ae worktree --slug forged && node generator.mjs',
    'ae worktree --slug forged > src/hidden.txt',
  ]) assert.equal(f.hook(command).permissionDecision, 'deny', command);
  assert.equal(fs.existsSync(path.join(f.workspace, '.worktrees')), false);
});

test('worktree control admission leaves invalid slug rejection to the authoritative CLI', (t) => {
  const f = fixture(t);
  const command = `node "${binPath}" worktree --slug ../outside`;
  assertAllowed(f.hook(command), command);
  const rejected = f.cli(['worktree', '--slug', '../outside']);
  assert.equal(rejected.status, 2, rejected.stderr + rejected.stdout);
  assert.match(rejected.stderr, /--slug is required and must be lowercase-hyphen/);
  assert.equal(fs.existsSync(path.join(f.workspace, '.worktrees')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'outside')), false);
  assert.doesNotMatch(f.runGit(['worktree', 'list', '--porcelain']).stdout, /harness\//);
});
