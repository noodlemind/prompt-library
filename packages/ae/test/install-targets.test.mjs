import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { INSTALLED_TARGETS, RECOGNIZED_UNINSTALLED_TARGETS, parseFlags } from '../lib/flags.mjs';
import { binPath, packageRoot } from './helpers/cli.mjs';
import { tempDir } from './helpers/temp.mjs';

function run(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', HOME: tempDir('install-target-user-'), USERPROFILE: tempDir('install-target-profile-') },
  });
}

test('parseFlags keeps installed targets and rejects the rest before install runs', () => {
  assert.deepEqual([...parseFlags(['--target', 'vscode, cli']).targets], ['vscode', 'cli']);
  assert.deepEqual([...parseFlags([]).targets], [...INSTALLED_TARGETS]);
  assert.throws(() => parseFlags(['--target', 'bogus']), /unknown target "bogus"/);
  assert.throws(() => parseFlags(['--target', 'cursor']), /"cursor" is recognized but ae install does not install it/);
  assert.throws(() => parseFlags(['--target', 'vscode,']), /cannot be empty/);
  for (const name of RECOGNIZED_UNINSTALLED_TARGETS) {
    assert.throws(() => parseFlags(['--target', name]), new RegExp(`"${name}" is recognized but ae install does not install it`));
  }
});

test('ae install --target rejects unknown and recognized-but-uninstalled hosts without writing', () => {
  const workspace = tempDir('install-target-ws-');
  const copilotHome = tempDir('install-target-home-');
  fs.rmSync(copilotHome, { recursive: true, force: true });
  const result = run(['install', '--target', 'cursor,codex,bogus', '--workspace', workspace, '--copilot-home', copilotHome, '--dry-run']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown target "bogus"/);
  assert.match(result.stderr, /"cursor" is recognized but ae install does not install it/);
  assert.match(result.stderr, /"codex" is recognized but ae install does not install it/);
  assert.match(result.stderr, /Installed targets: vscode, cli, intellij/);
  assert.equal(fs.existsSync(copilotHome), false, 'a rejected target list must not create the copilot home');

  const accepted = run(['install', '--target', 'cli', '--workspace', workspace, '--copilot-home', copilotHome, '--dry-run']);
  assert.equal(accepted.status, 0, accepted.stderr);
});
