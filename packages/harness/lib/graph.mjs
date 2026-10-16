import path from 'node:path';
import { readStructuralIndex } from './repo-map/structural-index.mjs';
import { trackedSourceFiles } from './repo-map/scan.mjs';
import { readFileFacts, readSourceHashes, contentHash, FILE_FACTS_VERSION } from './repo-map/facts.mjs';
import { buildImportGraph, IMPORT_RESOLVER_VERSION } from './repo-map/imports.mjs';
import { EXIT } from './style.mjs';

export const GRAPH_OPERATIONS = ['deps', 'dependents', 'path'];

function usage(message) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint: 'harness help graph' });
}

function filePath(workspace, value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw usage('graph requires a repository file path');
  const absolute = path.resolve(workspace, value);
  const rel = path.relative(workspace, absolute).split(path.sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) throw usage('graph file must be inside the workspace');
  return rel;
}

export function queryGraph({ workspace, home, operation = 'deps', files = [], depth = operation === 'path' ? 8 : 1, limit = 50 }) {
  if (!GRAPH_OPERATIONS.includes(operation)) throw usage('graph operation must be deps, dependents or path');
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 32 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw usage('graph depth must be 1 to 32 and limit must be 1 to 200');
  if (files.length !== (operation === 'path' ? 2 : 1)) throw usage('graph requires one file, or two files for path');
  const roots = files.map(file => filePath(path.resolve(workspace), file));
  const inventory = trackedSourceFiles(workspace);
  const cached = readStructuralIndex(workspace, { home });
  const read = readFileFacts(workspace, inventory.files, { cachedFiles: cached && !cached.unreadable.length && cached.meta.fileFactsVersion === FILE_FACTS_VERSION ? cached.files : null });
  const { facts } = read;
  const graph = buildImportGraph(facts, new Set(inventory.files));
  const finalInventory = trackedSourceFiles(workspace);
  const finalHashes = readSourceHashes(workspace, inventory.files);
  const sourceChanged = finalInventory.unavailable || finalInventory.inventoryHash !== inventory.inventoryHash || [...facts].some(([rel, fact]) => fact.hash !== finalHashes.get(rel));
  const coverage = {
    tracked: inventory.total,
    scanned: facts.size,
    filesTruncated: inventory.total > facts.size,
    unavailable: inventory.unavailable,
    sourceChanged,
    unreadable: [...facts.values()].filter(fact => fact.tier === 'unreadable').length,
    parseErrors: [...facts.values()].filter(fact => fact.errors).length,
    extractionTruncated: [...facts.values()].some(fact => Object.values(fact.limitsReached).some(Boolean)),
    extractionUnknown: [...facts.values()].some(fact => fact.coverageUnknown),
    moduleEdgesTruncated: graph.moduleEdgesTruncated,
    unresolvedTruncated: graph.unresolvedTruncated,
    unresolvedImports: graph.unresolvedImports.length,
    heuristicEdges: graph.modules.filter(edge => edge.resolution === 'unique-local').length,
  };
  coverage.complete = !Object.entries(coverage).some(([key, value]) => !['tracked', 'scanned'].includes(key) && Boolean(value));
  const snapshot = contentHash(JSON.stringify({ resolverVersion: IMPORT_RESOLVER_VERSION, inventory: inventory.inventoryHash, facts: [...facts].map(([file, fact]) => [file, fact.hash, fact.imports, fact.tier, fact.errors, fact.limitsReached]) }));
  const result = {
    operation, roots, snapshot, source: 'worktree', relation: 'observed-module-imports', depth, limit,
    cache: { generation: cached?.generation || null, reused: read.reused, refreshed: facts.size - read.reused },
    coverage, outcome: 'found', path: null, nodes: [], edges: [], unresolved: [],
    omitted: { edges: 0, unresolved: 0 }, depthLimitReached: false,
  };
  if (sourceChanged || inventory.unavailable) return { ...result, outcome: 'unknown' };
  if (roots.some(rel => !facts.has(rel) || facts.get(rel).tier === 'unreadable')) return { ...result, outcome: coverage.complete ? 'missing' : 'unknown' };
  const reverse = operation === 'dependents';
  const adjacency = new Map();
  for (const edge of graph.modules) {
    const source = reverse ? edge.to : edge.from;
    if (!adjacency.has(source)) adjacency.set(source, []);
    adjacency.get(source).push(edge);
  }
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  for (const edges of adjacency.values()) edges.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.via, b.via));
  const visited = new Map([[roots[0], { distance: 0, parent: null, edge: null }]]);
  const queue = [roots[0]];
  const selected = [];
  for (let at = 0; at < queue.length; at += 1) {
    const from = queue[at];
    const distance = visited.get(from).distance;
    const edges = adjacency.get(from) || [];
    if (distance >= depth) {
      if (edges.some(edge => !visited.has(reverse ? edge.from : edge.to))) result.depthLimitReached = true;
      continue;
    }
    for (const edge of edges) {
      const to = reverse ? edge.from : edge.to;
      if (operation !== 'path') {
        if (selected.length < limit) selected.push(edge);
        else result.omitted.edges += 1;
      }
      if (!visited.has(to)) {
        visited.set(to, { distance: distance + 1, parent: from, edge });
        queue.push(to);
      }
    }
  }
  if (operation === 'path') {
    if (visited.has(roots[1])) {
      const route = [];
      const edges = [];
      for (let file = roots[1]; file !== null; file = visited.get(file).parent) {
        route.unshift(file);
        if (visited.get(file).edge) edges.unshift(visited.get(file).edge);
      }
      if (edges.length <= limit) { result.path = route; selected.push(...edges); }
      else { result.outcome = 'truncated'; result.omitted.edges = edges.length; }
    } else result.outcome = coverage.complete && !result.depthLimitReached ? 'not-found' : 'unknown';
  }
  result.edges = selected.map(edge => ({ ...edge, via: edge.via.slice(0, 512), viaTruncated: edge.via.length > 512 }));
  const nodes = new Set([roots[0], ...(result.path || [])]);
  for (const edge of selected) { nodes.add(edge.from); nodes.add(edge.to); }
  result.nodes = [...nodes].sort().map(file => ({ file, tier: facts.get(file).tier, hash: facts.get(file).hash, errors: facts.get(file).errors }));
  const unresolved = graph.unresolvedImports.filter(edge => visited.has(edge.from));
  result.unresolved = unresolved.slice(0, limit).map(edge => ({ ...edge, import: edge.import.slice(0, 512), ...(edge.import.length > 512 ? { importTruncated: true } : {}) }));
  result.omitted.unresolved = Math.max(0, unresolved.length - limit);
  return result;
}
