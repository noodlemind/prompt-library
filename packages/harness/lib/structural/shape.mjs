// Structural index shape — the single integration contract between the
// structural index builder (`harness index --structural`, Phase 3) and every
// consumer (the `structural-expectations` verify check, orient enrichment,
// doctor S1). Consumers import THIS module only; when the builder lands, the
// integration is one import swap here, not a change in every consumer.
//
// Storage root: `~/.harness/index/<repo-id>/structural/` (HARNESS_HOME
// overrides the home for tests). Four files:
//
// files.json    { "version": 1, "files": { "<rel-path>": {
//                   "hash": "<sha256 of content>", "mtime": <epoch-ms>,
//                   "size": <bytes>, "symbols": ["name", ...],
//                   "imports": ["specifier", ...], "complexity": <int>
//                 } } }
// symbols.json  { "version": 1, "symbols": [ {
//                   "name": "...", "file": "<rel-path>", "kind": "function|class|const|...",
//                   "exported": true|false, "def": { "line": <1-based> },
//                   "refs": [ { "file": "<rel-path>", "line": <1-based> } ]
//                 } ] }
// graph.json    { "version": 1,
//                 "calls": [ { "from": "<rel-path>#<symbol>", "to": "<rel-path>#<symbol>" } ],
//                 "modules": [ { "from": "<rel-path>", "to": "<rel-path>" } ],
//                 "unresolved": [ { "from": "<rel-path>#<symbol>", "to": "<bare-name>" } ] }
// meta.json     { "version": 1, "sha": "<full commit sha the index was built at>",
//                 "branch": "...", "baseSha": "...", "generatedAt": "<ISO 8601>",
//                 "extractorTier": "lexical|tree-sitter", "grammarVersions": {} }
//
// Read semantics: `meta.json` is mandatory — without it the index is treated
// as absent. The other three degrade to empty structures when missing so a
// partially written index never crashes a consumer; any malformed JSON marks
// the whole index unreadable (consumers skip, never guess).

import fs from 'node:fs';
import path from 'node:path';
import { harnessGlobalHome } from '../paths.mjs';
import { repoId } from '../knowledge/store.mjs';

export const STRUCTURAL_SHAPE_VERSION = 1;

const EMPTY_FILES = Object.freeze({ version: STRUCTURAL_SHAPE_VERSION, files: {} });
const EMPTY_SYMBOLS = Object.freeze({ version: STRUCTURAL_SHAPE_VERSION, symbols: [] });
const EMPTY_GRAPH = Object.freeze({ version: STRUCTURAL_SHAPE_VERSION, calls: [], modules: [], unresolved: [] });

/** `<home>/index/<repo-id>/structural` for this workspace. */
export function structuralDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'index', repoId(workspace), 'structural');
}

function readJson(dir, name) {
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) return { value: null, error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: `${name} is not a JSON object` };
    }
    return { value: parsed, error: null };
  } catch (error) {
    return { value: null, error: `${name}: ${error.message}` };
  }
}

/**
 * Read the structural index for a workspace.
 * Returns `{ present, reason, files, symbols, graph, meta }`:
 * - `present: false` with a `reason` when the index is missing or unreadable —
 *   consumers must skip, never fail, on that signal.
 * - `present: true` with normalized `files` (map), `symbols` (array),
 *   `graph` ({calls, modules, unresolved}), and `meta` otherwise.
 *
 * Two on-disk encodings are accepted and normalized to one consumer shape:
 * the builder's compact form (`files.json` is a bare rel→entry map,
 * `symbols.json` a bare name→{defs,refs} map, `graph.json` with
 * `{modules, unresolvedImports, calls: [{from, symbol, to: [files]}],
 * unresolvedCalls}`), and the documented wrapper form above. The builder's
 * form is authoritative; the wrapper form keeps fixtures readable.
 */
export function readStructuralIndex(workspace, { home } = {}) {
  const dir = structuralDir(workspace, { home });
  const absent = (reason) => ({ present: false, reason, dir, files: {}, symbols: [], graph: EMPTY_GRAPH, meta: null });
  if (!fs.existsSync(dir)) return absent('structural index not found');

  const meta = readJson(dir, 'meta.json');
  if (meta.error) return absent(`unreadable meta.json (${meta.error})`);
  if (!meta.value) return absent('structural index has no meta.json');
  if (typeof meta.value.sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(meta.value.sha)) {
    return absent('meta.json has no valid baseline sha');
  }

  const files = readJson(dir, 'files.json');
  const symbols = readJson(dir, 'symbols.json');
  const graph = readJson(dir, 'graph.json');
  const broken = files.error || symbols.error || graph.error;
  if (broken) return absent(`unreadable structural index (${broken})`);

  return {
    present: true,
    reason: null,
    dir,
    files: normalizeFiles(files.value),
    symbols: normalizeSymbols(symbols.value),
    graph: normalizeGraph(graph.value),
    meta: meta.value,
  };
}

function normalizeFiles(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_FILES.files };
  // Wrapper form: { version, files: {...} }. Builder form: the map itself.
  if (parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) return parsed.files;
  if ('version' in parsed && !('files' in parsed)) return { ...EMPTY_FILES.files };
  return parsed;
}

function normalizeSymbols(parsed) {
  if (!parsed || typeof parsed !== 'object') return [...EMPTY_SYMBOLS.symbols];
  // Wrapper form: { version, symbols: [rows] } already row-shaped.
  if (Array.isArray(parsed.symbols)) return parsed.symbols;
  // Builder form: { "<name>": { defs: [{file, line, kind, exported}], refs: [{file, line}] } }
  // → one row per def, carrying the symbol's shared refs.
  const rows = [];
  for (const [name, entry] of Object.entries(parsed)) {
    if (name === 'version' || !entry || typeof entry !== 'object') continue;
    const refs = Array.isArray(entry.refs) ? entry.refs : [];
    for (const def of Array.isArray(entry.defs) ? entry.defs : []) {
      if (!def || typeof def.file !== 'string') continue;
      rows.push({
        name,
        file: def.file,
        kind: def.kind || 'symbol',
        exported: def.exported === true,
        def: { line: Number.isFinite(def.line) ? def.line : 0 },
        refs,
      });
    }
  }
  return rows;
}

function normalizeGraph(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_GRAPH };
  const calls = [];
  for (const edge of Array.isArray(parsed.calls) ? parsed.calls : []) {
    if (!edge || typeof edge.from !== 'string') continue;
    if (typeof edge.symbol === 'string' && Array.isArray(edge.to)) {
      // Builder form: caller file + callee symbol + defining files.
      for (const target of edge.to) {
        if (typeof target === 'string') calls.push({ from: `${edge.from}#${edge.symbol}`, to: `${target}#${edge.symbol}` });
      }
    } else if (typeof edge.to === 'string') {
      calls.push({ from: edge.from, to: edge.to });
    }
  }
  const unresolved = [];
  for (const entry of Array.isArray(parsed.unresolved) ? parsed.unresolved : []) {
    if (entry && typeof entry.from === 'string' && typeof entry.to === 'string') unresolved.push(entry);
  }
  for (const entry of Array.isArray(parsed.unresolvedCalls) ? parsed.unresolvedCalls : []) {
    if (entry && typeof entry.from === 'string' && typeof entry.symbol === 'string') {
      unresolved.push({ from: `${entry.from}#${entry.symbol}`, to: entry.symbol });
    }
  }
  for (const entry of Array.isArray(parsed.unresolvedImports) ? parsed.unresolvedImports : []) {
    if (entry && typeof entry.from === 'string' && typeof entry.import === 'string') {
      unresolved.push({ from: entry.from, to: entry.import });
    }
  }
  return {
    calls,
    modules: Array.isArray(parsed.modules) ? parsed.modules : [],
    unresolved,
  };
}
