import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { installGlobalHarnessShim } from '../lib/global-bin.mjs';
import { installVSCodeBridge } from '../lib/install-vscode-bridge.mjs';
import { adoptStorageAlias, storageIdForRepo } from '../lib/storage-aliases.mjs';

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-upgrade-'));
  try { return run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('an owned legacy runtime override executes the upgraded CLI', () => fixture(home => {
  const relative = '.harness-bin/bin/harness.mjs';
  const legacy = path.join(home, relative);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "console.log('0.10.0');\n");
  fs.writeFileSync(path.join(home, '.harness-lock.json'), JSON.stringify({ package: 'harness', files: [relative] }));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const result = installHarnessBin(packageRoot, home, {}, () => {});
  const run = spawnSync(process.execPath, [legacy, '--version'], {
    encoding: 'utf8', env: { ...process.env, HARNESS_BIN: legacy, AE_BIN: legacy },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'))).version);
  assert.ok(result.files.includes(relative));
}));

test('runtime hydration preserves an unowned legacy entry and owned dry-runs', () => fixture(home => {
  const relative = '.harness-bin/bin/harness.mjs', legacy = path.join(home, relative);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const original = "console.log('user-owned');\n";
  fs.writeFileSync(legacy, original);
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  installHarnessBin(packageRoot, home, {}, () => {});
  assert.equal(fs.readFileSync(legacy, 'utf8'), original);
  fs.writeFileSync(path.join(home, '.harness-lock.json'), JSON.stringify({ package: 'harness', files: [relative] }));
  const result = installHarnessBin(packageRoot, home, { dryRun: true }, () => {});
  assert.equal(fs.readFileSync(legacy, 'utf8'), original);
  assert.ok(result.files.includes(relative));
}));

test('runtime hydration does not follow an owned legacy directory symlink', { skip: process.platform === 'win32' ? 'symlink creation needs Windows privilege' : false }, () => fixture(root => {
  const home = path.join(root, 'copilot'), outside = path.join(root, 'outside');
  fs.mkdirSync(home); fs.mkdirSync(path.join(outside, 'bin'), { recursive: true });
  const legacy = path.join(outside, 'bin/harness.mjs'), original = 'unrelated runtime\n';
  fs.writeFileSync(legacy, original);
  fs.symlinkSync(outside, path.join(home, '.harness-bin'));
  fs.writeFileSync(path.join(home, '.harness-lock.json'), JSON.stringify({ package: 'harness', files: ['.harness-bin/bin/harness.mjs'] }));
  installHarnessBin(fileURLToPath(new URL('../', import.meta.url)), home, {}, () => {});
  assert.equal(fs.readFileSync(legacy, 'utf8'), original);
}));

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
