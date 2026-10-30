import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mergeVSCodeSettings } from '../lib/vscode-settings.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/ae.mjs');
const locations = {
  'chat.agentFilesLocations': 'agents',
  'chat.instructionsFilesLocations': 'instructions',
  'chat.agentSkillsLocations': 'skills',
  'chat.hookFilesLocations': 'hooks',
};
const normalized = value => value.replace(/\\/g, '/');

test('VS Code settings select every customization location from the chosen home', () => {
  const copilotHome = path.join(os.tmpdir(), 'ae selected home');
  const input = { 'editor.fontSize': 17, 'chat.hookFilesLocations': { 'company/hooks': true }, 'chat.tools.terminal.autoApprove': { npm: false } };
  const settings = mergeVSCodeSettings(input, { copilotHome });
  for (const [key, directory] of Object.entries(locations)) {
    assert.equal(settings[key][normalized(path.join(copilotHome, directory))], true, key);
    assert.equal(settings[key][`~/.copilot/${directory}`], undefined, key);
  }
  assert.equal(settings['chat.hookFilesLocations']['company/hooks'], true);
  assert.equal(settings['editor.fontSize'], 17);
  assert.deepEqual(settings['chat.tools.terminal.autoApprove'], { npm: false });
  assert.equal(input['chat.agentFilesLocations'], undefined);
});

test('the ordinary default home keeps portable tilde locations', () => {
  const settings = mergeVSCodeSettings({}, { copilotHome: path.join(os.homedir(), '.copilot') });
  for (const [key, directory] of Object.entries(locations)) assert.deepEqual(settings[key], { [`~/.copilot/${directory}`]: true });
});

test('legacy array-shaped discovery settings become serializable selected-home mappings', () => {
  const copilotHome = path.join(os.tmpdir(), 'ae-selected-array-home');
  const input = Object.fromEntries(Object.keys(locations).map(key => [key, ['legacy/path']]));
  const settings = JSON.parse(JSON.stringify(mergeVSCodeSettings(input, { copilotHome })));
  for (const [key, directory] of Object.entries(locations)) {
    assert.equal(settings[key][normalized(path.join(copilotHome, directory))], true, key);
    assert.equal(settings[key]['legacy/path'], true, 'preserve the authored legacy location');
  }
});

for (const source of ['flag', 'environment']) test(`install and doctor discover the selected VS Code home from ${source}`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-vscode-selected-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const copilotHome = path.join(root, 'custom copilot');
  const aeHome = path.join(root, 'ae');
  const userDir = process.platform === 'win32' ? path.join(root, 'AppData/Roaming/Code/User')
    : process.platform === 'darwin' ? path.join(root, 'Library/Application Support/Code/User')
      : path.join(root, '.config/Code/User');
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(workspace);
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'AppData/Roaming'), LOCALAPPDATA: path.join(root, 'AppData/Local'), AE_HOME: aeHome, HARNESS_HOME: aeHome, COPILOT_HOME: source === 'flag' ? path.join(root, 'wrong-home') : copilotHome, NO_COLOR: '1' };
  const shared = ['--workspace', workspace, '--ae-home', aeHome, '--no-events'];
  if (source === 'flag') shared.push('--copilot-home', copilotHome);
  const run = args => spawnSync(process.execPath, [bin, ...args, ...shared], { cwd: workspace, env, encoding: 'utf8', timeout: 120_000 });
  const installed = run(['install', '--target', 'vscode', '--configure-vscode']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const settingsPath = path.join(userDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const [key, directory] of Object.entries(locations)) assert.equal(settings[key][normalized(path.join(copilotHome, directory))], true, key);
  const doctor = run(['doctor', '--host', 'vscode', '--json']);
  const v3 = JSON.parse(doctor.stdout).checks.find(check => check.id === 'V3');
  assert.equal(v3.pass, true, JSON.stringify(v3));
  fs.writeFileSync(settingsPath, JSON.stringify(mergeVSCodeSettings({})));
  const mismatched = run(['doctor', '--host', 'vscode', '--json']);
  const missing = JSON.parse(mismatched.stdout).checks.find(check => check.id === 'V3');
  assert.equal(missing.pass, false, JSON.stringify(missing));
});

for (const malformed of ['{ broken', '[]', 'null']) test(`install refuses invalid VS Code settings before changing any profile: ${malformed}`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-vscode-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const copilotHome = path.join(root, 'custom copilot');
  const aeHome = path.join(root, 'ae');
  const profiles = process.platform === 'win32' ? path.join(root, 'AppData/Roaming')
    : process.platform === 'darwin' ? path.join(root, 'Library/Application Support')
      : path.join(root, '.config');
  const good = path.join(profiles, 'Code/User/settings.json');
  const bad = path.join(profiles, 'Code - Insiders/User/settings.json');
  for (const file of [good, bad]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(workspace);
  const original = '{\n  // Keep this authored formatting.\n  "editor.fontSize": 19\n}\n';
  fs.writeFileSync(good, original);
  fs.writeFileSync(bad, malformed);
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'AppData/Roaming'), LOCALAPPDATA: path.join(root, 'AppData/Local'), AE_HOME: aeHome, HARNESS_HOME: aeHome, COPILOT_HOME: copilotHome, NO_COLOR: '1' };
  const shared = ['--workspace', workspace, '--ae-home', aeHome, '--no-events', '--copilot-home', copilotHome];
  const installed = spawnSync(process.execPath, [bin, 'install', '--target', 'vscode', '--configure-vscode', '--json', ...shared], { cwd: workspace, env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(installed.status, 0, installed.stdout + installed.stderr);
  assert.match(installed.stdout + installed.stderr, /E_VSCODE_SETTINGS/);
  assert.match(installed.stdout + installed.stderr, /settings\.json/);
  assert.equal(fs.readFileSync(good, 'utf8'), original);
  assert.equal(fs.readFileSync(bad, 'utf8'), malformed);
  assert.equal(fs.existsSync(path.join(copilotHome, 'agents/engineer.agent.md')), false, 'invalid configuration must be found before hydration');
  const doctor = spawnSync(process.execPath, [bin, 'doctor', '--host', 'vscode', '--json', ...shared], { cwd: workspace, env, encoding: 'utf8', timeout: 120_000 });
  const discovery = JSON.parse(doctor.stdout).checks.find(check => check.id === 'V3');
  assert.equal(discovery.pass, false, JSON.stringify(discovery));
});
