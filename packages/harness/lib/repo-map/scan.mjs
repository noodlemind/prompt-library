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
    return { files: all.slice(0, MAX_FILES_SCANNED), total: all.length };
}

export function readFileSafe(workspace, rel) {
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full) return '';
    return readFileNoFollow(full, { maxBytes: MAX_FILE_BYTES, root: workspace }) ?? '';
}
