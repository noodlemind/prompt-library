import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('diagram renderers are pinned and bundled in the AE distribution', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries({ pele: '1.8.0', '@d2lang/d2': '0.1.34', '@resvg/resvg-wasm': '2.6.2' })) {
    assert.equal(manifest.dependencies[name], version, `${name} must have a pinned version`);
    assert.ok(manifest.bundledDependencies.includes(name), `${name} must ship inside the archive`);
  }
});

test('offline local and global archives render both bundled backends from foreign directories and repack', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae diagram package '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(npm, 'npm CLI is required for the archive rendering proof');
  const toolBin = path.join(root, 'tool bin');
  fs.mkdirSync(toolBin);
  if (process.platform === 'win32') fs.writeFileSync(path.join(toolBin, 'npm.cmd'), `@echo off\r\n"${process.execPath.replace(/%/g, '%%')}" "${npm.replace(/%/g, '%%')}" %*\r\n`);
  else fs.writeFileSync(path.join(toolBin, 'npm'), `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(npm).href)}).catch(error => { console.error(error); process.exitCode = 1; });\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), COPILOT_HOME: path.join(root, 'copilot'),
    AE_HOME: path.join(root, 'control'), HARNESS_HOME: path.join(root, 'control'),
    PATH: [toolBin, path.dirname(process.execPath), process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/bin'].join(path.delimiter),
    npm_config_ignore_scripts: 'false', npm_config_update_notifier: 'false',
    npm_config_userconfig: path.join(root, 'npm-userconfig'), npm_config_globalconfig: path.join(root, 'npm-globalconfig') };
  fs.writeFileSync(env.npm_config_userconfig, '');
  fs.writeFileSync(env.npm_config_globalconfig, '');
  delete env.AE_BIN;
  delete env.HARNESS_BIN;
  delete env.NODE_TEST_CONTEXT;
  for (const command of ['ae', 'd2', 'pstack', 'tlc']) assert.ok(spawnSync(command, ['--version'], { env }).error, `${command} must not be supplied by the environment`);
  const run = (command, args, cwd, extraEnv = {}) => {
    const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const npmRun = (args, cwd, cache) => run(process.execPath, [npm, ...args], cwd, { npm_config_cache: cache });
  const archives = path.join(root, 'archives');
  fs.mkdirSync(archives);
  const [packed] = JSON.parse(npmRun(['pack', '--json', '--pack-destination', archives], packageRoot, path.join(root, 'pack cache')));
  assert.equal(packed.files.some(file => /\.jar$/i.test(file.path)), false, 'diagram archive must contain no Java JAR payload');
  const archive = path.join(archives, packed.filename);
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const originalHash = digest(archive);
  for (const global of [false, true]) {
    const mode = global ? 'global' : 'local', prefix = path.join(root, `${mode} installed prefix`), cache = path.join(root, `${mode} fresh cache`);
    const installation = ['install', ...(global ? ['--global'] : []), '--prefix', prefix, '--offline', '--ignore-scripts=false', '--omit=optional', '--no-audit', '--no-fund', archive];
    npmRun(installation, root, cache);
    const moduleRoot = global ? npmRun(['root', '--global', '--prefix', prefix], root, cache).trim() : path.join(prefix, 'node_modules');
    const installed = path.join(moduleRoot, 'ae-harness'), cli = path.join(installed, 'bin/ae.mjs');
    const command = path.join(global ? process.platform === 'win32' ? prefix : path.join(prefix, 'bin') : path.join(prefix, 'node_modules/.bin'), process.platform === 'win32' ? 'ae.cmd' : 'ae');
    assert.ok(fs.existsSync(command), `${mode} installation must expose ae`);
    assert.equal(fs.existsSync(path.join(installed, 'test')), false);
    assert.equal(fs.existsSync(path.join(installed, 'node_modules/tree-sitter-java')), false, 'optional grammars are omitted');
    for (const asset of ['THIRD-PARTY-NOTICES.md', 'node_modules/pele/LICENSE', 'node_modules/@d2lang/d2/LICENSE.txt', 'node_modules/@d2lang/d2/THIRD_PARTY_NOTICES.txt', 'node_modules/@d2lang/d2/dist/node-esm/d2.wasm', 'node_modules/@d2lang/d2/dist/node-esm/worker.js', 'node_modules/@resvg/resvg-wasm/index_bg.wasm', 'lib/diagrams/fonts/SourceSans3-Regular.ttf', 'lib/diagrams/fonts/LICENSE.md', 'lib/diagrams/formal.mjs', 'lib/diagrams/formal-protocol.mjs', 'lib/diagrams/formal-graph.mjs']) assert.ok(fs.existsSync(path.join(installed, asset)), `${mode} archive is missing ${asset}`);
    assert.equal(fs.existsSync(path.join(installed, 'lib/diagrams/vendor/pstack')), false, 'archive carries AE native implementation, not an upstream subsystem');
    assert.equal(run(process.execPath, [cli, '--version'], root).trim(), packed.version);
    const workspace = path.join(root, `${mode} fixture workspace`), foreign = path.join(root, `${mode} foreign working directory`);
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(workspace, 'src/input.mjs'), 'export const receive = () => "ready";\n');
    fs.writeFileSync(path.join(workspace, 'diagram.mmd'), 'flowchart LR\n  received[Received] --> processed[Processed]\n');
    fs.writeFileSync(path.join(workspace, 'diagram.d2'), 'direction: right\nreceived: Received\nprocessed: Processed\nreceived -> processed\n');
    for (const renderer of ['pele', 'd2']) {
      const result = JSON.parse(run(process.execPath, [cli, 'diagrams', 'render', '--file', renderer === 'pele' ? 'diagram.mmd' : 'diagram.d2', '--sources', 'src/input.mjs', '--renderer', renderer, ...(renderer === 'd2' ? ['--layout', 'tala'] : []), '--png', '--scale', '1', '--workspace', workspace, '--ae-home', path.join(root, `${mode} ae home`), '--json'], foreign));
      assert.equal(result.status, 'ok');
      assert.match(result.id, /^[a-f0-9]{64}$/);
      for (const [kind, filename] of Object.entries({ svg: 'diagram.svg', html: 'report.html', png: 'diagram.png', receipt: 'receipt.json' })) {
        assert.equal(result.artifacts[kind], `.harness/diagrams/${result.id}/${filename}`);
        assert.ok(fs.statSync(path.join(workspace, result.artifacts[kind])).size > 0);
      }
      const svg = fs.readFileSync(path.join(workspace, result.artifacts.svg), 'utf8');
      assert.match(svg, /<svg\b/);
      assert.match(svg, /Received/);
      assert.match(svg, /Processed/);
    }
    // Replay a saved upstream TLC trace through the installed CLI, with invalid
    // checker paths: drawing must never need to read or execute those tools.
    const formalStdout = fs.readFileSync(path.join(packageRoot, 'test/fixtures/formal-diagrams/pstack-counterjump.txt'), 'utf8');
    const formalEvidence = { schema: 1, feature: 'formal-verification', passed: true, status: 'passed',
      source: { files: [{ path: 'src/input.mjs', sha256: digest(path.join(workspace, 'src/input.mjs')) }] },
      verificationBindings: [{ path: '<copied-runner>', sha256: '0'.repeat(64) }],
      models: [{ module: 'CounterJump.tla', expected: 'safety-violation', property: 'NotThree', pass: true,
        execution: { status: 12, signal: null, error: null, stdout: formalStdout, stderr: '' } }] };
    fs.writeFileSync(path.join(workspace, 'formal-verification.json'), JSON.stringify(formalEvidence));
    const formal = JSON.parse(run(process.execPath, [cli, 'diagrams', 'formal', '--file', 'formal-verification.json', '--model', 'CounterJump.tla', '--workspace', workspace, '--json'], foreign,
      { AE_TLC_JAR: path.join(root, 'missing-tlc.jar'), AE_TLC_JAVA: path.join(root, 'missing-java') }));
    assert.equal(formal.kind, 'formal-trace');
    assert.equal(formal.verification, 'not-verified');
    const formalRecord = JSON.parse(fs.readFileSync(path.join(workspace, formal.artifacts.receipt), 'utf8'));
    assert.equal(formalRecord.projection.property, 'NotThree');
    assert.equal(formalRecord.projection.role, 'expected-negative-control');
    assert.match(fs.readFileSync(path.join(workspace, formal.artifacts.svg), 'utf8'), /Jump/);
    const dot = fs.readFileSync(path.join(packageRoot, 'test/fixtures/formal-diagrams/pstack-counter-graph.dot'), 'utf8');
    fs.writeFileSync(path.join(workspace, 'Counter.graph.dot'), dot);
    const frame = (code, body = '') => `@!@!@STARTMSG ${code}:0 @!@!@\n${body}\n@!@!@ENDMSG ${code} @!@!@\n`;
    // Saved graph and synthetic envelope exercise the installed import path;
    // this is protocol replay, not a fresh positive model-checking result.
    formalEvidence.models = [{ module: 'Counter.tla', expected: 'pass', pass: true,
      graph: { format: 'tlc-dot', file: 'Counter.graph.dot', sha256: digest(path.join(workspace, 'Counter.graph.dot')), exploration: 'complete' },
      execution: { status: 0, signal: null, error: null, stdout: frame(2193) + frame(2199, '4 states generated, 4 distinct states found, 0 states left on queue.') + frame(2186), stderr: '' } }];
    fs.writeFileSync(path.join(workspace, 'formal-verification.json'), JSON.stringify(formalEvidence));
    const explored = JSON.parse(run(process.execPath, [cli, 'diagrams', 'formal', '--file', 'formal-verification.json', '--model', 'Counter.tla', '--workspace', workspace, '--json'], foreign,
      { AE_TLC_JAR: path.join(root, 'missing-tlc.jar'), AE_TLC_JAVA: path.join(root, 'missing-java') }));
    assert.equal(explored.kind, 'formal-state-graph'); assert.equal(explored.verification, 'not-verified');
    const exploredRecord = JSON.parse(fs.readFileSync(path.join(workspace, explored.artifacts.receipt), 'utf8'));
    assert.equal(exploredRecord.projection.nodes.length, 4);
    assert.equal(exploredRecord.projection.coverage.exploration, 'complete');
    assert.match(fs.readFileSync(path.join(workspace, explored.artifacts.svg), 'utf8'), /Inc/);
    assert.match(fs.readFileSync(path.join(installed, 'THIRD-PARTY-NOTICES.md'), 'utf8'), /Lauren Tan/);
    npmRun(['run', 'prepack'], installed, cache);
    const repacked = path.join(root, `${mode} repacked`);
    fs.mkdirSync(repacked);
    const [again] = JSON.parse(npmRun(['pack', '--json', '--pack-destination', repacked], installed, cache));
    assert.equal(digest(path.join(repacked, again.filename)), originalHash, `${mode} installed repack must preserve the complete source archive`);
  }
});
