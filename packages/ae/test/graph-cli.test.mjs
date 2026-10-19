import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { harnessControlCommand } from '../corpus/hooks/lib/tool-payload.mjs';
import { beforeDeliveryTool } from '../lib/agent-delivery.mjs';
import { createTreesitterExtract, packageGrammarRoots } from '../lib/repo-map/treesitter-extractor.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });

function fixture(t, files = {}) {
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
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', workspace], { cwd: workspace, env, encoding: 'utf8', timeout: 10_000 });
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
  assert.equal(fs.existsSync(f.home), false, 'an uncached query publishes no index');
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
  assert.deepEqual(f.json('graph', 'deps', 'd.mjs').unresolved, [{ from: 'd.mjs', import: 'helper', reason: 'ambiguous' }]);
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
    assert.equal(f.cli('index', '--structural').status, 0);
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
