import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getCommand } from '../lib/registry.mjs';

test('formal trace replay is discoverable with receipt and model selection', () => {
  const command = getCommand('diagrams');
  assert.ok(command.verbs.some(({ verb }) => verb === 'formal'));
  for (const flag of ['--file', '--model', '--max-nodes', '--png', '--scale', '--timeout']) {
    assert.ok(command.args.flags.find(({ name }) => name === flag)?.verbs.includes('formal'), flag);
  }
});

test('diagram help describes recorded replay without invoking a checker', () => {
  const cli = fileURLToPath(new URL('../bin/ae.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'diagrams', '--help'], {
    encoding: 'utf8', env: { ...process.env, AE_TLC_JAR: '', AE_TLC_JAVA: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--model/);
  assert.match(result.stdout, /recorded|replay/i);
});
