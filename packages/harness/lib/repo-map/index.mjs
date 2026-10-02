import { builtinModules } from 'node:module';
import path from 'node:path';
import { tokenize } from '../tokenize.mjs';
import { estimateTokens } from '../token-meter.mjs';
import { extract as lexicalExtract, SOURCE_EXTENSIONS } from './lexical-extractor.mjs';
import { writeFileContained } from '../fs-safe.mjs';
import { codebaseMapWriteRel } from '../project-layout.mjs';
import { trackedSourceFiles, readFileSafe } from './scan.mjs';
import { readStructuralIndexIfCurrent } from './structural-index.mjs';

const DEFAULT_MAX_TOKENS = 1000;
const IMPORT_SUFFIX = /\.(?:js|jsx|mjs|cjs|ts|tsx|py|java)$/i;
const NODE_BUILTINS = new Set(builtinModules);

function compareRel(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requestRel(workspace, raw) {
  let text = String(raw ?? '').trim().replace(/\\/g, '/');
  if (path.isAbsolute(text)) {
    const relative = path.relative(path.resolve(workspace), path.resolve(text));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      text = relative.split(path.sep).join('/');
    }
  }
  if (text.startsWith('./')) text = text.slice(2);
  return text;
}

function currentStructuralFiles(workspace) {
  try {
    return readStructuralIndexIfCurrent(workspace)?.files || null;
  } catch {
    return null;
  }
}

function fileFacts(workspace, rels) {
  const structural = currentStructuralFiles(workspace);
  const facts = new Map();
  for (const rel of rels) {
    const pre = structural?.[rel];
    const extracted = pre || lexicalExtract(rel, readFileSafe(workspace, rel));
    facts.set(rel, {
      rel,
      symbols: Array.isArray(extracted.symbols) ? extracted.symbols : [],
      imports: Array.isArray(extracted.imports) ? extracted.imports : [],
    });
  }
  return facts;
}

function relativeTargets(fromRel, specifier, trackedSet) {
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return [];
  if (trackedSet.has(normalized)) return normalized === fromRel ? [] : [normalized];
  if (path.posix.extname(normalized)) return [];
  const matches = [];
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${normalized}${ext}`;
    if (candidate !== fromRel && trackedSet.has(candidate)) matches.push(candidate);
  }
  return matches;
}

function moduleIndex(rels) {
  const byModule = new Map();
  const add = (key, rel) => {
    if (!key) return;
    if (!byModule.has(key)) byModule.set(key, []);
    byModule.get(key).push(rel);
  };
  for (const rel of rels) {
    const noExt = rel.replace(IMPORT_SUFFIX, '');
    add(noExt, rel);
    if (rel.endsWith('/__init__.py')) add(rel.slice(0, -'/__init__.py'.length), rel);
  }
  return byModule;
}

function moduleTargets(specifier, byModule) {
  const cleaned = String(specifier).replace(/['"]/g, '').trim().replace(IMPORT_SUFFIX, '');
  if (!cleaned || cleaned.includes('/') || cleaned.startsWith('node:') || NODE_BUILTINS.has(cleaned)) return [];
  const asPath = cleaned.split('.').filter(Boolean).join('/');
  if (!asPath) return [];
  const suffix = `/${asPath}`;
  const matches = new Set();
  for (const [key, rels] of byModule) {
    if (key !== asPath && !key.endsWith(suffix)) continue;
    for (const rel of rels) matches.add(rel);
  }
  return matches.size === 1 ? [...matches] : [];
}

function importTargets(fromRel, specifier, byModule, trackedSet) {
  const cleaned = String(specifier).replace(/['"]/g, '').trim();
  if (!cleaned) return [];
  if (cleaned.startsWith('./') || cleaned.startsWith('../')) return relativeTargets(fromRel, cleaned, trackedSet);
  return moduleTargets(cleaned, byModule).filter((rel) => rel !== fromRel);
}

function importEdges(facts, trackedSet) {
  const byModule = moduleIndex(trackedSet);
  const incoming = new Map();
  const outgoing = new Map();
  for (const { rel, imports } of facts.values()) {
    const seen = new Set();
    for (const imp of imports) {
      for (const target of importTargets(rel, imp, byModule, trackedSet)) {
        if (seen.has(target)) continue;
        seen.add(target);
        if (!outgoing.has(rel)) outgoing.set(rel, []);
        outgoing.get(rel).push(target);
        if (!incoming.has(target)) incoming.set(target, []);
        incoming.get(target).push(rel);
      }
    }
  }
  return { incoming, outgoing };
}

export function buildRepoMap({ workspace, query = '', maxTokens = DEFAULT_MAX_TOKENS, extract = lexicalExtract, title = 'Repo Map', preferStructural = true } = {}) {
  const { files, total } = trackedSourceFiles(workspace);
  if (!files.length) return { files: [], body: '', tokens: 0, empty: true };

    let structural = null;
  if (preferStructural) {
    try {
      structural = readStructuralIndexIfCurrent(workspace);
    } catch {
      structural = null;
    }
  }

  const info = new Map();
  for (const rel of files) {
    const pre = structural?.files?.[rel];
    const { symbols, imports } = pre || extract(rel, readFileSafe(workspace, rel));
    info.set(rel, { rel, symbols, imports, importedBy: 0 });
  }

    const byStem = new Map();
  for (const rel of files) {
    const stem = path.basename(rel).replace(/\.\w+$/, '');
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(rel);
  }
  for (const { imports } of info.values()) {
    for (const imp of imports) {
      const last = imp.replace(/['"]/g, '').split(/[./\\]/).filter(Boolean).pop();
      for (const target of byStem.get(last) || []) info.get(target).importedBy += 1;
    }
  }

  const queryTokens = new Set(tokenize(query));
  const scored = [...info.values()].map((f) => {
    let queryScore = 0;
    if (queryTokens.size) {
      const hay = new Set(tokenize(`${f.rel} ${f.symbols.join(' ')}`));
      for (const t of queryTokens) if (hay.has(t)) queryScore += 1;
    }
    const degreeScore = f.importedBy * 2 + Math.min(f.symbols.length, 12);
    return { ...f, score: queryScore * 5 + degreeScore };
  });
  // Locale-independent tie-break: the committed map must be byte-identical
  // across hosts for the same tree.
  scored.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const lines = [
    `# ${title}`,
    '',
    `> Deterministic ${structural ? 'structural' : 'lexical'} map of ${total} tracked source files${total > files.length ? ` (top ${files.length} scanned)` : ''}.${query ? ` Ranked for: "${query}".` : ''}`,
    '',
  ];
  const selected = [];
  for (const f of scored) {
    const symbolList = f.symbols.slice(0, 6).join(', ');
    const entry = `- \`${f.rel}\`${f.importedBy ? ` (imported by ${f.importedBy})` : ''}${symbolList ? ` — ${symbolList}` : ''}`;
    if (estimateTokens([...lines, entry].join('\n')) > maxTokens) break;
    lines.push(entry);
    selected.push(f.rel);
  }

  const body = lines.join('\n');
  return { files: selected, body, tokens: estimateTokens(body), empty: false, totalFiles: total, structural: Boolean(structural) };
}

export function buildNeighborhood({ workspace, files = [] } = {}) {
  const { files: tracked } = trackedSourceFiles(workspace);
  const trackedSet = new Set(tracked);
  const facts = fileFacts(workspace, tracked);
  const { incoming, outgoing } = importEdges(facts, trackedSet);
  const requested = Array.isArray(files) ? files : [files];
  const missing = [];
  const seenMissing = new Set();
  const seeds = [];
  const seenSeeds = new Set();
  for (const raw of requested) {
    const rel = requestRel(workspace, raw);
    if (rel && trackedSet.has(rel)) {
      if (!seenSeeds.has(rel)) {
        seenSeeds.add(rel);
        seeds.push(rel);
      }
      continue;
    }
    const label = rel || String(raw ?? '');
    if (!seenMissing.has(label)) {
      seenMissing.add(label);
      missing.push(label);
    }
  }
  const hop = new Set(seeds);
  for (const rel of seeds) {
    for (const target of outgoing.get(rel) || []) hop.add(target);
    for (const source of incoming.get(rel) || []) hop.add(source);
  }
  return {
    files: [...hop].sort(compareRel).map((rel) => ({
      rel,
      symbols: facts.get(rel).symbols,
      imports: facts.get(rel).imports,
      importedBy: [...(incoming.get(rel) || [])].sort(compareRel),
    })),
    missing,
  };
}

/**
 * Write the query-less codebase map. Committed docs/codebase-map.md is kept
 * when that file or docs/plans already exists; otherwise the map lives under
 * gitignored .harness/codebase-map.md.
 */
export function writeCodebaseMap({ workspace, dryRun = false, maxTokens = 2500 }) {
  // The map stays lexical-only (preferStructural: false): it must
  // be byte-identical across hosts for the same tree, and whether a given
  // host has built a structural index is host-local state that must never
  // leak into a committed artifact.
  const map = buildRepoMap({ workspace, query: '', maxTokens, title: 'Codebase Map', preferStructural: false });
  if (map.empty) return null;
  const rel = codebaseMapWriteRel(workspace);
  if (!dryRun) {
    // Refuse to write through a symlinked `docs/` (or a pre-planted symlink
    // at the target itself) — a naive mkdir+write would otherwise follow
    // either straight out of the workspace. writeFileContained also writes
    // atomically (tmp + rename), so a concurrent reader never observes a
    // partial map.
    const full = writeFileContained(workspace, rel, map.body + '\n');
    if (!full) return null;
  }
  return { path: rel.split(path.sep).join('/'), tokens: map.tokens, files: map.files.length };
}
