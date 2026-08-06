// Persistent structural codebase index (blueprint P3). Lives OUTSIDE the
// knowledge git store at ~/.harness/index/<repo-id>/structural/ — derived and
// rebuildable: deleting the directory never loses knowledge, and it never
// touches governance history. Four tables:
//   files.json    per-file { hash, mtime, size, symbols, imports, complexity,
//                 defs, refs, tier } — the superset the incremental rebuild
//                 and symbol table are derived from
//   symbols.json  declaration table: name → { defs: [{file,line,kind,
//                 exported}], refs: [{file,line}] }
//   graph.json    caller/callee approximation + module dependency edges;
//                 unresolved edges preserved EXPLICITLY, never fabricated
//   meta.json     { sha, branch, baseSha, generatedAt, extractorTier,
//                 grammarVersions, ... } — the P9 generation-context stamp
// All writes are atomic temp+rename through fs-safe's writeFileContained.
// Building is async-command-path work (harness index --structural); READING
// is fully synchronous so buildRepoMap/orient stay sync and model-free.
//
// Extracted names/locations are UNTRUSTED repo text: every string passes
// redactSecrets + a length cap at index-WRITE time here, and every human or
// agent render additionally passes inertLine (renderStructuralDigest).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from '../paths.mjs';
import { repoId, inertLine } from '../knowledge/store.mjs';
import { writeFileContained, readFileNoFollow } from '../fs-safe.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { estimateTokens } from '../token-meter.mjs';
import { EXIT } from '../style.mjs';
import { trackedSourceFiles, readFileSafe } from './scan.mjs';
import { MAX_IDENTIFIER_LENGTH } from './treesitter-extractor.mjs';

export const STRUCTURAL_INDEX_VERSION = 1;

// Bounded tables: a hostile or simply huge tree must not balloon the index
// or any surface rendered from it.
const MAX_SYMBOL_TABLE = 20_000;
const MAX_DEFS_PER_SYMBOL = 20;
const MAX_REFS_PER_SYMBOL = 50;
const MAX_MODULE_EDGES = 20_000;
const MAX_CALL_EDGES = 20_000;
const MAX_UNRESOLVED = 4_000;
const MAX_DELTA_NAMES = 50;

function git(workspace, args) {
  const r = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** ~/.harness/index/<repo-id>/structural — respects HARNESS_HOME via harnessGlobalHome. */
export function structuralIndexDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'index', repoId(workspace), 'structural');
}

function readJson(dir, name) {
  const body = readFileNoFollow(path.join(dir, name), { root: dir });
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Synchronous, tolerant read of the prebuilt index. Returns
 * { dir, meta, files, symbols, graph } or null when no readable index exists.
 * The `<home>/index` pre-check keeps the common no-index case free of the
 * repoId git spawn — orient calls this every session.
 */
export function readStructuralIndex(workspace, { home } = {}) {
  if (!fs.existsSync(path.join(home || harnessGlobalHome(), 'index'))) return null;
  const dir = structuralIndexDir(workspace, { home });
  if (!fs.existsSync(path.join(dir, 'meta.json'))) return null;
  const meta = readJson(dir, 'meta.json');
  if (!meta || typeof meta !== 'object' || !meta.version) return null;
  return {
    dir,
    meta,
    files: readJson(dir, 'files.json') || {},
    symbols: readJson(dir, 'symbols.json') || {},
    graph: readJson(dir, 'graph.json') || {},
  };
}

/**
 * The orient-side gate: hand back the index ONLY when its generation stamp
 * matches the current HEAD — otherwise consumers keep their unchanged lexical
 * behavior. Cheap when absent (one existsSync, no git spawn).
 */
export function readStructuralIndexIfCurrent(workspace, { home } = {}) {
  if (!fs.existsSync(path.join(home || harnessGlobalHome(), 'index'))) return null;
  const index = readStructuralIndex(workspace, { home });
  if (!index || !index.meta.sha) return null;
  const head = git(workspace, ['rev-parse', 'HEAD']);
  if (!head || head !== index.meta.sha) return null;
  return index;
}

/**
 * Validate a user-supplied `--since` ref: reject anything that could read as
 * a git option (leading `-`), then require `git rev-parse --verify` to
 * resolve it to a commit — always after `--end-of-options`. Returns the
 * resolved sha; throws the CLI usage-error shape otherwise.
 */
export function validateSinceRef(workspace, ref) {
  const value = String(ref || '').trim();
  if (!value || value.startsWith('-')) {
    throw Object.assign(new Error(`invalid --since ref: ${JSON.stringify(String(ref || ''))}`), {
      code: 'E_USAGE',
      hint: 'pass a git ref (branch, tag, or sha) that does not start with "-"',
      exit: EXIT.usage,
    });
  }
  const sha = git(workspace, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${value}^{commit}`]);
  if (!sha) {
    throw Object.assign(new Error(`--since ref does not resolve to a commit: ${JSON.stringify(value)}`), {
      code: 'E_USAGE',
      hint: 'git rev-parse --verify <ref> must succeed in this workspace',
      exit: EXIT.usage,
    });
  }
  return sha;
}

function changedFilesSince(workspace, sha) {
  const out = git(workspace, ['diff', '--name-only', sha, '--']);
  if (out === null) return null; // diff failed → caller degrades to a full pass
  return new Set(out.split('\n').filter(Boolean));
}

// Names and free-text fields extracted from repo files are untrusted: redact
// secret-shaped content FIRST (a truncated credential might no longer match
// the screen), then cap the length.
function cleanName(name) {
  const redacted = redactSecrets(String(name ?? ''));
  return redacted.length > MAX_IDENTIFIER_LENGTH ? redacted.slice(0, MAX_IDENTIFIER_LENGTH) : redacted;
}

function sanitizeEntry(res, { hash, mtime, size }) {
  return {
    hash,
    mtime,
    size,
    symbols: (res.symbols || []).map(cleanName),
    imports: (res.imports || []).map(cleanName),
    complexity: Number.isFinite(res.complexity) ? res.complexity : 1,
    defs: (res.defs || []).map((d) => ({
      name: cleanName(d.name),
      kind: String(d.kind || 'symbol').slice(0, 24),
      line: Number.isFinite(d.line) ? d.line : 0,
      exported: Boolean(d.exported),
    })),
    refs: (res.refs || []).map((r) => ({
      name: cleanName(r.name),
      line: Number.isFinite(r.line) ? r.line : 0,
    })),
    tier: res.tier === 'treesitter' ? 'treesitter' : 'lexical',
    ...(res.hasErrors ? { errors: true } : {}),
  };
}

function buildSymbolTable(files) {
  const symbols = {};
  const rels = Object.keys(files).sort();
  for (const rel of rels) {
    for (const d of files[rel].defs) {
      if (!symbols[d.name]) {
        if (Object.keys(symbols).length >= MAX_SYMBOL_TABLE) continue;
        symbols[d.name] = { defs: [], refs: [] };
      }
      if (symbols[d.name].defs.length < MAX_DEFS_PER_SYMBOL) {
        symbols[d.name].defs.push({ file: rel, line: d.line, kind: d.kind, exported: d.exported });
      }
    }
  }
  for (const rel of rels) {
    for (const r of files[rel].refs) {
      const entry = symbols[r.name];
      if (entry && entry.refs.length < MAX_REFS_PER_SYMBOL) entry.refs.push({ file: rel, line: r.line });
    }
  }
  return symbols;
}

function buildGraph(files, symbols) {
  const rels = Object.keys(files).sort();
  // Module edges use the same basename-stem approximation the repo map uses
  // for import-degree. An import that resolves to no tracked file is KEPT as
  // an unresolved edge — recorded, never guessed into a target.
  const byStem = new Map();
  for (const rel of rels) {
    const stem = path.basename(rel).replace(/\.\w+$/, '');
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(rel);
  }
  const modules = [];
  const unresolvedImports = [];
  for (const rel of rels) {
    for (const imp of files[rel].imports) {
      // Strip a trailing source extension first: './b.mjs' must stem to 'b',
      // not 'mjs' (the bare split would take the extension as the last part).
      const last = imp
        .replace(/['"]/g, '')
        .replace(/\.(?:js|jsx|mjs|cjs|ts|tsx|py|java)$/i, '')
        .split(/[./\\]/)
        .filter(Boolean)
        .pop();
      const targets = (last && byStem.get(last)) || [];
      if (targets.length) {
        for (const to of targets) {
          if (to !== rel && modules.length < MAX_MODULE_EDGES) modules.push({ from: rel, to, via: imp });
        }
      } else if (unresolvedImports.length < MAX_UNRESOLVED) {
        unresolvedImports.push({ from: rel, import: imp });
      }
    }
  }
  // Caller/callee approximation: a ref name that the declaration table binds
  // to files OTHER than the caller becomes a call edge; everything else is an
  // explicit unresolved call, never a fabricated edge.
  const calls = [];
  const unresolvedCalls = [];
  const seenUnresolved = new Set();
  for (const rel of rels) {
    const perFile = new Map();
    for (const r of files[rel].refs) {
      if (perFile.has(r.name)) continue;
      perFile.set(r.name, true);
      const entry = symbols[r.name];
      const to = entry ? [...new Set(entry.defs.map((d) => d.file))].filter((f) => f !== rel).slice(0, 5) : [];
      if (to.length) {
        if (calls.length < MAX_CALL_EDGES) calls.push({ from: rel, symbol: r.name, to });
      } else if (!entry) {
        const key = `${rel} ${r.name}`;
        if (!seenUnresolved.has(key) && unresolvedCalls.length < MAX_UNRESOLVED) {
          seenUnresolved.add(key);
          unresolvedCalls.push({ from: rel, symbol: r.name });
        }
      }
    }
  }
  return { modules, unresolvedImports, calls, unresolvedCalls };
}

function symbolDelta(priorSymbols, nextSymbols) {
  const prior = priorSymbols || {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const name of Object.keys(nextSymbols)) {
    if (!(name in prior)) added.push(name);
    else if (JSON.stringify(prior[name].defs) !== JSON.stringify(nextSymbols[name].defs)) changed.push(name);
  }
  for (const name of Object.keys(prior)) {
    if (!(name in nextSymbols)) removed.push(name);
  }
  const cap = (list) => ({ count: list.length, names: list.sort().slice(0, MAX_DELTA_NAMES) });
  return { added: cap(added), removed: cap(removed), changed: cap(changed) };
}

/**
 * Build (or incrementally refresh) the structural index. Async only because
 * the command path around it is async — the work itself is local fs + git +
 * the injected extractor. Incremental discipline:
 *   1. mtime+size fast path — an unchanged stat reuses the prior entry with
 *      no read at all;
 *   2. sha256 content-hash confirm — a touched-but-identical file reuses the
 *      prior entry without re-parsing;
 *   3. `since` (a PRE-VALIDATED sha from validateSinceRef) narrows the
 *      re-parse candidates to `git diff --name-only <sha> --`; files outside
 *      the diff keep their prior entries verbatim.
 * Bounded by the shared MAX_FILES_SCANNED / MAX_FILE_BYTES caps.
 */
export async function buildStructuralIndex({ workspace, home, extractor, since = null, dryRun = false, log = () => {} }) {
  const dir = structuralIndexDir(workspace, { home });
  const prior = readStructuralIndex(workspace, { home });
  const { files: tracked, total } = trackedSourceFiles(workspace);
  const changed = since && prior ? changedFilesSince(workspace, since) : null;

  const nextFiles = {};
  let reparsed = 0;
  let reused = 0;
  for (const rel of tracked) {
    const priorEntry = prior?.files?.[rel];
    if (changed && priorEntry && !changed.has(rel)) {
      nextFiles[rel] = priorEntry;
      reused += 1;
      continue;
    }
    let st = null;
    try {
      st = fs.statSync(path.join(workspace, rel));
    } catch {
      continue; // listed but unreadable — skip, never guess
    }
    if (priorEntry && !changed?.has(rel) && priorEntry.mtime === st.mtimeMs && priorEntry.size === st.size) {
      nextFiles[rel] = priorEntry;
      reused += 1;
      continue;
    }
    const content = readFileSafe(workspace, rel);
    const hash = sha256(content);
    if (priorEntry && priorEntry.hash === hash) {
      nextFiles[rel] = { ...priorEntry, mtime: st.mtimeMs, size: st.size };
      reused += 1;
      continue;
    }
    nextFiles[rel] = sanitizeEntry(extractor.extract(rel, content), { hash, mtime: st.mtimeMs, size: st.size });
    reparsed += 1;
  }
  const removedFiles = Object.keys(prior?.files || {}).filter((rel) => !(rel in nextFiles)).length;

  const symbols = buildSymbolTable(nextFiles);
  const graph = buildGraph(nextFiles, symbols);
  const delta = symbolDelta(prior?.symbols, symbols);

  const errorFiles = Object.values(nextFiles).filter((f) => f.errors).length;
  const meta = {
    version: STRUCTURAL_INDEX_VERSION,
    sha: git(workspace, ['rev-parse', 'HEAD']),
    branch: git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']),
    baseSha: since || null,
    generatedAt: new Date().toISOString(),
    extractorTier: extractor.tier || 'lexical',
    webTreeSitter: extractor.webTreeSitter || null,
    grammarVersions: extractor.grammarVersions || {},
    missingGrammars: extractor.missingGrammars || [],
    integrityFailures: extractor.integrityFailures || [],
    parseFailures: extractor.counters?.parseFailures ?? 0,
    errorFiles,
    filesIndexed: Object.keys(nextFiles).length,
    totalTracked: total,
    truncated: total > tracked.length,
  };

  if (!dryRun) {
    // meta.json is written LAST: readers treat meta as the completeness
    // signal, so a crashed build leaves the previous stamp in place instead
    // of presenting fresh-looking metadata over half-written tables. Each
    // individual write is atomic (fs-safe temp + rename).
    const writes = [
      ['files.json', nextFiles],
      ['symbols.json', symbols],
      ['graph.json', graph],
      ['meta.json', meta],
    ];
    for (const [name, data] of writes) {
      if (!writeFileContained(dir, name, JSON.stringify(data) + '\n')) {
        log(`structural index write refused: ${name}`);
        return { dir, written: false, reparsed, reused, removedFiles, delta, meta };
      }
    }
  }

  return { dir, written: !dryRun, reparsed, reused, removedFiles, delta, meta };
}

/**
 * Budgeted text rendering of the structural index — the AGENT lane of the
 * three-audience contract (blueprint §9). Never raw index JSON: a bounded,
 * framed digest under a token budget (repo-map's 1000-token budget is the
 * precedent), every line passed through inertLine because symbol names and
 * paths are retrieved repo text.
 */
export function renderStructuralDigest(index, { maxTokens = 1000 } = {}) {
  const { meta, files, symbols, graph } = index;
  const lines = [
    '# Structural Index Digest',
    '',
    inertLine(
      `> ${meta.filesIndexed} files @ ${(meta.sha || 'unknown').slice(0, 7)} (${meta.branch || '?'}) · tier ${meta.extractorTier}` +
        (meta.integrityFailures?.length ? ` · GRAMMAR INTEGRITY FAILED (${meta.integrityFailures.length})` : '')
    ),
    '',
  ];
  const push = (line) => {
    if (estimateTokens([...lines, line].join('\n')) > maxTokens) return false;
    lines.push(line);
    return true;
  };

  const topRefs = Object.entries(symbols)
    .filter(([, s]) => s.refs.length)
    .sort((a, b) => b[1].refs.length - a[1].refs.length || (a[0] < b[0] ? -1 : 1))
    .slice(0, 10);
  if (topRefs.length) {
    push('Most-referenced symbols:');
    for (const [name, s] of topRefs) {
      const def = s.defs[0];
      if (!push(inertLine(`- ${name} (${s.refs.length} refs) — ${def ? `${def.file}:${def.line}` : 'defs elsewhere'}`))) break;
    }
    push('');
  }

  const hotspots = Object.entries(files)
    .sort((a, b) => b[1].complexity - a[1].complexity || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8);
  if (hotspots.length) {
    push('Complexity hotspots:');
    for (const [rel, f] of hotspots) {
      if (!push(inertLine(`- ${rel} (branches ~${f.complexity}, symbols ${f.symbols.length})`))) break;
    }
    push('');
  }

  push(
    inertLine(
      `Edges: ${graph.modules?.length ?? 0} module · ${graph.calls?.length ?? 0} call · unresolved ${graph.unresolvedImports?.length ?? 0} imports / ${graph.unresolvedCalls?.length ?? 0} calls (unresolved edges are preserved, never fabricated)`
    )
  );
  const body = lines.join('\n');
  return { body, tokens: estimateTokens(body) };
}
