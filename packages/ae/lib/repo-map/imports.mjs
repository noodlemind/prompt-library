import path from 'node:path';
import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { SOURCE_EXTENSIONS } from './lexical-extractor.mjs';
import { loadResolverConfigs, configuredTargets } from './resolver-config.mjs';

export const IMPORT_RESOLVER_VERSION = 2;
const IMPORT_SUFFIX = /\.(?:js|jsx|mjs|cjs|ts|tsx|py|java)$/i;
const NODE_BUILTINS = new Set(builtinModules);
const edgeId = (...parts) => `edge:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;

function uniqueOther(rels, fromRel) {
  const hits = [...(rels || [])];
  return hits.length === 1 && hits[0] !== fromRel ? hits : [];
}

function pathCandidates(normalized, fromRel, trackedSet) {
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return [];
  if (trackedSet.has(normalized)) return normalized === fromRel ? [] : [normalized];
  const extension = path.posix.extname(normalized);
  if (extension) {
    const substitutions = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }[extension] || [];
    return substitutions.map(ext => normalized.slice(0, -extension.length) + ext).filter(file => trackedSet.has(file));
  }
  const files = [];
  const indexes = [];
  for (const ext of SOURCE_EXTENSIONS) {
    const file = `${normalized}${ext}`;
    const index = `${normalized}/index${ext}`;
    if (trackedSet.has(file)) files.push(file);
    if (trackedSet.has(index)) indexes.push(index);
  }
  const init = `${normalized}/__init__.py`;
  if (trackedSet.has(init)) indexes.push(init);
  return files.length ? files : indexes;
}

function relativeTargets(fromRel, specifier, trackedSet) {
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  return uniqueOther(pathCandidates(normalized, fromRel, trackedSet), fromRel);
}

function dotsToRelative(specifier) {
  const match = /^(\.+)(.*)$/.exec(specifier);
  if (!match) return '';
  const climbs = match[1].length - 1;
  const rest = match[2].split('.').filter(Boolean).join('/');
  const prefix = climbs <= 0 ? './' : '../'.repeat(climbs);
  return rest ? `${prefix}${rest}` : prefix;
}

function addKey(map, key, rel) {
  if (!key) return;
  let bucket = map.get(key);
  if (!bucket) map.set(key, (bucket = new Set()));
  bucket.add(rel);
}

function addSuffixes(map, key, rel) {
  const parts = key.split('/');
  for (let i = 0; i < parts.length; i++) addKey(map, parts.slice(i).join('/'), rel);
}

function moduleIndex(rels) {
  const exact = new Map();
  const suffix = new Map();
  for (const rel of rels) {
    const noExt = rel.replace(IMPORT_SUFFIX, '');
    addKey(exact, rel, rel);
    addKey(exact, noExt, rel);
    addSuffixes(suffix, noExt, rel);
    if (rel.endsWith('/__init__.py')) {
      const pkg = rel.slice(0, -'/__init__.py'.length);
      addKey(exact, pkg, rel);
      addSuffixes(suffix, pkg, rel);
    }
  }
  return { exact, suffix };
}

function moduleTargets(specifier, lookup, fromRel) {
  const cleaned = String(specifier).replace(/['"]/g, '').trim();
  if (!cleaned || cleaned.startsWith('node:') || NODE_BUILTINS.has(cleaned)) return [];
  if (cleaned.includes('/')) {
    if (IMPORT_SUFFIX.test(cleaned)) {
      const preferred = uniqueOther(lookup.exact.get(cleaned), fromRel);
      if (preferred.length) return preferred;
    }
    return uniqueOther(lookup.exact.get(cleaned.replace(IMPORT_SUFFIX, '')), fromRel);
  }
  const asPath = cleaned.replace(IMPORT_SUFFIX, '').split('.').filter(Boolean).join('/');
  if (!asPath) return [];
  return uniqueOther(lookup.suffix.get(asPath), fromRel);
}

function targetsFor(fromRel, specifier, lookup, trackedSet) {
  const cleaned = String(specifier).replace(/['"]/g, '').trim();
  if (!cleaned) return [];
  if (cleaned.startsWith('./') || cleaned.startsWith('../')) return relativeTargets(fromRel, cleaned, trackedSet);
  if (cleaned.startsWith('.')) {
    const asRelative = dotsToRelative(cleaned);
    return asRelative ? relativeTargets(fromRel, asRelative, trackedSet) : [];
  }
  return moduleTargets(cleaned, lookup, fromRel);
}


export function importResolver(trackedSet, { workspace } = {}) {
  const lookup = moduleIndex(trackedSet);
  const configs = loadResolverConfigs(workspace);
  return (from, specifier, { occurrence } = {}) => {
    const cleaned = String(specifier).replace(/['"]/g, '').trim();
    if (!cleaned || cleaned.startsWith('node:') || NODE_BUILTINS.has(cleaned)) return { targets: [], resolution: null, reason: 'external' };
    const configured = configuredTargets(from, cleaned, configs, normalized => pathCandidates(normalized, from, trackedSet));
    if (configured) return {
      targets: configured.candidates.length === 1 ? configured.candidates : [],
      candidates: configured.candidates.slice(0, 32),
      resolution: configured.candidates.length === 1 ? 'configured-path' : null,
      reason: configured.unsupported ? 'unsupported-configuration' : configured.candidates.length > 1 ? 'ambiguous' : configured.candidates.length ? null : 'configured-path-unresolved',
      evidence: configured.evidence,
    };
    if (/\.java$/i.test(from) && occurrence?.bindings?.some(binding => binding.kind === 'static')) {
      const owner = cleaned.slice(0, cleaned.lastIndexOf('.'));
      const matches = [...(lookup.suffix.get(owner.split('.').join('/')) || [])].filter(file => file !== from);
      if (matches.length === 1) return { targets: matches, resolution: 'unique-local', reason: null };
      if (matches.length > 1) return { targets: [], candidates: matches, resolution: null, reason: 'ambiguous' };
    }
    const targets = targetsFor(from, cleaned, lookup, trackedSet);
    const relative = cleaned.startsWith('.');
    if (targets.length) return { targets, resolution: relative ? 'relative' : 'unique-local', reason: null };
    if (!cleaned || cleaned.startsWith('node:') || NODE_BUILTINS.has(cleaned)) return { targets, resolution: null, reason: 'external' };
    let candidates;
    if (relative) {
      const rel = cleaned.startsWith('./') || cleaned.startsWith('../') ? cleaned : dotsToRelative(cleaned);
      const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(from), rel));
      if (normalized === from) return { targets, resolution: null, reason: 'self' };
      candidates = pathCandidates(normalized, from, trackedSet);
    } else if (cleaned.includes('/')) {
      candidates = lookup.exact.get(cleaned.replace(IMPORT_SUFFIX, ''));
    } else {
      candidates = lookup.suffix.get(cleaned.replace(IMPORT_SUFFIX, '').split('.').filter(Boolean).join('/'));
    }
    return { targets, candidates: [...(candidates || [])].filter(file => file !== from).slice(0, 32), resolution: null, reason: (candidates?.size ?? candidates?.length ?? 0) > 1 ? 'ambiguous' : 'unresolved' };
  };
}

function occurrenceEvidence(from, fact, specifier) {
  return (fact.importOccurrences || []).filter(item => item?.specifier === specifier && item.range && Number.isSafeInteger(item.range.startLine) && item.range.startLine > 0).map(item => ({ path: from, sha256: fact.hash || null, range: item.range }));
}

/** Bind a local identifier to explicit import sources, never to same-name globals. */
export function resolveImportBinding(from, local, fact, trackedSet, options = {}) {
  const resolve = options.resolve || importResolver(trackedSet, options), bindings = [], evidence = [];
  const occurrences = (fact.importOccurrences || []).filter(occurrence => occurrence?.bindings?.some(binding => binding.local === local));
  for (const occurrence of occurrences) {
    const match = resolve(from, occurrence.specifier, { occurrence });
    for (const binding of occurrence.bindings.filter(binding => binding.local === local && binding.kind !== 'type')) {
      for (const target of match.targets) bindings.push({ ...binding, target, specifier: occurrence.specifier, resolution: match.resolution });
    }
    evidence.push(...occurrenceEvidence(from, fact, occurrence.specifier), ...(match.evidence || []));
  }
  const targets = [...new Set(bindings.map(binding => binding.target))];
  const typeOnly = occurrences.length && occurrences.every(occurrence => occurrence.bindings.filter(binding => binding.local === local).every(binding => binding.kind === 'type'));
  return { targets, bindings, evidence: evidence.slice(0, 32), method: 'static-resolver', resolutionStatus: targets.length === 1 ? 'candidate' : targets.length > 1 ? 'ambiguous' : 'unresolved', reason: typeOnly ? 'type-only-import' : targets.length ? 'explicit-import-binding' : occurrences.length ? 'unresolved-import-binding' : 'no-explicit-binding' };
}

export function buildImportGraph(facts, trackedSet, { maxEdges = 20_000, maxUnresolved = 4_000, workspace } = {}) {
  const resolve = importResolver(trackedSet, { workspace });
  const modules = [];
  const unresolvedImports = [];
  let moduleEdgesTruncated = false;
  let unresolvedTruncated = false;
  for (const [from, fact] of facts) {
    const seen = new Map();
    const unresolved = new Set();
    for (const specifier of fact.imports) {
      const occurrence = fact.importOccurrences?.find(item => item.specifier === specifier);
      const match = resolve(from, specifier, { occurrence });
      const evidence = [...occurrenceEvidence(from, fact, specifier), ...(match.evidence || [])];
      const method = fact.tier === 'treesitter' ? 'ast' : 'lexical';
      for (const to of match.targets) {
        if (!facts.has(to) || facts.get(to).tier === 'unreadable') {
          if (!unresolved.has(specifier)) {
            unresolved.add(specifier);
            if (unresolvedImports.length < maxUnresolved) unresolvedImports.push({ id: edgeId('unresolved-import', from, specifier), from, import: specifier, reason: 'unreadable', method, resolutionStatus: 'unresolved', candidates: [to], evidence: evidence.slice(0, 32) });
            else unresolvedTruncated = true;
          }
          continue;
        }
        const prior = seen.get(to);
        if (prior) {
          const room = Math.max(0, 32 - prior.evidence.length);
          prior.evidence.push(...evidence.slice(0, room));
          prior.evidenceOmitted = (prior.evidenceOmitted || 0) + Math.max(0, evidence.length - room);
          continue;
        }
        if (modules.length < maxEdges) {
          const edge = { id: edgeId('module-import', from, to), from, to, via: specifier, resolution: match.resolution, method, resolutionStatus: ['relative', 'configured-path'].includes(match.resolution) ? 'exact-under-rule' : 'candidate', resolverVersion: IMPORT_RESOLVER_VERSION, evidence: evidence.slice(0, 32), ...(evidence.length > 32 ? { evidenceOmitted: evidence.length - 32 } : {}) };
          seen.set(to, edge); modules.push(edge);
        } else moduleEdgesTruncated = true;
      }
      if (!match.targets.length && !['self', 'external'].includes(match.reason) && !unresolved.has(specifier)) {
        unresolved.add(specifier);
        if (unresolvedImports.length < maxUnresolved) unresolvedImports.push({ id: edgeId('unresolved-import', from, specifier), from, import: specifier, reason: match.reason, method, resolutionStatus: match.reason === 'ambiguous' ? 'ambiguous' : 'unresolved', candidates: match.candidates || [], evidence: evidence.slice(0, 32) });
        else unresolvedTruncated = true;
      }
    }
  }
  return { modules, unresolvedImports, moduleEdgesTruncated, unresolvedTruncated };
}

export function importEdges(facts, trackedSet) {
  const { modules } = buildImportGraph(facts, trackedSet, { maxEdges: Infinity, maxUnresolved: 0 });
  const incoming = new Map();
  const outgoing = new Map();
  for (const { from, to } of modules) {
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(to);
    if (!incoming.has(to)) incoming.set(to, []);
    incoming.get(to).push(from);
  }
  return { incoming, outgoing };
}
