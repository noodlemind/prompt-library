/**
 * `@` file completion (P4bAC14).
 *
 * What phase 4b shipped for `@` was the string `"file references are not wired
 * yet"`. This is the wiring.
 *
 * IT IS WORKSPACE-CONFINED, and that is a governance property rather than a
 * convenience. Every other path the harness touches goes through
 * `safeResolveUnderRoot`; a completion that offered `../../.ssh/id_rsa` would
 * be the one surface that helps you name a file the rest of the system exists
 * to keep you from naming. Traversal is refused here, not filtered downstream.
 *
 * IT NEVER READS FILE CONTENT. Completion is a directory listing and nothing
 * more — the reference it produces is dispatched through the registry like any
 * other argument, and the command that receives it does its own reading under
 * its own rules.
 *
 * RANKING IS DELIBERATELY BORING: prefix beats substring, shallow beats deep,
 * directories sort with a trailing separator so one keystroke continues the
 * path. Fuzzy subsequence matching is offered only when nothing else hit,
 * because a fuzzy match that outranks an exact prefix is how a completion list
 * stops being predictable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { safeResolveUnderRoot } from '../path-safe.mjs';

/** Directories never worth offering. Listing them buries the repository's own
 * files under machinery nobody types a path into by hand. */
const SKIP = new Set(['.git', 'node_modules', '.harness', 'dist', 'build', '.next', '.venv', '__pycache__', '.worktrees', '.claude']);

/** How many rows the chooser can show. More than this and the list has stopped
 * being a completion. */
export const MAX_RESULTS = 8;
/** Directories descended when the prefix names no directory of its own. Bounds
 * the cost of `@` on a large repository, which is otherwise a full walk on a
 * keystroke. */
const MAX_SCAN = 4000;

function listDir(root, relDir) {
  let full;
  try {
    full = relDir ? safeResolveUnderRoot(root, relDir) : root;
  } catch {
    // Traversal, absolute path, or anything else that would leave the
    // workspace. An empty list is the right answer: the path is not offered,
    // and no error teaches the caller that the guard is worth probing.
    return [];
  }
  try {
    return fs.readdirSync(full, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Complete one `@` prefix.
 *
 * `prefix` is what follows the sigil, exactly as typed. A trailing separator
 * means "inside this directory"; anything else is a partial name in its parent.
 */
export function completePath(prefix, { workspace = process.cwd(), limit = MAX_RESULTS } = {}) {
  const raw = String(prefix ?? '');
  // A leading `/` or a `..` segment is refused rather than resolved: see the
  // module note. `path.posix` throughout, because the reference a person types
  // is a repo-relative path and stays one on Windows.
  if (raw.startsWith('/') || raw.startsWith('\\') || raw.split(/[\\/]/).includes('..')) return [];

  const endsWithSep = /[\\/]$/.test(raw);
  const normalized = raw.replace(/\\/g, '/');
  const dir = endsWithSep ? normalized.replace(/\/$/, '') : path.posix.dirname(normalized);
  const base = endsWithSep ? '' : path.posix.basename(normalized);
  const relDir = dir === '.' || dir === '' ? '' : dir;

  const entries = listDir(workspace, relDir);
  const wanted = base.toLowerCase();
  const scored = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    if (!base && entry.name.startsWith('.')) continue; // hidden files only when asked for by name
    const name = entry.name;
    const lower = name.toLowerCase();
    let score;
    if (!wanted) score = 0;
    else if (lower === wanted) score = 4;
    else if (lower.startsWith(wanted)) score = 3;
    else if (lower.includes(wanted)) score = 2;
    else continue;
    const isDir = entry.isDirectory();
    const rel = relDir ? `${relDir}/${name}` : name;
    scored.push({ path: isDir ? `${rel}/` : rel, name, kind: isDir ? 'dir' : 'file', score });
  }

  // Nothing in the named directory: fall back to a bounded walk from the
  // workspace root, so `@workbench` finds `docs/architecture/harness-cli-
  // workbench.md` without the path being known in advance. This is the one
  // fuzzy path, and it only runs when the precise one came back empty.
  if (!scored.length && base && !relDir) {
    for (const hit of walk(workspace, wanted, limit)) scored.push(hit);
  }

  scored.sort((a, b) => (
    b.score - a.score
    || a.path.split('/').length - b.path.split('/').length
    || (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1)
    || a.path.localeCompare(b.path)
  ));
  return scored.slice(0, limit);
}

/** A bounded breadth-first walk. Breadth-first because the file someone means
 * is far more often near the root than deep in a tree. */
function* walk(root, wanted, limit) {
  const queue = [''];
  let seen = 0;
  let found = 0;
  while (queue.length && seen < MAX_SCAN && found < limit) {
    const rel = queue.shift();
    for (const entry of listDir(root, rel)) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      seen += 1;
      if (seen > MAX_SCAN) return;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { queue.push(child); continue; }
      if (entry.name.toLowerCase().includes(wanted)) {
        found += 1;
        yield { path: child, name: entry.name, kind: 'file', score: 1 };
        if (found >= limit) return;
      }
    }
  }
}
