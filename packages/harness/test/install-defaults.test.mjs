import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyInstallDefaults } from '../lib/install-defaults.mjs';
import { parseFlags } from '../lib/flags.mjs';

test('setup applies configure-vscode and balanced autonomy by default', () => {
  const flags = applyInstallDefaults(parseFlags([]), [], 'setup');
  assert.equal(flags.configureVsCode, true);
  assert.equal(flags.autonomy, 'balanced');
});

test('--no-configure-vscode opts out of VS Code settings merge', () => {
  const argv = ['--no-configure-vscode'];
  const flags = applyInstallDefaults(parseFlags(argv), argv, 'setup');
  assert.equal(flags.configureVsCode, false);
});
