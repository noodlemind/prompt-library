import { createRedactor } from '../redact.mjs';
import { formalFailure as fail, readTlcRun, readTlcTrace } from './formal-protocol.mjs';
import { formalGraphSource, readTlcGraph } from './formal-graph.mjs';

const MODULE = /^[A-Za-z][A-Za-z0-9_]*\.tla$/;
const PROPERTY = /^[A-Za-z][A-Za-z0-9_]*$/;

function selectedModel(receipt, module) {
  if (!receipt || receipt.schema !== 1 || receipt.feature !== 'formal-verification' || !Array.isArray(receipt.models)
    || receipt.models.length > 8 || !MODULE.test(module || '')) throw fail('select a retained formal-verification receipt and exact .tla module');
  const models = receipt.models.filter(model => model?.module === module);
  if (models.length !== 1) throw fail('selected model is missing or ambiguous in the receipt');
  const model = models[0];
  if (!['pass', 'safety-violation', 'liveness-violation'].includes(model.expected)
    || model.expected !== 'pass' && !PROPERTY.test(model.property || '')
    || model.property != null && !PROPERTY.test(model.property)) throw fail('a negative control must name its intended property');
  if (!model.execution || model.execution.error || model.execution.signal || ![0, 12, 13].includes(model.execution.status)) throw fail('selected model has no completed retained evidence');
  return model;
}

/** Only a positive run selects graph I/O. A violating run keeps its witness. */
export function formalGraphReference(receipt, module) {
  const model = selectedModel(receipt, module);
  if (model.expected !== 'pass' || model.execution.status !== 0 || model.graph == null) return null;
  const graph = model.graph;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || Object.keys(graph).sort().join(',') !== 'exploration,file,format,sha256'
    || graph.format !== 'tlc-dot' || graph.file !== `${module.slice(0, -4)}.graph.dot`
    || !/^[a-f0-9]{64}$/.test(graph.sha256 || '') || !['complete', 'partial'].includes(graph.exploration)) throw fail('invalid receipt-relative recorded graph reference');
  return graph;
}

export function formalReceiptBindings(receipt) {
  const groups = [receipt?.source?.files, receipt?.verificationBindings];
  if (groups.some(group => !Array.isArray(group)) || groups[0].length + groups[1].length > 2048) throw fail('recorded source and verification bindings are missing or oversized');
  const files = new Map();
  let runner;
  for (const [groupIndex, group] of groups.entries()) for (const binding of group) {
    if (!binding || typeof binding.path !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256 || '')
      || Object.keys(binding).some(key => !['path', 'sha256'].includes(key))) throw fail('invalid recorded file binding');
    if (groupIndex === 1 && binding.path === '<copied-runner>') {
      if (runner && runner !== binding.sha256) throw fail('conflicting copied-runner identities');
      runner = binding.sha256;
      continue;
    }
    if (files.has(binding.path) && files.get(binding.path) !== binding.sha256) throw fail('conflicting recorded file bindings');
    files.set(binding.path, binding.sha256);
  }
  return [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, sha256]) => ({ path, sha256 }));
}

/** Compile retained evidence. Filesystem, checker and rendering remain outside. */
export function projectFormalEvidence(receipt, module, { maxNodes = 50, redactor = createRedactor(), graph: dot } = {}) {
  const model = selectedModel(receipt, module), execution = model.execution;
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 200) throw fail('select 1 to 200 states');
  const run = readTlcRun(execution.stdout), positive = model.expected === 'pass' && execution.status === 0;
  let graph, property = null, role, note, coverage, kind;
  if (positive) {
    if (dot === undefined) throw fail('positive evidence has no exported graph; rerun the explicitly configured formal checker with --capture-graph, then retain its receipt and DOT file');
    if (!run.success || run.errors.length || run.violationCount || !run.states?.distinct || run.states.remaining !== 0) throw fail('recorded positive graph lacks a complete successful exploration with an empty queue');
    graph = readTlcGraph(dot);
    const exploration = model.graph?.exploration || 'complete';
    if (exploration === 'complete' && graph.nodes.length !== run.states.distinct) throw fail('complete graph state count does not match recorded exploration');
    coverage = { exploration, recordedStates: run.states, drawnStates: graph.nodes.length, drawnTransitions: graph.edges.length };
    role = 'recorded-positive-model'; kind = 'formal-state-graph';
    note = `Recorded ${exploration} finite model graph; neutral states; not fresh verification; no rule-specific state marks are inferred`;
  } else {
    if (run.violationCount !== 1 || !run.violation || execution.status !== (run.violation.kind === 'temporal' ? 13 : 12)) throw fail('recorded failure does not identify a supported invariant or temporal counterexample');
    const allowed = run.violation.kind === 'temporal' ? [2116, 2121, 2264] : [2107, 2110, 2121];
    if (run.errors.some(frame => !allowed.includes(frame.code))) throw fail('recorded run contains another checker error');
    graph = readTlcTrace(run);
    property = run.violation.property || model.property || 'UnidentifiedTemporalProperty';
    const expectedKind = model.expected === 'safety-violation' ? 'invariant' : 'temporal';
    role = model.expected === 'pass' ? 'unexpected-model-violation'
      : expectedKind === run.violation.kind && (run.violation.kind === 'temporal' || model.property === property) ? 'expected-negative-control' : 'negative-control-mismatch';
    coverage = { exploration: 'trace-only', drawnStates: graph.nodes.length, drawnTransitions: graph.edges.length };
    kind = 'formal-trace';
    note = `Recorded counterexample for ${property}; ${role}; not fresh verification; trace only, not the complete reachable graph${run.violation.kind === 'temporal' ? '; temporal failure is an infinite behavior, not one bad terminal state' : ''}`;
  }
  if (graph.nodes.length > maxNodes) throw fail(`evidence has ${graph.nodes.length} states; raise --max-nodes up to 200; states and bug paths are never clipped`);
  const safe = value => redactor.redactText(String(value));
  const view = formalGraphSource(graph, note, safe);
  const tool = receipt.tool && typeof receipt.tool === 'object' ? {
    release: typeof receipt.tool.release === 'string' && receipt.tool.release.length <= 64 ? safe(receipt.tool.release) : null,
    version: typeof receipt.tool.version === 'string' && receipt.tool.version.length <= 256 ? safe(receipt.tool.version) : null,
    sha256: /^[a-f0-9]{64}$/.test(receipt.tool.sha256 || '') ? receipt.tool.sha256 : null,
  } : null;
  return { format: 'mermaid', kind, source: view.source,
    metadata: {
      version: 1, kind: positive ? 'recorded-formal-state-graph' : 'recorded-formal-trace', module,
      property: property === null ? null : safe(property), violation: run.violation?.kind || null, role, coverage,
      freshVerification: false, semantics: 'View of retained finite model evidence. No checker is run and no unrecorded state, transition or rule mark is inferred.',
      recordedReceiptStatus: ['passed', 'failed', 'blocked'].includes(receipt.status) ? receipt.status : 'unknown',
      recordedReceiptPassed: receipt.passed === true, recordedExpectation: model.expected, recordedTool: tool,
      recordedSource: { commit: /^[a-f0-9]{40,64}$/.test(receipt.source?.commit || '') ? receipt.source.commit : null, kind: receipt.source?.sourceKind === 'working-tree-bytes' ? receipt.source.sourceKind : 'unknown' },
      recordedModelPass: model.pass === true,
      ...(positive ? {} : { trace: { states: view.nodes.length, steps: view.edges.length, loop: graph.loop, stutters: graph.stutters } }),
      recordedRunnerSha256: receipt.verificationBindings?.find(binding => binding.path === '<copied-runner>')?.sha256 ?? null,
      stderrPresent: typeof execution.stderr === 'string' && Boolean(execution.stderr.trim()),
      nodes: view.nodes, edges: view.edges,
      limitations: ['Imported receipt data is not authenticated proof.', 'Freshness covers only recorded bound files; new writers outside that inventory are not detected.', 'TLC values are retained as opaque text, without evaluation or numerical conversion.', 'The copied runner identity is retained but not rechecked as a workspace file.', 'Only framed stdout and a selected bound graph are interpreted; stderr is diagnostic.', 'Real-code correspondence and model completeness remain separate verification questions.'],
      attribution: { author: 'Lauren Tan', project: 'pstack /statechart', version: '0.15.36', commit: '4dd1d05818d19792e7cd6e818f1667f95f7e1dbe', relationship: 'Architecture and saved protocol-fixture reference; AE-owned implementation.' },
    } };
}
