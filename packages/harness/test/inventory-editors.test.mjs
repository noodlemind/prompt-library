import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectEditorInventory } from '../lib/inventory-editors.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-editor-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return full;
  };
  return { root, write, base: { userHome: root, platform: 'darwin', env: { PATH: '' } } };
}

test('VS Code inventory reads only bounded local manifests and approved JSONC overrides', t => {
  const f = fixture(t);
  f.write('Code/resources/app/package.json', JSON.stringify({ name: 'code', version: '1.109.0', token: 'secret' }));
  f.write('Code/User/settings.json', `// user overrides\n{"chat.useAgentSkills":true,"chat.agentSkillsLocations":{"/private/skills":true},"http.proxy":"https://token-secret.invalid",}`);
  f.write('extensions/ms.example-1/package.json', JSON.stringify({ publisher: 'ms', name: 'example', version: '1.0.0' }));
  f.write('extensions/ms.example-2/package.json', JSON.stringify({ publisher: 'ms', name: 'example', version: '2.0.0' }));
  const state = f.write('Code/User/globalStorage/state.vscdb', 'private history');
  const before = fs.readFileSync(state);
  const result = collectEditorInventory({ ...f.base, editor: 'vscode', installation: path.join(f.root, 'Code'), userData: path.join(f.root, 'Code'), pluginsRoot: path.join(f.root, 'extensions') });
  assert.equal(result.status, 'collected');
  assert.equal(result.product.version, '1.109.0');
  assert.deepEqual(result.extensions.map(value => value.version), ['1.0.0', '2.0.0']);
  assert.ok(result.extensions.every(value => value.enabled === null && value.scope === 'local-installed' && value.source.endsWith('package.json')));
  assert.deepEqual(result.settings.overrides, { 'chat.useAgentSkills': true, 'chat.agentSkillsLocations': { '/private/skills': true } });
  assert.equal(result.settings.effective_known, false);
  assert.equal(result.running_instance, null);
  assert.equal(result.remote.status, 'uncollected');
  assert.deepEqual(fs.readFileSync(state), before);
  assert.equal(JSON.stringify(result).includes('token-secret'), false);
});

test('profiles use existing directory IDs and missing profiles never fall back or create state', t => {
  const f = fixture(t);
  f.write('Cursor/User/settings.json', '{"chat.useAgentSkills":false}');
  f.write('Cursor/User/profiles/42a/settings.json', '{"chat.useAgentSkills":true}');
  const args = { ...f.base, editor: 'cursor', userData: path.join(f.root, 'Cursor'), pluginsRoot: path.join(f.root, 'extensions') };
  const selected = collectEditorInventory({ ...args, profile: '42a' });
  assert.equal(selected.profile.value, '42a');
  assert.equal(selected.settings.overrides['chat.useAgentSkills'], true);
  const missing = collectEditorInventory({ ...args, profile: 'missing-profile' });
  assert.equal(missing.profile.observed, false);
  assert.deepEqual(missing.settings.overrides, {});
  assert.ok(missing.warnings.some(value => /profile.*not found/i.test(value)));
  assert.equal(fs.existsSync(path.join(f.root, 'Cursor/User/profiles/missing-profile')), false);
  assert.throws(() => collectEditorInventory({ ...args, profile: '../escape' }), /profile/i);
});

test('unsafe, malformed, oversized and capped metadata produce explicit incomplete coverage', t => {
  const f = fixture(t);
  f.write('extensions/a/package.json', '{broken');
  f.write('extensions/b/package.json', 'x'.repeat(65_537));
  const outside = f.write('outside/package.json', '{"publisher":"evil","name":"outside","version":"1"}');
  fs.mkdirSync(path.join(f.root, 'extensions/c'));
  fs.symlinkSync(outside, path.join(f.root, 'extensions/c/package.json'));
  const result = collectEditorInventory({ ...f.base, editor: 'vscode', pluginsRoot: path.join(f.root, 'extensions') });
  assert.deepEqual(result.extensions, []);
  assert.equal(result.coverage.complete, false);
  assert.ok(result.warnings.some(value => /bounded regular|unsafe|malformed/i.test(value)));
  const capped = collectEditorInventory({ ...f.base, editor: 'vscode', pluginsRoot: path.join(f.root, 'extensions'), limits: { directories: 1 } });
  assert.equal(capped.coverage.complete, false);
  assert.ok(capped.warnings.some(value => /Collection directories bound/i.test(value)));
  const timed = collectEditorInventory({ ...f.base, editor: 'vscode', pluginsRoot: path.join(f.root, 'extensions'), limits: { milliseconds: 0 } });
  assert.equal(timed.coverage.complete, false);
  assert.ok(timed.warnings.some(value => /time/i.test(value)));
});

test('an uninstalled editor reports absence and launcher selection cannot execute arbitrary files', t => {
  const f = fixture(t);
  const result = collectEditorInventory({ ...f.base, editor: 'vscode', installation: path.join(f.root, 'missing-installation') });
  assert.equal(result.status, 'not-found');
  assert.equal(result.installation.value, null);
  assert.equal(result.launcher.value, null);
  assert.equal(result.profile.observed, false);
  assert.deepEqual(result.extensions, []);
  const script = f.write('unrelated-script', '#!/bin/sh\ntouch forbidden\n');
  assert.throws(() => collectEditorInventory({ ...f.base, editor: 'vscode', launcher: script }), /known launcher/i);
  const launcher = f.write('bin/code', '#!/bin/sh\ntouch forbidden\n');
  fs.chmodSync(launcher, 0o755);
  const picked = collectEditorInventory({ ...f.base, editor: 'vscode', launcher });
  assert.equal(picked.launcher.value, launcher);
  assert.equal(picked.launcher.scope, 'cli_selected');
  assert.equal(fs.existsSync(path.join(f.root, 'forbidden')), false);
});

test('JetBrains versioned configurations retain plugin scope and explicit disabled IDs', t => {
  const f = fixture(t);
  f.write('IDE/product-info.json', JSON.stringify({ name: 'IntelliJ IDEA', version: '2026.2', buildNumber: '262.1' }));
  f.write('IDE/plugins/bundled/META-INF/plugin.xml', '<idea-plugin><id>bundled.plugin</id><name>Bundled</name><version>1</version></idea-plugin>');
  f.write('JetBrains/IntelliJIdea2026.1/disabled_plugins.txt', 'downloaded.plugin\n');
  f.write('JetBrains/IntelliJIdea2026.1/plugins/downloaded/META-INF/plugin.xml', '<idea-plugin><id>downloaded.plugin</id><name>Downloaded</name><version>2</version></idea-plugin>');
  f.write('JetBrains/IntelliJIdea2026.2/plugins/new/META-INF/plugin.xml', '<idea-plugin><id>downloaded.plugin</id><name>Downloaded</name><version>3</version></idea-plugin>');
  const result = collectEditorInventory({ ...f.base, editor: 'jetbrains', installation: path.join(f.root, 'IDE'), configRoot: path.join(f.root, 'JetBrains') });
  assert.equal(result.product.version, '2026.2');
  assert.equal(result.configurations.length, 2);
  assert.equal(result.extensions.find(value => value.scope === 'bundled').enabled, null);
  assert.equal(result.extensions.find(value => value.version === '2').enabled, false);
  assert.equal(result.extensions.find(value => value.version === '3').enabled, null);
  assert.ok(result.extensions.every(value => value.source.endsWith('plugin.xml')));
  assert.equal(result.running_instance, null);
  assert.throws(() => collectEditorInventory({ ...f.base, editor: 'jetbrains', profile: 'work' }), /profile.*VS Code|profile.*Cursor/i);
});

test('symlinked editor roots and root ancestors are refused without touching targets', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, 'linked'));
  const result = collectEditorInventory({ ...f.base, editor: 'cursor', userData: path.join(f.root, 'linked', 'Cursor') });
  assert.equal(result.coverage.complete, false);
  assert.ok(result.warnings.some(value => /unsafe/i.test(value)));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a named JetBrains version directory must actually exist and be a safe directory', t => {
  const f = fixture(t);
  const configRoot = path.join(f.root, 'JetBrains/IntelliJIdea2026.2');
  const args = { ...f.base, editor: 'jetbrains', configRoot };
  const missing = collectEditorInventory(args);
  assert.deepEqual(missing.configurations, []);
  assert.equal(missing.status, 'not-found');
  f.write('JetBrains/IntelliJIdea2026.2', 'not a directory');
  assert.deepEqual(collectEditorInventory(args).configurations, []);
  fs.unlinkSync(configRoot);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, configRoot);
  const unsafe = collectEditorInventory(args);
  assert.deepEqual(unsafe.configurations, []);
  assert.equal(unsafe.coverage.complete, false);
});

test('JetBrains collection reads JAR descriptors in plugin lib directories without extraction', t => {
  const f = fixture(t);
  const archive = Buffer.from('UEsDBBQAAAAIABgFTF18u+YvOwAAAFIAAAATAAAATUVUQS1JTkYvcGx1Z2luLnhtbLPJTElN1C3IKU3PzLOzyUyxy0os0oNwbfSBXJu8xNxUOy/HIBt9MMumLLWoODM/z87ERh/GBClEGAIAUEsBAhQDFAAAAAgAGAVMXXy75i87AAAAUgAAABMAAAAAAAAAAAAAAIABAAAAAE1FVEEtSU5GL3BsdWdpbi54bWxQSwUGAAAAAAEAAQBBAAAAbAAAAAAA', 'base64');
  const source = f.write('plugins/jar-plugin/lib/plugin.jar', archive);
  const result = collectEditorInventory({ ...f.base, editor: 'jetbrains', configRoot: path.join(f.root, 'missing'), pluginsRoot: path.join(f.root, 'plugins') });
  assert.deepEqual(result.extensions.map(value => [value.id, value.version, value.source]), [['jar.plugin', '4', source]]);
  assert.equal(result.extensions[0].enabled, null);
  assert.deepEqual(fs.readdirSync(path.dirname(source)), ['plugin.jar']);
  const bad = f.write('plugins/bad/lib/bad.jar', archive.subarray(0, archive.length - 10));
  const incomplete = collectEditorInventory({ ...f.base, editor: 'jetbrains', configRoot: path.join(f.root, 'missing'), pluginsRoot: path.join(f.root, 'plugins') });
  assert.equal(incomplete.coverage.complete, false);
  assert.ok(incomplete.warnings.some(value => value.includes(bad) && /JAR/i.test(value)));
  assert.equal(incomplete.extensions.length, 1);
});

test('JetBrains macOS installation metadata is observed under bundle Resources', t => {
  const f = fixture(t);
  const source = f.write('IDE.app/Contents/Resources/product-info.json', JSON.stringify({ name: 'IntelliJ IDEA', version: '2026.2', buildNumber: '262.1' }));
  const result = collectEditorInventory({ ...f.base, editor: 'jetbrains', installation: path.join(f.root, 'IDE.app'), configRoot: path.join(f.root, 'missing') });
  assert.equal(result.product.version, '2026.2');
  assert.equal(result.product.source, source);
  const contents = collectEditorInventory({ ...f.base, editor: 'jetbrains', installation: path.join(f.root, 'IDE.app/Contents'), configRoot: path.join(f.root, 'missing') });
  assert.equal(contents.product.source, source);
});

test('known launcher symlinks resolve read-only and Unix non-executable files cannot be cli-selected', t => {
  const f = fixture(t);
  const target = f.write('Code.app/Contents/Resources/app/bin/code', '#!/bin/sh\ntouch forbidden\n');
  fs.chmodSync(target, 0o755);
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const link = path.join(bin, 'code');
  fs.symlinkSync(target, link);
  const picked = collectEditorInventory({ ...f.base, editor: 'vscode', env: { PATH: bin } });
  assert.equal(picked.launcher.value, link);
  assert.equal(picked.launcher.resolved_path, target);
  assert.equal(picked.launcher.observed, true);
  assert.equal(picked.coverage.complete, true);
  assert.equal(fs.existsSync(path.join(f.root, 'forbidden')), false);
  fs.unlinkSync(link);
  const file = f.write('bin/code', 'not executable');
  fs.chmodSync(file, 0o644);
  const unavailable = collectEditorInventory({ ...f.base, editor: 'vscode', env: { PATH: bin } });
  assert.equal(unavailable.launcher.value, null);
  assert.equal(unavailable.launcher.observed, false);
  const windows = collectEditorInventory({ ...f.base, platform: 'win32', editor: 'vscode', launcher: file });
  assert.equal(windows.launcher.value, file);
});
