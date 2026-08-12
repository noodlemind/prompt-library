/**
 * Config sugar + default user scope (TUI/TUX frontier plan Phase 1).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { normalizeConfigPositionals, configResultOf } from '../lib/config-cmd.mjs';
import { statusForExit } from '../lib/tui/ledger.mjs';
import { statusSegments } from '../lib/tui/status.mjs';
import { interpretLine } from '../lib/tui/session.mjs';
import { createBlock, recordSegments } from '../lib/tui/block.mjs';
import { EXIT } from '../lib/style.mjs';
import { tempDir, packageRoot, binPath } from './helpers/index.mjs';

test('normalizeConfigPositionals accepts key=value and key = value', () => {
  assert.deepEqual(
    normalizeConfigPositionals(['set', 'agent.enabled=false'], { verb: 'set' }),
    ['set', 'agent.enabled', 'false'],
  );
  assert.deepEqual(
    normalizeConfigPositionals(['set', 'agent.enabled', '=', 'false'], { verb: 'set' }),
    ['set', 'agent.enabled', 'false'],
  );
});

test('config set without --scope defaults to user', async () => {
  const workspace = tempDir('cfg-scope-ws-');
  const copilotHome = tempDir('cfg-scope-home-');
  const result = await configResultOf(
    ['set', 'agent.enabled', 'false', '--workspace', workspace, '--copilot-home', copilotHome],
  );
  assert.equal(result.scope, 'user');
  assert.equal(result.scopeDefaulted, true);
  assert.equal(result.written, false);
});

test('config set key=value works via CLI without --scope', () => {
  const workspace = tempDir('cfg-eq-ws-');
  const copilotHome = tempDir('cfg-eq-home-');
  const r = spawnSync(
    process.execPath,
    [binPath, 'config', 'set', 'agent.enabled=true', '--workspace', workspace, '--copilot-home', copilotHome, '--no-events'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /agent\.enabled/);
  assert.match(r.stdout, /user/);
});

test('ledger statusForExit maps EXIT.usage to usage (not inconclusive)', () => {
  assert.equal(statusForExit(EXIT.usage), 'usage');
  assert.equal(statusForExit(1), 'failed');
});

test('usage block record segments say usage not failed', () => {
  const block = createBlock({ status: 'usage', exit: EXIT.usage, command: 'config set' });
  const texts = recordSegments(block).map((s) => s.text);
  assert.ok(texts.includes('usage'), texts.join(','));
  assert.ok(!texts.includes('failed'));
});

test('statusSegments include agent on/off', () => {
  const on = statusSegments({ workspace: '~/x', agent: true });
  assert.ok(on.some((s) => s.text === 'agent on'));
  const off = statusSegments({ workspace: '~/x', agent: false });
  assert.ok(off.some((s) => s.text === 'agent off'));
});

test('interpretLine recognizes agent on/off product verbs', () => {
  assert.deepEqual(interpretLine('agent off'), { kind: 'agent-mode-set', enabled: false });
  assert.deepEqual(interpretLine('/agent on'), { kind: 'agent-mode-set', enabled: true });
  assert.equal(interpretLine('?').kind, 'help');
});
