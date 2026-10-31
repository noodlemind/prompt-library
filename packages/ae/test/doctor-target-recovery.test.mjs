import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { initGit } from './helpers/cli-fixtures.mjs';
import { recoveryDiagnostics } from '../lib/diagnostics.mjs';

const bin = fileURLToPath(new URL('../bin/ae.mjs', import.meta.url));
for (const target of ['cli', 'vscode', 'intellij']) {
  test(`doctor recovery follows its selected ${target} installation contract`, t => {
    const root = tempDir('doctor-target-repair-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'product'), home = path.join(root, 'state');
    const copilot = path.join(root, 'copilot'), intellij = path.join(root, 'intellij'), userHome = path.join(root, 'user');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'README.md'), 'Disposable product.\n');
    initGit(workspace);
    const appData = path.join(userHome, 'AppData', 'Roaming');
    const settingsDir = process.platform === 'win32' ? path.join(appData, 'Code', 'User')
      : process.platform === 'darwin' ? path.join(userHome, 'Library', 'Application Support', 'Code', 'User') : path.join(userHome, '.config', 'Code', 'User');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), '{}\n');
    const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, APPDATA: appData, LOCALAPPDATA: path.join(userHome, 'AppData', 'Local'), AE_INTELLIJ_HOME: intellij, AE_VSCODE_EXTENSIONS_DIR: path.join(root, 'extensions') };
    const invoke = args => {
      const result = spawnSync(process.execPath, [bin, ...args, '--json', '--no-events'], { cwd: workspace, env, encoding: 'utf8', timeout: 30_000 });
      assert.ifError(result.error);
      assert.ok(result.stdout.trim(), result.stderr);
      return { ...result, value: JSON.parse(result.stdout) };
    };
    const doctorArgs = ['doctor', '--target', target, '--workspace', workspace, '--copilot-home', copilot, '--ae-home', home];
    const before = invoke(doctorArgs).value;
    const repair = before.diagnostics.failures.find(item => item.checkId === 'H2').nextActions[0];
    assert.equal(repair.argv[repair.argv.indexOf('--target') + 1], target);
    const result = invoke(repair.argv.slice(1));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const after = invoke(doctorArgs).value;
    for (const id of ['H1', 'H2', 'H3', 'H4', 'H7']) assert.ok(after.checks.find(item => item.id === id)?.pass, id);
    if (target === 'intellij') {
      assert.ok(after.checks.find(item => item.id === 'T2')?.pass);
      assert.equal(fs.existsSync(copilot), false, 'IntelliJ recovery must not hydrate the CLI home');
      const unavailable = after.diagnostics.failures.find(item => item.checkId === 'T1');
      assert.ok(unavailable.nextActions.every(item => item.kind === 'guidance'));
    } else {
      assert.equal(fs.existsSync(intellij), false, 'recovery must not hydrate IntelliJ');
      assert.ok(after.checks.find(item => item.id === (target === 'cli' ? 'C1' : 'V1'))?.pass);
    }
    if (target === 'vscode') {
      const discovery = after.diagnostics.failures.find(item => item.checkId === 'V3');
      assert.ok(discovery.nextActions[0].argv.includes('--configure-vscode'));
      const configured = invoke(discovery.nextActions[0].argv.slice(1));
      assert.equal(configured.status, 0, configured.stdout + configured.stderr);
      assert.ok(invoke(doctorArgs).value.checks.find(item => item.id === 'V3')?.pass);
    }
  });
}

test('a missing selected-host hook bundle recommends only that host installation', () => {
  for (const [target, checkId] of [['cli', 'C1'], ['vscode', 'V1']]) {
    const result = recoveryDiagnostics({ source: 'doctor', target, checks: [{ id: checkId, pass: false }], workspace: '/product', copilotHome: '/selected', home: '/state' });
    assert.deepEqual(result.failures[0].nextActions[0].argv, ['ae', 'install', '--target', target, '--workspace', '/product', '--copilot-home', '/selected', '--ae-home', '/state']);
  }
});
