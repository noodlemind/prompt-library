import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const packageRoot = path.resolve(import.meta.dirname, '..');

test('standalone source and its offline-installed archive validate and pack without repository or global assets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-standalone-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(npm, 'npm CLI is required for the standalone package regression');
  const source = path.join(root, 'source');
  fs.cpSync(packageRoot, source, { recursive: true, filter: entry => path.basename(entry) !== 'node_modules' && !entry.endsWith('.tgz') });
  fs.mkdirSync(path.join(source, 'node_modules'));
  fs.cpSync(path.join(packageRoot, 'node_modules/yaml'), path.join(source, 'node_modules/yaml'), { recursive: true });
  const userconfig = path.join(root, 'npm-userconfig'), globalconfig = path.join(root, 'npm-globalconfig');
  fs.writeFileSync(userconfig, '');
  fs.writeFileSync(globalconfig, '');
  const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), COPILOT_HOME: path.join(root, 'copilot'),
    AE_HOME: path.join(root, 'control'), HARNESS_HOME: path.join(root, 'control'),
    PATH: [path.dirname(process.execPath), process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/bin'].join(path.delimiter), npm_config_cache: path.join(root, 'cache'),
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_ignore_scripts: 'false' };
  delete env.AE_BIN;
  delete env.HARNESS_BIN;
  delete env.NODE_TEST_CONTEXT;
  assert.ok(spawnSync('ae', ['--version'], { env }).error, 'the packaging proof must not use a global ae');
  const run = (cwd, args) => spawnSync(process.execPath, [npm, ...args], {
    cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  const ok = (cwd, args) => {
    const result = run(cwd, args);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  const archives = path.join(root, 'archives');
  fs.mkdirSync(archives);
  const [packed] = JSON.parse(ok(source, ['pack', '--json', '--pack-destination', archives]).stdout);
  assert.equal(packed.name, 'ae-harness');
  assert.ok(packed.files.some(file => file.path === 'scripts/check-release.mjs'));
  const prefix = path.join(root, 'installed');
  ok(root, ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', path.join(archives, packed.filename)]);
  const installed = path.join(prefix, 'node_modules/ae-harness');
  assert.equal(fs.existsSync(path.join(installed, 'test')), false);
  assert.equal(fs.existsSync(path.join(installed, 'package-lock.json')), false);
  assert.ok(fs.existsSync(path.join(prefix, 'node_modules/.bin', process.platform === 'win32' ? 'ae.cmd' : 'ae')), 'archive installation must expose the ae command');
  assert.equal(ok(root, ['exec', '--prefix', prefix, '--offline', '--', 'ae', '--version']).stdout.trim(), packed.version);
  ok(installed, ['run', 'prepack']);
  const repacked = path.join(root, 'repacked');
  fs.mkdirSync(repacked);
  ok(installed, ['pack', '--json', '--pack-destination', repacked]);

  const lockPath = path.join(source, 'package-lock.json'), lockBytes = fs.readFileSync(lockPath);
  const lock = JSON.parse(lockBytes);
  lock.version = '0.0.0';
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  const drift = run(source, ['run', 'check:release']);
  assert.notEqual(drift.status, 0, 'standalone packaging must still reject lockfile version drift');
  assert.match(drift.stdout + drift.stderr, /lockfile.*version/i);
  fs.writeFileSync(lockPath, lockBytes);

  const manifestPath = path.join(source, 'package.json'), manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  manifest.bin = { harness: './bin/ae.mjs' };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const wrongBin = run(source, ['run', 'check:release']);
  assert.notEqual(wrongBin.status, 0, 'release validation must reject stale CLI export names');
  assert.match(wrongBin.stdout + wrongBin.stderr, /ae.*bin|bin.*ae/i);
  fs.writeFileSync(manifestPath, manifestBytes);

  const corpus = path.join(installed, 'corpus');
  fs.renameSync(corpus, `${corpus}-missing`);
  const missing = run(installed, ['pack', '--json', '--pack-destination', repacked]);
  assert.notEqual(missing.status, 0, 'archive repacking must reject missing shipped assets');
  assert.match(missing.stdout + missing.stderr, /corpus/i);
  fs.renameSync(`${corpus}-missing`, corpus);

  const bridgePath = path.join(installed, 'vscode-extension/package.json');
  const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
  bridge.version = 'invalid';
  fs.writeFileSync(bridgePath, JSON.stringify(bridge));
  const invalid = run(installed, ['run', 'prepack']);
  assert.notEqual(invalid.status, 0, 'archive validation must reject an invalid release manifest');
  assert.match(invalid.stdout + invalid.stderr, /version/i);
});
