import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SOURCE_EXTENSIONS } from './lexical-extractor.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from '../fs-safe.mjs';

export const MAX_FILES_SCANNED = 4000;
export const MAX_FILE_BYTES = 200_000;

export function trackedSourceFiles(workspace) {
  const res = spawnSync('git', ['-C', workspace, 'ls-files', '-z'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) return { files: [], total: 0, inventoryHash: null, unavailable: true };
  const all = res.stdout
    .split('\0')
    .filter(Boolean)
    .filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase()));
  return { files: all.slice(0, MAX_FILES_SCANNED), total: all.length, inventoryHash: createHash('sha256').update(JSON.stringify(all)).digest('hex'), unavailable: false };
}

export function readSourceFile(workspace, rel) {
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full) return null;
  return readFileNoFollow(full, { maxBytes: MAX_FILE_BYTES, root: workspace });
}

export function readFileSafe(workspace, rel) {
  return readSourceFile(workspace, rel) ?? '';
}
