// Projections are descriptive views of existing harness results. They neither
// resolve additional dependencies nor establish application behavior or proof.
const failure = message => Object.assign(new Error(`diagram: ${message}`), { code: 'E_DIAGRAM', exit: 2 });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' && value.length > 0;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, clone(value[key])]));

// Numeric entities are Mermaid label data. In particular, quotes, line breaks,
// HTML, Markdown, comments and directives can never become source statements.
function label(value) {
  return [...String(value)].map(character => /^[A-Za-z0-9 _]$/.test(character) ? character : `#${character.codePointAt(0)};`).join('');
}

function bounds({ maxNodes = 50, maxEdges = 200 } = {}) {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 200
    || !Number.isSafeInteger(maxEdges) || maxEdges < 0 || maxEdges > 1000) throw failure('view limits require 1 to 200 nodes and 0 to 1000 edges');
  return { maxNodes, maxEdges };
}

function select(nodes, edges, roots, key, limits) {
  const ordered = [...nodes].sort((a, b) => compare(key(a), key(b)));
  const identifiers = new Set(ordered.map(key));
  if (identifiers.size !== nodes.length) throw failure('duplicate node identity');
  if (edges.some(edge => !identifiers.has(edge.from) || !identifiers.has(edge.to))) throw failure('edge references an absent node');
  const selected = new Set(roots.filter(root => identifiers.has(root)).slice(0, limits.maxNodes));
  for (const node of ordered) {
    if (selected.size >= limits.maxNodes) break;
    selected.add(key(node));
  }
  const selectedNodes = ordered.filter(node => selected.has(key(node)));
  const selectedEdges = edges.filter(edge => selected.has(edge.from) && selected.has(edge.to)).slice(0, limits.maxEdges);
  const omittedNodes = nodes.length - selectedNodes.length, omittedEdges = edges.length - selectedEdges.length;
  return { nodes: selectedNodes, edges: selectedEdges, view: { ...limits, omittedNodes, omittedEdges, complete: omittedNodes === 0 && omittedEdges === 0 } };
}

const omission = view => `${view.omittedNodes} nodes and ${view.omittedEdges} edges omitted from view`;

function selectImports(nodes, edges, roots, reverse, limits) {
  const ordered = [...nodes].sort((a, b) => compare(a.file, b.file));
  const identifiers = new Set(ordered.map(node => node.file));
  if (identifiers.size !== nodes.length) throw failure('duplicate node identity');
  if (edges.some(edge => !identifiers.has(edge.from) || !identifiers.has(edge.to))) throw failure('edge references an absent node');
  const adjacency = new Map();
  for (const edge of edges) {
    const from = reverse ? edge.to : edge.from;
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(edge);
  }
  // Establish breadth-first parents before clipping. This keeps a grandchild
  // from consuming a slot before a direct neighbor, even if its name sorts first.
  const queue = [...new Set(roots.filter(root => identifiers.has(root)))], reachable = new Set(queue), parents = new Map();
  for (let at = 0; at < queue.length; at++) {
    for (const edge of adjacency.get(queue[at]) || []) {
      const next = reverse ? edge.from : edge.to;
      if (reachable.has(next)) continue;
      reachable.add(next); queue.push(next); parents.set(next, { node: queue[at], edge });
    }
  }
  const selected = new Set(queue.filter(node => !parents.has(node)).slice(0, limits.maxNodes)), tree = [];
  for (const node of queue) {
    const parent = parents.get(node);
    if (!parent || !selected.has(parent.node) || selected.size >= limits.maxNodes || tree.length >= limits.maxEdges) continue;
    selected.add(node); tree.push(parent.edge);
  }
  // Unconnected facts may fill remaining space only after the root component
  // fits. A clipped reachable child is never reintroduced as an isolated node.
  if (selected.size === reachable.size) for (const node of ordered) {
    if (selected.size >= limits.maxNodes) break;
    if (!reachable.has(node.file)) selected.add(node.file);
  }
  const treeSet = new Set(tree);
  const selectedEdges = [...tree, ...edges.filter(edge => !treeSet.has(edge) && selected.has(edge.from) && selected.has(edge.to))].slice(0, limits.maxEdges);
  const omittedNodes = nodes.length - selected.size, omittedEdges = edges.length - selectedEdges.length;
  return {
    nodes: ordered.filter(node => selected.has(node.file)), edges: selectedEdges,
    view: { ...limits, omittedNodes, omittedEdges, complete: omittedNodes === 0 && omittedEdges === 0 },
  };
}

export function projectGraph(result, options = {}) {
  const limits = bounds(options);
  if (!result || result.source !== 'worktree' || result.relation !== 'observed-module-imports'
    || !Array.isArray(result.nodes) || !Array.isArray(result.edges) || !Array.isArray(result.roots)
    || result.nodes.some(node => !node || !text(node.file))
    || result.edges.some(edge => !edge || !text(edge.from) || !text(edge.to) || !text(edge.resolution))) throw failure('expected a module-import graph result');
  const edges = [...result.edges].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.via || '', b.via || '') || compare(a.resolution, b.resolution));
  const selected = selectImports(result.nodes, edges, result.roots, result.operation === 'dependents', limits);
  const nodes = selected.nodes.map((node, index) => ({ ...clone(node), diagramId: `n${index}`, origin: 'extracted' }));
  const ids = new Map(nodes.map(node => [node.file, node.diagramId]));
  const projectedEdges = selected.edges.map(edge => ({ ...clone(edge), origin: 'extracted', relation: 'observed-module-imports' }));
  const status = `Module imports; outcome ${result.outcome || 'unknown'}; coverage ${result.coverage?.complete ? 'complete' : 'incomplete'}; ${omission(selected.view)}; upstream omissions ${result.omitted?.edges || 0} edges and ${result.omitted?.unresolved || 0} unresolved imports${result.depthLimitReached ? '; traversal depth limit reached' : ''}; not runtime calls or proof`;
  const source = [
    'flowchart TB',
    `  ae_status["${label(status)}"]`,
    ...nodes.map(node => `  ${node.diagramId}["${label(node.file)}"]`),
    ...projectedEdges.map(edge => `  ${ids.get(edge.from)} -->|${label(`imports (${edge.resolution})`)}| ${ids.get(edge.to)}`),
    ...(nodes.length ? [] : ['  ae_empty["No extracted module nodes available"]']),
  ].join('\n') + '\n';
  return {
    format: 'mermaid', kind: 'module-imports', source,
    metadata: {
      version: 1, kind: 'module-imports', scope: 'worktree', authority: 'descriptive-context',
      semantics: 'Module import declarations; not runtime calls or proof.',
      ...pick(result, ['snapshot', 'generation', 'source', 'freshness', 'producer', 'relation', 'operation', 'roots', 'depth', 'limit', 'outcome', 'path', 'coverage', 'depthLimitReached', 'omitted', 'unresolved', 'cache']),
      nodes, edges: projectedEdges, view: selected.view,
    },
  };
}

export function projectFlow(result, flowId, options = {}) {
  const limits = bounds(options);
  if (!result || result.model?.version !== 1 || result.model.format !== 'statechart' || !Array.isArray(result.model.flows)
    || !result.preparation || !text(flowId)) throw failure('a saved application flow model and flow ID are required');
  const flow = result.model.flows.find(item => item.id === flowId);
  if (!flow) throw failure('requested flow is absent from the saved model');
  if (!Array.isArray(flow.states) || !Array.isArray(flow.transitions)
    || flow.states.some(state => !state || !text(state.id)) || !flow.states.some(state => state.id === flow.initial)
    || flow.transitions.some(edge => !edge || !text(edge.from) || !text(edge.to) || !text(edge.event) || edge.guard !== undefined && !text(edge.guard))) throw failure('invalid application flow statechart');
  const transitions = [...flow.transitions].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.event, b.event) || compare(a.guard || '', b.guard || ''));
  const selected = select(flow.states, transitions, [flow.initial], state => state.id, limits);
  const nodes = selected.nodes.map((state, index) => ({ ...clone(state), diagramId: `s${index}`, origin: 'authored' }));
  const ids = new Map(nodes.map(state => [state.id, state.diagramId]));
  const projectedTransitions = selected.edges.map(edge => ({ ...clone(edge), origin: 'authored' }));
  const status = `Application flow ${flow.title}; status ${result.state || 'unknown'}; committed default branch; descriptive context; ${omission(selected.view)}; not verification or proof`;
  const source = [
    'stateDiagram-v2',
    ...nodes.map(state => `  state "${label(`${state.id}${state.kind ? ` (${state.kind})` : ''}`)}" as ${state.diagramId}`),
    `  [*] --> ${ids.get(flow.initial)}`,
    ...projectedTransitions.map(edge => `  ${ids.get(edge.from)} --> ${ids.get(edge.to)} : ${label(`${edge.event}${edge.guard === undefined ? '' : ` [${edge.guard}]`}`)}`),
    `  note right of ${ids.get(flow.initial)} : ${label(status)}`,
  ].join('\n') + '\n';
  return {
    format: 'mermaid', kind: 'application-flow', source,
    metadata: {
      version: 1, kind: 'application-flow', scope: 'committed-default-branch', authority: 'descriptive-context',
      semantics: 'Authored application flow; not verification or proof.',
      ...pick(result, ['state', 'reason', 'generationCommit', 'defaultCommit', 'defaultRef', 'sha256', 'reference', 'projectId', 'changedPaths', 'omittedChangedPaths', 'preparation']),
      flowId: flow.id, title: flow.title, initial: flow.initial,
      ...pick(flow, ['sources', 'properties']),
      ...pick(result.model, ['assumptions', 'limitations']),
      nodes, transitions: projectedTransitions, view: selected.view,
    },
  };
}
