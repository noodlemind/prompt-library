import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installGlobalHarnessShim } from '../lib/global-bin.mjs';
import { installVSCodeBridge } from '../lib/install-vscode-bridge.mjs';
import { adoptStorageAlias, storageIdForRepo } from '../lib/storage-aliases.mjs';

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-upgrade-'));
  try { return run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a managed legacy command is retargeted to the canonical runtime', () => fixture(home => {
  fs.mkdirSync(path.join(home, 'bin'));
  fs.writeFileSync(path.join(home, '.harness-lock.json'), JSON.stringify({ package: 'harness', files: ['bin/harness'] }));
  fs.writeFileSync(path.join(home, 'bin/harness'), '#!/usr/bin/env node\n/** Global harness shim — installed by harness install. */\n');
  const result = installGlobalHarnessShim(home, {}, () => {});
  assert.equal(result.legacyPath, path.join(home, 'bin/harness'));
  assert.match(fs.readFileSync(result.legacyPath, 'utf8'), /\.ae-bin.*ae\.mjs/);
}));

test('a legacy command with no matching ownership is preserved', () => fixture(home => {
  fs.mkdirSync(path.join(home, 'bin'));
  const custom = '#!/bin/sh\necho unrelated-tool\n';
  fs.writeFileSync(path.join(home, 'bin/harness'), custom);
  installGlobalHarnessShim(home, {}, () => {});
  assert.equal(fs.readFileSync(path.join(home, 'bin/harness'), 'utf8'), custom);
  assert.ok(fs.existsSync(path.join(home, 'bin/ae')));
}));

test('installation refuses to replace an unrelated ae command', () => fixture(home => {
  fs.mkdirSync(path.join(home, 'bin'));
  const custom = '#!/bin/sh\necho unrelated-tool\n';
  fs.writeFileSync(path.join(home, 'bin/ae'), custom);
  assert.throws(() => installGlobalHarnessShim(home, {}, () => {}), { code: 'E_TARGET' });
  assert.equal(fs.readFileSync(path.join(home, 'bin/ae'), 'utf8'), custom);
}));

test('bridge upgrade retires only the matching former bridge after copying the candidate', () => fixture(root => {
  const packageRoot = path.join(root, 'package');
  const extensionsDir = path.join(root, 'extensions');
  const source = path.join(packageRoot, 'vscode-extension');
  const legacy = path.join(extensionsDir, 'harness-copilot-bridge');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'ae-copilot-bridge', publisher: 'harness', version: '0.1.1' }));
  fs.writeFileSync(path.join(source, 'extension.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(legacy, 'package.json'), JSON.stringify({ name: 'harness-copilot-bridge', publisher: 'harness', version: '0.1.1' }));
  const result = installVSCodeBridge({ packageRoot, extensionsDir });
  assert.ok(fs.existsSync(path.join(result.path, 'extension.cjs')));
  assert.equal(fs.existsSync(legacy), false);
}));

test('an explicit repository rename preserves the original physical plan store', () => fixture(home => {
  const oldId = 'github.com-team-before-79f2fe34';
  const newId = 'github.com-team-after-c6ab3991';
  const plans = path.join(home, 'projects', oldId, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, 'accepted.md'), 'immutable accepted plan\n');
  assert.deepEqual(adoptStorageAlias(newId, oldId, { home }), { storageId: oldId, unchanged: false });
  assert.equal(storageIdForRepo(newId, { home }), oldId);
  assert.equal(fs.readFileSync(path.join(plans, 'accepted.md'), 'utf8'), 'immutable accepted plan\n');
  assert.deepEqual(adoptStorageAlias(newId, oldId, { home }), { storageId: oldId, unchanged: true });
}));

test('repository identity migration dry-run preserves the destination namespace', () => fixture(home => {
  const oldId = 'github.com-team-before-12345678';
  const newId = 'github.com-team-after-87654321';
  fs.mkdirSync(path.join(home, 'projects', oldId), { recursive: true });
  fs.writeFileSync(path.join(home, 'projects', oldId, 'plan.md'), 'accepted');
  const result = adoptStorageAlias(newId, oldId, { home, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(storageIdForRepo(newId, { home }), newId);
  assert.equal(fs.existsSync(path.join(home, 'storage-aliases')), false);
}));
