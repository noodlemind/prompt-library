import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tokenize } from '../tokenize.mjs';
import { estimateTokens } from '../token-meter.mjs';
import { extract as lexicalExtract, SOURCE_EXTENSIONS } from './lexical-extractor.mjs';

const DEFAULT_MAX_TOKENS = 1000;
const MAX_FILES_SCANNED = 4000;
const MAX_FILE_BYTES = 200_000;
// Only defined where the platform supports it (Linux/macOS; absent on
// Windows) — feature-checked so the read path below can degrade gracefully
// instead of throwing on an unsupported flag.
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : null;

function trackedSourceFiles(workspace) {
  const res = spawnSync('git', ['-C', workspace, 'ls-files'], { encoding: 'utf8', timeout: 15_000 });
  if (res.status !== 0) return { files: [], total: 0 };
  const all = res.stdout
    .split('\n')
    .filter(Boolean)
    .filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase()));
  // Scan a bounded subset for performance, but report the true total so
  // orientation can tell the agent when the map is a sample of a larger tree.
  return { files: all.slice(0, MAX_FILES_SCANNED), total: all.length };
}

/**
 * Read a tracked file with no TOCTOU window: an lstat-then-read (checking
 * "not a symlink" and then separately opening the path) leaves a gap where a
 * tracked path can be swapped for a symlink between the two calls, so the
 * read would follow it after all. Opening with O_NOFOLLOW instead asks the
 * kernel to refuse the open atomically if the final path component is a
 * symlink — the fd that comes back, if any, is guaranteed to be the real
 * file. Falls back to the old lstat-then-read guard on a platform without
 * O_NOFOLLOW (e.g. Windows) — narrows the window there but cannot close it.
 */
function readFileSafe(workspace, rel) {
  const full = path.join(workspace, rel);
  if (O_NOFOLLOW !== null) {
    let fd;
    try {
      fd = fs.openSync(full, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch {
      return '';
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return '';
      const buf = Buffer.alloc(stat.size);
      fs.readSync(fd, buf, 0, stat.size, 0);
      return buf.toString('utf8');
    } catch {
      return '';
    } finally {
      fs.closeSync(fd);
    }
  }
  try {
    // Never follow symlinks: a tracked link pointing outside the workspace
    // must not leak external content into a committed map.
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return '';
    return fs.readFileSync(full, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Resolve a write path under `workspace`, refusing it if the target escapes
 * the workspace or any path component from the root down to (and including)
 * the file itself already exists as a symlink — a symlinked `docs/` (or a
 * pre-planted symlink at the target itself) could otherwise redirect the
 * write outside the workspace entirely. Returns the safe absolute path, or
 * null when the write should be refused. A missing component along the way
 * simply means the rest of the path doesn't exist yet (nothing to be a
 * symlink), so the walk stops there and the path is treated as safe to
 * create.
 */
function containedWritePath(workspace, relParts) {
  const root = path.resolve(workspace);
  const full = path.resolve(root, ...relParts);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  let cur = root;
  for (const part of relParts) {
    cur = path.join(cur, part);
    let stat;
    try {
      stat = fs.lstatSync(cur);
    } catch {
      break;
    }
    if (stat.isSymbolicLink()) return null;
  }
  return full;
}

/**
 * Build a budgeted lexical repo map. Deterministic: no model, no network.
 * Files are ranked by import-degree (how many files reference them) plus symbol
 * density, and — when a query is given — boosted by normalized-token overlap
 * with the path and symbols, so orientation is code-relevant to the task.
 */
export function buildRepoMap({ workspace, query = '', maxTokens = DEFAULT_MAX_TOKENS, extract = lexicalExtract, title = 'Repo Map' } = {}) {
  const { files, total } = trackedSourceFiles(workspace);
  if (!files.length) return { files: [], body: '', tokens: 0, empty: true };

  const info = new Map();
  for (const rel of files) {
    const { symbols, imports } = extract(rel, readFileSafe(workspace, rel));
    info.set(rel, { rel, symbols, imports, importedBy: 0 });
  }

  // Approximate import-degree: a file is "imported by" another whose import
  // targets end with this file's module name (basename without extension).
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
    const structural = f.importedBy * 2 + Math.min(f.symbols.length, 12);
    return { ...f, score: queryScore * 5 + structural };
  });
  // Locale-independent tie-break: the committed map must be byte-identical
  // across hosts for the same tree.
  scored.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const lines = [
    `# ${title}`,
    '',
    `> Deterministic lexical map of ${total} tracked source files${total > files.length ? ` (top ${files.length} scanned)` : ''}.${query ? ` Ranked for: "${query}".` : ''}`,
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
  return { files: selected, body, tokens: estimateTokens(body), empty: false, totalFiles: total };
}

/**
 * Write the committed, query-less codebase map to docs/codebase-map.md.
 * Deterministic and timestamp-free so the committed file only changes when
 * the code structure changes — a durable cold-start orientation for agents.
 */
export function writeCodebaseMap({ workspace, dryRun = false, maxTokens = 2500 }) {
  const map = buildRepoMap({ workspace, query: '', maxTokens, title: 'Codebase Map' });
  if (map.empty) return null;
  const relParts = ['docs', 'codebase-map.md'];
  const rel = path.join(...relParts);
  if (!dryRun) {
    // Refuse to write through a symlinked `docs/` (or a pre-planted symlink
    // at the target itself) — a naive mkdir+write would otherwise follow
    // either straight out of the workspace.
    const full = containedWritePath(workspace, relParts);
    if (!full) return null;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, map.body + '\n', 'utf8');
  }
  return { path: rel.split(path.sep).join('/'), tokens: map.tokens, files: map.files.length };
}
