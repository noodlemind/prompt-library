import path from 'node:path';
import { readStructuralIndex, buildStructuralIndex, structuralIndexIsCurrent } from './repo-map/structural-index.mjs';
import { trackedSourceFiles } from './repo-map/scan.mjs';
import { readFileFacts, readSourceHashes, contentHash, FILE_FACTS_VERSION } from './repo-map/facts.mjs';
import { buildImportGraph, IMPORT_RESOLVER_VERSION } from './repo-map/imports.mjs';
import { captureWorkingSources } from './repo-map/working-sources.mjs';
import { EXIT } from './style.mjs';

export const GRAPH_OPERATIONS = ['deps', 'dependents', 'path', 'explain', 'impact'];
const GENERATION = /^[a-f0-9]{32}$/;
const routeOperation = operation => operation === 'path' || operation === 'explain';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function usage(message) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint: 'ae help graph' });
}

function snapshotError(message) {
  return Object.assign(new Error(message), { code: 'E_GRAPH_SNAPSHOT', exit: 1, hint: 'Use a retained structural generation returned by ae index --structural; snapshots never fall back to current source.' });
}

function filePath(workspace, value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw usage('graph requires a repository file path');
  const absolute = path.resolve(workspace, value);
  const rel = path.relative(workspace, absolute).split(path.sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) throw usage('graph file must be inside the workspace');
  return rel;
}

/** Refresh syntax with the shipped parser before the synchronous query API.
 * A named generation is historical evidence and never refreshes source. */
export async function prepareGraph(options) {
  const { workspace, home, generation = null } = options;
  if ('operation' in options) validateGraphQuery(options);
  const dryRun = options.dryRun === true || options.flags?.dryRun === true;
  if (generation !== null) {
    if (!GENERATION.test(generation)) throw usage('graph generation must be a 32-character lowercase hexadecimal identifier');
    return { generation, refreshed: false, historical: true, ...(dryRun ? { dryRun: true } : {}) };
  }
  if (dryRun) return { generation: null, refreshed: false, dryRun: true };
  const { createTreesitterExtract, packageGrammarRoots } = await import('./repo-map/treesitter-extractor.mjs');
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  const prior = readStructuralIndex(workspace, { home });
  const sameExtractor = prior?.meta?.fileFactsVersion === FILE_FACTS_VERSION
    && prior.meta.extractorTier === extractor.tier
    && JSON.stringify(prior.meta.grammarVersions || {}) === JSON.stringify(extractor.grammarVersions || {})
    && JSON.stringify(prior.meta.webTreeSitter || null) === JSON.stringify(extractor.webTreeSitter || null);
  if (sameExtractor && structuralIndexIsCurrent(workspace, prior)) return { generation: prior.generation, refreshed: false, tier: extractor.tier };
  const built = await buildStructuralIndex({ workspace, home, extractor });
  if (!built.written) {
    if (built.sourceChanged) throw Object.assign(new Error('graph source changed during preparation; retry'), { code: 'E_GRAPH_PREPARE', exit: 1 });
    return { generation: null, refreshed: false, degraded: true, tier: 'lexical', reason: built.reason || { code: 'E_STRUCTURAL_PREPARE', message: 'A complete structural generation could not be published.' } };
  }
  return { generation: built.meta.generation, refreshed: true, reparsed: built.reparsed, reused: built.reused, tier: extractor.tier };
}

export function validateGraphQuery({ workspace, operation = 'deps', files = [], depth = routeOperation(operation) ? 8 : 1, limit = 50, generation = null }) {
  if (!GRAPH_OPERATIONS.includes(operation)) throw usage('graph operation must be deps, dependents, path, explain or impact');
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 32 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw usage('graph depth must be 1 to 32 and limit must be 1 to 200');
  if (files.length !== (routeOperation(operation) ? 2 : 1)) throw usage('graph requires one file, or two files for path/explain');
  if (generation !== null && !GENERATION.test(generation)) throw usage('graph generation must be a 32-character lowercase hexadecimal identifier');
  return files.map(file => filePath(path.resolve(workspace), file));
}

function storedGraph(index) {
  const modules = index.graph?.modules;
  if (!Array.isArray(modules) || modules.some(edge => !edge || typeof edge.from !== 'string' || typeof edge.to !== 'string' || typeof edge.via !== 'string' || typeof edge.resolution !== 'string'
    || !index.files[edge.from] || !index.files[edge.to])) throw snapshotError('structural generation has invalid module relationships');
  const unresolvedImports = index.graph.unresolvedImports ?? [];
  if (!Array.isArray(unresolvedImports) || unresolvedImports.some(edge => !edge || typeof edge.from !== 'string' || typeof edge.import !== 'string' || typeof edge.reason !== 'string'
    || !index.files[edge.from])) throw snapshotError('structural generation has invalid unresolved relationships');
  return {
    ...index.graph, modules, unresolvedImports,
    moduleEdgesTruncated: Boolean(index.meta.moduleEdgesTruncated), unresolvedTruncated: Boolean(index.meta.unresolvedTruncated),
  };
}

function indexedAdjacency(graph, reverse) {
  const stored = graph.adjacency;
  const key = reverse ? 'reverse' : 'forward';
  const map = new Map();
  if (stored?.version === 1) {
    const rows = stored[key];
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw snapshotError('structural generation has invalid adjacency');
    const seen = new Set();
    for (const [file, indexes] of Object.entries(rows)) {
      if (!Array.isArray(indexes)) throw snapshotError('structural generation has invalid adjacency');
      const edges = [];
      for (const index of indexes) {
        const edge = Number.isSafeInteger(index) && graph.modules[index];
        if (!edge || (reverse ? edge.to : edge.from) !== file || seen.has(index)) throw snapshotError('structural generation has invalid adjacency');
        seen.add(index); edges.push(edge);
      }
      map.set(file, edges);
    }
    if (seen.size !== graph.modules.length) throw snapshotError('structural generation adjacency omits relationships');
  } else {
    for (const edge of graph.modules) {
      const source = reverse ? edge.to : edge.from;
      if (!map.has(source)) map.set(source, []);
      map.get(source).push(edge);
    }
  }
  for (const edges of map.values()) edges.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.via, b.via));
  return map;
}

export function queryGraph({ workspace, home, operation = 'deps', files = [], depth = routeOperation(operation) ? 8 : 1, limit = 50, generation = null, lexicalFallback = false }) {
  const roots = validateGraphQuery({ workspace, operation, files, depth, limit, generation });
  let facts, graph, coverage, cached, reused, sourceIdentity = null, currentGeneration = null, adjacencyReused = false;
  if (generation) {
    cached = readStructuralIndex(workspace, { home, generation });
    if (!cached?.meta || cached.unreadable.length || cached.generation !== generation) throw snapshotError('selected structural generation is unavailable or unreadable');
    graph = storedGraph(cached);
    sourceIdentity = cached.meta.sourceState || null;
    facts = new Map(Object.entries(cached.files).map(([rel, fact]) => [rel, { ...fact, rel }]));
    reused = facts.size; adjacencyReused = Boolean(graph.adjacency);
    coverage = {
      tracked: cached.meta.totalTracked ?? facts.size, scanned: facts.size,
      filesTruncated: Boolean(cached.meta.truncated), unavailable: false, sourceChanged: false,
      unreadable: cached.meta.unreadableFiles || 0, parseErrors: cached.meta.errorFiles || 0,
      extractionTruncated: Boolean(cached.meta.extractionTruncated), extractionUnknown: !cached.meta.sourceState,
      moduleEdgesTruncated: graph.moduleEdgesTruncated, unresolvedTruncated: graph.unresolvedTruncated,
      unresolvedImports: graph.unresolvedImports.length, heuristicEdges: graph.modules.filter(edge => edge.resolution === 'unique-local').length,
    };
  } else {
    const inventory = trackedSourceFiles(workspace);
    cached = lexicalFallback ? null : readStructuralIndex(workspace, { home });
    const source = cached?.meta?.sourceState ? captureWorkingSources(workspace) : null;
    sourceIdentity = source?.state || null;
    const compatible = source?.valid && cached.meta.sourceState.version === source.state.version
      && cached.meta.sourceState.configDigest === source.state.configDigest
      && cached.meta.sourceState.extractorRevision === source.state.extractorRevision;
    const read = readFileFacts(workspace, inventory.files, { cachedFiles: compatible && !cached.unreadable.length && cached.meta.fileFactsVersion === FILE_FACTS_VERSION ? cached.files : null });
    facts = read.facts; reused = read.reused;
    const stored = compatible && !cached.unreadable.length && source.state.digest === cached.meta.sourceState.digest
      && cached.meta.fileFactsVersion === FILE_FACTS_VERSION && [...facts].every(([rel, fact]) => fact.hash === cached.files[rel]?.hash);
    graph = stored ? storedGraph(cached) : buildImportGraph(facts, new Set(inventory.files), { workspace });
    if (stored) currentGeneration = cached.generation;
    adjacencyReused = Boolean(stored && graph.adjacency);
    const finalInventory = trackedSourceFiles(workspace);
    const finalHashes = readSourceHashes(workspace, inventory.files);
    const finalSource = source ? captureWorkingSources(workspace) : null;
    const sourceChanged = finalInventory.unavailable || finalInventory.inventoryHash !== inventory.inventoryHash
      || source && (!finalSource?.valid || source.state.digest !== finalSource.state.digest)
      || [...facts].some(([rel, fact]) => fact.hash !== finalHashes.get(rel));
    coverage = {
      tracked: inventory.total, scanned: facts.size, filesTruncated: inventory.total > facts.size, unavailable: inventory.unavailable, sourceChanged,
      unreadable: [...facts.values()].filter(fact => fact.tier === 'unreadable').length,
      parseErrors: [...facts.values()].filter(fact => fact.errors).length,
      extractionTruncated: [...facts.values()].some(fact => Object.values(fact.limitsReached).some(Boolean)),
      extractionUnknown: [...facts.values()].some(fact => fact.coverageUnknown),
      moduleEdgesTruncated: graph.moduleEdgesTruncated, unresolvedTruncated: graph.unresolvedTruncated,
      unresolvedImports: graph.unresolvedImports.length, heuristicEdges: graph.modules.filter(edge => edge.resolution === 'unique-local').length,
    };
  }
  coverage.complete = !Object.entries(coverage).some(([key, value]) => !['tracked', 'scanned'].includes(key) && Boolean(value));
  Object.assign(coverage, { scope: 'git-tracked-source', semanticCompleteness: 'unverified', untrackedFiles: 'excluded', lexicalFiles: [...facts.values()].filter(fact => fact.tier === 'lexical').length });
  const snapshot = contentHash(JSON.stringify({
    resolverVersion: generation ? cached.meta.resolverVersion : IMPORT_RESOLVER_VERSION,
    sourceIdentity,
    producer: cached?.meta ? { fileFactsVersion: cached.meta.fileFactsVersion, extractorSignature: cached.meta.extractorSignature } : null,
    facts: [...facts].map(([file, fact]) => [file, fact.hash, fact.imports, fact.tier, Boolean(fact.errors), fact.limitsReached || {}]),
    modules: graph.modules, unresolved: graph.unresolvedImports,
  }));
  const result = {
    operation, roots, snapshot, generation: generation || currentGeneration,
    source: generation ? 'snapshot' : 'worktree', scope: 'git-tracked-source', relation: 'observed-module-imports', authority: 'descriptive-context', depth, limit,
    freshness: generation ? { state: 'historical', liveValidated: false } : { state: coverage.sourceChanged || coverage.unavailable ? 'unknown' : 'current', liveValidated: !coverage.sourceChanged && !coverage.unavailable },
    producer: {
      resolverVersion: generation ? cached.meta.resolverVersion : IMPORT_RESOLVER_VERSION,
      fileFactsVersion: cached?.meta?.fileFactsVersion || FILE_FACTS_VERSION,
      extractorTier: [...new Set([...facts.values()].filter(fact => fact.tier !== 'unreadable').map(fact => fact.tier))].join('+') || 'unavailable',
      grammarVersions: cached?.meta?.grammarVersions || {},
      integrityFailures: cached?.meta?.integrityFailures || [],
      missingGrammars: cached?.meta?.missingGrammars || [],
    },
    cache: { generation: cached?.generation || null, reused, refreshed: facts.size - reused, adjacencyReused },
    coverage, outcome: 'found', path: null, nodes: [], edges: [], unresolved: [], omitted: { edges: 0, unresolved: 0 }, depthLimitReached: false,
    ...(operation === 'explain' ? { explanation: [] } : {}), ...(operation === 'impact' ? { affected: [] } : {}),
  };
  if (coverage.sourceChanged || coverage.unavailable) return { ...result, outcome: 'unknown' };
  if (roots.some(rel => !facts.has(rel) || facts.get(rel).tier === 'unreadable')) return { ...result, outcome: coverage.complete ? 'missing' : 'unknown' };
  const reverse = operation === 'dependents' || operation === 'impact';
  const adjacency = indexedAdjacency(graph, reverse);
  const visited = new Map([[roots[0], { distance: 0, parent: null, edge: null }]]);
  const queue = [roots[0]], selected = [];
  for (let at = 0; at < queue.length; at += 1) {
    const from = queue[at], distance = visited.get(from).distance, edges = adjacency.get(from) || [];
    if (distance >= depth) {
      if (edges.some(edge => !visited.has(reverse ? edge.from : edge.to))) result.depthLimitReached = true;
      continue;
    }
    for (const edge of edges) {
      const to = reverse ? edge.from : edge.to;
      if (!routeOperation(operation)) {
        if (selected.length < limit) selected.push(edge);
        else result.omitted.edges += 1;
      }
      if (!visited.has(to)) { visited.set(to, { distance: distance + 1, parent: from, edge }); queue.push(to); }
    }
  }
  if (routeOperation(operation)) {
    if (visited.has(roots[1])) {
      const route = [], edges = [];
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
  if (operation === 'explain') result.explanation = result.edges.map(edge => ({ from: edge.from, to: edge.to, relation: 'imports', method: edge.method || 'lexical', resolution: edge.resolutionStatus || (edge.resolution === 'relative' ? 'exact-under-rule' : 'candidate'), evidence: edge.evidence || [], authority: 'descriptive-context', limitation: 'Import declarations do not establish runtime calls or complete architecture.' }));
  if (operation === 'impact') result.affected = result.nodes.filter(node => node.file !== roots[0]).map(node => ({ ...node, distance: visited.get(node.file).distance, reason: 'reverse-import-path', authority: 'advisory' })).sort((a, b) => a.distance - b.distance || compare(a.file, b.file));
  return result;
}
