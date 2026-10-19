import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SOURCE_EXTENSIONS } from './lexical-extractor.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from '../fs-safe.mjs';

export const MAX_FILES_SCANNED = 4000;
export const MAX_FILE_BYTES = 200_000;

export function trackedSourceFiles(workspace) {
  const res = spawnSync('git', ['-C', workspace, 'ls-files', '-z'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) return { files: [], total: 0, inventoryHash: null, unavailable: true };
  const all = [...new Set(res.stdout
    .split('\0')
    .filter(Boolean)
    .filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase())))].sort();
  return { files: all.slice(0, MAX_FILES_SCANNED), total: all.length, inventoryHash: createHash('sha256').update(JSON.stringify(all)).digest('hex'), unavailable: false };
}

export function inspectSourceFile(workspace, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) return { state: 'excluded' };
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full || full === path.resolve(workspace)) return { state: 'excluded' };
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!stat.isFile()) return { state: 'excluded' };
  if (stat.size > MAX_FILE_BYTES) return { state: 'oversized', size: stat.size };
  const bytes = readFileNoFollow(full, { root: workspace, maxBytes: MAX_FILE_BYTES, encoding: null });
  if (bytes === null) return { state: 'unreadable' };
  if (bytes.includes(0)) return { state: 'unsupported', size: bytes.length };
  return { state: 'readable', hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, content: bytes.toString('utf8'), mtime: stat.mtimeMs };
}

export function readSourceFile(workspace, rel) {
  return inspectSourceFile(workspace, rel).content ?? null;
}

export function readFileSafe(workspace, rel) {
  return readSourceFile(workspace, rel) ?? '';
}
