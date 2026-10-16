import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { analyzePerformance } from '../lib/performance.mjs';
import { renderPerformanceHtml } from '../lib/performance-report.mjs';
import { tempDir } from './helpers/temp.mjs';
import { initGit } from './helpers/cli-fixtures.mjs';

function fixture() {
  const unknown = (metric) => ({ metric, status: 'unknown', reason: 'No compatible measurement.' });
  return {
    version: 1, id: 'a'.repeat(64), profile: { path: '.github/harness/performance.json', sha256: 'b'.repeat(64) },
    inputs: { domain: null, repos: [{ id: 'self', root: '/tmp/example', head: 'c'.repeat(40) }], sources: [
      { id: 'web', repo: 'self', path: 'src/web.mjs', kind: 'code', state: 'regular', sha256: 'd'.repeat(64), bytes: 30 },
      { id: 'api', repo: 'self', path: 'package.json', kind: 'manifest', state: 'regular', sha256: 'e'.repeat(64), bytes: 70 },
      { id: 'worker', repo: 'self', path: 'src/worker.mjs', kind: 'code', state: 'unavailable', sha256: null, bytes: 0 },
      { id: 'trace', repo: 'self', path: 'evidence/trace.json', kind: 'evidence', state: 'regular', sha256: 'f'.repeat(64), bytes: 200 },
    ] },
    architecture: { nodes: [
      { id: 'request', label: 'Receive request', kind: 'operation', sources: ['web'] },
      { id: 'query', label: 'Run query', kind: 'service', sources: ['api'] },
      { id: 'background', label: 'Run worker', kind: 'queue', sources: ['worker'] },
    ], edges: [{ id: 'request-query', from: 'request', to: 'query', mode: 'sync', sources: ['web', 'api'] }] },
    implementation: { nodes: [
      { id: 'web', repo: 'self', path: 'src/web.mjs', kind: 'code', state: 'regular', sha256: 'd'.repeat(64), symbols: ['start'], imports: ['./api.mjs'], packages: [] },
      { id: 'api', repo: 'self', path: 'package.json', kind: 'manifest', state: 'regular', sha256: 'e'.repeat(64), symbols: [], imports: [], packages: ['slow-package'] },
      { id: 'worker', repo: 'self', path: 'src/worker.mjs', kind: 'code', state: 'unavailable', sha256: null, symbols: [], imports: [], packages: [] },
    ], edges: [{ from: 'web', to: 'api', dependency: './api.mjs', provenance: 'extracted', fidelity: 'lexical' }, { from: 'api', to: null, dependency: 'slow-package', provenance: 'extracted', fidelity: 'lexical' }] },
    journeys: [
      { id: 'search', title: 'Search records', entry: 'request', completion: 'query', nodes: ['request', 'query'], environment: 'fixture', workload: '20 requests/s', maxAgeSeconds: 3600, constraints: [{ id: 'completion', text: 'Complete after the query', sources: ['api'] }], goals: [
        { metric: 'latency', statistic: 'p95', unit: 'ms', basis: 'request to response', target: 200, status: 'missed', reason: 'Observed value exceeds target.', observation: { source: 'trace', capturedAt: '2026-10-15T12:00:00Z', value: 250, samples: 100, provenance: { kind: 'synthetic', description: 'Fixture only' } } },
        unknown('reliability'), unknown('throughput'), unknown('cost'),
      ] },
      { id: 'work', title: 'Background work', entry: 'background', completion: 'background', nodes: ['background'], environment: 'fixture', workload: '1 job/s', maxAgeSeconds: 60, constraints: [], goals: ['latency', 'reliability', 'throughput', 'cost'].map(unknown) },
    ],
    diagnostics: [
      { id: 'path-gap', view: 'architecture', kind: 'structural-violation', journeys: ['search'], nodes: ['query'], sources: ['api'], title: 'Completion rule violated', detail: 'The declared path is incomplete.', provenance: 'declared' },
      { id: 'latency', view: 'implementation', kind: 'measured-symptom', journeys: ['search'], nodes: ['query'], sources: ['api', 'trace'], title: 'Latency exceeds goal', detail: 'Cause remains unknown.', provenance: 'observed' },
    ],
    observations: [{ source: 'trace', version: 1, provenance: { kind: 'synthetic', description: 'Fixture only' }, capturedAt: '2026-10-15T12:00:00Z', environment: 'fixture', workload: '20 requests/s', sourceHashes: { web: 'd'.repeat(64), api: 'e'.repeat(64) }, metrics: [
      { journey: 'search', metric: 'latency', statistic: 'p95', unit: 'ms', basis: 'request to response', value: 250, samples: 100 },
      { journey: 'search', node: 'query', metric: 'latency', statistic: 'p95', unit: 'ms', basis: 'query duration', value: 170, samples: 100 },
    ], deployments: [{ node: 'query', repo: 'self', commit: 'c'.repeat(40) }] }],
    coverage: { selected: 4, read: 3, unavailable: 1 }, unknowns: ['Worker source is unavailable.'], limitations: ['Lexical extraction does not prove runtime calls.'],
  };
}

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.events = {}; this.className = ''; this.ownText = '';
    this.classList = {
      toggle: (name, enabled) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(' '); },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.ownText = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(event, listener) { this.events[event] = listener; }
  fire(event) { this.events[event]?.({ target: this }); }
  focus() { this.document.activeElement = this; }
}

function mount(report) {
  const html = renderPerformanceHtml(report);
  const ids = new Map();
  const document = { getElementById: (id) => ids.get(id), createElement: (tag) => new Element(tag, document), createElementNS: (_namespace, tag) => new Element(tag, document) };
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) ids.set(id, new Element('div', document));
  ids.get('performance-data').textContent = html.match(/<script type="application\/json" id="performance-data">([\s\S]*?)<\/script>/)[1];
  const script = html.match(/<script id="performance-controller">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { document });
  return { html, document, get: (id) => ids.get(id), all: (id) => flatten(ids.get(id)) };
}

function flatten(element) { return [element, ...element.children.flatMap(flatten)]; }
function button(app, id, text) { return app.all(id).find((element) => element.tagName === 'BUTTON' && element.textContent.includes(text)); }

test('unresolved dependency positions cannot overwrite a selected source identity', () => {
  const report = fixture();
  const source = { ...report.inputs.sources[0], id: 'unresolved-1', path: 'src/other.mjs' };
  report.inputs.sources.push(source);
  report.implementation.nodes.push({ ...source, symbols: [], imports: [], packages: [] });
  report.architecture.nodes[0].sources.push(source.id);
  const app = mount(report);
  const sourceButton = app.all('implementation-graph').find(item => item.dataset.source === source.id);
  const dependencyButton = app.all('implementation-graph').find(item => item.dataset.dependency === '1');
  assert.notDeepEqual(sourceButton.style, dependencyButton.style);
  assert.match(button(app, 'implementation-graph', 'package.json').textContent, /manifest/);
});

test('report is deterministic and self-contained with script-safe lossless JSON', () => {
  const report = fixture();
  const hostile = '</script><img src=x onerror=alert(1)> & > \u2028 \u2029';
  report.journeys[0].title = hostile;
  const html = renderPerformanceHtml(report);
  assert.equal(html, renderPerformanceHtml(report));
  assert.ok(!html.includes(hostile));
  assert.deepEqual(JSON.parse(html.match(/id="performance-data">([\s\S]*?)<\/script>/)[1]), report);
  assert.equal([...html.matchAll(/<script\b/g)].length, 2);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /name="viewport"/);
  assert.doesNotMatch(html, /\b(?:src|href)="(?!#)/);
  assert.doesNotMatch(html, /\.innerHTML\b|\bfetch\(|\beval\(/);
});

test('journey view shows four independent goals, linked maps and unknown coverage', () => {
  const app = mount(fixture());
  assert.equal(app.get('goals').children.length, 4);
  assert.match(app.get('goals').textContent, /Latency.*250 ms.*200 ms/s);
  assert.match(app.get('goals').textContent, /Reliability.*Unknown.*Throughput.*Unknown.*Cost.*Unknown/s);
  assert.match(app.get('architecture-graph').textContent, /Receive request.*Run query/s);
  assert.match(app.get('implementation-graph').textContent, /web\.mjs.*package\.json.*slow-package/s);
  assert.doesNotMatch(app.get('architecture-graph').textContent, /Run worker/);
  assert.match(app.get('coverage').textContent, /3.*4.*1/s);
  assert.match(app.get('unknowns').textContent, /Worker source is unavailable/);
  assert.match(app.get('snapshot-inputs').textContent, /b{64}.*c{40}/s);
});

test('source lists and drilldowns disclose truncated extraction beside the affected file', () => {
  const report = fixture();
  report.implementation.nodes[0].limitsReached = { symbols: true, imports: true, refs: false };
  const app = mount(report);
  const source = button(app, 'source-list', 'src/web.mjs');
  assert.match(source.textContent, /truncat.*symbols.*imports/i);
  source.fire('click');
  assert.match(app.get('detail').textContent, /truncat.*symbols.*imports.*omitted/i);
  assert.doesNotMatch(button(app, 'source-list', 'package.json').textContent, /truncat/i);
});

test('node and source buttons cross-highlight their mapping while retaining keyboard focus', () => {
  const app = mount(fixture());
  const node = button(app, 'architecture-graph', 'Run query');
  node.focus(); node.fire('click');
  assert.equal(node.getAttribute('aria-pressed'), 'true');
  assert.equal(button(app, 'implementation-graph', 'package.json').getAttribute('aria-pressed'), 'true');
  assert.equal(button(app, 'implementation-graph', 'web.mjs').getAttribute('aria-pressed'), 'false');
  assert.equal(app.document.activeElement, node);
  assert.match(app.get('detail').textContent, /synthetic.*query duration.*170 ms/s);
  assert.match(app.get('detail').textContent, /artifact.*unknown.*build.*unknown/s);
  button(app, 'source-list', 'src/web.mjs').fire('click');
  assert.equal(button(app, 'architecture-graph', 'Receive request').getAttribute('aria-pressed'), 'true');
  assert.equal(node.getAttribute('aria-pressed'), 'false');
  assert.match(app.get('detail').textContent, /start.*\.\/api\.mjs/s);
});

test('changing journey filters both maps, sources, findings and measurements', () => {
  const app = mount(fixture());
  app.get('journey').value = 'work'; app.get('journey').fire('change');
  assert.match(app.get('architecture-graph').textContent, /Run worker/);
  assert.doesNotMatch(app.get('implementation-graph').textContent, /web\.mjs|package\.json/);
  assert.match(app.get('source-list').textContent, /worker\.mjs.*unavailable/s);
  assert.doesNotMatch(app.get('source-list').textContent, /trace\.json/);
  assert.doesNotMatch(app.get('architecture-findings').textContent, /Completion rule violated/);
  assert.doesNotMatch(app.get('observation-list').textContent, /trace/);
  assert.equal(app.get('goals').children.length, 4);
  assert.match(app.get('journey-summary').textContent, /1 job\/s.*60/s);
});

test('finding and imported measurement drilldowns preserve provenance and unresolved deployment links', () => {
  const app = mount(fixture());
  button(app, 'architecture-findings', 'Completion rule violated').fire('click');
  assert.match(app.get('detail').textContent, /Structural violation.*declared.*path is incomplete/s);
  assert.equal(button(app, 'implementation-graph', 'package.json').getAttribute('aria-pressed'), 'true');
  button(app, 'implementation-findings', 'Latency exceeds goal').fire('click');
  assert.match(app.get('detail').textContent, /Measured symptom.*observed.*Cause remains unknown/s);
  button(app, 'observation-list', 'trace').fire('click');
  assert.match(app.get('detail').textContent, /synthetic.*Fixture only.*2026-10-15T12:00:00Z.*100 samples/s);
  assert.match(app.get('detail').textContent, /d{64}.*e{64}/s);
  assert.match(app.html, /snapshot|Snapshot/);
  assert.match(app.html, /not causal proof/);
  assert.match(app.html, /do not authenticate production/);
});

test('measurement drilldown selects freshness for the active journey from an analyzed report', t => {
  const workspace = fs.realpathSync(tempDir('performance-report-freshness-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  initGit(workspace);
  fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true });
  const code = 'export function run() { return 1; }\n';
  fs.writeFileSync(path.join(workspace, 'code.mjs'), code);
  const goal = { metric: 'latency', statistic: 'p95', unit: 'ms', basis: 'request completion', target: 200 };
  const journeys = [['search', 3600], ['work', 60]].map(([id, maxAgeSeconds]) => ({ id, title: id, entry: 'request', completion: 'request', nodes: ['request'], environment: 'fixture', workload: 'one request', maxAgeSeconds, goals: [goal], constraints: [] }));
  const observation = { version: 1, provenance: { kind: 'synthetic', description: 'Fixture only' }, capturedAt: '2026-10-15T12:00:00Z', environment: 'fixture', workload: 'one request', sourceHashes: { code: crypto.createHash('sha256').update(code).digest('hex') }, metrics: journeys.map(journey => ({ journey: journey.id, metric: 'latency', statistic: 'p95', unit: 'ms', basis: 'request completion', value: 100, samples: 10 })) };
  fs.writeFileSync(path.join(workspace, 'trace.json'), JSON.stringify(observation));
  fs.writeFileSync(path.join(workspace, '.github/harness/performance.json'), JSON.stringify({ version: 1, sources: [{ id: 'code', repo: 'self', path: 'code.mjs', kind: 'code' }, { id: 'trace', repo: 'self', path: 'trace.json', kind: 'evidence' }], nodes: [{ id: 'request', label: 'Request', kind: 'service', sources: ['code'] }], edges: [], journeys, observations: ['trace'] }));
  const report = analyzePerformance({ workspace, now: Date.parse('2026-10-15T12:02:00Z') });
  assert.deepEqual(report.observations[0].freshness.map(({ journey, status }) => ({ journey, status })), [{ journey: 'search', status: 'current' }, { journey: 'work', status: 'stale' }]);
  const app = mount(report);
  button(app, 'observation-list', 'trace').fire('click');
  assert.match(app.get('detail').textContent, /Freshness at evaluation current/);
  assert.doesNotMatch(app.get('detail').textContent, /maximum age|"journey"/);
  app.get('journey').value = 'work'; app.get('journey').fire('change');
  button(app, 'observation-list', 'trace').fire('click');
  assert.match(app.get('detail').textContent, /Freshness at evaluation stale/);
  assert.doesNotMatch(app.get('detail').textContent, /"journey"/);
  report.observations[0].freshness = report.observations[0].freshness.filter(item => item.journey !== 'search');
  const missing = mount(report);
  button(missing, 'observation-list', 'trace').fire('click');
  assert.match(missing.get('detail').textContent, /Freshness at evaluation unknown/);
  assert.doesNotMatch(missing.get('detail').textContent, /maximum age/);
});

test('hostile node, file, finding and measurement text never creates elements or executable links', () => {
  const report = fixture();
  const attack = '<svg onload=alert(1)>javascript:alert(2)</svg>';
  report.architecture.nodes[1].label = attack;
  report.inputs.sources[1].path = 'javascript:alert(3)';
  report.implementation.nodes[1].path = 'javascript:alert(3)';
  report.diagnostics[0].detail = attack;
  report.observations[0].provenance.description = attack;
  const app = mount(report);
  button(app, 'architecture-graph', attack).fire('click');
  assert.match(app.get('detail').textContent, /<svg onload=alert\(1\)>/);
  button(app, 'source-list', 'javascript:alert(3)').fire('click');
  assert.match(app.get('detail').textContent, /javascript:alert\(3\)/);
  button(app, 'architecture-findings', 'Completion rule violated').fire('click');
  assert.match(app.get('detail').textContent, /<svg onload=alert\(1\)>/);
  button(app, 'observation-list', 'trace').fire('click');
  assert.match(app.get('detail').textContent, /<svg onload=alert\(1\)>/);
  assert.ok(app.all('detail').every((element) => !['SVG', 'SCRIPT', 'IMG', 'IFRAME'].includes(element.tagName)));
  assert.ok(app.all('detail').every((element) => !element.getAttribute('href') || element.getAttribute('href').startsWith('#')));
});

test('empty reports retain all four unknown dimensions and usable empty states', () => {
  const report = fixture();
  report.journeys = []; report.architecture = { nodes: [], edges: [] }; report.implementation = { nodes: [], edges: [] }; report.observations = []; report.diagnostics = []; report.inputs.sources = [];
  const app = mount(report);
  assert.equal(app.get('goals').children.length, 4);
  assert.match(app.get('architecture-graph').textContent, /No .*nodes/i);
  assert.match(app.get('implementation-graph').textContent, /No .*sources/i);
  assert.match(app.get('detail').textContent, /Select/);
});

test('the first unresolved dependency can be inspected without inventing a source mapping', () => {
  const report = fixture();
  report.implementation.edges = [{ from: 'api', to: null, dependency: 'slow-package', provenance: 'extracted', fidelity: 'lexical' }];
  const app = mount(report);
  button(app, 'implementation-graph', 'slow-package').fire('click');
  assert.match(app.get('detail').textContent, /slow-package.*extracted.*lexical.*Resolved source unknown/s);
  assert.equal(button(app, 'architecture-graph', 'Run query').getAttribute('aria-pressed'), 'true');
});

test('the default inspector retains declared constraints and their source drilldown', () => {
  const app = mount(fixture());
  assert.match(app.get('detail').textContent, /Declared constraints.*Complete after the query/s);
  button(app, 'detail', 'package.json').fire('click');
  assert.match(app.get('detail').textContent, /Original byte hash.*e{64}/s);
});
