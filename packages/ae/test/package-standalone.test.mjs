import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tailText(value, limit) {
  const bytes = Buffer.from(value || '');
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

function npmDebugLog(cache) {
  if (!cache) return null;
  try {
    const directory = path.join(cache, '_logs'), stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const name = fs.readdirSync(directory).filter(name => name.endsWith('-debug-0.log')).sort().at(-1);
    if (!name) return null;
    const full = path.join(directory, name), file = fs.lstatSync(full);
    if (!file.isFile() || file.isSymbolicLink()) return null;
    const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 16_384));
      fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      return { name, tail: tailText(bytes.toString('utf8'), 16_384) };
    } finally { fs.closeSync(fd); }
  } catch (error) { return { error: error.message }; }
}

function npmRunner(npm, env) {
  const run = (cwd, args) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [npm, ...args], {
      cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    return { ...result, elapsedMs: Date.now() - started };
  };
  const ok = (cwd, args) => {
    const result = run(cwd, args);
    if (result.error || result.status !== 0) {
      let npmVersion = 'unknown';
      try { npmVersion = JSON.parse(fs.readFileSync(path.resolve(path.dirname(npm), '../package.json'), 'utf8')).version; } catch {}
      const receipt = { schema: 1, argv: [process.execPath, npm, ...args], cwd, nodeVersion: process.version, npmVersion,
        timeoutMs: 60_000, elapsedMs: result.elapsedMs, exitCode: result.status, signal: result.signal,
        error: result.error ? { code: result.error.code, message: result.error.message } : null,
        stdout: tailText(result.stdout, 8192), stderr: tailText(result.stderr, 8192), npmDebugLog: npmDebugLog(env.npm_config_cache) };
      let evidencePath;
      try {
        const parent = env.HARNESS_CHECK_ARTIFACT_DIR || os.tmpdir();
        fs.mkdirSync(parent, { recursive: true });
        const artifacts = fs.mkdtempSync(path.join(parent, 'standalone-package-failure-'));
        evidencePath = path.join(artifacts, 'npm-failure.json');
        fs.writeFileSync(evidencePath, JSON.stringify(receipt, null, 2) + '\n');
      } catch (error) { receipt.evidenceError = error.message; }
      assert.fail(`npm command failed; diagnostic receipt: ${evidencePath || 'unavailable'}\n${JSON.stringify(receipt, null, 2)}`);
    }
    return result;
  };
  return { run, ok };
}

test('standalone command failures retain bounded private diagnostics after fixture cleanup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-package-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fixture'), artifacts = path.join(root, 'evidence'), cache = path.join(fixture, 'cache');
  fs.mkdirSync(path.join(cache, '_logs'), { recursive: true });
  fs.writeFileSync(path.join(cache, '_logs/fixture-debug-0.log'), `${'x'.repeat(100_000)}\nprivate npm failure marker\n`);
  const npm = path.join(fixture, 'npm-cli.mjs');
  fs.writeFileSync(npm, 'console.log("child stdout marker"); console.error("child stderr marker"); process.exit(42);\n');
  const { ok } = npmRunner(npm, { ...process.env, npm_config_cache: cache, HARNESS_CHECK_ARTIFACT_DIR: artifacts });
  assert.throws(() => ok(fixture, ['install', 'fixture.tgz']), error => {
    assert.match(error.message, /npm-cli\.mjs.*install.*fixture\.tgz/s);
    assert.match(error.message, /child stdout marker/);
    assert.match(error.message, /child stderr marker/);
    assert.match(error.message, /private npm failure marker/);
    return true;
  });
  fs.rmSync(fixture, { recursive: true, force: true });
  const receipt = JSON.parse(fs.readFileSync(path.join(artifacts, fs.readdirSync(artifacts)[0], 'npm-failure.json'), 'utf8'));
  assert.equal(receipt.exitCode, 42);
  assert.ok(receipt.elapsedMs >= 0);
  assert.equal(receipt.timeoutMs, 60_000);
  assert.ok(Buffer.byteLength(receipt.npmDebugLog.tail) <= 16_384);
  assert.match(receipt.npmDebugLog.tail, /private npm failure marker/);
});

test('standalone source and its offline-installed archive validate and pack without repository or global assets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-standalone-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(npm, 'npm CLI is required for the standalone package regression');
  const source = path.join(root, 'source');
  fs.cpSync(packageRoot, source, { recursive: true, filter: entry => path.basename(entry) !== 'node_modules' && !entry.endsWith('.tgz') });
  fs.mkdirSync(path.join(source, 'node_modules'));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  for (const dependency of manifest.bundledDependencies) {
    const destination = path.join(source, 'node_modules', dependency);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(packageRoot, 'node_modules', dependency), destination, { recursive: true });
  }
  const userconfig = path.join(root, 'npm-userconfig'), globalconfig = path.join(root, 'npm-globalconfig');
  fs.writeFileSync(userconfig, '');
  fs.writeFileSync(globalconfig, '');
  const toolBin = path.join(root, 'tool-bin');
  fs.mkdirSync(toolBin);
  // Nested lifecycle calls must use the selected CLI even when npm and Node
  // come from separate installations rather than an ambient global command.
  if (process.platform === 'win32') fs.writeFileSync(path.join(toolBin, 'npm.cmd'), `@echo off\r\n"${process.execPath.replace(/%/g, '%%')}" "${npm.replace(/%/g, '%%')}" %*\r\n`);
  else fs.writeFileSync(path.join(toolBin, 'npm'), `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(npm).href)}).catch(error => { console.error(error); process.exitCode = 1; });\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), COPILOT_HOME: path.join(root, 'copilot'),
    AE_HOME: path.join(root, 'control'), HARNESS_HOME: path.join(root, 'control'),
    PATH: [toolBin, path.dirname(process.execPath), process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/bin'].join(path.delimiter), npm_config_cache: path.join(root, 'cache'),
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_ignore_scripts: 'false', npm_config_update_notifier: 'false' };
  delete env.AE_BIN;
  delete env.HARNESS_BIN;
  delete env.NODE_TEST_CONTEXT;
  assert.ok(spawnSync('ae', ['--version'], { env }).error, 'the packaging proof must not use a global ae');
  const { run, ok } = npmRunner(npm, env);
  const archives = path.join(root, 'archives');
  fs.mkdirSync(archives);
  const [packed] = JSON.parse(ok(source, ['pack', '--json', '--pack-destination', archives]).stdout);
  assert.equal(packed.name, 'ae-harness');
  assert.ok(packed.files.some(file => file.path === 'scripts/check-release.mjs'));
  assert.ok(packed.files.some(file => file.path === 'lib/repo-map/vendor/tree-sitter-java/tree-sitter-java.wasm'));
  assert.equal(packed.files.some(file => file.path.endsWith('.node')), false, 'the archive must not ship native Node parser bindings');
  const prefix = path.join(root, 'installed path with spaces');
  ok(root, ['install', '--prefix', prefix, '--offline', '--ignore-scripts=false', '--omit=optional', '--no-audit', '--no-fund', path.join(archives, packed.filename)]);
  const installed = path.join(prefix, 'node_modules/ae-harness');
  assert.equal(fs.existsSync(path.join(installed, 'test')), false);
  assert.equal(fs.existsSync(path.join(installed, 'package-lock.json')), false);
  assert.ok(fs.existsSync(path.join(prefix, 'node_modules/.bin', process.platform === 'win32' ? 'ae.cmd' : 'ae')), 'archive installation must expose the ae command');
  assert.equal(ok(root, ['exec', '--prefix', prefix, '--offline', '--', 'ae', '--version']).stdout.trim(), packed.version);
  const proveAst = runtime => {
    const astProbe = `
    import assert from 'node:assert/strict';
    globalThis.fetch = () => { throw new Error('parser extraction must not fetch assets'); };
    const { createTreesitterExtract, packageGrammarRoots } = await import(${JSON.stringify(pathToFileURL(path.join(runtime, 'lib/repo-map/treesitter-extractor.mjs')).href)});
    const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
    assert.equal(extractor.tier, 'treesitter', JSON.stringify(extractor));
    assert.deepEqual(extractor.missingGrammars, []);
    const cases = [
      ['probe.js', 'export function jsFunction() {}', 'jsFunction'],
      ['probe.ts', 'export interface Item { id: string }; export function tsFunction(value: Item) { return value.id; }', 'tsFunction'],
      ['probe.tsx', 'export function Component() { return <span/>; }', 'Component'],
      ['probe.py', 'def py_function():\\n    return 1\\n', 'py_function'],
      ['Probe.java', 'public class Probe { public int javaMethod() { return 1; } }', 'javaMethod'],
    ];
    for (const [file, source, symbol] of cases) {
      const facts = extractor.extract(file, source);
      assert.equal(facts.tier, 'treesitter', file);
      assert.equal(Boolean(facts.hasErrors || facts.errors), false, file + ' must parse without errors');
      assert.ok(facts.symbols.includes(symbol), file + ': ' + JSON.stringify(facts));
    }
    console.log('installed-ast-five-languages');
  `;
    const parsed = spawnSync(process.execPath, ['--input-type=module', '-e', astProbe], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(parsed.error);
    assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
    assert.equal(parsed.stdout.trim(), 'installed-ast-five-languages');
  };
  proveAst(installed);
  const globalPrefix = path.join(root, 'global path with spaces');
  ok(root, ['install', '--global', '--prefix', globalPrefix, '--offline', '--ignore-scripts=false', '--omit=optional', '--no-audit', '--no-fund', path.join(archives, packed.filename)]);
  proveAst(path.join(globalPrefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'ae-harness'));
  ok(installed, ['run', 'prepack']);
  const repacked = path.join(root, 'repacked');
  fs.mkdirSync(repacked);
  ok(installed, ['pack', '--json', '--pack-destination', repacked]);
  const grammarPath = path.join(installed, 'lib/repo-map/vendor/tree-sitter-java/tree-sitter-java.wasm');
  const grammarBytes = fs.readFileSync(grammarPath);
  fs.writeFileSync(grammarPath, 'corrupt bundled parser');
  const corruptParser = run(installed, ['run', 'check:release']);
  assert.notEqual(corruptParser.status, 0, 'installed release validation must reject changed parser bytes');
  assert.match(corruptParser.stdout + corruptParser.stderr, /bundled parser integrity mismatch/);
  fs.writeFileSync(grammarPath, grammarBytes);

  const wasm = path.join(installed, 'node_modules/@d2lang/d2/dist/node-esm/d2.wasm');
  fs.renameSync(wasm, `${wasm}-missing`);
  try {
    const missingRenderer = run(installed, ['run', 'prepack']);
    assert.notEqual(missingRenderer.status, 0, 'prepack must reject a missing bundled renderer runtime');
    assert.match(missingRenderer.stdout + missingRenderer.stderr, /renderer.*asset|asset.*renderer/i);
  } finally { fs.renameSync(`${wasm}-missing`, wasm); }

  const lockPath = path.join(source, 'package-lock.json'), lockBytes = fs.readFileSync(lockPath);
  const lock = JSON.parse(lockBytes);
  lock.version = '0.0.0';
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  const drift = run(source, ['run', 'check:release']);
  assert.notEqual(drift.status, 0, 'standalone packaging must still reject lockfile version drift');
  assert.match(drift.stdout + drift.stderr, /lockfile.*version/i);
  fs.writeFileSync(lockPath, lockBytes);

  const manifestPath = path.join(source, 'package.json'), manifestBytes = fs.readFileSync(manifestPath);
  const invalidManifest = JSON.parse(manifestBytes);
  invalidManifest.bin = { harness: './bin/ae.mjs' };
  fs.writeFileSync(manifestPath, JSON.stringify(invalidManifest));
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
