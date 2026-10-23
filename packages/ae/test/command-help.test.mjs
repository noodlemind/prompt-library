import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandHelpRequested, dispatch, listCommands } from '../lib/registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-help-home-'));

function run(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NO_COLOR: '1', AE_HOME: home, HARNESS_HOME: home },
  });
}

test('help flags are recognized only before a -- boundary', () => {
  assert.equal(commandHelpRequested(['--help']), true);
  assert.equal(commandHelpRequested(['-h']), true);
  assert.equal(commandHelpRequested(['--json', '--help']), true);
  assert.equal(commandHelpRequested(['--', '--help']), false);
  assert.equal(commandHelpRequested(['--workspace', '/tmp']), false);
});

test('dispatch does not run a command when --help is present', async () => {
  assert.equal(await dispatch(['gate', '--help'], {}), 0);
  assert.equal(await dispatch(['gate', '-h'], {}), 0);
});

test('every registered command accepts --help and -h', () => {
  const commands = listCommands();
  assert.ok(commands.length > 0);
  for (const name of commands) {
    for (const flag of ['--help', '-h']) {
      const help = run(['help', name]);
      const direct = run([name, flag]);
      assert.equal(direct.status, 0, `${name} ${flag}\n${direct.stdout}\n${direct.stderr}`);
      assert.match(direct.stdout, /Usage:/, `${name} ${flag} prints usage`);
      assert.equal(direct.stdout, help.stdout, `${name} ${flag} matches ae help ${name}`);
      assert.equal(help.status, 0, help.stderr);
    }
  }
});

test('a help flag after -- is not command help', () => {
  const help = run(['help', 'exec']);
  const literal = run(['exec', '--', '--help']);
  assert.notEqual(literal.stdout, help.stdout);
});
