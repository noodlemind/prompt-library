import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseFlags } from '../lib/flags.mjs';

const binPath = path.resolve(import.meta.dirname, '..', 'bin', 'harness.mjs');

const SEPARATED_VALUE_FLAGS = [
  '--query', '--phase', '--limit', '--autonomy', '--copilot-home', '--target',
  '--plan', '--base', '--enforcement', '--learnings', '--workspace', '--collection',
  '-c', '--min-score', '--docid', '--path', '--lines', '--max-bytes', '--host',
  '--session', '--title', '--category', '--tags', '--trigger', '--claim', '--body',
  '--body-file', '--ops', '--domain', '--reason', '--to', '--why', '--since',
  '--layer', '--branch', '--ids', '--stale',
];

test('parseFlags: --target with a missing value is a named usage error, never a TypeError', () => {
  assert.throws(() => parseFlags(['--target']), /invalid --target/, 'trailing --target (pre-fix: TypeError from .split)');
  assert.throws(
    () => parseFlags(['install', '--target', '--', 'x']),
    /invalid --target/,
    'the boundary slice legitimately removes the value — the parser must say so, not crash'
  );
  assert.throws(() => parseFlags(['--target', '--json']), /invalid --target/, 'a flag-shaped next token is a missing value, not a target list');
  assert.throws(() => parseFlags(['--target=']), /invalid --target/, 'the inline form with an empty value is the same missing value');
});

test('parseFlags: every previously-working --target form still parses identically', () => {
  assert.deepEqual([...parseFlags(['--target', 'cli']).targets], ['cli']);
  assert.deepEqual([...parseFlags(['--target', 'vscode, intellij']).targets], ['vscode', 'intellij'], 'whitespace is still trimmed');
  assert.deepEqual([...parseFlags(['--target=cli,vscode']).targets], ['cli', 'vscode']);
  assert.deepEqual([...parseFlags(['upgrade', '--target', 'cli', '--json']).targets], ['cli']);
  assert.deepEqual([...parseFlags([]).targets], ['vscode', 'cli', 'intellij'], 'the default target set is untouched');
});

test('parseFlags: no separated value flag throws a raw TypeError when its value is missing', () => {
  for (const flag of SEPARATED_VALUE_FLAGS) {
    try {
      parseFlags([flag]);
    } catch (error) {
      assert.equal(
        error instanceof TypeError,
        false,
        `${flag} with a missing value threw a TypeError (E_UNEXPECTED at the CLI): ${error.message}`
      );
      assert.match(error.message, /^invalid /, `${flag} must fail with the package's named flag error: ${error.message}`);
    }
  }
});

test('CLI: `install --target` names the flag instead of reporting an undefined-property crash', () => {
  const result = spawnSync(process.execPath, [binPath, 'install', '--target', '--json'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const body = JSON.parse(result.stderr.trim());
  assert.match(body.error.message, /invalid --target/, 'pre-fix: "Cannot read properties of undefined (reading \'split\')"');
});
