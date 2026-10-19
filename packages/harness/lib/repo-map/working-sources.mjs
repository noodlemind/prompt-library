import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertNoSymlinkAncestors, readFileNoFollow } from '../fs-safe.mjs';
import { MAX_FILES_SCANNED, MAX_FILE_BYTES } from './scan.mjs';
import { SOURCE_EXTENSIONS } from './lexical-extractor.mjs';

export const SOURCE_STATE_VERSION = 1;
const RESOLVER_FILE = /^(?:package\.json|[jt]sconfig[^/]*\.json|pyproject\.toml|setup\.cfg|pom\.xml|build\.gradle(?:\.kts)?|\.gitignore|\.gitattributes)$/;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const EXTRACTOR_REVISION = digest(['scan.mjs', 'lexical-extractor.mjs', 'treesitter-extractor.mjs', 'grammars.lock'].map((rel) => fs.readFileSync(new URL(rel, import.meta.url))).join('\0'));

export function readSourceFile(workspace, rel) {
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
  return { state: 'readable', hash: digest(bytes), size: bytes.length, content: bytes.toString('utf8'), mtime: stat.mtimeMs };
}

export function captureWorkingSources(workspace) {
  const options = { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 };
  const listed = spawnSync('git', ['-C', workspace, 'ls-files', '-z'], options);
  const head = spawnSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], options);
  if (listed.status !== 0 || head.status !== 0) return { valid: false, reason: 'source state unavailable' };
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
  const sourcePaths = paths.filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase()));
  const selected = sourcePaths.slice(0, MAX_FILES_SCANNED);
  const configs = paths.filter((rel) => RESOLVER_FILE.test(path.posix.basename(rel)));
  const entries = Object.fromEntries([...new Set([...selected, ...configs])].map((rel) => {
    const { content, mtime, ...identity } = readSourceFile(workspace, rel);
    return [rel, identity];
  }));
  const identities = Object.entries(entries).map(([rel, { state, hash, size }]) => [rel, state, hash || null, size ?? null]);
  return {
    valid: true,
    head: head.stdout.trim(),
    files: selected,
    entries,
    state: {
      version: SOURCE_STATE_VERSION,
      digest: digest(JSON.stringify([SOURCE_STATE_VERSION, EXTRACTOR_REVISION, head.stdout.trim(), sourcePaths, configs, identities])),
      extractorRevision: EXTRACTOR_REVISION,
      configDigest: digest(JSON.stringify(identities.filter(([rel]) => configs.includes(rel)))),
      scanned: selected.length,
      total: sourcePaths.length,
      truncated: sourcePaths.length > selected.length,
      omitted: Object.entries(entries).filter(([, entry]) => entry.state !== 'readable').map(([rel, entry]) => ({ rel, state: entry.state })),
    },
  };
}

export function structuralCurrentness(workspace, meta) {
  if (meta?.sourceState?.version !== SOURCE_STATE_VERSION) return { current: false, reason: 'source state missing or obsolete; rebuild the index' };
  const snapshot = captureWorkingSources(workspace);
  if (!snapshot.valid) return { current: false, reason: snapshot.reason };
  const current = meta.sha === snapshot.head && meta.sourceState.digest === snapshot.state.digest;
  return { current, reason: current ? null : 'source bytes, tracked paths, configuration or HEAD changed', sourceState: snapshot.state };
}
