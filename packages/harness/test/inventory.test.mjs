import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInventory } from '../lib/inventory.mjs';
import { inventoryResultOf } from '../lib/inventory-cmd.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-cache-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'harness');
  return { root, home, cache: path.join(home, 'inventory/editors.json'), base: { home, userHome: root, env: { PATH: '' }, platform: 'darwin' } };
}

test('URI userinfo never reaches the cache through a projected location key', t => {
  const f = fixture(t), userData = path.join(f.root, 'Code');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  const locations = Object.fromEntries(['https://', '//', 'https:\\\\'].map(prefix => [`${prefix}canary-reader:canary-private-pass@example.invalid/skills`, true]));
  fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({ 'chat.agentSkillsLocations': locations }));
  const result = runInventory({ ...f.base, verb: 'refresh', editor: 'vscode', userData });
  assert.equal(result.status, 'ok', result.reason);
  assert.equal(result.published, true);
  for (const raw of [JSON.stringify(result), fs.readFileSync(f.cache, 'utf8')]) {
    assert.doesNotMatch(raw, /canary-reader|canary-private-pass/);
    assert.match(raw, /redacted:url-credentials/);
  }
});

test('show missing inventory creates nothing; refresh only writes selected Harness home', t => {
  const f = fixture(t);
  const missing = runInventory({ ...f.base, verb: 'show' });
  assert.equal(missing.status, 'ok');
  assert.equal(missing.collected, false);
  assert.equal(missing.inventory, null);
  assert.equal(fs.existsSync(f.home), false);
  const refreshed = runInventory({ ...f.base, verb: 'refresh', editor: 'vscode' });
  assert.equal(refreshed.status, 'ok');
  assert.equal(refreshed.published, true);
  assert.equal(refreshed.inventory.inventory_version, 1);
  assert.equal(refreshed.inventory.editors.vscode.running_instance, null);
  assert.deepEqual(fs.readdirSync(f.root), ['harness']);
  assert.deepEqual(runInventory({ ...f.base, verb: 'show' }).inventory, refreshed.inventory);
});

test('dry-run does not collect or create any path and cache refresh does not mutate editor files', t => {
  const f = fixture(t);
  assert.equal(runInventory({ ...f.base, verb: 'refresh', editor: 'cursor', dryRun: true }).published, false);
  assert.equal(fs.existsSync(f.home), false);
  fs.mkdirSync(path.join(f.root, 'Cursor/User'), { recursive: true });
  const settings = path.join(f.root, 'Cursor/User/settings.json');
  fs.writeFileSync(settings, '{"chat.useAgentSkills":true}');
  const bytes = fs.readFileSync(settings);
  runInventory({ ...f.base, verb: 'refresh', editor: 'cursor', userData: path.join(f.root, 'Cursor') });
  assert.deepEqual(fs.readFileSync(settings), bytes);
});

test('malformed or unsafe cache fails closed and retains exact bytes', async t => {
  for (const raw of ['{', '{}', '{"inventory_version":2}', 'x'.repeat(2 * 1024 * 1024 + 1)]) await t.test(raw.slice(0, 20), st => {
    const f = fixture(st);
    fs.mkdirSync(path.dirname(f.cache), { recursive: true });
    fs.writeFileSync(f.cache, raw);
    assert.equal(runInventory({ ...f.base, verb: 'show' }).status, 'failed');
    assert.equal(runInventory({ ...f.base, verb: 'refresh', editor: 'cursor' }).status, 'failed');
    assert.equal(fs.readFileSync(f.cache, 'utf8'), raw);
  });
});

test('symlinked Harness home ancestors and cache paths never redirect writes', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.home);
  assert.equal(runInventory({ ...f.base, verb: 'show' }).status, 'failed');
  assert.equal(runInventory({ ...f.base, verb: 'refresh', editor: 'vscode' }).status, 'failed');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('publication failure preserves existing cache and redaction precedes persistence', t => {
  const f = fixture(t);
  runInventory({ ...f.base, verb: 'refresh', editor: 'vscode' });
  const before = fs.readFileSync(f.cache);
  const fail = runInventory({ ...f.base, verb: 'refresh', editor: 'cursor', publish: () => null });
  assert.equal(fail.status, 'failed');
  assert.deepEqual(fs.readFileSync(f.cache), before);
  fs.mkdirSync(path.join(f.root, 'Code/User'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'Code/User/settings.json'), JSON.stringify({ 'chat.agentSkillsLocations': { 'https://example.invalid?token=inventory-test-secret': true } }));
  const result = runInventory({ ...f.base, verb: 'refresh', editor: 'vscode', userData: path.join(f.root, 'Code') });
  assert.equal(result.status, 'ok');
  assert.equal(fs.readFileSync(f.cache, 'utf8').includes('inventory-test-secret'), false);
});

test('concurrent different editor refreshes preserve both observations', async t => {
  const f = fixture(t);
  const modulePath = fileURLToPath(new URL('../lib/inventory.mjs', import.meta.url));
  const worker = editor => new Promise((resolve, reject) => {
    const script = `import {runInventory} from ${JSON.stringify(modulePath)}; const result=runInventory(${JSON.stringify({ ...f.base, verb: 'refresh', editor })}); if(result.status!=='ok') throw new Error(result.reason);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([worker('vscode'), worker('cursor')]);
  assert.deepEqual(Object.keys(runInventory({ ...f.base, verb: 'show' }).inventory.editors).sort(), ['cursor', 'vscode']);
});

test('command parser keeps selected home and exact known inventory inputs', t => {
  const f = fixture(t);
  const ctx = { harnessHome: f.home };
  assert.equal(inventoryResultOf(['show'], ctx).status, 'ok');
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(inventoryResultOf(['refresh', '--editor', 'unsupported'], ctx).status, 'failed');
  assert.equal(inventoryResultOf(['refresh', '--editor'], ctx).exitCode, 2);
  assert.equal(inventoryResultOf(['refresh', '--launcher', '--json'], ctx).exitCode, 2);
  assert.equal(inventoryResultOf(['show', '--unknown'], ctx).exitCode, 2);
  assert.equal(inventoryResultOf(['show', 'extra'], ctx).exitCode, 2);
  assert.equal(inventoryResultOf(['refresh', '--editor=cursor', '--harness-home', f.home, '--dry-run', '--json'], ctx).published, false);
  assert.equal(fs.existsSync(f.home), false);
});

test('cached observations explicitly remain unvalidated when editor files change', t => {
  const f = fixture(t);
  const pluginsRoot = path.join(f.root, 'extensions');
  const manifest = path.join(pluginsRoot, 'example/package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ publisher: 'ms', name: 'example', version: '1' }));
  const args = { ...f.base, editor: 'vscode', pluginsRoot };
  runInventory({ ...args, verb: 'refresh' });
  fs.writeFileSync(manifest, JSON.stringify({ publisher: 'ms', name: 'example', version: '2' }));
  const shown = runInventory({ ...args, verb: 'show' });
  assert.equal(shown.inventory.editors.vscode.extensions[0].version, '1');
  assert.equal(shown.freshness.status, 'cached-not-revalidated');
  assert.equal(shown.freshness.editors.vscode.currentness_known, false);
  assert.ok(shown.freshness.editors.vscode.age_ms >= 0);
  assert.equal(runInventory({ ...args, verb: 'refresh' }).inventory.editors.vscode.extensions[0].version, '2');
});

test('invalid cache claims, duplicate JSON keys and settings outside the allowlist are rejected', async t => {
  const mutations = [
    value => { value.editors.vscode.settings.overrides['http.proxy'] = 'private'; },
    value => { value.editors.vscode.profile.observed = 'yes'; },
    value => { value.editors.vscode.coverage.bytes = -1; },
    value => { value.editors.vscode.extensions = [{ id: 'x.y', source: '/extension/package.json', scope: 'local-installed', enabled: false }]; },
    value => { value.editors.vscode.running_instance = { version: 'invented' }; },
  ];
  for (const mutate of mutations) await t.test(String(mutate), st => {
    const f = fixture(st);
    runInventory({ ...f.base, verb: 'refresh', editor: 'vscode' });
    const value = JSON.parse(fs.readFileSync(f.cache, 'utf8'));
    mutate(value);
    const bytes = JSON.stringify(value);
    fs.writeFileSync(f.cache, bytes);
    assert.equal(runInventory({ ...f.base, verb: 'show' }).status, 'failed');
    assert.equal(fs.readFileSync(f.cache, 'utf8'), bytes);
  });
  const f = fixture(t);
  runInventory({ ...f.base, verb: 'refresh', editor: 'vscode' });
  const bytes = fs.readFileSync(f.cache, 'utf8').replace('"inventory_version": 1', '"inventory_version": 2, "inventory_version": 1');
  fs.writeFileSync(f.cache, bytes);
  assert.equal(runInventory({ ...f.base, verb: 'show' }).status, 'failed');
  assert.equal(fs.readFileSync(f.cache, 'utf8'), bytes);
});

test('native global no-events is admitted and duplicate or show-only inputs fail exactly', t => {
  const f = fixture(t);
  assert.equal(inventoryResultOf(['show', '--workspace', f.root, '--harness-home', f.home, '--json', '--no-events']).status, 'ok');
  assert.equal(fs.existsSync(f.home), false);
  for (const argv of [
    ['show', '--editor', 'vscode'],
    ['refresh', '--editor', 'vscode', '--editor=cursor'],
    ['show', '--json', '--json'],
    ['show', '--harness-home', f.home, '--harness-home', f.root],
    ['refresh', '--editor', 'vscode', '--profile', 'first', '--profile', 'second'],
  ]) assert.equal(inventoryResultOf(argv, { harnessHome: f.home }).exitCode, 2, JSON.stringify(argv));
  assert.equal(fs.existsSync(f.home), false);
});

test('valid long JetBrains plugin names round-trip through the cache', async t => {
  for (const length of [257, 512]) await t.test(`${length} characters`, st => {
    const f = fixture(st);
    const pluginsRoot = path.join(f.root, 'plugins');
    const full = path.join(pluginsRoot, 'example/META-INF/plugin.xml');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `<idea-plugin><id>example.plugin</id><name>${'x'.repeat(length)}</name><version>1</version></idea-plugin>`);
    const result = runInventory({ ...f.base, verb: 'refresh', editor: 'jetbrains', pluginsRoot, configRoot: path.join(f.root, 'missing') });
    assert.equal(result.status, 'ok');
    assert.equal(runInventory({ ...f.base, verb: 'show' }).inventory.editors.jetbrains.extensions[0].name.length, length);
  });
});

test('dry-run enforces the same static profile and launcher contract without collecting', t => {
  const f = fixture(t);
  for (const invalid of [
    { editor: 'jetbrains', profile: 'work' },
    { editor: 'vscode', profile: '../escape' },
    { editor: 'cursor', launcher: path.join(f.root, 'arbitrary-executable') },
    { editor: 'vscode', configRoot: f.root },
  ]) assert.equal(runInventory({ ...f.base, verb: 'refresh', ...invalid, dryRun: true }).status, 'failed');
  assert.equal(fs.existsSync(f.home), false);
});

test('VS Code publisher and name bounds produce a cacheable complete ID', t => {
  const f = fixture(t);
  const pluginsRoot = path.join(f.root, 'extensions');
  const manifest = path.join(pluginsRoot, 'long/package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ publisher: 'a'.repeat(128), name: 'b'.repeat(128), version: '1' }));
  const result = runInventory({ ...f.base, verb: 'refresh', editor: 'vscode', pluginsRoot });
  assert.equal(result.status, 'ok');
  assert.equal(result.inventory.editors.vscode.extensions[0].id.length, 257);
  assert.equal(runInventory({ ...f.base, verb: 'show' }).status, 'ok');
});

test('real atomic rename failure leaves exact previous cache and no temporary files', t => {
  const f = fixture(t);
  runInventory({ ...f.base, verb: 'refresh', editor: 'vscode' });
  const before = fs.readFileSync(f.cache);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === f.cache) throw Object.assign(new Error('Injected rename I/O failure'), { code: 'EIO' });
    return rename(from, to);
  };
  let result;
  try { result = runInventory({ ...f.base, verb: 'refresh', editor: 'cursor' }); } finally { fs.renameSync = rename; }
  assert.equal(result.status, 'failed');
  assert.deepEqual(fs.readFileSync(f.cache), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.cache)), ['editors.json']);
});
