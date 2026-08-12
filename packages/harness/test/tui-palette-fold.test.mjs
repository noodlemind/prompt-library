/**
 * TUI palette folds CLI inventory into product actions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommandIndex } from '../lib/command-index.mjs';
import { signatureOf, containsFlagSyntax, resolveSelection } from '../lib/tui/palette.mjs';

test('TUI folds multi-verb commands: no bare parent rows that only ask for a verb', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  assert.equal(rows.some((r) => r.id === 'command:config'), false, 'no bare config parent');
  assert.equal(rows.some((r) => r.id === 'command:checks'), false, 'no bare checks parent');
  assert.ok(rows.some((r) => r.id === 'verb:config:set'));
  assert.ok(rows.some((r) => r.id === 'verb:checks:run'));
});

test('CLI surface still has the full parent+verb inventory', () => {
  const { rows } = buildCommandIndex({ surface: 'cli', workspace: process.cwd() });
  assert.ok(rows.some((r) => r.id === 'command:config'));
  assert.ok(rows.some((r) => r.id === 'verb:config:set'));
});

test('TUI labels are product language and signatures never show --flags', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const set = rows.find((r) => r.id === 'verb:config:set');
  assert.equal(set.label, 'Set config value');
  const sig = signatureOf(set);
  assert.equal(sig, 'key · value');
  assert.ok(!containsFlagSyntax(sig));
  assert.doesNotMatch(sig, /--/);
  assert.doesNotMatch(sig, /</);

  const write = rows.find((r) => r.id === 'command:write');
  assert.equal(write.label, 'Write a file');
  assert.match(signatureOf(write), /path/);
  assert.doesNotMatch(signatureOf(write), /--path/);
});

test('config set from palette soft-defaults scope to user', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const set = rows.find((r) => r.id === 'verb:config:set');
  const { argv, invalid } = resolveSelection(set, { key: 'agent.enabled', value: 'true' });
  assert.equal(invalid, null);
  assert.deepEqual(argv.slice(0, 4), ['config', 'set', 'agent.enabled', 'true']);
  assert.ok(argv.includes('--scope') && argv.includes('user'));
});
