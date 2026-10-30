import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { projectFormalEvidence } from '../lib/diagrams/formal.mjs';
import { diagramsResultOf } from '../lib/diagram-cmd.mjs';
import { readTlcGraph } from '../lib/diagrams/formal-graph.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const frame = (code, level = 0, body = '') => `@!@!@STARTMSG ${code}:${level} @!@!@\n${body}\n@!@!@ENDMSG ${code} @!@!@\n`;
const state = (i, action, value) => frame(2217, 4, `${i}: <${action}>\n${value}`);
const success = frame(2193, 0, 'No error has been found.') + frame(2199, 0, '3 states generated, 3 distinct states found, 0 states left on queue.') + frame(2186);
const receipt = (stdout, model = {}) => ({ schema: 1, feature: 'formal-verification', passed: true, status: 'passed',
  source: { files: [] }, verificationBindings: [],
  models: [{ module: 'Model.tla', expected: 'pass', pass: true, execution: { status: 0, signal: null, error: null, stdout, stderr: '' }, ...model }] });
const failing = value => receipt(frame(2110, 1, 'Invariant Safe is violated.') + state(1, 'Initial predicate', value) + state(2, 'Module!Publish line 3', value) + frame(2186),
  { expected: 'safety-violation', property: 'Safe', execution: { status: 12, signal: null, error: null, stdout: frame(2110, 1, 'Invariant Safe is violated.') + state(1, 'Initial predicate', value) + state(2, 'Module!Publish line 3', value) + frame(2186) } });
const graph = String.raw`strict digraph DiskGraph {
nodesep=0.35;
subgraph cluster_graph {
color="white";
-9007199254740993 [label="phase = \"ready\"",style = filled]
-9007199254740993 -> 9007199254740993 [label="Module!Publish",color="black",fontcolor="black"];
9007199254740993 [label="phase = \"done\""];
9007199254740993 -> 9007199254740994 [label="Reset",color="black",fontcolor="black"];
9007199254740994 [label="phase = \"ready\""];
{rank = same; -9007199254740993;}
}
}`;

test('native formal labels retain large integers, ranges, nested values and prototype names as exact text', () => {
  const value = '/\\ __proto__ = 9007199254740993\n/\\ constructor = [counter |-> <<9007199254740993, {TRUE, FALSE}>>, interval |-> 9007199254740991..9007199254740993]';
  const result = projectFormalEvidence(failing(value), 'Model.tla');
  assert.equal(result.metadata.trace.states, 2, 'equal states remain distinct witness occurrences');
  assert.match(result.metadata.nodes[0].label, /__proto__=9007199254740993/);
  assert.match(result.metadata.nodes[0].label, /9007199254740991\.\.9007199254740993/);
  assert.match(result.metadata.edges[0].action, /Module!Publish/);
});

test('retained upstream graph fixtures preserve ground values and all concrete relationships', () => {
  const counter = readTlcGraph(fs.readFileSync(new URL('./fixtures/formal-diagrams/pstack-counter-graph.dot', import.meta.url), 'utf8'));
  assert.equal(counter.nodes.length, 4); assert.equal(counter.edges.length, 3);
  assert.deepEqual(counter.nodes.map(node => node.variables[0].valueText), ['0', '1', '2', '3']);
  const player = readTlcGraph(fs.readFileSync(new URL('./fixtures/formal-diagrams/pstack-player-graph.dot', import.meta.url), 'utf8'));
  assert(player.nodes.length > 10 && player.edges.length > 20);
  assert(player.nodes.some(node => node.variables.some(value => value.valueText === '"Normal volume"')));
  assert(player.edges.some(edge => edge.action === 'YouPressPlay'));
});

test('native value framing accepts multiline ground text but refuses damaged values and concatenated runs', () => {
  const nested = '/\\ record = [counter |-> 9007199254740993,\n value |-> <<"literal \\\"quote\\\"",\n {TRUE, FALSE}>>]\n/\\ ready = TRUE';
  const result = projectFormalEvidence(failing(nested), 'Model.tla');
  assert.match(result.metadata.nodes[0].label, /9007199254740993/);
  for (const value of ['x = [value |-> 1', 'x = "unterminated', 'x = 0\nhidden = TRUE', 'x = <<1,2]', 'x = (a :> 1']) {
    assert.throws(() => projectFormalEvidence(failing(value), 'Model.tla'), /state|value/);
  }
  const joined = failing('x = 0');
  joined.models[0].execution.stdout += joined.models[0].execution.stdout;
  assert.throws(() => projectFormalEvidence(joined, 'Model.tla'), /completed run/);
});

test('unrecognized or incorrectly classified state frames cannot silently disappear', () => {
  const hidden = failing('x = 0');
  hidden.models[0].execution.stdout = hidden.models[0].execution.stdout.replace(frame(2186), frame(2216, 4, 'A state the compiler cannot interpret') + frame(2186));
  assert.throws(() => projectFormalEvidence(hidden, 'Model.tla'), /state frame/);
  const wrongLevel = failing('x = 0');
  wrongLevel.models[0].execution.stdout = wrongLevel.models[0].execution.stdout.replace('STARTMSG 2217:4', 'STARTMSG 2217:0');
  assert.throws(() => projectFormalEvidence(wrongLevel, 'Model.tla'), /state frame/);
});

test('large valid multiline values compile within a bounded subprocess deadline', () => {
  const value = 'x = {\n' + '0,\n'.repeat(16000) + '0}';
  const evidence = failing(value), module = new URL('../lib/diagrams/formal.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs'; const {projectFormalEvidence} = await import(${JSON.stringify(module)}); const result = projectFormalEvidence(JSON.parse(fs.readFileSync(0,'utf8')), 'Model.tla'); console.log(JSON.stringify({nodes:result.metadata.nodes.length,first:result.metadata.nodes[0].label.length}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: JSON.stringify(evidence), encoding: 'utf8', timeout: 4000, maxBuffer: 4096 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { nodes: 2, first: value.slice(4).length });
});

test('a recorded positive explored graph preserves IDs, same-label states and every distinct transition', () => {
  const result = projectFormalEvidence(receipt(success), 'Model.tla', { graph });
  assert.equal(result.kind, 'formal-state-graph');
  assert.equal(result.metadata.coverage.exploration, 'complete');
  assert.equal(result.metadata.nodes.length, 3);
  assert.equal(result.metadata.edges.length, 2);
  assert.deepEqual(result.metadata.nodes.map(n => n.recordedId), ['-9007199254740993', '9007199254740993', '9007199254740994']);
  assert.equal(result.metadata.nodes[0].label, result.metadata.nodes[2].label);
  assert.match(result.source, /Module/);
  assert.doesNotMatch(result.source, /classDef|breaks|mayBreak|safe state/);
  assert.equal(result.metadata.freshVerification, false);
});

test('missing graph, incomplete positive runs, malformed DOT and hidden transitions refuse a complete graph', () => {
  assert.throws(() => projectFormalEvidence(receipt(success), 'Model.tla'), /capture-graph|exported graph/);
  const bad = [
    graph.replace('9007199254740993 [label=', '9007199254740995 [label='),
    graph.replace('color="white";', 'URL="https://example.invalid";'),
    graph.replace('phase =', 'phase = [broken'),
    graph.replace('Module!Publish', 'Module!Publish\\q'),
    graph.replace('9007199254740994 [label=', '9007199254740993 [label='),
  ];
  for (const input of bad) assert.throws(() => projectFormalEvidence(receipt(success), 'Model.tla', { graph: input }), /formal|graph|DOT|state/);
  assert.throws(() => projectFormalEvidence(receipt(success.replace('0 states left', '1 states left')), 'Model.tla', { graph }), /complete|queue|explor/);
  assert.throws(() => projectFormalEvidence(receipt(success), 'Model.tla', { graph, maxNodes: 2 }), /states|limit|budget/);
  const partial = receipt(success, { graph: { format: 'tlc-dot', file: 'Model.graph.dot', sha256: hash(graph), exploration: 'partial' } });
  assert.equal(projectFormalEvidence(partial, 'Model.tla', { graph }).metadata.coverage.exploration, 'partial');
  const negative = failing('x = 0');
  negative.models[0].graph = { file: '../unused.dot' };
  assert.equal(projectFormalEvidence(negative, 'Model.tla', { graph: 'must not replace the witness' }).kind, 'formal-trace');
});

test('graph references are receipt-relative, hash-bound and included in saved diagram freshness', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-native-formal-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'evidence'));
  fs.writeFileSync(path.join(workspace, 'Model.tla'), '---- MODULE Model ----\n====\n');
  fs.writeFileSync(path.join(workspace, 'evidence/Model.graph.dot'), graph);
  const evidence = receipt(success, { graph: { format: 'tlc-dot', file: 'Model.graph.dot', sha256: hash(graph), exploration: 'complete' } });
  evidence.verificationBindings = [{ path: 'Model.tla', sha256: hash(fs.readFileSync(path.join(workspace, 'Model.tla'))) }];
  const input = path.join(workspace, 'evidence/formal-verification.json');
  fs.writeFileSync(input, JSON.stringify(evidence));
  const render = () => diagramsResultOf(['formal', '--file', 'evidence/formal-verification.json', '--model', 'Model.tla', '--workspace', workspace]);
  const result = await render();
  assert.equal(result.kind, 'formal-state-graph');
  assert.equal(result.freshness.state, 'current');
  const record = JSON.parse(fs.readFileSync(path.join(workspace, result.artifacts.receipt), 'utf8'));
  assert(record.snapshot.bindings.some(b => b.path === 'evidence/Model.graph.dot' && b.sha256 === hash(graph)));
  fs.appendFileSync(path.join(workspace, 'evidence/Model.graph.dot'), '\n');
  const status = await diagramsResultOf(['status', '--receipt', result.artifacts.receipt, '--workspace', workspace]);
  assert.equal(status.state, 'stale');
  await assert.rejects(render(), /hash|changed|binding/);
  for (const file of ['../Model.graph.dot', '/tmp/Model.graph.dot', 'https://example.invalid/model.dot']) {
    evidence.models[0].graph.file = file;
    fs.writeFileSync(input, JSON.stringify(evidence));
    await assert.rejects(render(), /graph|relative|contained|file/);
  }
  if (process.platform !== 'win32') {
    evidence.models[0].graph.file = 'Model.graph.dot'; fs.writeFileSync(input, JSON.stringify(evidence));
    fs.unlinkSync(path.join(workspace, 'evidence/Model.graph.dot'));
    fs.writeFileSync(path.join(workspace, 'outside.dot'), graph);
    fs.symlinkSync(path.join(workspace, 'outside.dot'), path.join(workspace, 'evidence/Model.graph.dot'));
    await assert.rejects(render(), /unsafe|unreadable/);
  }
});

test('formal artifact hashes bind raw bytes and invalid UTF-8 never becomes replacement-character evidence', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formal-bytes-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const dot = Buffer.from(graph); dot[dot.indexOf('ready')] = 0x80;
  fs.writeFileSync(path.join(workspace, 'Model.graph.dot'), dot);
  const evidence = receipt(success, { graph: { format: 'tlc-dot', file: 'Model.graph.dot', sha256: hash(dot.toString('utf8')), exploration: 'complete' } });
  const input = path.join(workspace, 'formal-verification.json');
  fs.writeFileSync(input, JSON.stringify(evidence));
  const render = () => diagramsResultOf(['formal', '--file', 'formal-verification.json', '--model', 'Model.tla', '--workspace', workspace]);
  await assert.rejects(render(), /hash|UTF-8/);
  evidence.models[0].graph.sha256 = hash(dot);
  fs.writeFileSync(input, JSON.stringify(evidence));
  await assert.rejects(render(), /UTF-8/);
  fs.writeFileSync(path.join(workspace, 'Model.graph.dot'), graph);
  evidence.models[0].graph.sha256 = hash(graph);
  const valid = JSON.stringify(evidence);
  fs.writeFileSync(input, Buffer.concat([Buffer.from(valid.slice(0, -1) + ',"diagnostic":"'), Buffer.from([0x80]), Buffer.from('"}') ]));
  await assert.rejects(render(), /UTF-8/);
});
