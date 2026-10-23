import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { listCommands } from '../lib/registry.mjs';
import { binPath, packageRoot } from './helpers/cli.mjs';

function run(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('every registered command --help and -h exits 0 with that command usage', () => {
  for (const name of listCommands()) {
    const expected = run(['help', name]);
    assert.equal(expected.status, 0, `ae help ${name}\n${expected.stderr}`);
    assert.match(expected.stdout, new RegExp(`Usage: ae ${name}\\b`));
    for (const flag of ['--help', '-h']) {
      const result = run([name, flag]);
      assert.equal(result.status, 0, `ae ${name} ${flag}\n${result.stderr}`);
      assert.equal(result.stdout, expected.stdout, `ae ${name} ${flag} must print the same usage as ae help ${name}`);
      assert.doesNotMatch(result.stderr, /unknown flag/, `ae ${name} ${flag} must not be rejected as an unknown flag`);
    }
  }
});
