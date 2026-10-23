import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { harnessControlCommand } from '../corpus/hooks/lib/tool-payload.mjs';
import { beforeDeliveryTool } from '../lib/agent-delivery.mjs';
import { createTreesitterExtract, packageGrammarRoots } from '../lib/repo-map/treesitter-extractor.mjs';
import { prepareGraph } from '../lib/graph.mjs';
import { readStructuralIndex } from '../lib/repo-map/structural-index.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });

function fixture(t, files = {}, { timeout = 10000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-graph-cli-'));
  const workspace = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  const env = { ...process.env, HARNESS_HOME: home, HARNESS_NO_EVENTS: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(spawnSync('git', args, { cwd: workspace, env }).status, 0);
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), body);
  };
  const initial = {
    'a.mjs': "import { b } from './b.mjs';\nexport function a() { return b(); }\n",
    'b.mjs': "import { c } from './c.mjs';\nexport function b() { return c(); }\n",
    'c.mjs': 'export function c() { return 1; }\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(initial)) write(rel, body);
  for (const args of [['add', '.'], ['commit', '-qm', 'fixture']]) assert.equal(spawnSync('git', args, { cwd: workspace, env }).status, 0);
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', workspace], { cwd: workspace, env, encoding: 'utf8', timeout });
  const json = (...args) => {
    const result = cli(...args, '--json');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, home, write, cli, json };
}

test('deps, dependents and path produce bounded directed relationships in every output lane', (t) => {
  const f = fixture(t);
  const deps = f.json('graph', 'deps', 'a.mjs', '--depth', '2');
  assert.deepEqual(deps.edges.map(edge => [edge.from, edge.to]), [['a.mjs', 'b.mjs'], ['b.mjs', 'c.mjs']]);
  assert.equal(deps.coverage.complete, true);
  assert.deepEqual(f.json('graph', 'dependents', 'c.mjs', '--depth', '2').nodes.map(node => node.file), ['a.mjs', 'b.mjs', 'c.mjs']);
  assert.deepEqual(f.json('graph', 'path', 'a.mjs', 'c.mjs').path, ['a.mjs', 'b.mjs', 'c.mjs']);
  assert.equal(f.json('graph', 'path', 'c.mjs', 'a.mjs').outcome, 'not-found');
  const limited = f.json('graph', 'deps', 'a.mjs', '--depth', '2', '--limit', '1');
  assert.equal(limited.edges.length, 1);
  assert.equal(limited.omitted.edges, 1);
  for (const lane of ['json-envelope', 'agent']) {
    const result = f.cli('graph', 'path', 'a.mjs', 'c.mjs', '--output', lane);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /a\.mjs/);
    if (lane === 'json-envelope') assert.equal(JSON.parse(result.stdout).command, 'graph');
  }
  assert.equal(fs.existsSync(f.home), true, 'a cold CLI query prepares its parser-backed structural generation');
  assert.match(deps.generation, /^[a-f0-9]{32}$/);
});

test('dirty edits and removed files change live graph queries without rebuilding the index', (t) => {
  const f = fixture(t);
  assert.equal(f.cli('index', '--structural').status, 0);
  const before = f.json('graph', 'deps', 'a.mjs');
  assert.deepEqual(before.edges.map(edge => edge.to), ['b.mjs']);
  f.write('a.mjs', "import { c } from './c.mjs';\nexport function a() { return c(); }\n");
  const dirty = f.json('graph', 'deps', 'a.mjs');
  assert.deepEqual(dirty.edges.map(edge => edge.to), ['c.mjs']);
  assert.notEqual(dirty.snapshot, before.snapshot);
  assert.equal(dirty.cache.reused, 2);
  fs.unlinkSync(path.join(f.workspace, 'c.mjs'));
  const missing = f.json('graph', 'deps', 'a.mjs');
  assert.deepEqual(missing.edges, []);
  assert.equal(missing.coverage.complete, false);
  assert.equal(missing.unresolved[0].import, './c.mjs');
  assert.equal(f.json('graph', 'path', 'a.mjs', 'b.mjs').outcome, 'unknown');
  const orient = f.json('orient', '--read', '--file', 'a.mjs');
  assert.equal(orient.graph.commands.includes('ae graph deps'), true);
});

test('cycles terminate and ambiguous imports qualify negative path results', (t) => {
  const f = fixture(t, {
    'c.mjs': "import { a } from './a.mjs';\nexport function c() { return a(); }\n",
    'd.mjs': "import { helper } from 'helper';\n",
    'one/helper.mjs': 'export function helper() {}\n',
    'two/helper.mjs': 'export function helper() {}\n',
  });
  const cycle = f.json('graph', 'deps', 'a.mjs', '--depth', '8');
  assert.equal(cycle.edges.length, 3);
  assert.equal(cycle.nodes.length, 3);
  assert.equal(f.json('graph', 'path', 'd.mjs', 'one/helper.mjs').outcome, 'unknown');
  const unresolved = f.json('graph', 'deps', 'd.mjs').unresolved;
  assert.deepEqual(unresolved.map(({ from, import: specifier, reason }) => ({ from, import: specifier, reason })), [{ from: 'd.mjs', import: 'helper', reason: 'ambiguous' }]);
  assert.equal(unresolved[0].resolutionStatus, 'ambiguous');
  assert.deepEqual(unresolved[0].candidates, ['one/helper.mjs', 'two/helper.mjs']);
});

test('invalid queries fail at the boundary and graph commands are available to agents', (t) => {
  const f = fixture(t);
  for (const args of [['graph'], ['graph', 'unknown', 'a.mjs'], ['graph', 'path', 'a.mjs'], ['graph', 'deps', '../outside.mjs'], ['graph', 'deps', 'a.mjs', '--depth', '33'], ['graph', 'deps', 'a.mjs', '--limit', '201'], ['graph', 'deps', 'a.mjs', '--depth', '1x'], ['graph', 'deps', 'a.mjs', '--unrecognized']]) {
    assert.equal(f.cli(...args).status, 2, args.join(' '));
  }
  const argv = ['graph', 'deps', 'a.mjs'];
  assert.equal(harnessControlCommand(['harness', ...argv], f.workspace), 'graph');
  assert.equal(beforeDeliveryTool({ name: 'harness', input: { argv } }, { workspace: f.workspace }).pass, true);
});

test('explain and impact use source evidence while named generations stay historical in every lane', t => {
  const f = fixture(t);
  const explanation = f.json('graph', 'explain', 'a.mjs', 'c.mjs');
  assert.deepEqual(explanation.path, ['a.mjs', 'b.mjs', 'c.mjs']);
  assert.equal(explanation.explanation[0].evidence[0].path, 'a.mjs');
  assert.equal(explanation.explanation[0].evidence[0].range.startLine, 1);
  const impact = f.json('graph', 'impact', 'c.mjs', '--depth', '2');
  assert.deepEqual(impact.affected.map(row => row.file), ['b.mjs', 'a.mjs']);
  const generation = explanation.generation;
  f.write('a.mjs', "import { c } from './c.mjs';\n");
  for (const lane of ['ledger', 'json-envelope', 'agent']) {
    const args = ['graph', 'explain', 'a.mjs', 'c.mjs', '--generation', generation];
    const result = lane === 'ledger' ? f.cli(...args, '--json') : f.cli(...args, '--output', lane);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /b\.mjs/);
    assert.match(result.stdout, /historical/);
  }
  const invalid = f.cli('graph', 'deps', 'a.mjs', '--generation', '../outside', '--json');
  assert.equal(invalid.status, 2);
});

test('cold graph dry runs never publish an index in JSON or envelope output', t => {
  for (const lane of ['ledger', 'json-envelope']) {
    const f = fixture(t);
    const args = ['graph', 'deps', 'a.mjs', '--dry-run'];
    const result = lane === 'ledger' ? f.cli(...args, '--json') : f.cli(...args, '--output', lane);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.home), false, 'dry-run must not create a home or structural generation');
    assert.match(result.stdout, /"dryRun":true/);
    assert.doesNotMatch(result.stdout, /"prepared":true/);
    assert.match(result.stdout, /"extractorTier":"lexical"/);
  }
});

test('over-budget AST publication keeps small CLI queries available with labelled lexical evidence', t => {
  const body = Array.from({ length: 150 }, (_, i) => `export function f${i}() { return ${i}; }`).join('\n');
  const files = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`m${i}.mjs`, `${i === 0 ? "import './m1.mjs';\n" : ''}${body}\n`]));
  const f = fixture(t, files, { timeout: 60000 });
  const result = f.json('graph', 'deps', 'm0.mjs');
  assert.deepEqual(result.edges.map(edge => edge.to), ['m1.mjs']);
  assert.equal(result.preparation.degraded, true);
  assert.equal(result.preparation.refreshed, false);
  assert.equal(result.preparation.tier, 'lexical');
  assert.equal(result.preparation.reason.code, 'E_STRUCTURAL_PUBLISH');
  assert.match(result.preparation.reason.message, /bounded files\.json/);
  assert.equal(result.generation, null);
  assert.equal(result.producer.extractorTier, 'lexical');
  assert.deepEqual(result.producer.grammarVersions, {});
  assert.ok(result.edges.every(edge => edge.method === 'lexical'));
  assert.equal(readStructuralIndex(f.workspace, { home: f.home }), null);
  for (const lane of [[], ['--output', 'json-envelope']]) {
    const orient = f.json('orient', '--read', '--context-version', '2', '--question-kind', 'change-impact', '--file', 'm1.mjs', ...lane);
    const packet = orient.slice.impactContext;
    assert.equal(packet.preparation.degraded, true);
    assert.equal(packet.preparation.reason.code, 'E_STRUCTURAL_PUBLISH');
    assert.ok(packet.graphs.every(graph => graph.generation === null && graph.producer.extractorTier === 'lexical'));
  }
  const historical = f.cli('graph', 'deps', 'm0.mjs', '--generation', 'f'.repeat(32), '--json');
  assert.equal(historical.status, 1);
  assert.match(historical.stderr, /E_GRAPH_SNAPSHOT/);
});

test('an unborn HEAD keeps live CLI graph queries available with a preparation reason', t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.workspace, '.git', 'refs', 'heads'), { recursive: true });
  const result = f.json('graph', 'deps', 'a.mjs');
  assert.deepEqual(result.edges.map(edge => edge.to), ['b.mjs']);
  assert.equal(result.preparation.degraded, true);
  assert.match(result.preparation.reason.message, /HEAD|source state/);
  assert.equal(result.generation, null);
  const envelope = f.cli('graph', 'deps', 'a.mjs', '--output', 'json-envelope');
  assert.equal(envelope.status, 0, envelope.stderr);
  assert.match(envelope.stdout, /"degraded":true/);
  assert.match(envelope.stdout, /"code":"E_STRUCTURAL_SOURCE_STATE"/);
});

test('source mutation during parser preparation still fails closed', async t => {
  const f = fixture(t);
  const original = fs.statSync;
  let changed = false;
  fs.statSync = function (file, ...args) {
    const result = original.call(this, file, ...args);
    if (!changed && file === path.join(f.workspace, 'a.mjs')) {
      changed = true;
      f.write('a.mjs', "import './c.mjs';\n");
    }
    return result;
  };
  try {
    await assert.rejects(prepareGraph({ ...f, operation: 'deps', files: ['a.mjs'] }), { code: 'E_GRAPH_PREPARE' });
    assert.equal(changed, true);
  } finally { fs.statSync = original; }
});

test('long default imports, side effects and reexports agree before and after indexing', (t) => {
  const target = `${'nested/'.repeat(25)}target.mjs`;
  const f = fixture(t, {
    'a.mjs': `import target from './${target}';\nimport './b.mjs';\nexport * from './c.mjs';\n`,
    [target]: 'export default function target() {}\n',
  });
  const cold = f.json('graph', 'deps', 'a.mjs');
  assert.deepEqual(cold.edges.map(edge => edge.to).sort(), ['b.mjs', 'c.mjs', target].sort());
  assert.deepEqual(cold.unresolved, []);
  assert.equal(f.cli('index', '--structural').status, 0);
  const warm = f.json('graph', 'deps', 'a.mjs');
  assert.deepEqual(warm.edges, cold.edges);
  assert.deepEqual(warm.unresolved, []);
  assert.equal(warm.cache.refreshed, 0);
});

test('depth-limited paths qualify absence and never return partial routes', (t) => {
  const f = fixture(t);
  const limited = f.json('graph', 'path', 'a.mjs', 'c.mjs', '--depth', '1');
  assert.equal(limited.outcome, 'unknown');
  assert.equal(limited.path, null);
  assert.equal(limited.depthLimitReached, true);
  const truncated = f.json('graph', 'path', 'a.mjs', 'c.mjs', '--limit', '1');
  assert.equal(truncated.outcome, 'truncated');
  assert.equal(truncated.path, null);
  assert.deepEqual(truncated.edges, []);
});

for (const [extension, language] of [['mjs', 'javascript'], ['ts', 'typescript'], ['tsx', 'tsx']]) {
  test(`literal dynamic imports preserve CLI paths after ${language} indexing`, (t) => {
    if (!extractor.grammarVersions?.[language]) return t.skip('optional grammar not installed');
    const loader = `loader.${extension}`;
    const f = fixture(t, { [loader]: "export const load = () => import('./b.mjs');\n" });
    const cold = f.json('graph', 'path', loader, 'c.mjs');
    assert.deepEqual(cold.path, [loader, 'b.mjs', 'c.mjs']);
    const indexed = f.cli('index', '--structural');
    assert.equal(indexed.status, 0, indexed.stderr + indexed.stdout);
    const warm = f.json('graph', 'path', loader, 'c.mjs');
    assert.equal(warm.outcome, 'found');
    assert.deepEqual(warm.path, [loader, 'b.mjs', 'c.mjs']);
    assert.deepEqual(warm.edges, cold.edges);
    assert.equal(warm.nodes.find(node => node.file === loader).tier, 'treesitter');
    assert.equal(warm.cache.refreshed, 0);
  });
}

test('human graph output discloses traversal depth separately from source coverage', (t) => {
  const f = fixture(t);
  for (const args of [['deps', 'a.mjs'], ['dependents', 'c.mjs'], ['path', 'a.mjs', 'c.mjs']]) {
    const limited = f.json('graph', ...args, '--depth', '1');
    assert.equal(limited.depthLimitReached, true);
    assert.equal(limited.coverage.complete, true);
    assert.deepEqual(limited.omitted, { edges: 0, unresolved: 0 });
    const human = f.cli('graph', ...args, '--depth', '1');
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Traversal stopped at --depth 1; increase --depth/);
    assert.doesNotMatch(human.stdout, /incomplete coverage/);
    const expanded = f.cli('graph', ...args, '--depth', '2');
    assert.equal(expanded.status, 0, expanded.stderr);
    assert.doesNotMatch(expanded.stdout, /Traversal stopped/);
    assert.match(expanded.stdout, /a\.mjs/);
    assert.match(expanded.stdout, /c\.mjs/);
  }
});
