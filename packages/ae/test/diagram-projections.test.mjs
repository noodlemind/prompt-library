import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectGraph, projectFlow } from '../lib/diagrams/projections.mjs';

const digest = 'a'.repeat(64), commit = 'b'.repeat(40);
function graph() {
  return {
    source: 'worktree', relation: 'observed-module-imports', snapshot: digest,
    operation: 'dependents', roots: ['src/b.mjs'], depth: 2, limit: 50,
    outcome: 'found', path: null, depthLimitReached: true,
    coverage: { complete: false, heuristicEdges: 1, unreadable: 0 },
    nodes: [{ file: 'src/b.mjs', tier: 'lexical', hash: digest, errors: null }, { file: 'src/a.mjs', tier: 'tree-sitter', hash: 'c'.repeat(64), errors: null }],
    edges: [{ from: 'src/a.mjs', to: 'src/b.mjs', via: './b.mjs', resolution: 'unique-local', viaTruncated: false }],
    unresolved: [{ from: 'src/b.mjs', import: 'missing', reason: 'ambiguous' }],
    omitted: { edges: 2, unresolved: 3 },
  };
}
function model() {
  return {
    state: 'current', scope: 'committed-default-branch', authority: 'descriptive-context',
    generationCommit: commit, defaultCommit: commit, sha256: digest,
    preparation: { version: 1, digest, generationCommit: commit, defaultBranch: { name: 'main', ref: 'refs/remotes/origin/main', source: 'origin-head' }, watchPaths: ['src'], sources: [{ path: 'src/app.mjs', mode: '100644', sha256: digest }] },
    model: { version: 1, format: 'statechart', assumptions: ['A queued item is durable.'], limitations: ['External services are abstracted.'], flows: [{
      id: 'checkout', title: 'Checkout', sources: ['src/app.mjs'], initial: 'idle',
      states: [{ id: 'idle' }, { id: 'active' }, { id: 'done', kind: 'terminal' }],
      transitions: [{ from: 'idle', to: 'active', event: 'start', guard: 'ready && count > 0' }, { from: 'active', to: 'done', event: 'finish' }],
      properties: ['Only active items finish.'],
    }] },
  };
}

test('module import projection preserves direction, extraction provenance and incomplete coverage', () => {
  const input = graph(), before = structuredClone(input), result = projectGraph(input);
  assert.match(result.source, /^flowchart TB\n/);
  assert.match(result.source, /n0 -->\|imports #40;unique#45;local#41;\| n1/);
  assert.equal(result.metadata.scope, 'worktree');
  assert.equal(result.metadata.relation, 'observed-module-imports');
  assert.equal(result.metadata.snapshot, digest);
  assert.deepEqual(result.metadata.coverage, input.coverage);
  assert.deepEqual(result.metadata.omitted, input.omitted);
  assert.deepEqual(result.metadata.unresolved, input.unresolved);
  assert.equal(result.metadata.nodes[0].hash, input.nodes[1].hash);
  assert.equal(result.metadata.nodes[0].origin, 'extracted');
  assert.equal(result.metadata.edges[0].resolution, 'unique-local');
  assert.equal(result.metadata.depthLimitReached, true);
  assert.match(result.source, /Module imports/);
  assert.match(result.source, /traversal depth limit reached/);
  assert.match(result.metadata.semantics, /not runtime calls or proof/);
  assert.deepEqual(input, before);
});

test('module projection is deterministic when extractor arrays have different orders', () => {
  const first = graph(), second = structuredClone(first);
  second.nodes.reverse(); second.edges.reverse();
  assert.deepEqual(projectGraph(first), projectGraph(second));
});

test('module projection retains the producing generation, freshness and parser provenance', () => {
  const input = graph();
  input.generation = 'd'.repeat(32);
  input.freshness = { state: 'current', liveValidated: true };
  input.producer = {
    resolverVersion: 2, fileFactsVersion: 4, extractorTier: 'treesitter',
    grammarVersions: { javascript: 'verified-grammar' }, integrityFailures: [], missingGrammars: [],
  };
  input.edges[0].method = 'ast';
  input.edges[0].resolutionStatus = 'candidate';
  input.edges[0].evidence = [{ path: 'src/a.mjs', sha256: digest, range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 24 } }];
  const result = projectGraph(input);
  assert.equal(result.metadata.generation, input.generation);
  assert.deepEqual(result.metadata.freshness, input.freshness);
  assert.deepEqual(result.metadata.producer, input.producer);
  assert.equal(result.metadata.edges[0].method, 'ast');
  assert.equal(result.metadata.edges[0].resolutionStatus, 'candidate');
  assert.deepEqual(result.metadata.edges[0].evidence, input.edges[0].evidence);
  result.metadata.producer.grammarVersions.javascript = 'changed';
  assert.equal(input.producer.grammarVersions.javascript, 'verified-grammar', 'receipt metadata must not alias query results');
});

test('bounded import views keep roots and count every hidden node and edge separately from upstream omissions', () => {
  const input = graph();
  input.roots = ['n59.mjs'];
  input.nodes = Array.from({ length: 60 }, (_, i) => ({ file: `n${String(i).padStart(2, '0')}.mjs`, tier: 'lexical', hash: digest }));
  input.edges = input.nodes.slice(1).map((node, i) => ({ from: input.nodes[i].file, to: node.file, via: `./${node.file}`, resolution: 'relative' }));
  const result = projectGraph(input, { maxNodes: 3, maxEdges: 1 });
  assert.ok(result.metadata.nodes.some(node => node.file === 'n59.mjs'));
  assert.deepEqual(result.metadata.view, { maxNodes: 3, maxEdges: 1, omittedNodes: 58, omittedEdges: 58, complete: false });
  assert.deepEqual(result.metadata.edges.map(edge => [edge.from, edge.to]), [['n58.mjs', 'n59.mjs']]);
  assert.deepEqual(result.metadata.nodes.map(node => node.file), ['n58.mjs', 'n59.mjs']);
  assert.deepEqual(result.metadata.omitted, { edges: 2, unresolved: 3 });
  assert.match(result.source, /58 nodes and 58 edges omitted from view/);
});

test('clipped import views retain root dependencies before alphabetically earlier grandchildren', () => {
  const input = graph();
  input.operation = 'deps'; input.roots = ['lib/diagram-cmd.mjs'];
  input.nodes = ['lib/diagram-cmd.mjs', 'lib/flags.mjs', 'lib/flow-model.mjs', 'lib/graph.mjs', 'lib/paths.mjs', 'lib/a-runtime-identity.mjs'].map(file => ({ file, tier: 'lexical', hash: digest }));
  input.edges = ['lib/flags.mjs', 'lib/flow-model.mjs', 'lib/graph.mjs', 'lib/paths.mjs'].map(to => ({ from: 'lib/diagram-cmd.mjs', to, via: `./${to}`, resolution: 'relative' }));
  input.edges.push({ from: 'lib/paths.mjs', to: 'lib/a-runtime-identity.mjs', via: './a-runtime-identity.mjs', resolution: 'relative' });
  const result = projectGraph(input, { maxNodes: 4 });
  assert.deepEqual(result.metadata.nodes.map(node => node.file), ['lib/diagram-cmd.mjs', 'lib/flags.mjs', 'lib/flow-model.mjs', 'lib/graph.mjs']);
  assert.equal(result.metadata.edges.length, 3);
  assert.equal(result.metadata.view.omittedNodes, 2);
  assert.equal(result.metadata.view.omittedEdges, 2);
  assert.ok(result.metadata.edges.every(edge => edge.from === input.roots[0]));
  const reordered = structuredClone(input); reordered.nodes.reverse(); reordered.edges.reverse();
  assert.deepEqual(projectGraph(reordered, { maxNodes: 4 }), result);
});

test('clipped dependent views traverse incoming imports while preserving their actual direction', () => {
  const input = graph();
  input.operation = 'dependents'; input.roots = ['lib/sink.mjs'];
  input.nodes = ['lib/sink.mjs', 'lib/a-first.mjs', 'lib/m-parent.mjs', 'lib/0-ancestor.mjs'].map(file => ({ file, tier: 'lexical', hash: digest }));
  input.edges = [
    { from: 'lib/a-first.mjs', to: 'lib/sink.mjs', via: './sink.mjs', resolution: 'relative' },
    { from: 'lib/m-parent.mjs', to: 'lib/sink.mjs', via: './sink.mjs', resolution: 'relative' },
    { from: 'lib/0-ancestor.mjs', to: 'lib/m-parent.mjs', via: './m-parent.mjs', resolution: 'relative' },
  ];
  const result = projectGraph(input, { maxNodes: 3 });
  assert.deepEqual(result.metadata.nodes.map(node => node.file), ['lib/a-first.mjs', 'lib/m-parent.mjs', 'lib/sink.mjs']);
  assert.deepEqual(result.metadata.edges.map(edge => [edge.from, edge.to]), [['lib/a-first.mjs', 'lib/sink.mjs'], ['lib/m-parent.mjs', 'lib/sink.mjs']]);
  assert.equal(result.metadata.view.omittedNodes, 1);
  assert.equal(result.metadata.view.omittedEdges, 1);
});

test('unknown graph results do not fabricate module nodes from requested roots', () => {
  const input = { ...graph(), outcome: 'unknown', nodes: [], edges: [] };
  const result = projectGraph(input);
  assert.deepEqual(result.metadata.nodes, []);
  assert.match(result.source, /outcome unknown/);
  assert.match(result.source, /No extracted module nodes available/);
});

test('hostile filenames and event text remain data without Mermaid statements or directives', () => {
  const input = graph(), hostile = 'evil\"]\nclick n0 "javascript:alert(1)"\n%%{init: {securityLevel: "loose"}}%%<script>&`';
  input.nodes[0].file = hostile; input.roots = [hostile]; input.edges[0].to = hostile;
  const projected = projectGraph(input);
  assert.ok(projected.metadata.nodes.some(node => node.file === hostile));
  assert.doesNotMatch(projected.source, /javascript:|<script>|%%\{|^click /m);
  assert.match(projected.source, /#34;/);
  assert.match(projected.source, /#10;/);
  const flow = model(); flow.model.flows[0].transitions[0].event = hostile;
  const result = projectFlow(flow, 'checkout');
  assert.doesNotMatch(result.source, /javascript:|<script>|%%\{|^click /m);
  assert.equal(result.metadata.transitions.find(item => item.from === 'idle').event, hostile);
});

test('flow projection preserves authored states, guards, properties and committed source bindings', () => {
  const input = model(), before = structuredClone(input), result = projectFlow(input, 'checkout');
  assert.match(result.source, /^stateDiagram-v2\n/);
  assert.match(result.source, /\[\*\] --> s2/);
  assert.match(result.source, /start #91;ready #38;#38; count #62; 0#93;/);
  assert.equal(result.metadata.scope, 'committed-default-branch');
  assert.equal(result.metadata.authority, 'descriptive-context');
  assert.equal(result.metadata.generationCommit, commit);
  assert.deepEqual(result.metadata.preparation, input.preparation);
  assert.equal(result.metadata.nodes.find(item => item.id === 'done').kind, 'terminal');
  assert.equal(result.metadata.nodes[0].origin, 'authored');
  assert.deepEqual(result.metadata.assumptions, input.model.assumptions);
  assert.deepEqual(result.metadata.limitations, input.model.limitations);
  assert.deepEqual(result.metadata.properties, input.model.flows[0].properties);
  assert.equal(result.metadata.transitions.find(item => item.from === 'idle').guard, 'ready && count > 0');
  assert.doesNotMatch(result.source, /--> \[\*\]/);
  assert.match(result.metadata.semantics, /not verification or proof/);
  assert.deepEqual(input, before);
});

test('stale flow projections remain visibly stale and preserve the explanation', () => {
  const input = { ...model(), state: 'stale', reason: 'Watched source changed.', changedPaths: ['src/app.mjs'], omittedChangedPaths: 2, defaultCommit: 'd'.repeat(40) };
  const result = projectFlow(input, 'checkout');
  assert.equal(result.metadata.state, 'stale');
  assert.equal(result.metadata.reason, input.reason);
  assert.deepEqual(result.metadata.changedPaths, input.changedPaths);
  assert.equal(result.metadata.omittedChangedPaths, 2);
  assert.match(result.source, /status stale/);
});

test('bounded state views retain the initial state and expose omitted transitions', () => {
  const input = model(), result = projectFlow(input, 'checkout', { maxNodes: 2, maxEdges: 1 });
  assert.ok(result.metadata.nodes.some(item => item.id === 'idle'));
  assert.equal(result.metadata.view.omittedNodes, 1);
  assert.equal(result.metadata.view.omittedEdges, 1);
  assert.equal(result.metadata.view.complete, false);
  assert.match(result.source, /1 nodes and 1 edges omitted from view/);
});

test('flow projection order is deterministic without changing events or guards', () => {
  const first = model(), second = structuredClone(first);
  second.model.flows[0].states.reverse(); second.model.flows[0].transitions.reverse();
  assert.deepEqual(projectFlow(first, 'checkout'), projectFlow(second, 'checkout'));
});

test('invalid bounds, absent flows and dangling endpoints fail explicitly', () => {
  assert.throws(() => projectGraph(graph(), { maxNodes: 0 }), { code: 'E_DIAGRAM' });
  assert.throws(() => projectGraph(graph(), { maxEdges: -1 }), { code: 'E_DIAGRAM' });
  assert.throws(() => projectFlow({ state: 'absent', model: null }, 'checkout'), { code: 'E_DIAGRAM' });
  assert.throws(() => projectFlow(model(), 'missing'), { code: 'E_DIAGRAM' });
  const imports = graph(); imports.edges[0].to = 'not-extracted.mjs';
  assert.throws(() => projectGraph(imports), { code: 'E_DIAGRAM' });
  const flow = model(); flow.model.flows[0].transitions[0].to = 'missing';
  assert.throws(() => projectFlow(flow, 'checkout'), { code: 'E_DIAGRAM' });
});
