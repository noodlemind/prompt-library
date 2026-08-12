import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from '../paths.mjs';
import { repoId } from '../knowledge/store.mjs';
import { readFileNoFollow } from '../fs-safe.mjs';

export const STRUCTURAL_SHAPE_VERSION = 1;

const worktreeIds = new Map();

export function worktreeId(workspace) {
  const key = path.resolve(workspace);
  const cached = worktreeIds.get(key);
  if (cached) return cached;
  let root = key;
  const top = spawnSync('git', ['-C', key, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10_000 });
  if (top.status === 0 && top.stdout.trim()) root = top.stdout.trim();
  try {
    root = fs.realpathSync(root);
  } catch {
    // keep the resolved path
  }
  const id = `wt-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  worktreeIds.set(key, id);
  return id;
}

const EMPTY_FILES = Object.freeze({ version: STRUCTURAL_SHAPE_VERSION, files: {} });
const EMPTY_SYMBOLS = Object.freeze({ version: STRUCTURAL_SHAPE_VERSION, symbols: [] });
const EMPTY_GRAPH = Object.freeze({ version: STRUCTURAL_SHAPE_VERSION, calls: [], modules: [], unresolved: [] });

/** `<home>/index/<repo-id>/<worktree-id>/structural` for this workspace. */
export function structuralDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'index', repoId(workspace), worktreeId(workspace), 'structural');
}

function readJson(dir, name) {
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) return { value: null, error: null };
    const body = readFileNoFollow(full, { root: dir });
  if (body === null) return { value: null, error: `${name} is unreadable (symlink, oversized, or open failure)` };
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: `${name} is not a JSON object` };
    }
    return { value: parsed, error: null };
  } catch (error) {
    return { value: null, error: `${name}: ${error.message}` };
  }
}

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
    const version = meta.value.version;
  if (version !== undefined && !(Number.isFinite(version) && version <= STRUCTURAL_SHAPE_VERSION)) {
    return absent(`unsupported structural index version ${JSON.stringify(version)} (this harness reads ${STRUCTURAL_SHAPE_VERSION})`);
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
