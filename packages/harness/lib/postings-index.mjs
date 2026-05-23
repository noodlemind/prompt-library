import fs from 'fs';
import path from 'path';
import { tokenize, FIELD_BOOSTS } from './tokenize.mjs';

function countTokens(text) {
  return tokenize(text).length;
}

function addFieldTokens(termMap, docId, text, boost) {
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  for (const t of tokens) {
    if (!termMap[t]) termMap[t] = {};
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
  const terms = {};
  const docLengths = {};
  const entryMeta = {};

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

export function writePostingsIndex(indexDir, postings, meta, flags) {
  if (flags.dryRun) return { indexDir, entryCount: meta.entryCount };

  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, 'postings.json'), JSON.stringify(postings, null, 0), 'utf8');
  fs.writeFileSync(path.join(indexDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { indexDir, entryCount: meta.entryCount };
}

export function loadPostingsIndex(indexDir) {
  const postingsPath = path.join(indexDir, 'postings.json');
  const metaPath = path.join(indexDir, 'meta.json');
  if (!fs.existsSync(postingsPath) || !fs.existsSync(metaPath)) return null;

  try {
    const postings = JSON.parse(fs.readFileSync(postingsPath, 'utf8'));
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return { ...postings, meta };
  } catch {
    return null;
  }
}

export function isIndexStale(indexDir, manifestUpdated) {
  const metaPath = path.join(indexDir, 'meta.json');
  if (!fs.existsSync(metaPath) || !manifestUpdated) return true;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return meta.updated !== manifestUpdated;
  } catch {
    return true;
  }
}

export function runBuildPostingsIndex({ entries, indexDir, manifestUpdated, flags }) {
  if (!entries.length) {
    if (!flags.dryRun && fs.existsSync(indexDir)) {
      fs.rmSync(indexDir, { recursive: true, force: true });
    }
    return { entryCount: 0, indexDir };
  }

  const postings = buildPostingsIndex(entries);
  const meta = {
    version: 1,
    updated: manifestUpdated,
    entryCount: entries.length,
    algorithm: 'bm25',
  };

  writePostingsIndex(indexDir, postings, meta, flags);
  return { entryCount: entries.length, indexDir };
}
