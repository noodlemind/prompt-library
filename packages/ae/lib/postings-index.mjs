import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { tokenize, FIELD_BOOSTS } from './tokenize.mjs';
import { readFileNoFollow, writeFileContained } from './fs-safe.mjs';

// Persist tokenizer/shape compatibility, not only the manifest date.
export const POSTINGS_INDEX_VERSION = 2;

// Calendar dates cannot distinguish same-day rebuilds in a shared Copilot home.
export const manifestFingerprint = (content) => crypto.createHash('sha256').update(content).digest('hex');

function countTokens(text) {
  return tokenize(text).length;
}

function addFieldTokens(termMap, docId, text, boost) {
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  for (const t of tokens) {
    if (!termMap[t]) termMap[t] = Object.create(null);
    termMap[t][docId] = (termMap[t][docId] || 0) + boost;
  }
  return tokens.length;
}

function indexEntry(termMap, entry) {
  const docId = entry.id;
  let length = 0;
  length += addFieldTokens(termMap, docId, entry.symptom, FIELD_BOOSTS.symptom);
  length += addFieldTokens(termMap, docId, entry.title, FIELD_BOOSTS.title);
  length += addFieldTokens(termMap, docId, (entry.tags || []).join(' '), FIELD_BOOSTS.tags);
  length += addFieldTokens(termMap, docId, entry.module, FIELD_BOOSTS.module);
  length += addFieldTokens(termMap, docId, entry.summary, FIELD_BOOSTS.summary);
  length += addFieldTokens(termMap, docId, entry.excerpt, FIELD_BOOSTS.excerpt);
  return Math.max(length, 1);
}

export function buildPostingsIndex(entries) {
  const terms = Object.create(null);
  const docLengths = Object.create(null);
  const entryMeta = Object.create(null);

  for (const entry of entries) {
    docLengths[entry.id] = indexEntry(terms, entry);
    entryMeta[entry.id] = {
      path: entry.path,
      title: entry.title,
      summary: entry.summary || '',
      symptom: entry.symptom || '',
      module: entry.module || '',
      excerpt: entry.excerpt || '',
      scope: entry.scope,
      kind: entry.kind,
      date: entry.date || entry.updated || '',
    };
  }

  const N = entries.length;
  const totalLength = Object.values(docLengths).reduce((a, b) => a + b, 0);
  const avgdl = N > 0 ? totalLength / N : 1;

  return { N, avgdl, docLengths, terms, entries: entryMeta };
}

export function writePostingsIndex(indexDir, postings, meta, flags, projectManifest) {
  if (flags.dryRun) return { indexDir, entryCount: meta.entryCount };

  fs.mkdirSync(indexDir, { recursive: true });
  const content = JSON.stringify(postings, null, 0);
  const files = [
    ...(typeof projectManifest === 'string' ? [['manifest.json', projectManifest]] : []),
    ['postings.json', content],
    ['meta.json', JSON.stringify({ ...meta, postingsSha256: manifestFingerprint(content) }, null, 2)],
  ];
  for (const [name, bytes] of files) {
    const stat = fs.lstatSync(path.join(indexDir, name), { throwIfNoEntry: false });
    const mode = stat ? stat.mode & 0o777 : 0o600;
    if (!writeFileContained(indexDir, name, bytes, { mode })) throw new Error(`knowledge index ${name} publication failed`);
  }
  return { indexDir, entryCount: meta.entryCount };
}

export function loadPostingsIndex(indexDir) {
  const postingsPath = path.join(indexDir, 'postings.json');
  const metaPath = path.join(indexDir, 'meta.json');
  if (!fs.existsSync(postingsPath) || !fs.existsSync(metaPath)) return null;

  try {
    const meta = JSON.parse(readFileNoFollow(metaPath, { root: indexDir }) || 'null');
    if (meta.version !== POSTINGS_INDEX_VERSION) return null;
    const content = readFileNoFollow(postingsPath, { root: indexDir });
    if (content === null || !/^[a-f0-9]{64}$/.test(meta.postingsSha256 || '') || manifestFingerprint(content) !== meta.postingsSha256) return null;
    const postings = JSON.parse(content);
    return { ...postings, meta };
  } catch {
    return null;
  }
}

export function postingsMatchManifest(index, manifestUpdated, manifestSha256) {
  return Boolean(index?.meta && manifestUpdated && /^[a-f0-9]{64}$/.test(manifestSha256 || '')
    && index.meta.version === POSTINGS_INDEX_VERSION && index.meta.updated === manifestUpdated && index.meta.manifestSha256 === manifestSha256);
}

export function isIndexStale(indexDir, manifestUpdated, manifestSha256) {
  return !postingsMatchManifest(loadPostingsIndex(indexDir), manifestUpdated, manifestSha256);
}

export function runBuildPostingsIndex({ entries, indexDir, manifestUpdated, manifestContent, projectManifest, flags }) {
  // Always persist meta (including entryCount: 0) so `index --status` can
  // distinguish "never built" from "built empty — no solution docs yet".
  // Previously empty rebuilds deleted .harness-index, so status forever said
  // "not built" even after a successful `ae index`.
  const postings = entries.length
    ? buildPostingsIndex(entries)
    : { N: 0, avgdl: 1, docLengths: Object.create(null), terms: Object.create(null), entries: Object.create(null) };
  const meta = {
    version: POSTINGS_INDEX_VERSION,
    updated: manifestUpdated,
    manifestSha256: typeof manifestContent === 'string' ? manifestFingerprint(manifestContent) : null,
    ...(typeof projectManifest === 'string' ? { manifestSnapshotSha256: manifestFingerprint(projectManifest) } : {}),
    entryCount: entries.length,
    algorithm: 'bm25',
    headSha: flags?.headSha || null,
  };

  writePostingsIndex(indexDir, postings, meta, flags, projectManifest);
  return { entryCount: entries.length, indexDir, empty: entries.length === 0 };
}
