/**
 * TUI palette folds CLI inventory into product actions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommandIndex } from '../lib/command-index.mjs';
import { signatureOf, containsFlagSyntax, resolveSelection } from '../lib/tui/palette.mjs';

test('TUI collapses multi-verb families into one modal entry', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const settings = rows.find((r) => r.id === 'command:config');
  assert.ok(settings, 'Settings is one palette row');
  assert.equal(settings.picker, 'config');
  assert.equal(settings.label, 'Settings');
  assert.equal(rows.some((r) => r.id === 'verb:config:set'), false, 'no config set dump on main palette');
  assert.equal(rows.some((r) => r.id === 'verb:checks:run'), false, 'no checks run dump on main palette');
  const checks = rows.find((r) => r.id === 'command:checks');
  assert.equal(checks?.picker, 'verbs');
  assert.equal(checks?.label, 'Checks');
});

test('CLI surface still has the full parent+verb inventory', () => {
  const { rows } = buildCommandIndex({ surface: 'cli', workspace: process.cwd() });
  assert.ok(rows.some((r) => r.id === 'command:config'));
  assert.ok(rows.some((r) => r.id === 'verb:config:set'));
});

test('TUI labels are product language and signatures never show --flags', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const write = rows.find((r) => r.id === 'command:write');
  assert.equal(write.label, 'Write a file');
  assert.match(signatureOf(write), /path/);
  assert.doesNotMatch(signatureOf(write), /--path/);
  assert.ok(!containsFlagSyntax(signatureOf(write)));
});

test('config set from CLI index soft-defaults scope to user', () => {
  const { rows } = buildCommandIndex({ surface: 'cli', workspace: process.cwd() });
  const set = rows.find((r) => r.id === 'verb:config:set');
  const { argv, invalid } = resolveSelection(set, { key: 'agent.enabled', value: 'true' });
  assert.equal(invalid, null);
  assert.deepEqual(argv.slice(0, 4), ['config', 'set', 'agent.enabled', 'true']);
  assert.ok(argv.includes('--scope') && argv.includes('user'));
});

test('settings modal lists keys with effective values', async () => {
  const { configSettingsRows } = await import('../lib/tui/modals.mjs');
  const { tempDir } = await import('./helpers/index.mjs');
  const workspace = tempDir('modal-ws-');
  const copilotHome = tempDir('modal-home-');
  const rows = configSettingsRows({ workspace, copilotHome });
  assert.ok(rows.some((r) => r.configKey === 'agent.enabled'));
  assert.ok(rows.some((r) => r.openArgv && r.openArgv[0] === 'config' && r.openArgv[1] === 'show'));
});
