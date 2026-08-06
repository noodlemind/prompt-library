// Persistent structural codebase index (blueprint P3). Lives OUTSIDE the
// knowledge git store at ~/.harness/index/<repo-id>/<worktree-id>/structural/
// — derived and rebuildable: deleting the directory never loses knowledge, and
// it never touches governance history. Four tables:
//   files.json    per-file { hash, mtime, size, symbols, imports, complexity,
//                 defs, refs, tier } — the superset the incremental rebuild
//                 and symbol table are derived from
//   symbols.json  declaration table: name → { defs: [{file,line,kind,
//                 exported}], refs: [{file,line}] }
//   graph.json    caller/callee approximation + module dependency edges;
//                 unresolved edges preserved EXPLICITLY, never fabricated
//   meta.json     { sha, branch, baseSha, generatedAt, extractorTier,
//                 grammarVersions, ... } — the P9 generation-context stamp
// All writes are atomic temp+rename through fs-safe's writeFileContained, and
// the four together are published as ONE generation via a staged directory
// swap (publishGeneration) so no reader can mix generations.
// Building is async-command-path work (harness index --structural); READING
// is fully synchronous so buildRepoMap/orient stay sync and model-free.
//
// Extracted names/locations are UNTRUSTED repo text: every string passes
// redactSecrets + a length cap at index-WRITE time here, and every human or
// agent render additionally passes inertLine (renderStructuralDigest).
//
// TWO READERS, ONE CONTRACT: `readStructuralIndex` here is the builder-side
// tolerant reader for orient/buildRepoMap — raw tables, null when absent,
// with `readStructuralIndexIfCurrent` gating on meta.sha. The verify/doctor
// consumers instead read through lib/structural/shape.mjs, which adds an
// explicit `{ present, reason }` skip signal, sha-shape validation, and
// normalization of both accepted on-disk encodings. Both readers share the
// fs-safe readFileNoFollow discipline (no-follow, dir-contained, size-capped).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from '../paths.mjs';
import { repoId, inertLine } from '../knowledge/store.mjs';
import { worktreeId } from '../structural/shape.mjs';
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

/** ~/.harness/index/<repo-id>/<worktree-id>/structural — respects HARNESS_HOME
 * via harnessGlobalHome. The worktree segment (shape.mjs `worktreeId`) keeps
 * co-located worktrees of one repo from serving each other's tables: they
 * share a `repoId` and can sit at the same `meta.sha` with different content. */
export function structuralIndexDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'index', repoId(workspace), worktreeId(workspace), 'structural');
}

/**
 * Read one table. Distinguishes ABSENT (`{ value: null, error: null }`) from
 * UNREADABLE — oversized past the fs-safe cap, symlinked, or corrupt JSON.
 * Collapsing the two (the old `|| {}`) turned a 10 MB+ or truncated table into
 * a silent empty one: a permanent silent full rebuild plus a bogus
 * "everything added" delta, with nothing on any surface saying so.
 */
function readTable(dir, name) {
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) return { value: null, error: null };
  const body = readFileNoFollow(full, { root: dir });
  if (body === null) return { value: null, error: `${name} is unreadable (oversized, symlink, or open failure)` };
  try {
    return { value: JSON.parse(body), error: null };
  } catch {
    return { value: null, error: `${name} is not valid JSON` };
  }
}

function readJson(dir, name) {
  return readTable(dir, name).value;
}

function readMeta(dir) {
  const meta = readJson(dir, 'meta.json');
  if (!meta || typeof meta !== 'object') return null;
  // `version` is written by the builder, so it is checked by the reader: an
  // index from a NEWER writer must be skipped, never half-understood.
  if (!Number.isFinite(meta.version) || meta.version > STRUCTURAL_INDEX_VERSION) return null;
  return meta;
}

/**
 * Synchronous, tolerant read of the prebuilt index. Returns
 * { dir, meta, files, symbols, graph, unreadable } or null when no readable
 * index exists. `unreadable` lists tables that exist but could not be read —
 * loud rather than silently empty (doctor S1 surfaces it, the builder refuses
 * to diff against it). The `<home>/index` pre-check keeps the common no-index
 * case free of the repoId git spawn — orient calls this every session.
 */
export function readStructuralIndex(workspace, { home } = {}) {
  if (!fs.existsSync(path.join(home || harnessGlobalHome(), 'index'))) return null;
  const dir = structuralIndexDir(workspace, { home });
  if (!fs.existsSync(path.join(dir, 'meta.json'))) return null;
  const meta = readMeta(dir);
  if (!meta) return null;
  const files = readTable(dir, 'files.json');
  const symbols = readTable(dir, 'symbols.json');
  const graph = readTable(dir, 'graph.json');
  const unreadable = [files.error, symbols.error, graph.error].filter(Boolean);
  return {
    dir,
    meta,
    files: files.value || {},
    symbols: symbols.value || {},
    graph: graph.value || {},
    unreadable,
  };
}

/**
 * The orient-side gate: hand back the index ONLY when its generation stamp
 * matches the current HEAD — otherwise consumers keep their unchanged lexical
 * behavior. Cheap when absent (one existsSync, no git spawn) and cheap when
 * STALE: meta.json is read and compared FIRST, so the common stale case never
 * parses (and discards) multi-megabyte tables on every orient turn.
 */
export function readStructuralIndexIfCurrent(workspace, { home } = {}) {
  if (!fs.existsSync(path.join(home || harnessGlobalHome(), 'index'))) return null;
  const dir = structuralIndexDir(workspace, { home });
  if (!fs.existsSync(path.join(dir, 'meta.json'))) return null;
  const meta = readMeta(dir);
  if (!meta || !meta.sha) return null;
  const head = git(workspace, ['rev-parse', 'HEAD']);
  if (!head || head !== meta.sha) return null;
  const index = readStructuralIndex(workspace, { home });
  // A current stamp over an unreadable table is not a usable index.
  if (!index || index.unreadable.length) return null;
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

/**
 * Is a prior `files.json` entry usable as-is? Reused entries are written back
 * verbatim and fed to buildSymbolTable, so a hand-edited or partially written
 * table must be REJECTED here (the file is re-parsed instead) rather than
 * crashing the build with a TypeError that only manual deletion recovers from.
 */
function usablePriorEntry(entry) {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof entry.hash === 'string' &&
      Array.isArray(entry.symbols) &&
      Array.isArray(entry.imports) &&
      Array.isArray(entry.defs) &&
      Array.isArray(entry.refs)
  );
}

function buildSymbolTable(files, truncation) {
  // Null prototype: symbol names are untrusted repo text, and a repo defining
  // `constructor`, `__proto__`, or `toString` must land as an ordinary own
  // key, not resolve to an inherited Object.prototype member (which would
  // make `.defs` access throw and abort indexing).
  const symbols = Object.create(null);
  const rels = Object.keys(files).sort();
  // Own counter rather than Object.keys(symbols).length per def: that rebuilt
  // the whole key array on every declaration, which is quadratic exactly where
  // it hurts most (a repo big enough to approach the cap).
  let distinct = 0;
  for (const rel of rels) {
    for (const d of Array.isArray(files[rel]?.defs) ? files[rel].defs : []) {
      if (!d || typeof d.name !== 'string') continue;
      if (!symbols[d.name]) {
        if (distinct >= MAX_SYMBOL_TABLE) {
          truncation.symbols = true;
          continue;
        }
        symbols[d.name] = { defs: [], refs: [] };
        distinct += 1;
      }
      if (symbols[d.name].defs.length < MAX_DEFS_PER_SYMBOL) {
        symbols[d.name].defs.push({ file: rel, line: d.line, kind: d.kind, exported: d.exported });
      } else {
        // Per-symbol cap: the symbol IS in the table, only its long def list is
        // shortened. Tracked separately from the table-level cap because it
        // costs recall (a caller we never list), never soundness.
        truncation.symbolDetail = true;
      }
    }
  }
  for (const rel of rels) {
    for (const r of Array.isArray(files[rel]?.refs) ? files[rel].refs : []) {
      if (!r || typeof r.name !== 'string') continue;
      const entry = symbols[r.name];
      if (!entry) continue;
      if (entry.refs.length < MAX_REFS_PER_SYMBOL) entry.refs.push({ file: rel, line: r.line });
      else truncation.symbolDetail = true;
    }
  }
  return symbols;
}

function buildGraph(files, symbols, truncation) {
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
          if (to === rel) continue;
          if (modules.length < MAX_MODULE_EDGES) modules.push({ from: rel, to, via: imp });
          else truncation.moduleEdges = true;
        }
      } else if (unresolvedImports.length < MAX_UNRESOLVED) {
        unresolvedImports.push({ from: rel, import: imp });
      } else {
        truncation.unresolved = true;
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
    for (const r of Array.isArray(files[rel]?.refs) ? files[rel].refs : []) {
      if (!r || typeof r.name !== 'string' || perFile.has(r.name)) continue;
      perFile.set(r.name, true);
      const entry = symbols[r.name];
      const to = entry ? [...new Set(entry.defs.map((d) => d.file))].filter((f) => f !== rel).slice(0, 5) : [];
      if (to.length) {
        if (calls.length < MAX_CALL_EDGES) calls.push({ from: rel, symbol: r.name, to });
        else truncation.callEdges = true;
      } else if (!entry) {
        const key = `${rel} ${r.name}`;
        if (seenUnresolved.has(key)) continue;
        if (unresolvedCalls.length < MAX_UNRESOLVED) {
          seenUnresolved.add(key);
          unresolvedCalls.push({ from: rel, symbol: r.name });
        } else {
          truncation.unresolved = true;
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
  // Own-key membership only: `prior` comes from JSON.parse (Object prototype
  // intact), so `'constructor' in prior` would be true for every table.
  for (const name of Object.keys(nextSymbols)) {
    if (!Object.hasOwn(prior, name)) added.push(name);
    // A CORRUPT PRIOR REBUILDS, IT NEVER CRASHES (review finding). `prior`
    // comes from a hand-editable, possibly truncated symbols.json, so an entry
    // may be null or a primitive — `prior[name].defs` then threw a TypeError
    // straight out of `harness index --structural`, and only deleting the index
    // by hand recovered. Same discipline as `usablePriorEntry` for files.json:
    // an entry that is not an object is not comparable, so it counts as CHANGED
    // (the safe direction — never silently "unchanged").
    else if (
      !prior[name] ||
      typeof prior[name] !== 'object' ||
      JSON.stringify(prior[name].defs) !== JSON.stringify(nextSymbols[name].defs)
    ) {
      changed.push(name);
    }
  }
  for (const name of Object.keys(prior)) {
    if (!Object.hasOwn(nextSymbols, name)) removed.push(name);
  }
  const cap = (list) => ({ count: list.length, names: list.sort().slice(0, MAX_DELTA_NAMES) });
  return { added: cap(added), removed: cap(removed), changed: cap(changed) };
}

/**
 * Publish the four tables as ONE generation (review finding).
 *
 * Each individual write is atomic, and meta.json is written LAST as the
 * completeness signal — but that only orders the writes, it does not make the
 * SET atomic. Both readers (`readStructuralIndex` here and shape.mjs's) read
 * meta.json first and then the tables, so a build landing between those reads
 * hands back meta.json from generation N-1 beside files.json from generation N
 * — mixed generations, with symbol rows citing files the meta never saw.
 *
 * The whole generation is therefore staged in a sibling directory and swapped
 * in with two renames. A concurrent reader sees the previous generation whole,
 * the new one whole, or — for the instant between the renames — no index
 * directory at all, which every reader already treats as "absent, skip". On any
 * failure the previous generation is renamed back, so a refused publish leaves
 * the index exactly as it was rather than empty. Returns `{ ok }` plus the
 * table name that refused, for the caller's log line.
 */
function publishGeneration(dir, writes) {
  const parent = path.dirname(dir);
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const staging = path.join(parent, `.staging-${path.basename(dir)}-${suffix}`);
  const retired = path.join(parent, `.retired-${path.basename(dir)}-${suffix}`);
  const discard = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort — derived, rebuildable data; never worth failing a build
    }
  };
  try {
    fs.mkdirSync(staging, { recursive: true });
  } catch {
    return { ok: false, failed: 'staging directory' };
  }
  for (const [name, data] of writes) {
    if (!writeFileContained(staging, name, JSON.stringify(data) + '\n')) {
      discard(staging);
      return { ok: false, failed: name };
    }
  }
  let movedAside = false;
  try {
    if (fs.existsSync(dir)) {
      fs.renameSync(dir, retired);
      movedAside = true;
    }
    fs.renameSync(staging, dir);
  } catch {
    // Restore the previous generation rather than leaving the index absent.
    if (movedAside && !fs.existsSync(dir)) {
      try {
        fs.renameSync(retired, dir);
      } catch {
        discard(retired);
      }
    }
    discard(staging);
    discard(retired);
    return { ok: false, failed: 'generation swap' };
  }
  discard(retired);
  return { ok: true, failed: null };
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
 *      the diff keep their prior entries verbatim. SOUNDNESS RULE: that
 *      narrowing is only valid when `since` is exactly the sha the PRIOR index
 *      was built at. Any other ref leaves files changed between `since` and
 *      the prior stamp stale while the rebuild stamps meta.sha = HEAD, so the
 *      index would READ as current while carrying stale entries. A misaligned
 *      `--since` is therefore IGNORED (reported, never silent) and the build
 *      degrades to a full incremental pass.
 * Bounded by the shared MAX_FILES_SCANNED / MAX_FILE_BYTES caps.
 */
export async function buildStructuralIndex({ workspace, home, extractor, since = null, dryRun = false, log = () => {} }) {
  const dir = structuralIndexDir(workspace, { home });
  const onDisk = readStructuralIndex(workspace, { home });
  // An unreadable table is not a usable baseline: diffing against it would
  // report every symbol as added and silently re-derive the whole index.
  const priorUnreadable = onDisk?.unreadable?.length ? onDisk.unreadable : [];
  if (priorUnreadable.length) log(`prior structural index unusable: ${priorUnreadable.join('; ')} — rebuilding from scratch`);
  const prior = priorUnreadable.length ? null : onDisk;
  const { files: tracked, total } = trackedSourceFiles(workspace);

  let sinceIgnored = null;
  let appliedSince = null;
  if (since && prior) {
    if (prior.meta?.sha === since) appliedSince = since;
    else sinceIgnored = `--since ${since.slice(0, 12)} does not match the prior index baseline ${String(prior.meta?.sha || 'unknown').slice(0, 12)}`;
  } else if (since) {
    sinceIgnored = '--since needs a prior index to narrow against';
  }
  if (sinceIgnored) log(`${sinceIgnored} — running a full incremental pass instead`);
  const changed = appliedSince ? changedFilesSince(workspace, appliedSince) : null;

  const nextFiles = {};
  let reparsed = 0;
  let reused = 0;
  for (const rel of tracked) {
    const raw = prior?.files?.[rel];
    // A hand-edited or partially written prior entry is discarded and rebuilt,
    // never reused: it flows into files.json and the symbol table verbatim.
    const priorEntry = usablePriorEntry(raw) ? raw : undefined;
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

  // Cap hits are RECORDED: past a cap a removed symbol simply has no callers
  // and the delta misreports, so consumers must be able to tell a complete
  // table from a truncated one instead of trusting a silently shortened one.
  // `symbols` is the TABLE-level cap (a declaration that never entered the
  // table at all — findings computed from it can be wrong); `symbolDetail` is
  // the routine per-symbol def/ref cap, which only shortens a list.
  const truncation = { symbols: false, symbolDetail: false, moduleEdges: false, callEdges: false, unresolved: false };
  const symbols = buildSymbolTable(nextFiles, truncation);
  const graph = buildGraph(nextFiles, symbols, truncation);
  const delta = symbolDelta(prior?.symbols, symbols);

  const errorFiles = Object.values(nextFiles).filter((f) => f.errors).length;
  // What the reported delta is measured against — always the prior index when
  // one was usable, so the ledger can qualify the numbers honestly.
  const basedOn = prior?.meta?.sha || null;
  const meta = {
    version: STRUCTURAL_INDEX_VERSION,
    sha: git(workspace, ['rev-parse', 'HEAD']),
    branch: git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']),
    baseSha: appliedSince || null,
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
    symbolsTruncated: truncation.symbols,
    symbolDetailTruncated: truncation.symbolDetail,
    moduleEdgesTruncated: truncation.moduleEdges,
    callEdgesTruncated: truncation.callEdges,
    unresolvedTruncated: truncation.unresolved,
  };

  if (!dryRun) {
    // ONE GENERATION, PUBLISHED ATOMICALLY (publishGeneration above). meta.json
    // is still written last within the staged set — readers treat meta as the
    // completeness signal — but the whole set now becomes visible in a single
    // directory swap, so no reader can pair this build's tables with the
    // previous build's stamp.
    const published = publishGeneration(dir, [
      ['files.json', nextFiles],
      ['symbols.json', symbols],
      ['graph.json', graph],
      ['meta.json', meta],
    ]);
    if (!published.ok) {
      log(`structural index write refused: ${published.failed}`);
      return { dir, written: false, reparsed, reused, removedFiles, delta, meta, sinceIgnored, priorUnreadable, basedOn };
    }
  }

  return { dir, written: !dryRun, reparsed, reused, removedFiles, delta, meta, sinceIgnored, priorUnreadable, basedOn };
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
