import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeVSCodeSettings } from '../lib/vscode-settings.mjs';
import { INVENTORY_SETTINGS_KEYS } from '../lib/inventory-editors.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const SETTING = 'chat.subagents.allowInvocationsFromSubagents';

function vscodeUserDir(root) {
  if (process.platform === 'win32') return path.join(root, 'AppData', 'Roaming', 'Code', 'User');
  if (process.platform === 'darwin') return path.join(root, 'Library', 'Application Support', 'Code', 'User');
  return path.join(root, '.config', 'Code', 'User');
}

test('merged VS Code settings enable nested subagent invocations', () => {
  const settings = mergeVSCodeSettings({});
  assert.equal(settings[SETTING], true);
  assert.equal(INVENTORY_SETTINGS_KEYS.includes(SETTING), true);
});

test('install --configure-vscode writes the nested subagent setting and doctor V3 checks it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-vscode-home-'));
  const userDir = vscodeUserDir(root);
  fs.mkdirSync(userDir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-vscode-ws-'));
  const copilot = path.join(root, 'copilot');
  const aeHome = path.join(root, 'ae');
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    NO_COLOR: '1',
    AE_HOME: aeHome,
    HARNESS_HOME: aeHome,
    COPILOT_HOME: copilot,
  };
  const installed = spawnSync(process.execPath, [
    binPath, 'install', '--target', 'vscode', '--configure-vscode',
    '--workspace', workspace, '--copilot-home', copilot, '--ae-home', aeHome, '--no-events',
  ], { cwd: workspace, encoding: 'utf8', env });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const settingsPath = path.join(userDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings[SETTING], true);
  assert.equal(settings['chat.hookFilesLocations'][path.join(copilot, 'hooks').replace(/\\/g, '/')], true);

  const doctor = spawnSync(process.execPath, [
    binPath, 'doctor', '--host', 'vscode', '--json',
    '--workspace', workspace, '--copilot-home', copilot, '--ae-home', aeHome, '--no-events',
  ], { cwd: workspace, encoding: 'utf8', env });
  const body = JSON.parse(doctor.stdout);
  const v3 = body.checks.find((check) => check.id === 'V3');
  assert.equal(v3.pass, true, JSON.stringify(v3));

  settings[SETTING] = false;
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const again = spawnSync(process.execPath, [
    binPath, 'doctor', '--host', 'vscode', '--json',
    '--workspace', workspace, '--copilot-home', copilot, '--ae-home', aeHome, '--no-events',
  ], { cwd: workspace, encoding: 'utf8', env });
  const v3Again = JSON.parse(again.stdout).checks.find((check) => check.id === 'V3');
  assert.equal(v3Again.pass, false, JSON.stringify(v3Again));
  assert.match(v3Again.hint, /configure-vscode/);
  assert.match(v3Again.hint, /allowInvocationsFromSubagents/);
});
