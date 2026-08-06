// Shared workspace scan primitives for the repo-map tiers — extracted from
// repo-map/index.mjs so the budgeted map builder AND the persistent
// structural index (structural-index.mjs) enumerate and read tracked files
// through ONE bounded, symlink-safe implementation instead of drifting
// copies. Deterministic: git + local fs only, no model, no network.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SOURCE_EXTENSIONS } from './lexical-extractor.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from '../fs-safe.mjs';

export const MAX_FILES_SCANNED = 4000;
export const MAX_FILE_BYTES = 200_000;

export function trackedSourceFiles(workspace) {
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
 * Read a tracked file with the shared fs-safe defenses: EVERY ancestor
 * component of the tracked path is validated against the workspace root
 * first (assertNoSymlinkAncestors — a tracked file can still be listed by
 * `git ls-files` after `src/` itself was swapped for a symlink pointing
 * outside the workspace, and readFileNoFollow's O_NOFOLLOW only guards the
 * FINAL component, so without the ancestor walk the kernel happily follows
 * the symlinked directory and outside file content leaks into a committed
 * map), then the leaf itself is opened no-follow (readFileNoFollow) — the
 * same two-layer defense the episode readers use. Never throws; an
 * escaping/symlinked/missing/oversized file reads as empty, same as before.
 */
export function readFileSafe(workspace, rel) {
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full) return '';
  // `root: workspace` → readFileNoFollow verifies (canonicalize-after-acquire)
  // the opened inode's realpath is contained under the real workspace, closing
  // the ancestor-swap window between the walk above and the leaf open.
  return readFileNoFollow(full, { maxBytes: MAX_FILE_BYTES, root: workspace }) ?? '';
}
