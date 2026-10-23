import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mergeVSCodeSettings } from '../lib/vscode-settings.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { binPath, packageRoot } from './helpers/cli.mjs';
import { tempDir } from './helpers/temp.mjs';

test('install --configure-vscode enables nested subagent invocation and doctor V3 checks it', async () => {
  const userHome = tempDir('vscode-user-');
  const workspace = tempDir('vscode-ws-');
  const copilotHome = tempDir('vscode-copilot-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  const userDir = path.join(userHome, '.config', 'Code', 'User');
  fs.mkdirSync(userDir, { recursive: true });
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, NO_COLOR: '1' };
  const installed = spawnSync(process.execPath, [
    binPath, 'install', '--configure-vscode', '--target', 'vscode',
    '--workspace', workspace, '--copilot-home', copilotHome,
  ], { cwd: packageRoot, encoding: 'utf8', env });
  assert.equal(installed.status, 0, installed.stderr);
  const settingsPath = path.join(userDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings['chat.subagents.allowInvocationsFromSubagents'], true);
  assert.equal(settings['chat.hookFilesLocations']['~/.copilot/hooks'], true);

  const doctor = spawnSync(process.execPath, [
    binPath, 'doctor', '--host', 'vscode', '--json',
    '--workspace', workspace, '--copilot-home', copilotHome,
  ], { cwd: workspace, encoding: 'utf8', env });
  const report = JSON.parse(doctor.stdout);
  const v3 = report.checks.find((check) => check.id === 'V3');
  assert.equal(v3.pass, true, JSON.stringify(v3));

  const hooksOnly = path.join(tempDir('vscode-hooks-only-'), 'settings.json');
  fs.writeFileSync(hooksOnly, JSON.stringify({ 'chat.hookFilesLocations': { '~/.copilot/hooks': true } }));
  const missing = await runDoctor({
    copilotHome,
    assetsRoot: path.join(packageRoot, 'corpus'),
    pkgRoot: packageRoot,
    flags: { workspace, host: 'vscode' },
    vscodeSettingsPaths: [hooksOnly],
  });
  const missingV3 = missing.checks.find((check) => check.id === 'V3');
  assert.equal(missingV3.pass, false);
  assert.match(missingV3.hint, /chat\.subagents\.allowInvocationsFromSubagents/);

  const merged = path.join(tempDir('vscode-merged-'), 'settings.json');
  fs.writeFileSync(merged, JSON.stringify(mergeVSCodeSettings({})));
  const present = await runDoctor({
    copilotHome,
    assetsRoot: path.join(packageRoot, 'corpus'),
    pkgRoot: packageRoot,
    flags: { workspace, host: 'vscode' },
    vscodeSettingsPaths: [merged],
  });
  assert.equal(present.checks.find((check) => check.id === 'V3').pass, true);
});
