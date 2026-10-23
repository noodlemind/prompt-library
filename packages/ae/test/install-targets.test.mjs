import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INSTALLED_TARGETS, RECOGNIZED_UNINSTALLED_TARGETS, parseFlags } from '../lib/flags.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');

function run(args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-target-'));
  const home = path.join(root, 'home');
  const copilot = path.join(root, 'copilot');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace);
  const result = spawnSync(process.execPath, [
    binPath, ...args,
    '--copilot-home', copilot,
    '--workspace', workspace,
    '--ae-home', home,
    '--no-events',
  ], {
    encoding: 'utf8',
    cwd: workspace,
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
  });
  return { ...result, copilot, workspace };
}

test('parseFlags accepts only targets ae install actually writes', () => {
  assert.deepEqual([...parseFlags(['--target', 'vscode, cli']).targets].sort(), ['cli', 'vscode']);
  assert.throws(() => parseFlags(['--target', 'bogus']), (error) => {
    assert.match(error.message, /unknown target: bogus/);
    assert.match(error.message, /installed targets: vscode, cli, intellij/);
    return true;
  });
  assert.throws(() => parseFlags(['--target', 'cursor']), /recognized but not installed: cursor/);
  assert.throws(() => parseFlags(['--target', 'cursor,codex,bogus']), (error) => {
    assert.match(error.message, /unknown target: bogus/);
    assert.match(error.message, /recognized but not installed: cursor, codex/);
    assert.match(error.message, /writes no host config/);
    return true;
  });
});

test('ae install --target rejects unknown and recognized-but-uninstalled hosts', () => {
  const unknown = run(['install', '--target', 'bogus']);
  assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr);
  assert.match(unknown.stderr, /unknown target: bogus/);
  assert.match(unknown.stderr, new RegExp(INSTALLED_TARGETS.join(', ')));
  assert.equal(fs.existsSync(unknown.copilot), false);

  const mixed = run(['install', '--target', 'cursor,codex,bogus']);
  assert.equal(mixed.status, 2, mixed.stdout + mixed.stderr);
  assert.match(mixed.stderr, /unknown target: bogus/);
  assert.match(mixed.stderr, /recognized but not installed: cursor, codex/);
  for (const name of RECOGNIZED_UNINSTALLED_TARGETS) {
    if (name === 'grok') continue;
    assert.match(mixed.stderr, new RegExp(name));
  }
  assert.equal(fs.existsSync(mixed.copilot), false);
  assert.equal(fs.existsSync(path.join(mixed.workspace, '.cursor')), false);

  const recognized = run(['install', '--target', 'cursor']);
  assert.equal(recognized.status, 2, recognized.stdout + recognized.stderr);
  assert.match(recognized.stderr, /recognized but not installed: cursor/);
  assert.match(recognized.stderr, /writes no host config/);
  assert.equal(fs.existsSync(recognized.copilot), false);
});

test('ae install --target cli still installs', () => {
  const installed = run(['install', '--target', 'cli', '--dry-run']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
});
