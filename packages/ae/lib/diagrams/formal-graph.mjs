import { formalFailure, readTlcState } from './formal-protocol.mjs';

function quoted(text) {
  let value = '';
  if (text[0] !== '"') throw formalFailure('TLC DOT attribute needs a quoted value');
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '"') return { value, rest: text.slice(i + 1) };
    if (text[i] !== '\\') value += text[i];
    else {
      const next = text[++i];
      if (!['n', '"', '\\'].includes(next)) throw formalFailure('TLC DOT has an unsupported escape');
      value += next === 'n' ? '\n' : next;
    }
  }
  throw formalFailure('TLC DOT quoted value is incomplete');
}

function attributes(text) {
  const values = new Map();
  let rest = text.trim();
  while (rest) {
    const name = /^([A-Za-z]+)\s*=\s*/.exec(rest);
    if (!name || values.has(name[1])) throw formalFailure('TLC DOT has malformed or duplicate attributes');
    rest = rest.slice(name[0].length);
    let value;
    if (rest.startsWith('"')) ({ value, rest } = quoted(rest));
    else {
      const word = /^[A-Za-z]+/.exec(rest);
      if (!word) throw formalFailure('TLC DOT attribute value is unsupported');
      value = word[0]; rest = rest.slice(word[0].length);
    }
    values.set(name[1], value);
    rest = rest.trim();
    if (rest && !rest.startsWith(',')) throw formalFailure('TLC DOT attributes need a separator');
    rest = rest.slice(1).trim();
  }
  return values;
}

/** Accept the saved TLC dump grammar, never general Graphviz directives. */
export function readTlcGraph(dot) {
  if (typeof dot !== 'string' || !dot || new TextEncoder().encode(dot).length > 512 * 1024 || dot.includes('\0')) throw formalFailure('recorded TLC graph is missing or exceeds 512 KiB');
  const nodes = [], edges = [], ids = new Map(), steps = new Set(), ranked = [];
  let opened = false, depth = 0, closed = false, variableNames;
  for (const line of dot.replaceAll('\r\n', '\n').split('\n').map(value => value.trim()).filter(Boolean)) {
    if (!opened) {
      if (line !== 'strict digraph DiskGraph {') throw formalFailure('recorded graph is not a supported TLC DOT dump');
      opened = true; depth = 1; continue;
    }
    if (closed) throw formalFailure('TLC DOT contains content after the graph');
    if (line === 'subgraph cluster_graph {' && depth === 1) { depth += 1; continue; }
    if (line === '}') { if (--depth === 0) closed = true; continue; }
    if (line === 'nodesep=0.35;' && depth === 1) continue;
    if (depth !== 2) throw formalFailure('TLC DOT has an unexpected graph statement');
    if (line === 'color="white";') continue;
    if (/^\{rank = same;(?:\s*-?\d+;)+\}$/.test(line)) {
      ranked.push(...line.slice('{rank = same;'.length, -1).split(';').map(value => value.trim()).filter(Boolean));
      continue;
    }
    const entry = /^(-?\d+)(?: -> (-?\d+))? \[(.*)\];?$/.exec(line);
    if (!entry) throw formalFailure('TLC DOT has an unsupported graph statement');
    const attrs = attributes(entry[3]), label = attrs.get('label');
    if (label === undefined) throw formalFailure('TLC DOT state or transition has no label');
    if (entry[2] !== undefined) {
      if ([...attrs.keys()].some(key => !['label', 'color', 'fontcolor'].includes(key)) || ['color', 'fontcolor'].some(key => attrs.has(key) && attrs.get(key) !== 'black')) throw formalFailure('TLC DOT transition attributes are unsupported');
      const key = JSON.stringify([entry[1], entry[2], label]);
      if (!steps.has(key)) { steps.add(key); edges.push({ recordedFrom: entry[1], recordedTo: entry[2], action: label, role: 'transition' }); }
    } else {
      if ([...attrs.keys()].some(key => !['label', 'style'].includes(key)) || attrs.has('style') && attrs.get('style') !== 'filled') throw formalFailure('TLC DOT state attributes are unsupported');
      if (ids.has(entry[1])) throw formalFailure('TLC DOT has duplicate state identities');
      const variables = readTlcState(label), names = variables.map(v => v.name).sort().join(',');
      if (variableNames !== undefined && variableNames !== names) throw formalFailure('TLC DOT states have inconsistent variable sets');
      variableNames = names;
      const node = { id: `s${nodes.length}`, recordedId: entry[1], initial: attrs.get('style') === 'filled', variables };
      ids.set(entry[1], node.id); nodes.push(node);
    }
    if (nodes.length > 200 || edges.length > 2000) throw formalFailure('recorded graph exceeds its state or transition budget');
  }
  if (!closed || depth || !nodes.length || !nodes.some(node => node.initial)) throw formalFailure('recorded TLC graph is incomplete or has no initial state');
  if (ranked.some(id => !ids.has(id))) throw formalFailure('TLC DOT layout references a missing state');
  for (const edge of edges) {
    edge.from = ids.get(edge.recordedFrom); edge.to = ids.get(edge.recordedTo);
    if (!edge.from || !edge.to) throw formalFailure('TLC DOT transition references a missing state');
  }
  const reached = new Set(nodes.filter(node => node.initial).map(node => node.id));
  const pending = [...reached], outgoing = new Map();
  for (const edge of edges) {
    const group = outgoing.get(edge.from) || []; group.push(edge.to); outgoing.set(edge.from, group);
  }
  for (let i = 0; i < pending.length; i++) for (const next of outgoing.get(pending[i]) || []) if (!reached.has(next)) { reached.add(next); pending.push(next); }
  if (reached.size !== nodes.length) throw formalFailure('TLC DOT contains a state unreachable from its recorded initial states');
  return { nodes, edges };
}

export function formalGraphSource(graph, note, redact) {
  const encode = value => [...String(value)].map(ch => /^[A-Za-z0-9 _]$/.test(ch) ? ch : `#${ch.codePointAt(0)};`).join('');
  const nodes = graph.nodes.map(node => ({ id: node.id, ...(node.recordedId === undefined ? {} : { recordedId: node.recordedId }),
    label: redact(node.variables.map(value => node.variables.length === 1 ? value.valueText : `${value.name}=${value.valueText}`).join(' ')), initial: node.initial }));
  const edges = graph.edges.map(edge => ({ from: edge.from, to: edge.to, action: redact(edge.action), role: edge.role }));
  return { nodes, edges, source: ['stateDiagram-v2', ...nodes.map(node => `  state "${encode(node.label)}" as ${node.id}`),
    ...nodes.filter(node => node.initial).map(node => `  [*] --> ${node.id}`),
    ...edges.map(edge => `  ${edge.from} --> ${edge.to} : ${encode(edge.action)}`), `  note right of s0 : ${encode(redact(note))}`].join('\n') + '\n' };
}
