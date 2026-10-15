export function renderPerformanceHtml(report) {
  const data = JSON.stringify(report).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Domain performance report</title><style>
*{box-sizing:border-box}
body{margin:0;background:#f5f7f6;color:#20383f;font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,select{font:inherit;color:inherit}
button,select,summary,a{touch-action:manipulation}
button{cursor:pointer}
button:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid #237c83;outline-offset:3px}
a{color:#245f6b}
h1,h2,h3,p{margin:0}
h1{font-size:clamp(27px,4vw,38px);line-height:1.2;letter-spacing:-.035em}
h2{font-size:19px;letter-spacing:-.02em}
h3{font-size:16px}
p+p{margin-top:10px}
small,.muted{color:#596b70;font-size:13px}
button{border:1px solid #ccd7d6;background:#fff;border-radius:8px;text-align:left;overflow-wrap:anywhere}
button:hover{border-color:#56868a;background:#f5faf9}
.page{max-width:1440px;padding:40px 28px;margin:auto}
.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:650;color:#536d73}
.heading{display:flex;gap:20px;align-items:start;justify-content:space-between;margin:10px 0 18px}
.snapshot{border:1px solid #bdccca;border-radius:20px;padding:5px 12px;white-space:nowrap;font-size:12px}
.intro{max-width:860px;color:#52666c}
.nav{display:flex;gap:20px;flex-wrap:wrap;margin:20px 0 28px;font-size:13px}
.toolbar{display:grid;grid-template-columns:minmax(180px,370px) 1fr;align-items:end;gap:20px;padding:22px;background:#eaf0ee;border-radius:12px}
.toolbar label{display:block;font-size:13px;font-weight:600;margin-bottom:7px}
select{width:100%;min-width:0;border:1px solid #bdcdcb;background:#fff;border-radius:7px;padding:10px}
.goals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0 28px}
.goal{padding:18px;min-height:170px}
.goal-top,.panel-heading{display:flex;justify-content:space-between;gap:12px;align-items:center}
.goal-value{display:block;font-size:25px;font-weight:620;letter-spacing:-.025em;margin:10px 0 3px}
.goal .muted{display:block;margin-top:6px}
.badge{font-size:11px;border-radius:4px;padding:3px 6px;background:#eaf0ef;color:#44636a;white-space:nowrap;font-weight:550}
.badge.missed,.structural-violation .badge{background:#fae9e6;color:#963b32}
.badge.met{background:#e3f0e8;color:#2e6848}
.badge.stale,.measured-symptom .badge{background:#fff0da;color:#805b23}
.layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.panel{min-width:0;border:1px solid #d9e1df;background:#fff;border-radius:12px;padding:22px}
.panel-heading{margin-bottom:10px}
.panel>.muted{margin-bottom:18px}
.graph-scroll{overflow:auto;max-width:100%;border:1px solid #dce5e2;border-radius:9px;background-color:#f7faf9;background-image:radial-gradient(#d5e1dd .7px,transparent .7px);background-size:16px 16px}
.scene{position:relative;min-height:130px}
.scene>p{padding:20px}
.scene svg{position:absolute;inset:0;overflow:visible;pointer-events:none}
.edge{fill:none;stroke:#859e9f;stroke-width:1.5}
.edge.async,.edge.unknown{stroke-dasharray:5 4}
.map-node{position:absolute;width:180px;height:88px;padding:12px 13px;box-shadow:0 2px 5px #243e3d08}
.node-title{display:block;font-size:14px;font-weight:600;line-height:1.3;max-height:38px;overflow:hidden}
.node-meta{display:block;font-size:11px;color:#63777b;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.selected{border-color:#1b747b!important;box-shadow:0 0 0 2px #1b747b24;background:#edf7f5!important}
.has-violation{border-left:4px solid #ad594f}
.has-symptom{border-bottom:3px solid #bd9656}
.graph-note{margin:10px 0 20px;font-size:12px;color:#61767a}
.findings{display:grid;gap:8px}
.finding{padding:12px;width:100%}
.finding strong{display:block;font-size:13px;margin-top:6px}
.inspection{margin-top:20px}
.detail{margin-top:16px;overflow-wrap:anywhere}
.detail h3{margin:16px 0 8px}
.detail>h3:first-child{margin-top:0}
.detail p{font-size:13px}
.detail ul,.unknowns{margin:10px 0;padding-left:20px;font-size:13px}
.detail li+li,.unknowns li+li{margin-top:7px}
dl{display:grid;grid-template-columns:minmax(90px,auto) minmax(0,1fr);gap:6px 15px;font-size:12px;margin:12px 0}
dt{color:#65777c}
dd{margin:0;overflow-wrap:anywhere}
.chips{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}
.chip{padding:7px 10px;font-size:12px;max-width:100%}
.section-title{margin:22px 0 10px}
.source-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.source-list button{width:100%;padding:10px;font-size:12px}
.source-list small{display:block;font-size:11px;margin-top:4px}
.coverage{padding:12px 0;border-bottom:1px solid #e1e7e4;font-size:14px}
.coverage strong{font-size:24px;margin-right:6px}
details{margin-top:18px;font-size:13px}
summary{cursor:pointer;font-weight:600}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,monospace}
.limits{margin:24px 0 0;border-top:1px solid #d8e1dd;padding-top:18px;color:#607176;font-size:12px}
.limits ul{padding-left:18px}
.skip{position:absolute;left:-9999px}
.skip:focus{left:16px;top:12px;background:#fff;padding:10px;z-index:2}
@media(max-width:1050px){.layout{grid-template-columns:1fr}.panel{padding:20px}}@media(max-width:650px){.page{padding:26px 16px}.toolbar{grid-template-columns:1fr;padding:16px;gap:12px}.goals{grid-template-columns:repeat(2,minmax(0,1fr))}.goal{padding:14px}.heading{gap:10px}.source-list{grid-template-columns:1fr}.nav{gap:14px}}@media(max-width:380px){.goals{grid-template-columns:1fr}.panel{padding:15px}.snapshot{padding:4px 8px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:7px}}
</style></head><body><a class="skip" href="#journey">Skip to journey</a><div class="page">
<header><p class="eyebrow">Harness / performance</p><div class="heading"><h1>Domain performance</h1><span class="snapshot">Snapshot</span></div><p class="intro">Follow a user journey through its declared flow and selected source files. Inspect the evidence behind each finding and goal.</p><nav class="nav" aria-label="Report sections"><a href="#architecture">Architecture and flow</a><a href="#implementation">Code and dependencies</a><a href="#evidence">Evidence and coverage</a></nav></header>
<section class="toolbar" aria-label="Journey scope"><div><label for="journey">User journey</label><select id="journey"></select></div><p class="muted" id="journey-summary"></p></section>
<section class="goals" id="goals" aria-label="Journey goals"></section><main>
<div class="layout"><section class="panel" id="architecture"><div class="panel-heading"><h2>Architecture and flow</h2><span class="badge">Declared</span></div><p class="muted">Nodes and connections from the profile. Structural violations test declared rules.</p><div class="graph-scroll" tabindex="0" role="region" aria-label="Declared architecture map"><div class="scene" id="architecture-graph"></div></div><p class="graph-note">Arrows show direction. Dashed connections are async or unknown. Select a node to inspect its sources.</p><div class="findings" id="architecture-findings" aria-label="Architecture findings"></div></section>
<section class="panel" id="implementation"><div class="panel-heading"><h2>Code and dependencies</h2><span class="badge">Extracted / lexical</span></div><p class="muted">Selected files and their lexical references. Extraction is heuristic and does not prove runtime calls.</p><div class="graph-scroll" tabindex="0" role="region" aria-label="Extracted dependency map"><div class="scene" id="implementation-graph"></div></div><p class="graph-note">Unresolved references remain explicit. Selecting a file highlights its declared architecture mapping.</p><div class="findings" id="implementation-findings" aria-label="Implementation findings"></div></section></div>
<div class="layout inspection" id="evidence"><section class="panel"><h2>Inspect evidence</h2><div class="detail" id="detail" aria-live="polite"></div><h3 class="section-title">Journey sources</h3><div class="source-list" id="source-list"></div><h3 class="section-title">Imported measurements</h3><div class="findings" id="observation-list"></div></section>
<aside class="panel"><h2>Coverage and unknowns</h2><div class="coverage" id="coverage"></div><ul class="unknowns" id="unknowns"></ul><details><summary>Snapshot inputs and revisions</summary><div id="snapshot-inputs"></div></details><div class="limits"><p>This report is a snapshot. Goal states reflect evaluation when the report was created and do not update as time passes.</p><p>Imported measurements are not causal proof. Exported measurement bytes do not authenticate production identity. Map positions do not encode time or a critical path.</p><p>Declared means supplied by the profile. Extracted means read heuristically from selected files. Observed means attributed to an imported measurement.</p><ul id="limitations"></ul></div></aside></div></main></div>
<script type="application/json" id="performance-data">${data}</script><script id="performance-controller">(${activatePerformanceReport.toString()})();</script></body></html>`;
}

function activatePerformanceReport() {
  const report = JSON.parse(document.getElementById('performance-data').textContent);
  const get = (id) => document.getElementById(id);
  const text = (value) => value == null ? 'unknown' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const make = (tag, value, className = '') => { const element = document.createElement(tag); element.className = className; if (value != null) element.textContent = text(value); return element; };
  const add = (parent, tag, value, className) => { const element = make(tag, value, className); parent.append(element); return element; };
  const pairs = (parent, values) => { const list = add(parent, 'dl'); for (const [key, value] of values) { add(list, 'dt', key); add(list, 'dd', text(value)); } };
  const list = (parent, values) => { const ul = add(parent, 'ul'); for (const value of values) add(ul, 'li', text(value)); };
  const metricNames = { latency: 'Latency', reliability: 'Reliability', throughput: 'Throughput', cost: 'Cost' };
  const kindNames = { 'structural-violation': 'Structural violation', 'measured-symptom': 'Measured symptom', unknown: 'Unknown' };
  const sources = new Map(report.inputs.sources.map((source) => [source.id, source]));
  const nodes = new Map(report.architecture.nodes.map((node) => [node.id, node]));
  const selector = get('journey');
  let journey = report.journeys[0], selection = null, controls = [], activeSources = new Set(), activeObservations = [];
  const badge = (parent, value, status = '') => add(parent, 'span', value, `badge ${['met', 'missed', 'stale'].includes(status) ? status : ''}`);
  function control(parent, value, type, id, className = 'chip', extra = {}, track = true) {
    const button = add(parent, 'button', value, className); button.type = 'button'; button.dataset[type] = text(id); button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => { selection = { type, id, ...extra }; highlight(); inspect(); });
    if (track) controls.push({ button, type, id, ...extra });
    return button;
  }
  function sourceChips(parent, ids) {
    const chips = add(parent, 'div', null, 'chips');
    for (const id of new Set(ids)) control(chips, sources.has(id) ? `${sources.get(id).repo} / ${sources.get(id).path}` : `${id} / unknown source`, 'source', id, 'chip', {}, false);
  }
  function selectedMappings() {
    const nodeIds = new Set(), sourceIds = new Set();
    if (selection?.type === 'node') { nodeIds.add(selection.id); for (const id of nodes.get(selection.id)?.sources || []) sourceIds.add(id); }
    if (selection?.type === 'source') sourceIds.add(selection.id);
    if (selection?.type === 'dependency') sourceIds.add(selection.source);
    if (selection?.type === 'observation') sourceIds.add(selection.id);
    if (selection?.type === 'goal') { const goal = journey?.goals.find((item) => item.metric === selection.id); if (goal?.observation) sourceIds.add(goal.observation.source); }
    if (selection?.type === 'finding') { const finding = report.diagnostics.find((item) => item.id === selection.id); for (const id of finding.nodes) nodeIds.add(id); for (const id of finding.sources) sourceIds.add(id); }
    for (const node of report.architecture.nodes) if (node.sources.some((id) => sourceIds.has(id))) nodeIds.add(node.id);
    return { nodeIds, sourceIds };
  }
  function highlight() {
    const { nodeIds, sourceIds } = selectedMappings();
    for (const item of controls) {
      const chosen = item.type === 'node' ? nodeIds.has(item.id) : item.type === 'source' ? sourceIds.has(item.id) : item.type === 'dependency' ? sourceIds.has(item.source) : selection?.type === item.type && selection.id === item.id;
      item.button.classList.toggle('selected', chosen); item.button.setAttribute('aria-pressed', String(chosen));
    }
  }
  function graph(id, items, edges, empty) {
    const host = get(id); host.replaceChildren();
    if (!items.length) { host.style.width = '100%'; host.style.height = '130px'; add(host, 'p', empty, 'muted'); return; }
    const columns = Math.min(3, items.length), width = columns * 208 + 8, height = Math.ceil(items.length / columns) * 120 + 24;
    host.style.width = `${width}px`; host.style.height = `${height}px`;
    const positions = new Map(items.map((item, index) => [item.id, { x: 16 + index % columns * 208, y: 18 + Math.floor(index / columns) * 120 }]));
    const svgElement = (tag, attributes = {}) => { const element = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value); return element; };
    const svg = svgElement('svg', { width, height, 'aria-hidden': 'true' }), defs = svgElement('defs'), markerId = `${id}-arrow`;
    const marker = svgElement('marker', { id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#859e9f' })); defs.append(marker); svg.append(defs); host.append(svg);
    for (const edge of edges) {
      const from = positions.get(edge.from), to = positions.get(edge.to); if (!from || !to) continue;
      const sx = from.x + 180, sy = from.y + 44, tx = to.x, ty = to.y + 44, mid = (sx + tx) / 2;
      const path = svgElement('path', { d: `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`, class: `edge ${['async', 'unknown'].includes(edge.mode) ? edge.mode : ''}`, 'marker-end': `url(#${markerId})` });
      const title = svgElement('title'); title.textContent = text(edge.mode || 'extracted lexical reference'); path.append(title); svg.append(path);
    }
    for (const item of items) {
      const position = positions.get(item.id), button = control(host, null, item.type, item.selectionId ?? item.id, 'map-node', item.source ? { source: item.source } : {});
      button.style.left = `${position.x}px`; button.style.top = `${position.y}px`; button.setAttribute('aria-label', `${item.label}. ${item.meta}`);
      add(button, 'span', item.label, 'node-title'); add(button, 'span', item.meta, 'node-meta');
      const related = report.diagnostics.filter((finding) => finding.journeys.includes(journey?.id) && (item.type === 'node' ? finding.nodes.includes(item.id) : finding.sources.includes(item.selectionId ?? item.id)));
      button.classList.toggle('has-violation', related.some((finding) => finding.kind === 'structural-violation'));
      button.classList.toggle('has-symptom', related.some((finding) => finding.kind === 'measured-symptom'));
    }
  }
  function observationDetail(parent, observation, metrics = observation.metrics.filter((metric) => metric.journey === journey?.id)) {
    add(parent, 'h3', `Observed / ${text(observation.provenance.kind)}`);
    add(parent, 'p', observation.provenance.description);
    pairs(parent, [['Evidence source', observation.source], ['Captured at', observation.capturedAt], ['Environment', observation.environment], ['Workload', observation.workload], ['Freshness at evaluation', observation.freshness?.state || observation.freshness?.status || observation.freshness || 'See goal status']]);
    list(parent, metrics.map((metric) => `${metric.node || 'Journey'} / ${metricNames[metric.metric] || metric.metric} ${metric.statistic} / ${metric.basis} / ${metric.value} ${metric.unit} / ${metric.samples} samples`));
    add(parent, 'h3', 'Source hash mappings'); pairs(parent, Object.entries(observation.sourceHashes));
    add(parent, 'h3', 'Deployment mappings');
    if (!observation.deployments?.length) add(parent, 'p', 'Deployment artifact, build, repository and commit are unknown.');
    for (const mapping of observation.deployments || []) add(parent, 'p', `${mapping.node} / artifact ${text(mapping.artifact)} / build ${text(mapping.build)} / repository ${text(mapping.repo)} / commit ${text(mapping.commit)}`);
  }
  function sourceDetail(parent, id) {
    const source = sources.get(id); if (!source) { add(parent, 'p', 'Source mapping is unknown.'); return; }
    add(parent, 'h3', `${source.repo} / ${source.path}`);
    const repo = report.inputs.repos.find((item) => item.id === source.repo);
    pairs(parent, [['Source', source.id], ['Kind', source.kind], ['Read state', source.state], ['Original byte hash', source.sha256], ['Bytes', source.bytes], ['Repository root', repo?.root], ['Snapshot commit', repo?.head]]);
    const implementation = report.implementation.nodes.find((item) => item.id === id);
    if (implementation) { add(parent, 'p', 'Extracted / lexical. These references do not prove runtime calls.'); for (const key of ['symbols', 'imports', 'packages']) { add(parent, 'h3', key[0].toUpperCase() + key.slice(1)); list(parent, implementation[key]?.length ? implementation[key] : ['None extracted; absence is not proof of absence.']); } }
    for (const observation of activeObservations.filter((item) => item.source === id)) observationDetail(parent, observation);
  }
  function inspect() {
    const host = get('detail'); host.replaceChildren();
    if (!selection) {
      add(host, 'p', 'Select a node, file, goal, finding or measurement to inspect its evidence and linked sources.', 'muted');
      if (journey?.constraints.length) { add(host, 'h3', 'Declared constraints'); for (const constraint of journey.constraints) { add(host, 'p', constraint.text); sourceChips(host, constraint.sources); } }
      return;
    }
    if (selection.type === 'source') sourceDetail(host, selection.id);
    if (selection.type === 'node') {
      const node = nodes.get(selection.id); add(host, 'h3', node.label); pairs(host, [['Provenance', 'declared'], ['Node', node.id], ['Kind', node.kind]]);
      sourceChips(host, node.sources); add(host, 'h3', 'Declared connections');
      list(host, report.architecture.edges.filter((edge) => journey.nodes.includes(edge.from) && journey.nodes.includes(edge.to) && (edge.from === node.id || edge.to === node.id)).map((edge) => `${nodes.get(edge.from)?.label} → ${nodes.get(edge.to)?.label} / ${edge.mode}`));
      for (const observation of activeObservations) { const metrics = observation.metrics.filter((metric) => metric.journey === journey.id && metric.node === node.id); if (metrics.length) observationDetail(host, observation, metrics); }
    }
    if (selection.type === 'dependency') { const edge = report.implementation.edges[selection.id]; add(host, 'h3', edge.dependency); pairs(host, [['Provenance', edge.provenance], ['Fidelity', edge.fidelity], ['From', edge.from], ['Resolved source', edge.to]]); sourceChips(host, [edge.from, ...(edge.to ? [edge.to] : [])]); }
    if (selection.type === 'finding') { const finding = report.diagnostics.find((item) => item.id === selection.id); add(host, 'h3', finding.title); add(host, 'p', `${kindNames[finding.kind]} / ${finding.provenance}`); add(host, 'p', finding.detail); sourceChips(host, finding.sources); }
    if (selection.type === 'observation') observationDetail(host, activeObservations.find((item) => item.source === selection.id));
    if (selection.type === 'goal') {
      const goal = journey?.goals.find((item) => item.metric === selection.id) || { metric: selection.id, status: 'unknown', reason: 'No goal declared.' };
      add(host, 'h3', metricNames[goal.metric]); add(host, 'p', `${goal.status} / ${goal.reason}`);
      pairs(host, [['Target', goal.target == null ? 'unknown' : `${goal.target} ${goal.unit}`], ['Statistic', goal.statistic], ['Basis', goal.basis], ['Environment', journey?.environment], ['Workload', journey?.workload], ['Maximum age in seconds', journey?.maxAgeSeconds]]);
      const observation = activeObservations.find((item) => item.source === goal.observation?.source); if (observation) observationDetail(host, observation);
    }
  }
  function render() {
    selection = null; controls = []; activeSources = new Set();
    const journeyNodes = new Set(journey?.nodes || []);
    const architectureNodes = report.architecture.nodes.filter((node) => journeyNodes.has(node.id));
    const architectureEdges = report.architecture.edges.filter((edge) => journeyNodes.has(edge.from) && journeyNodes.has(edge.to));
    for (const node of architectureNodes) for (const id of node.sources) activeSources.add(id);
    for (const edge of architectureEdges) for (const id of edge.sources) activeSources.add(id);
    for (const constraint of journey?.constraints || []) for (const id of constraint.sources) activeSources.add(id);
    activeObservations = report.observations.filter((observation) => observation.metrics.some((metric) => metric.journey === journey?.id));
    for (const observation of activeObservations) activeSources.add(observation.source);
    get('journey-summary').textContent = journey ? `${journey.environment} / ${journey.workload} / ${journey.entry} → ${journey.completion} / maximum measurement age ${journey.maxAgeSeconds} seconds` : 'No user journeys were declared.';
    get('goals').replaceChildren();
    for (const [metric, name] of Object.entries(metricNames)) {
      const goal = journey?.goals.find((item) => item.metric === metric) || { status: 'unknown', reason: 'No goal declared.' };
      const card = control(get('goals'), null, 'goal', metric, 'goal'), top = add(card, 'span', null, 'goal-top');
      add(top, 'span', name); badge(top, ['met', 'missed', 'stale'].includes(goal.status) ? goal.status[0].toUpperCase() + goal.status.slice(1) : 'Unknown', goal.status);
      add(card, 'span', goal.observation ? `${goal.observation.value} ${goal.unit}` : 'Unknown', 'goal-value');
      add(card, 'span', goal.target == null ? 'Target unknown' : `Target ${['latency', 'cost'].includes(metric) ? '≤' : '≥'} ${goal.target} ${goal.unit} / ${goal.statistic}`, 'muted');
      add(card, 'span', goal.reason, 'muted');
    }
    graph('architecture-graph', architectureNodes.map((node) => ({ id: node.id, label: node.label, meta: `${node.kind} / declared`, type: 'node' })), architectureEdges, 'No declared nodes for this journey.');
    const implementationNodes = report.implementation.nodes.filter((node) => activeSources.has(node.id));
    const implementationIds = new Set(implementationNodes.map((node) => node.id));
    const implementationItems = implementationNodes.map((node) => ({ id: node.id, label: node.path.split('/').pop(), meta: `${node.repo} / ${node.state} / ${node.kind === 'code' ? 'lexical' : node.kind}`, type: 'source' }));
    const implementationEdges = [];
    report.implementation.edges.forEach((edge, index) => {
      if (!implementationIds.has(edge.from)) return;
      if (edge.to && implementationIds.has(edge.to)) implementationEdges.push(edge);
      else { const id = `dependency:${index}`; implementationItems.push({ id, selectionId: index, source: edge.from, label: edge.dependency, meta: edge.to ? 'Resolved outside this journey / lexical' : 'Unresolved reference / lexical', type: 'dependency' }); implementationEdges.push({ ...edge, to: id }); }
    });
    graph('implementation-graph', implementationItems, implementationEdges, 'No selected sources for this journey.');
    for (const view of ['architecture', 'implementation']) {
      const host = get(`${view}-findings`); host.replaceChildren();
      const findings = report.diagnostics.filter((finding) => finding.view === view && finding.journeys.includes(journey?.id));
      for (const finding of findings) { const button = control(host, null, 'finding', finding.id, `finding ${['structural-violation', 'measured-symptom'].includes(finding.kind) ? finding.kind : ''}`); badge(button, `${kindNames[finding.kind]} / ${finding.provenance}`); add(button, 'strong', finding.title); }
      if (!findings.length) add(host, 'p', 'No findings for this view. This does not establish performance.', 'muted');
    }
    get('source-list').replaceChildren();
    for (const source of report.inputs.sources.filter((item) => activeSources.has(item.id))) { const button = control(get('source-list'), `${source.repo} / ${source.path}`, 'source', source.id); add(button, 'small', `${source.kind} / ${source.state}`); }
    if (!activeSources.size) add(get('source-list'), 'p', 'No sources mapped to this journey.', 'muted');
    get('observation-list').replaceChildren();
    for (const observation of activeObservations) control(get('observation-list'), `${observation.source} / ${text(observation.provenance.kind)} / ${observation.capturedAt}`, 'observation', observation.source, 'finding');
    if (!activeObservations.length) add(get('observation-list'), 'p', 'No imported measurements for this journey.', 'muted');
    highlight(); inspect();
  }
  for (const item of report.journeys) { const option = add(selector, 'option', item.title); option.value = item.id; }
  if (!report.journeys.length) { add(selector, 'option', 'No journeys'); selector.disabled = true; }
  selector.value = journey?.id || ''; selector.addEventListener('change', () => { journey = report.journeys.find((item) => item.id === selector.value); render(); });
  const coverage = get('coverage'); add(coverage, 'strong', report.coverage.read); add(coverage, 'span', `of ${report.coverage.selected} selected sources read / ${report.coverage.unavailable} unavailable`);
  for (const unknown of report.unknowns.length ? report.unknowns : ['No additional unknowns recorded. Coverage remains limited to selected inputs.']) add(get('unknowns'), 'li', unknown);
  for (const limitation of report.limitations) add(get('limitations'), 'li', limitation);
  pairs(get('snapshot-inputs'), [['Report ID', report.id], ['Profile path', report.profile.path], ['Profile byte hash', report.profile.sha256]]);
  for (const repo of report.inputs.repos) pairs(get('snapshot-inputs'), [['Repository', repo.id], ['Root', repo.root], ['HEAD at evaluation', repo.head]]);
  if (report.inputs.domain) add(get('snapshot-inputs'), 'pre', JSON.stringify(report.inputs.domain, null, 2));
  render();
}
