import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { scoreDocuments, normalizeScores } from './bm25.mjs';
import { tokenize, FIELD_BOOSTS } from './tokenize.mjs';
import {
  loadRecallSynonyms,
  loadCollections,
  expandQueryTokens,
  entryMatchesCollection,
  resolveIndexDir,
} from './recall-config.mjs';
import { loadPostingsIndex, isIndexStale } from './postings-index.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from './fs-safe.mjs';

const require = createRequire(import.meta.url);

const SNIPPET_FIELDS = [
  { key: 'symptom', boost: FIELD_BOOSTS.symptom },
  { key: 'title', boost: FIELD_BOOSTS.title },
  { key: 'summary', boost: FIELD_BOOSTS.summary },
  { key: 'excerpt', boost: FIELD_BOOSTS.excerpt },
  { key: 'module', boost: FIELD_BOOSTS.module },
];

function recencyBoost(entry) {
  const dateStr = entry.date || entry.updated;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return 0;
  return Math.max(0, 1 - (Date.now() - new Date(dateStr).getTime()) / (365 * 86400000));
}

function bestSnippet(entry, queryTokens) {
  let best = { text: entry.summary || '', score: 0 };
  for (const { key } of SNIPPET_FIELDS) {
    const text = entry[key] || '';
    if (!text) continue;
    const tokens = new Set(tokenize(text));
    let hits = 0;
    for (const t of queryTokens) if (tokens.has(t)) hits++;
    if (hits > best.score) best = { text, score: hits };
  }
  return best.text.slice(0, 120);
}

function weightedOverlapScore(queryTokens, entry) {
  const fieldTexts = [
    { text: entry.symptom, weight: FIELD_BOOSTS.symptom },
    { text: entry.title, weight: FIELD_BOOSTS.title },
    { text: (entry.tags || []).join(' '), weight: FIELD_BOOSTS.tags },
    { text: entry.module, weight: FIELD_BOOSTS.module },
    { text: entry.summary, weight: FIELD_BOOSTS.summary },
    { text: entry.excerpt, weight: FIELD_BOOSTS.excerpt },
    // Knowledge-layer fields: the applicability condition and claim are often
    // the only place query terms appear (fallback ranker parity with BM25).
    { text: entry.trigger, weight: FIELD_BOOSTS.symptom },
    { text: entry.claim, weight: FIELD_BOOSTS.summary },
  ];

  let weightedHits = 0;
  let maxWeight = 0;
  for (const { text, weight } of fieldTexts) {
    if (!text) continue;
    maxWeight += weight;
    const fieldTokens = new Set(tokenize(text));
    for (const t of queryTokens) {
      if (fieldTokens.has(t)) weightedHits += weight;
    }
  }

  if (maxWeight <= 0) return 0;
  const overlap = weightedHits / (maxWeight * Math.max(queryTokens.length, 1));
  return overlap * 0.85 + recencyBoost(entry) * 0.15;
}

export function loadManifest(copilotHome, workspace) {
  const paths = [
    path.join(copilotHome, 'knowledge', 'manifest.yaml'),
    path.join(workspace, 'knowledge', 'manifest.yaml'),
  ];
  let lastError = null;
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      const yaml = require('yaml');
      const doc = yaml.parse(fs.readFileSync(p, 'utf8'));
      return { entries: doc.entries || [], path: p, updated: doc.updated || null, error: null };
    } catch (err) {
      lastError = err.message || String(err);
    }
  }
  return { entries: [], path: null, updated: null, error: lastError };
}

function rankWithBm25(queryTokens, index, entriesById, minScore) {
  const rawScores = scoreDocuments(queryTokens, index);
  const normalized = normalizeScores(rawScores);
  const results = [];

  for (const [docId, score] of normalized) {
    const entry = entriesById.get(docId) || index.entries?.[docId];
    if (!entry) continue;
    // Insights are unverified — rank below verified fixes at equal relevance.
    const kindPenalty = entry.kind === 'insight' ? 0.7 : 1;
    const withRecency = (score * 0.85 + recencyBoost(entry) * 0.15) * kindPenalty;
    if (withRecency < minScore) continue;
    results.push({
      ...entry,
      docid: docId,
      id: docId,
      score: withRecency,
      snippet: bestSnippet(entry, queryTokens),
      ranker: 'bm25',
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

function rankWithOverlap(queryTokens, entries, minScore) {
  return entries
    .map((e) => ({
      ...e,
      docid: e.docid || e.id,
      score: weightedOverlapScore(queryTokens, e) * (e.kind === 'insight' ? 0.7 : 1),
      snippet: bestSnippet(e, queryTokens),
      ranker: 'overlap',
    }))
    .filter((e) => e.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

export function rankRecall(query, { copilotHome, workspace, limit = 3, collection = null, minScore = 0.15 }) {
  const { entries, updated, path: manifestPath, error } = loadManifest(copilotHome, workspace);
  if (error && manifestPath) {
    throw new Error(
      `manifest parse failed (${manifestPath}): ${error} — run npm install in packages/harness or harness index`
    );
  }
  const synonyms = loadRecallSynonyms(copilotHome, workspace);
  const collections = loadCollections(copilotHome, workspace);
  const queryTokens = expandQueryTokens(tokenize(query), synonyms);
  if (!queryTokens.length) return [];

  const filtered = entries.filter((e) => entryMatchesCollection(e, collection, collections));
  const entryKey = (e) => e.docid || e.id;
  const entriesById = new Map(filtered.map((e) => [entryKey(e), e]));

  const indexDir = resolveIndexDir(copilotHome, workspace);
  const index = loadPostingsIndex(indexDir);
  const useBm25 = index && !isIndexStale(indexDir, updated) && index.N > 0;

  let scored;
  if (useBm25) {
    scored = rankWithBm25(queryTokens, index, entriesById, minScore).filter((e) =>
      entriesById.has(e.docid)
    );
  } else {
    scored = rankWithOverlap(queryTokens, filtered, minScore);
  }

  return scored.slice(0, limit).map((e) => ({
    ...e,
    score: Number(e.score.toFixed(3)),
  }));
}

export function findMatchingPlans(workspace, query, limit = 3) {
  const plansDirRel = path.join('docs', 'plans');
  // Physical containment (adversarial-review sweep, same class as
  // collectEpisodes/collectSolutions): docs/plans is scanned and read the
  // same way docs/solutions is — a symlinked plans directory (or a
  // symlinked plan file) must never let its target's content be read into
  // the orient pack's "Plans" recall section.
  if (!assertNoSymlinkAncestors(workspace, plansDirRel)) return [];
  const plansDir = path.join(workspace, plansDirRel);
  if (!fs.existsSync(plansDir)) return [];
  const queryTokens = new Set(tokenize(query));
  const results = [];

  for (const f of fs.readdirSync(plansDir)) {
    if (!f.endsWith('.md')) continue;
    const fileRel = path.join(plansDirRel, f);
    const full = assertNoSymlinkAncestors(workspace, fileRel);
    if (!full) continue; // symlinked leaf — never follow
    const raw = readFileNoFollow(full);
    if (raw === null) continue; // missing/oversized — skip, same as before
    const text = raw.slice(0, 4000);
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let status = 'unknown';
    let plan_lock = false;
    if (fm) {
      const sl = fm[1].match(/status:\s*(\S+)/);
      const pl = fm[1].match(/plan_lock:\s*(\S+)/);
      if (sl) status = sl[1];
      if (pl) plan_lock = pl[1] === 'true';
    }
    const tokens = new Set(tokenize(text));
    let hit = 0;
    for (const t of queryTokens) if (tokens.has(t)) hit++;
    const score = hit / Math.max(queryTokens.size, 1);
    if (score > 0.1) {
      results.push({
        path: `docs/plans/${f}`,
        score,
        status,
        plan_lock,
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function resolveDocPath(copilotHome, workspace, entry) {
  if (!entry?.path) return null;
  const knowledgeRoots = [
    path.join(copilotHome, 'knowledge'),
    path.join(workspace, 'knowledge'),
    workspace,
  ];
  for (const root of knowledgeRoots) {
    const full = safeResolveUnderRoot(root, entry.path);
    if (full && fs.existsSync(full)) return full;
  }
  return null;
}

export function findEntryByDocid(copilotHome, workspace, docid) {
  const { entries } = loadManifest(copilotHome, workspace);
  return entries.find((e) => e.id === docid || e.docid === docid) || null;
}
