import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildStructuralIndex, readStructuralIndex } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2, createTreesitterExtract, packageGrammarRoots } from '../lib/repo-map/treesitter-extractor.mjs';
import { queryGraph } from '../lib/graph.mjs';
import { parseGraphArguments } from '../lib/graph-cmd.mjs';
import { readStructuralIndex as readShapeIndex } from '../lib/structural/shape.mjs';
import { captureWorkingSources } from '../lib/repo-map/working-sources.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-graph-evidence-'));
  const workspace = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (file, text) => fs.writeFileSync(path.join(workspace, file), text);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  write('a.mjs', "import { b } from './b.mjs';\nexport function a() { return b(); }\n");
  write('b.mjs', "import { c } from './c.mjs';\nexport function b() { return c(); }\n");
  write('c.mjs', 'export function c() { return 1; }\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { workspace, home, root, write, git, extractor: { tier: 'lexical', extract: lexicalV2 } };
}

test('explain preserves directed path evidence and impact is bounded reverse reachability', async t => {
  const f = fixture(t);
  await buildStructuralIndex(f);
  const explanation = queryGraph({ ...f, operation: 'explain', files: ['a.mjs', 'c.mjs'] });
  assert.deepEqual(explanation.path, ['a.mjs', 'b.mjs', 'c.mjs']);
  assert.equal(explanation.scope, 'git-tracked-source');
  assert.equal(explanation.coverage.semanticCompleteness, 'unverified');
  assert.equal(explanation.explanation.length, 2);
  assert.equal(explanation.explanation[0].authority, 'descriptive-context');
  const impact = queryGraph({ ...f, operation: 'impact', files: ['c.mjs'], depth: 2 });
  assert.deepEqual(impact.affected.map(row => [row.file, row.distance]), [['b.mjs', 1], ['a.mjs', 2]]);
  assert.equal(impact.authority, 'descriptive-context');
});

test('named generations query immutable facts without claiming current source', async t => {
  const f = fixture(t);
  const first = await buildStructuralIndex(f);
  f.write('a.mjs', "import { c } from './c.mjs';\n");
  await buildStructuralIndex(f);
  const historic = queryGraph({ ...f, operation: 'deps', files: ['a.mjs'], generation: first.meta.generation });
  assert.deepEqual(historic.edges.map(row => row.to), ['b.mjs']);
  assert.equal(historic.source, 'snapshot');
  assert.equal(historic.generation, first.meta.generation);
  assert.deepEqual(historic.freshness, { state: 'historical', liveValidated: false });
  f.write('a.mjs', 'unrelated changed bytes');
  assert.deepEqual(queryGraph({ ...f, operation: 'deps', files: ['a.mjs'], generation: first.meta.generation }), historic);
});

test('selected generation validates its own table hashes and never falls back to live bytes', async t => {
  const f = fixture(t);
  const first = await buildStructuralIndex(f);
  f.write('a.mjs', "import { c } from './c.mjs';\n");
  await buildStructuralIndex(f);
  fs.appendFileSync(path.join(first.dir, 'graph.json'), ' ');
  assert.throws(() => queryGraph({ ...f, operation: 'deps', files: ['a.mjs'], generation: first.meta.generation }), { code: 'E_GRAPH_SNAPSHOT' });
});

test('unavailable, retired and unsafe generation identifiers fail explicitly', async t => {
  const f = fixture(t);
  const first = await buildStructuralIndex(f);
  await buildStructuralIndex(f);
  await buildStructuralIndex(f);
  for (const generation of [first.meta.generation, 'f'.repeat(32)]) {
    assert.throws(() => queryGraph({ ...f, files: ['a.mjs'], generation }), { code: 'E_GRAPH_SNAPSHOT' });
  }
  for (const generation of ['../outside', '', 'A'.repeat(32)]) {
    assert.throws(() => queryGraph({ ...f, files: ['a.mjs'], generation }), { code: 'E_USAGE' });
  }
});

test('published graph adjacency has stable forward and reverse edge references', async t => {
  const f = fixture(t);
  await buildStructuralIndex(f);
  const index = readStructuralIndex(f.workspace, f);
  assert.equal(index.graph.adjacency.version, 1);
  assert.deepEqual(index.graph.adjacency.forward['a.mjs'], [0]);
  assert.deepEqual(index.graph.adjacency.reverse['c.mjs'], [1]);
  const result = queryGraph({ ...f, files: ['a.mjs'] });
  assert.equal(result.cache.adjacencyReused, true);
});

test('generation parser consumes its value separately from positional files', () => {
  const generation = 'a'.repeat(32);
  const parsed = parseGraphArguments(['explain', 'a.mjs', 'b.mjs', '--generation', generation]);
  assert.deepEqual(parsed.files, ['a.mjs', 'b.mjs']);
  assert.equal(parsed.generation, generation);
});

test('incremental graph output equals a clean rebuild after source and candidate inventory changes', async t => {
  const f = fixture(t);
  await buildStructuralIndex(f);
  f.write('a.mjs', "import { c } from './c.mjs';\n");
  f.write('d.mjs', "import { c } from './c.mjs';\n");
  f.git('add', 'd.mjs');
  const incremental = await buildStructuralIndex(f);
  const incrementalGraph = readStructuralIndex(f.workspace, f).graph;
  const cleanHome = path.join(f.root, 'clean-home');
  await buildStructuralIndex({ ...f, home: cleanHome });
  assert.deepEqual(readStructuralIndex(f.workspace, { home: cleanHome }).graph, incrementalGraph);
  assert.equal(incremental.reparsed, 2);
});

test('explicit bindings narrow same-name call candidates and keep call-site uncertainty', async t => {
  const f = fixture(t);
  f.write('a.mjs', "import { run } from './b.mjs';\nexport function a() { return run(); }\n");
  f.write('b.mjs', 'export function run() {}\n');
  f.write('c.mjs', 'export function run() {}\n');
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  await buildStructuralIndex({ ...f, extractor });
  const index = readStructuralIndex(f.workspace, f);
  const candidate = index.graph.calls.find(row => row.from === 'a.mjs' && row.symbol === 'run');
  assert.deepEqual(candidate.to, ['b.mjs']);
  assert.equal(candidate.relation, 'call-candidate');
  assert.equal(candidate.resolutionStatus, 'candidate');
  assert.equal(candidate.reason, 'explicit-import-binding');
  assert.equal(candidate.evidence[0].path, 'a.mjs');
  const explanation = queryGraph({ ...f, operation: 'explain', files: ['a.mjs', 'b.mjs'] });
  assert.equal(explanation.explanation[0].evidence[0].range.startLine, 1);
  assert.equal(explanation.explanation[0].evidence[0].sha256, index.files['a.mjs'].hash);
  const normalized = readShapeIndex(f.workspace, f).graph.calls.find(row => row.from === 'a.mjs#run');
  assert.equal(normalized.relation, 'call-candidate');
  assert.equal(normalized.resolutionStatus, 'candidate');
  assert.equal(normalized.evidence[0].path, 'a.mjs');
});

test('configuration-only alias changes invalidate graph snapshot identity', async t => {
  const f = fixture(t);
  f.write('alias.ts', "import { run } from '@target';\n");
  f.write('left.ts', 'export function run() {}\n');
  f.write('right.ts', 'export function run() {}\n');
  f.write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@target': ['./left.ts'] } } }));
  f.git('add', '.');
  await buildStructuralIndex(f);
  const before = queryGraph({ ...f, files: ['alias.ts'] });
  f.write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@target': ['./right.ts'] } } }));
  await buildStructuralIndex(f);
  const after = queryGraph({ ...f, files: ['alias.ts'] });
  assert.deepEqual(before.edges.map(edge => edge.to), ['left.ts']);
  assert.deepEqual(after.edges.map(edge => edge.to), ['right.ts']);
  assert.notEqual(after.snapshot, before.snapshot);
});

for (const lexicalFallback of [false, true]) {
  for (const unborn of [false, true]) {
    test(`live graph rejects a configuration race without a cache (fallback=${lexicalFallback}, unborn=${unborn})`, t => {
      const f = fixture(t);
      f.write('alias.ts', "import { run } from '@target';\n");
      f.write('left.ts', 'export function run() {}\n');
      f.write('right.ts', 'export function run() {}\n');
      const config = target => JSON.stringify({ compilerOptions: { paths: { '@target': [`./${target}.ts`] } } });
      f.write('tsconfig.json', config('left'));
      f.git('add', '.');
      if (unborn) {
        fs.rmSync(path.join(f.workspace, '.git', 'refs', 'heads'), { recursive: true });
        assert.equal(captureWorkingSources(f.workspace).valid, false, 'index publication still requires HEAD');
        const live = queryGraph({ ...f, files: ['alias.ts'], lexicalFallback });
        assert.deepEqual(live.edges.map(edge => edge.to), ['left.ts']);
        assert.deepEqual(live.freshness, { state: 'current', liveValidated: true });
      }
      const configPath = path.resolve(f.workspace, 'tsconfig.json');
      const configFds = new Set();
      const sameConfig = file => {
        if (typeof file !== 'string') return false;
        const opened = path.resolve(file);
        return process.platform === 'win32' ? opened.toLowerCase() === configPath.toLowerCase() : opened === configPath;
      };
      const originalOpen = fs.openSync;
      const originalClose = fs.closeSync;
      const originalRead = fs.readSync;
      let changed = false;
      fs.openSync = function (file, ...args) {
        const fd = originalOpen.call(this, file, ...args);
        if (sameConfig(file)) configFds.add(fd);
        return fd;
      };
      fs.closeSync = function (fd) {
        configFds.delete(fd);
        return originalClose.call(this, fd);
      };
      const priorConfig = Buffer.from(config('left'));
      fs.readSync = function (fd, buffer, ...args) {
        const read = originalRead.call(this, fd, buffer, ...args);
        const sawConfig = configFds.has(fd)
          || (Buffer.isBuffer(buffer) && buffer.subarray(0, typeof read === 'number' ? read : buffer.length).includes(priorConfig));
        if (!changed && sawConfig) {
          changed = true;
          f.write('tsconfig.json', config('right'));
        }
        return read;
      };
      let result;
      try { result = queryGraph({ ...f, files: ['alias.ts'], lexicalFallback }); }
      finally {
        fs.openSync = originalOpen;
        fs.closeSync = originalClose;
        fs.readSync = originalRead;
      }
      assert.equal(changed, true);
      assert.equal(result.coverage.sourceChanged, true);
      assert.equal(result.outcome, 'unknown');
      assert.deepEqual(result.freshness, { state: 'unknown', liveValidated: false });
      assert.deepEqual(result.edges, []);
    });
  }
}

test('type-only bindings never become same-name global call candidates', async t => {
  const f = fixture(t);
  f.write('a.ts', "import type { run } from './b.ts';\n");
  f.write('b.ts', 'export function run() {}\n');
  f.git('add', '.');
  await buildStructuralIndex(f);
  const index = readStructuralIndex(f.workspace, f);
  assert.deepEqual(index.graph.calls.filter(row => row.from === 'a.ts'), []);
  assert.ok(index.graph.unresolvedCalls.some(row => row.from === 'a.ts' && row.reason === 'type-only-import'));
});

test('renamed imports retain the actual target declaration identity in normalized candidates', async t => {
  const f = fixture(t);
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  assert.ok(extractor.available.includes('javascript'), 'the shipped JavaScript grammar is available');
  f.write('a.mjs', "import { run as execute } from './b.mjs';\nexport function a() { return execute(); }\n");
  f.write('b.mjs', 'export function run() {}\n');
  await buildStructuralIndex({ ...f, extractor });
  const index = readStructuralIndex(f.workspace, f);
  const candidate = index.graph.calls.find(row => row.from === 'a.mjs' && row.symbol === 'execute');
  assert.equal(candidate.candidates[0].name, 'run');
  assert.match(candidate.candidates[0].id, /^b\.mjs#run@/);
  const normalized = readShapeIndex(f.workspace, f).graph.calls.find(row => row.from === 'a.mjs#execute');
  assert.equal(normalized.to, 'b.mjs#run');
  assert.equal(normalized.candidates[0].name, 'run');
});

test('AST call candidates require an unshadowed import and a supported direct named export', async t => {
  const f = fixture(t);
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  f.write('a.mjs', "import { execute, hidden, step, DefaultName } from './b.mjs';\nimport * as api from './b.mjs';\nexport function shadow(execute) { execute(); }\nexport function live() { execute(); hidden(); step(); DefaultName(); api.execute(); }\n");
  f.write('b.mjs', 'export function execute() {}\nfunction hidden() {}\nexport class Controller { step() {} }\nexport default function DefaultName() {}\n');
  await buildStructuralIndex({ ...f, extractor });
  const index = readStructuralIndex(f.workspace, f);
  const calls = index.graph.calls.filter(row => row.from === 'a.mjs');
  assert.equal(calls.filter(row => row.symbol === 'execute').length, 2);
  assert.ok(calls.every(row => row.evidence[0].range.startLine === 4));
  assert.equal(calls.some(row => ['hidden', 'step', 'DefaultName'].includes(row.symbol)), false);
  const unresolved = index.graph.unresolvedCalls.filter(row => row.from === 'a.mjs');
  assert.ok(unresolved.some(row => row.symbol === 'execute' && row.reason === 'shadowed-import-binding'));
  for (const name of ['hidden', 'step', 'DefaultName']) assert.ok(unresolved.some(row => row.symbol === name && row.reason === 'unsupported-export-binding'));
});

test('imported object members cannot bind unrelated module exports while namespaces retain candidates', async t => {
  const f = fixture(t);
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  f.write('a.mjs', "import { client } from './b.mjs';\nexport function run() { client.close(); }\n");
  f.write('b.mjs', 'export const client = { close() {} };\nexport function close() {}\n');
  f.write('namespace.mjs', "import * as api from './b.mjs';\nexport function run() { api.close(); }\n");
  f.write('require.cjs', "const api = require('./b.mjs');\nexports.run = function () { api.close(); };\n");
  f.write('destructured.cjs', "const { client } = require('./b.mjs');\nexports.run = function () { client.close(); };\n");
  f.write('default.mjs', "import client from './b.mjs';\nexport function run() { client.close(); }\n");
  f.write('py_object.py', 'from py_api import client\ndef run():\n    client.close()\n');
  f.write('py_module.py', 'import py_api as api\ndef run():\n    api.close()\n');
  f.write('py_api.py', 'client = object()\ndef close():\n    pass\n');
  f.git('add', '.');
  await buildStructuralIndex({ ...f, extractor });
  const index = readStructuralIndex(f.workspace, f);
  for (const file of ['a.mjs', 'destructured.cjs', 'default.mjs', 'py_object.py']) {
    assert.deepEqual(index.graph.calls.filter(row => row.from === file && row.symbol === 'close'), [], file);
    assert.ok(index.graph.unresolvedCalls.some(row => row.from === file && row.symbol === 'close' && row.reason === 'unsupported-receiver-binding'), file);
  }
  for (const file of ['namespace.mjs', 'require.cjs']) {
    const call = index.graph.calls.find(row => row.from === file && row.symbol === 'close');
    assert.deepEqual(call?.to, ['b.mjs'], file);
    assert.equal(call.reason, 'explicit-import-binding', file);
    assert.equal(call.candidates[0].name, 'close', file);
  }
  assert.deepEqual(index.graph.calls.find(row => row.from === 'py_module.py' && row.symbol === 'close')?.to, ['py_api.py']);
});

test('unaliased dotted Python imports do not bind root-package calls to the submodule', async t => {
  const f = fixture(t);
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  fs.mkdirSync(path.join(f.workspace, 'pkg'));
  f.write('pkg/__init__.py', 'def close():\n    return "root"\n');
  f.write('pkg/api.py', 'def close():\n    return "api"\n');
  const cases = [
    ['dotted.py', 'import pkg.api\ndef run():\n    pkg.close()\n', 'module-root', null],
    ['aliased.py', 'import pkg.api as api\ndef run():\n    api.close()\n', 'module', 'pkg/api.py'],
    ['root_alias.py', 'import pkg.api as pkg\ndef run():\n    pkg.close()\n', 'module', 'pkg/api.py'],
    ['simple.py', 'import pkg\ndef run():\n    pkg.close()\n', 'module', 'pkg/__init__.py'],
  ];
  for (const [file, source] of cases) f.write(file, source);
  f.git('add', '.');
  await buildStructuralIndex({ ...f, extractor });
  const index = readStructuralIndex(f.workspace, f);
  for (const [file, source, kind, target] of cases) {
    const calls = index.graph.calls.filter(row => row.from === file && row.symbol === 'close');
    if (target) assert.deepEqual(calls.map(row => row.to), [[target]], file);
    else {
      assert.deepEqual(calls, [], file);
      assert.ok(index.graph.unresolvedCalls.some(row => row.from === file && row.symbol === 'close' && row.reason === 'unsupported-receiver-binding'), file);
    }
    assert.equal(index.files[file].importOccurrences[0].bindings[0].kind, kind, file);
    assert.equal(lexicalV2(file, source).importOccurrences[0].bindings[0].kind, kind, file);
  }
  assert.ok(index.graph.modules.some(edge => edge.from === 'dotted.py' && edge.to === 'pkg/api.py'));
});

test('a shadowed call cannot suppress a later imported call in the same function', async t => {
  const f = fixture(t);
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  f.write('a.mjs', "import { execute } from './b.mjs';\nexport function run() { try {} catch (execute) { execute(); } return execute(); }\n");
  f.write('b.mjs', 'export function execute() {}\n');
  await buildStructuralIndex({ ...f, extractor });
  const index = readStructuralIndex(f.workspace, f);
  const calls = index.graph.calls.filter(row => row.from === 'a.mjs' && row.symbol === 'execute');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].to, ['b.mjs']);
  assert.ok(index.graph.unresolvedCalls.some(row => row.from === 'a.mjs' && row.reason === 'shadowed-import-binding'));
  assert.ok(calls[0].evidence[0].range.startColumn > index.graph.unresolvedCalls.find(row => row.from === 'a.mjs' && row.reason === 'shadowed-import-binding').evidence[0].range.startColumn);
});

test('lexical named-import references retain approximate provenance and exclude private definitions', async t => {
  const f = fixture(t);
  f.write('a.mjs', "import { visible as alias, hidden as secret, named, nested } from './b.ts';\nimport fallback from './fallback.mjs';\n");
  f.write('b.ts', 'export function visible() {}\nfunction hidden() {}\nexport default function named() {}\nexport namespace Api { export function nested() {} }\n');
  f.write('c.mjs', 'export function visible() {}\nexport function fallback() {}\n');
  f.write('fallback.mjs', 'export default function actual() {}\n');
  f.git('add', '.');
  await buildStructuralIndex(f);
  const index = readStructuralIndex(f.workspace, f);
  const references = index.graph.calls.filter(row => row.from === 'a.mjs');
  assert.equal(references.length, 1);
  assert.equal(references[0].symbol, 'visible');
  assert.deepEqual(references[0].to, ['b.ts']);
  assert.equal(references[0].method, 'lexical');
  assert.equal(references[0].observation, 'imported-name-reference');
  assert.equal(references[0].reason, 'imported-name-reference');
  assert.equal(references[0].candidates[0].name, 'visible');
  for (const name of ['hidden', 'named', 'nested']) assert.ok(index.graph.unresolvedCalls.some(row => row.from === 'a.mjs' && row.symbol === name && row.reason === 'unsupported-export-binding'));
  assert.ok(index.graph.unresolvedCalls.some(row => row.from === 'a.mjs' && row.symbol === 'fallback' && row.reason === 'unsupported-import-binding'));
});
