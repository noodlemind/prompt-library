import path from 'node:path';
import { builtinModules } from 'node:module';
import { SOURCE_EXTENSIONS } from './lexical-extractor.mjs';

export const IMPORT_RESOLVER_VERSION = 1;
const IMPORT_SUFFIX = /\.(?:js|jsx|mjs|cjs|ts|tsx|py|java)$/i;
const NODE_BUILTINS = new Set(builtinModules);

function uniqueOther(rels, fromRel) {
  const hits = [...(rels || [])];
  return hits.length === 1 && hits[0] !== fromRel ? hits : [];
}

function pathCandidates(normalized, fromRel, trackedSet) {
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return [];
  if (trackedSet.has(normalized)) return normalized === fromRel ? [] : [normalized];
  if (path.posix.extname(normalized)) return [];
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


export function importResolver(trackedSet) {
  const lookup = moduleIndex(trackedSet);
  return (from, specifier) => {
    const cleaned = String(specifier).replace(/['"]/g, '').trim();
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
    return { targets, resolution: null, reason: (candidates?.size ?? candidates?.length ?? 0) > 1 ? 'ambiguous' : 'unresolved' };
  };
}

export function buildImportGraph(facts, trackedSet, { maxEdges = 20_000, maxUnresolved = 4_000 } = {}) {
  const resolve = importResolver(trackedSet);
  const modules = [];
  const unresolvedImports = [];
  let moduleEdgesTruncated = false;
  let unresolvedTruncated = false;
  for (const [from, fact] of facts) {
    const seen = new Set();
    const unresolved = new Set();
    for (const specifier of fact.imports) {
      const match = resolve(from, specifier);
      for (const to of match.targets) {
        if (seen.has(to)) continue;
        seen.add(to);
        if (modules.length < maxEdges) modules.push({ from, to, via: specifier, resolution: match.resolution });
        else moduleEdgesTruncated = true;
      }
      if (!match.targets.length && !['self', 'external'].includes(match.reason) && !unresolved.has(specifier)) {
        unresolved.add(specifier);
        if (unresolvedImports.length < maxUnresolved) unresolvedImports.push({ from, import: specifier, reason: match.reason });
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
