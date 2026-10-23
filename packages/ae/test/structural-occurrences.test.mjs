import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extract } from '../lib/repo-map/lexical-extractor.mjs';
import { lexicalV2, createTreesitterExtract } from '../lib/repo-map/treesitter-extractor.mjs';
import { readFileFacts } from '../lib/repo-map/facts.mjs';
import { buildImportGraph, importResolver, resolveImportBinding } from '../lib/repo-map/imports.mjs';
import { spawnSync } from 'node:child_process';
import { buildStructuralIndex, readStructuralIndex } from '../lib/repo-map/structural-index.mjs';

test('lexical imports ignore comments, quoted examples, template text and member import methods', () => {
  const source = [
    "// import { run } from './comment.mjs';",
    "/* export { run } from './block.mjs'; */",
    'const example = "import fake from \'./string.mjs\'";',
    "const template = `import fake from './template.mjs'`;",
    'const pattern = /import fake from ".\\/regex.mjs"/;',
    "const method = loader.import('./method.mjs');",
    "import { run as execute } from './real.mjs';",
    "const dynamic = import('./dynamic.mjs');",
  ].join('\n');
  const result = extract('src/main.mjs', source);
  assert.deepEqual(result.imports, ['./real.mjs', './dynamic.mjs']);
  assert.equal(result.importOccurrences.length, 2);
  assert.deepEqual(result.importOccurrences[0].bindings, [{ imported: 'run', local: 'execute', kind: 'named' }]);
  assert.deepEqual(result.importOccurrences[0].range, { startLine: 7, startColumn: 1, endLine: 7, endColumn: 44 });
  assert.equal(result.importOccurrences[0].method, 'lexical');
});

test('lexical Python imports ignore comments/docstrings and preserve separate alias bindings', () => {
  const result = extract('pkg/service.py', [
    '# import fake',
    '"""from ghost import Lost\nimport hidden\n"""',
    'from .billing import Charge as Payment, Refund',
    'import audit.log as journal, metrics',
  ].join('\n'));
  assert.deepEqual(result.imports, ['.billing', 'audit.log', 'metrics']);
  assert.deepEqual(result.importOccurrences[0].bindings, [
    { imported: 'Charge', local: 'Payment', kind: 'named' },
    { imported: 'Refund', local: 'Refund', kind: 'named' },
  ]);
});

test('lexical Java comments and text blocks cannot declare imports or exported symbols', () => {
  const result = extract('Service.java', [
    '/* import com.ghost.Fake; public class Ghost {} */',
    'String sample = """\nimport com.ghost.AlsoFake;\npublic class Hidden {}\n""";',
    'import static com.acme.Helper.run;',
    'public class Service {}',
  ].join('\n'));
  assert.deepEqual(result.imports, ['com.acme.Helper.run']);
  assert.ok(!result.symbols.includes('Ghost') && !result.symbols.includes('Hidden'));
  assert.deepEqual(result.importOccurrences[0].bindings, [{ imported: 'run', local: 'run', kind: 'static' }]);
});

test('explicit JS extension substitution resolves TypeScript sources conservatively', () => {
  const resolve = importResolver(new Set(['src/main.ts', 'src/util.ts', 'src/dual.ts', 'src/dual.tsx']));
  assert.deepEqual(resolve('src/main.ts', './util.js').targets, ['src/util.ts']);
  assert.equal(resolve('src/main.ts', './dual.js').reason, 'ambiguous');
  assert.deepEqual(resolve('src/main.ts', './dual.js').targets, []);
});

test('tracked tsconfig paths resolve aliases and retain configuration evidence', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-alias-config-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', workspace]).status, 0);
  fs.writeFileSync(path.join(workspace, 'tsconfig.json'), '{\n // aliases are repository input\n "compilerOptions": {"baseUrl":".","paths":{"@app/*":["src/*"],},},\n}');
  assert.equal(spawnSync('git', ['-C', workspace, 'add', 'tsconfig.json']).status, 0);
  const tracked = new Set(['src/main.ts', 'src/lib.ts']);
  const source = "import { run as execute } from '@app/lib';";
  const from = { ...lexicalV2('src/main.ts', source), hash: 'a'.repeat(64) };
  const result = buildImportGraph(new Map([['src/main.ts', from], ['src/lib.ts', { ...lexicalV2('src/lib.ts', 'export function run() {}'), hash: 'b'.repeat(64) }]]), tracked, { workspace });
  assert.equal(result.modules[0].to, 'src/lib.ts');
  assert.equal(result.modules[0].resolution, 'configured-path');
  assert.ok(result.modules[0].evidence.some(item => item.path === 'tsconfig.json' && /^[a-f0-9]{64}$/.test(item.sha256)));
  const binding = resolveImportBinding('src/main.ts', 'execute', from, tracked, { workspace });
  assert.deepEqual(binding.targets, ['src/lib.ts']);
  assert.equal(binding.bindings[0].imported, 'run');
});

test('untracked resolver configuration cannot silently change graph resolution', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-untracked-config-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', workspace]).status, 0);
  fs.writeFileSync(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@x': ['src/lib'] } } }));
  const resolve = importResolver(new Set(['src/main.ts', 'src/lib.ts']), { workspace });
  assert.deepEqual(resolve('src/main.ts', '@x').targets, []);
});

test('static Java method imports resolve their declaring class without global name matching', () => {
  const tracked = new Set(['src/Service.java', 'src/main/java/com/acme/Helper.java', 'src/main/java/com/other/Helper.java']);
  const fact = { ...lexicalV2('src/Service.java', 'import static com.acme.Helper.run;\npublic class Service {}'), hash: 'c'.repeat(64) };
  const match = resolveImportBinding('src/Service.java', 'run', fact, tracked);
  assert.deepEqual(match.targets, ['src/main/java/com/acme/Helper.java']);
  assert.equal(match.bindings[0].kind, 'static');
});

test('type-only imports remain source relationships without becoming runtime call bindings', () => {
  const fact = { ...lexicalV2('main.ts', "import type { Client } from './client';"), hash: 'd'.repeat(64) };
  assert.equal(fact.importOccurrences[0].bindings[0].kind, 'type');
  const match = resolveImportBinding('main.ts', 'Client', fact, new Set(['main.ts', 'client.ts']));
  assert.deepEqual(match.targets, []);
  assert.equal(match.reason, 'type-only-import');
});

test('module relationship merges all supporting import occurrences with source identities', () => {
  const source = "import { first } from './util.mjs';\nimport { second } from './util.mjs';\n";
  const from = { ...lexicalV2('src/main.mjs', source), hash: 'a'.repeat(64) };
  const facts = new Map([
    ['src/main.mjs', from],
    ['src/util.mjs', { ...lexicalV2('src/util.mjs', 'export function first() {}\nexport function second() {}'), hash: 'b'.repeat(64) }],
  ]);
  const result = buildImportGraph(facts, new Set(facts.keys()));
  assert.equal(result.modules.length, 1);
  const edge = result.modules[0];
  assert.equal(edge.method, 'lexical');
  assert.equal(edge.resolutionStatus, 'exact-under-rule');
  assert.equal(edge.evidence.length, 2);
  assert.equal(edge.evidence[0].sha256, from.hash);
  assert.equal(edge.evidence[0].range.startLine, 1);
  assert.equal(edge.evidence[1].range.startLine, 2);
});

test('file facts preserve occurrence metadata when reusing a hash-matching entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-occurrence-facts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.mjs'), "import { run } from './lib.mjs';\n");
  const first = readFileFacts(root, ['main.mjs'], { extract: lexicalV2 });
  const cachedFiles = { 'main.mjs': first.facts.get('main.mjs') };
  const second = readFileFacts(root, ['main.mjs'], { cachedFiles, extract: () => { throw Error('should reuse'); } });
  assert.equal(second.reused, 1);
  assert.equal(second.facts.get('main.mjs').importOccurrences.length, 1);
  assert.deepEqual(second.facts.get('main.mjs').importOccurrences, cachedFiles['main.mjs'].importOccurrences);
});

test('shipped AST extraction retains qualified owners, distinct overload identities and occurrence ranges', async () => {
  const extractor = await createTreesitterExtract();
  const result = extractor.extract('src/Service.java', [
    'import com.acme.Item;',
    'public class Service {',
    '  public void run(Item item) {}',
    '  public void run(String item) {}',
    '}',
  ].join('\n'));
  assert.equal(result.tier, 'treesitter');
  const methods = result.defs.filter(def => def.name === 'run');
  assert.equal(methods.length, 2);
  assert.equal(methods[0].owner, 'Service');
  assert.notEqual(methods[0].id, methods[1].id);
  assert.equal(methods[0].range.startLine, 3);
  assert.equal(result.importOccurrences[0].method, 'ast');
  assert.equal(result.importOccurrences[0].range.startLine, 1);
});

test('AST require calls shadowed by function parameters or local bindings are not module imports', async () => {
  const extractor = await createTreesitterExtract();
  const result = extractor.extract('src/loader.mjs', [
    "function load(require) { return require('./parameter-fake.mjs'); }",
    "function local() { const require = custom; return require('./local-fake.mjs'); }",
    "const arrow = require => require('./arrow-fake.mjs');",
    "const real = require('./real.mjs');",
  ].join('\n'));
  assert.equal(result.tier, 'treesitter');
  assert.deepEqual(result.imports, ['./real.mjs']);
});

test('AST CommonJS bindings belong to their own variable declarators', async () => {
  const extractor = await createTreesitterExtract();
  const result = extractor.extract('main.cjs', [
    "const a = require('./a.cjs'), b = require('./b.cjs');",
    "let { foo: first } = require('./first.cjs'), { foo: second } = require('./second.cjs');",
    "var member = require('./member.cjs').foo, wrapped = wrap(require('./wrapped.cjs'));",
  ].join('\n'));
  assert.equal(result.tier, 'treesitter');
  assert.deepEqual(result.importOccurrences.map(({ specifier, bindings }) => ({ specifier, bindings })), [
    { specifier: './a.cjs', bindings: [{ imported: '*', local: 'a', kind: 'namespace' }] },
    { specifier: './b.cjs', bindings: [{ imported: '*', local: 'b', kind: 'namespace' }] },
    { specifier: './first.cjs', bindings: [{ imported: 'foo', local: 'first', kind: 'named' }] },
    { specifier: './second.cjs', bindings: [{ imported: 'foo', local: 'second', kind: 'named' }] },
    { specifier: './member.cjs', bindings: [] },
    { specifier: './wrapped.cjs', bindings: [] },
  ]);
});

test('lexical CommonJS bindings abstain on ambiguous declarations and transformed values', () => {
  const result = extract('main.cjs', [
    "const a = require('./a.cjs'), b = require('./b.cjs');",
    "const single = require('./single.cjs');",
    "const { foo: named } = require('./named.cjs');",
    "const member = require('./member.cjs').foo;",
    "const wrapped = wrap(require('./wrapped.cjs'));",
  ].join('\n'));
  assert.deepEqual(result.importOccurrences.map(({ specifier, bindings }) => ({ specifier, bindings })), [
    { specifier: './a.cjs', bindings: [] },
    { specifier: './b.cjs', bindings: [] },
    { specifier: './single.cjs', bindings: [{ imported: '*', local: 'single', kind: 'namespace' }] },
    { specifier: './named.cjs', bindings: [{ imported: 'foo', local: 'named', kind: 'named' }] },
    { specifier: './member.cjs', bindings: [] },
    { specifier: './wrapped.cjs', bindings: [] },
  ]);
});

test('lexical ESM bindings use the matching declaration when imports share a line', () => {
  const fact = lexicalV2('main.mjs', "import { first } from './a.mjs'; import { second } from './b.mjs';");
  assert.deepEqual(fact.importOccurrences.map(row => [row.specifier, row.bindings.map(binding => binding.local)]), [['./a.mjs', ['first']], ['./b.mjs', ['second']]]);
});

test('AST imported call observations mark bindings shadowed in their lexical scopes', async () => {
  const extractor = await createTreesitterExtract();
  const result = extractor.extract('main.mjs', [
    "import { run as execute } from './run.mjs';",
    "import * as api from './api.mjs';",
    "const cjs = require('./cjs.cjs');",
    'function shadowed(execute) { execute(); }',
    'function clear() { execute(); }',
    'function namespace(api) { api.run(); }',
    'function local() { const execute = custom; execute(); }',
    'function cjsClear() { cjs.run(); }',
    'function cjsShadow(cjs) { cjs.run(); }',
  ].join('\n'));
  assert.equal(result.tier, 'treesitter');
  assert.deepEqual(result.refs.map(ref => [ref.owner, ref.importBinding]), [
    ['shadowed', 'shadowed'], ['clear', undefined], ['namespace', 'shadowed'],
    ['local', 'shadowed'], ['cjsClear', undefined], ['cjsShadow', 'shadowed'],
  ]);
});

test('AST JavaScript export metadata identifies only direct declaration surfaces', async () => {
  const extractor = await createTreesitterExtract();
  const result = extractor.extract('main.mjs', [
    'export function visible() { function nested() {} }',
    'export default function primary() {}',
    'export const arrow = () => {}, value = 1;',
    'export class Api { run() {} }',
    'export const object = { method() {} };',
    'function reexported() {}',
    'export { reexported };',
  ].join('\n'));
  assert.equal(result.tier, 'treesitter');
  assert.deepEqual(result.defs.map(def => [def.name, def.exportKind]), [
    ['visible', 'named'], ['nested', undefined], ['primary', 'default'],
    ['arrow', 'named'], ['value', 'named'], ['Api', 'named'], ['run', undefined],
    ['object', 'named'], ['method', undefined], ['reexported', undefined],
  ]);
});

test('AST structural index keeps CommonJS bindings on the matching modules', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-cjs-bindings-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-cjs-bindings-home-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  const git = args => spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  assert.equal(git(['init', '-q']).status, 0);
  fs.writeFileSync(path.join(workspace, 'main.cjs'), "const a = require('./a.cjs'), b = require('./b.cjs');\na.foo();\nb.foo();\n");
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(workspace, `${name}.cjs`), 'function foo() {}\nmodule.exports = { foo };\n');
  assert.equal(git(['add', '.']).status, 0);
  assert.equal(git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']).status, 0);
  const extractor = await createTreesitterExtract();
  const result = await buildStructuralIndex({ workspace, home, extractor });
  assert.equal(result.written, true);
  const index = readStructuralIndex(workspace, { home });
  const tracked = new Set(['main.cjs', 'a.cjs', 'b.cjs']);
  assert.deepEqual(resolveImportBinding('main.cjs', 'a', index.files['main.cjs'], tracked).targets, ['a.cjs']);
  assert.deepEqual(resolveImportBinding('main.cjs', 'b', index.files['main.cjs'], tracked).targets, ['b.cjs']);
  const calls = index.graph.calls.filter(call => call.from === 'main.cjs' && call.symbol === 'foo');
  assert.deepEqual(calls, [], 'unsupported CommonJS export surfaces cannot establish call candidates');
});

test('canonical tsconfig selection cannot be overridden by an unrelated same-directory variant', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-config-selection-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', workspace]).status, 0);
  fs.writeFileSync(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@app/*': ['src/real/*'] } }, include: ['src'] }));
  fs.writeFileSync(path.join(workspace, 'tsconfig.app.json'), JSON.stringify({ compilerOptions: { paths: { '@app/*': ['test/fake/*'] } }, include: ['test'] }));
  assert.equal(spawnSync('git', ['-C', workspace, 'add', '.']).status, 0);
  const tracked = new Set(['src/main.ts', 'src/real/lib.ts', 'test/fake/lib.ts']);
  const resolve = importResolver(tracked, { workspace });
  assert.deepEqual(resolve('src/main.ts', '@app/lib').targets, ['src/real/lib.ts']);
});

for (const localConfig of ['{"extends":"../base.json"}', '{not valid json']) {
  test(`unsupported nearest configuration blocks ancestor alias assumptions: ${localConfig}`, (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-config-barrier-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '-q', workspace]).status, 0);
    fs.mkdirSync(path.join(workspace, 'nested'));
    fs.writeFileSync(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@app/*': ['wrong/*'] } } }));
    fs.writeFileSync(path.join(workspace, 'nested/tsconfig.json'), localConfig);
    assert.equal(spawnSync('git', ['-C', workspace, 'add', '.']).status, 0);
    const resolve = importResolver(new Set(['nested/main.ts', 'wrong/lib.ts']), { workspace });
    const result = resolve('nested/main.ts', '@app/lib');
    assert.deepEqual(result.targets, []);
    assert.equal(result.reason, 'unsupported-configuration');
  });
}
