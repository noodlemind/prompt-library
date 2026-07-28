import fs from 'node:fs';
import { storeDir, listLearnings, readLedger } from './store.mjs';
import { collectEpisodes } from './consolidate.mjs';
import { rankLearnings } from './retrieve.mjs';
import { tokenize } from '../tokenize.mjs';

/**
 * Deterministic retrieval PROXY for the knowledge layer — hit rate, false-surface
 * rate, and injected-token cost per ranking arm on a temporally held-out split.
 * This is NOT the model-graded net-benefit number (design §12, deferred): a
 * lexical-overlap "hit" only proves a relevant learning was surfaced, never that
 * it changed an agent's behavior for the better. Never publish a benefit claim
 * from this command — see the honesty contract in the knowledge-layer design.
 */

export const MIN_SCORE = 0.15;
const BYTES_PER_TOKEN = 4;
const RECOMMENDATION_BYTE_CEILING = 1024; // half the 2KB pack (design §7)

// A small, fixed set of queries about topics that never appear in this
// repo's corpus — used to measure how often an arm surfaces noise on a
// completely unrelated question. Mirrored (not imported, packages/harness
// ships standalone) in evals/fixtures/knowledge-negative-queries.json.
export const DEFAULT_NEGATIVE_QUERIES = [
  'kubernetes ingress tls rotation',
  'graphql federation gateway caching',
  'terraform state locking dynamodb',
  'websocket backpressure flow control',
  'oauth device code grant flow',
  'redis cluster resharding',
];

function activeLearnings(learnings) {
  return learnings.filter((l) => !l.fm.superseded_by && !['retired', 'disputed'].includes(l.fm.status));
}

/** Fraction of query tokens present in the candidate's token set — same shape rankLearnings uses. */
function overlapScore(queryTokens, hayTokens) {
  if (!queryTokens.size) return 0;
  let hits = 0;
  for (const t of queryTokens) if (hayTokens.has(t)) hits++;
  return hits / queryTokens.size;
}

/** The v1a control's per-episode line: frontmatter only (title + tags), no body. */
function episodeManifestLine(e) {
  return [e.title, ...(e.tags || [])].filter(Boolean).join(' ');
}

function episodeQuery(e) {
  return `${e.title || ''} ${(e.tags || []).join(' ')}`.trim();
}

/** Rank train episodes against a held-out query's tokens by frontmatter overlap. */
function rankTrainEpisodes(queryTokens, trainEpisodes) {
  const scored = [];
  for (const e of trainEpisodes) {
    const score = overlapScore(queryTokens, new Set(tokenize(episodeManifestLine(e))));
    if (score > 0) scored.push({ episode: e, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.episode.path.localeCompare(b.episode.path));
}

function falseSurfaceRateFor(queries, bestScoreFn) {
  if (!queries.length) return 0;
  let count = 0;
  for (const q of queries) if (bestScoreFn(q) >= MIN_SCORE) count++;
  return count / queries.length;
}

function round3(n) {
  return Number(n.toFixed(3));
}

/**
 * Evaluate the four retrieval arms (none / frontmatter / wholeIndex / bm25) on a
 * temporal train/held-out split of this workspace's consolidated episodes.
 * Read-only: never creates the store — a missing store is a clean blocked exit.
 */
export function evalKnowledge({ workspace, copilotHome, home, negativeQueries = [] } = {}) {
  const dir = storeDir(workspace, { home });
  if (!fs.existsSync(dir)) {
    return { pass: false, exitCode: 2, blockedReason: 'no knowledge store — nothing to evaluate' };
  }

  const episodes = collectEpisodes({ workspace, copilotHome });
  const dated = episodes.filter((e) => e.date).sort((a, b) => a.date.localeCompare(b.date));
  const undated = episodes.length - dated.length;
  if (dated.length < 4) {
    return { pass: false, exitCode: 2, blockedReason: 'need ≥4 dated episodes for a split' };
  }

  // cutoff = median date (upper median for an even split, so 6 dated episodes
  // split 4 train / 2 held-out); held-out is strictly after the cutoff.
  const cutoffIdx = Math.floor(dated.length / 2);
  const cutoff = dated[cutoffIdx].date;
  const train = dated.filter((e) => e.date <= cutoff);
  const heldOut = dated.filter((e) => e.date > cutoff);

  const learnings = listLearnings(dir);
  const active = activeLearnings(learnings);
  const ledger = readLedger(dir);
  const bySha = new Map(episodes.map((e) => [`${e.path}@${e.sha256}`, e]));

  // Ground truth (relevance proxy, not human-verified): per learning, the set
  // of categories among its ledger-linked episodes dated on/before the cutoff.
  const learningCategories = new Map();
  for (const entry of ledger) {
    if (!entry.learning) continue;
    const ep = bySha.get(`${entry.path}@${entry.sha256}`);
    if (!ep || !ep.date || ep.date > cutoff) continue;
    if (!learningCategories.has(entry.learning)) learningCategories.set(entry.learning, new Set());
    learningCategories.get(entry.learning).add(ep.category);
  }

  function relevantLearningsFor(ho) {
    return active.filter((l) => learningCategories.get(l.id)?.has(ho.category));
  }

  const scorable = heldOut.filter((ho) => relevantLearningsFor(ho).length > 0);
  const unscorable = heldOut.length - scorable.length;

  // --- none: the always-off baseline. ---
  const none = { hitRate: 0, falseSurfaceRate: 0, injectedTokens: 0 };

  // --- frontmatter: v1a control — rank train episodes by frontmatter overlap. ---
  let fmHits = 0;
  for (const ho of scorable) {
    const top3 = rankTrainEpisodes(new Set(tokenize(episodeQuery(ho))), train).slice(0, 3);
    if (top3.some((c) => c.episode.category === ho.category)) fmHits++;
  }
  const fmTotalBytes = train.reduce((n, e) => n + Buffer.byteLength(episodeManifestLine(e), 'utf8'), 0);
  const frontmatter = {
    hitRate: scorable.length ? round3(fmHits / scorable.length) : 0,
    falseSurfaceRate: round3(
      falseSurfaceRateFor(negativeQueries, (q) => {
        const top = rankTrainEpisodes(new Set(tokenize(q)), train)[0];
        return top ? top.score : 0;
      })
    ),
    injectedTokens: Math.ceil(fmTotalBytes / BYTES_PER_TOKEN),
  };

  // --- wholeIndex: every active learning's trigger line injected, unconditionally. ---
  // A relevant learning that exists in the active set is, by construction,
  // always included — the arm's real cost is the token bill, not ranking.
  const wiTotalBytes = active.reduce((n, l) => n + Buffer.byteLength(l.fm.trigger || '', 'utf8'), 0);
  const wholeIndex = {
    hitRate: scorable.length ? 1 : 0,
    falseSurfaceRate: round3(
      falseSurfaceRateFor(negativeQueries, (q) => {
        const results = rankLearnings({ workspace, query: q, limit: Math.max(active.length, 1), home });
        return results.length ? results[0].score : 0;
      })
    ),
    injectedTokens: Math.ceil(wiTotalBytes / BYTES_PER_TOKEN),
  };

  // --- bm25: rankLearnings top-3, the store's real retrieval path. ---
  let bmHits = 0;
  for (const ho of scorable) {
    const results = rankLearnings({ workspace, query: episodeQuery(ho), limit: 3, home });
    const relevant = new Set(relevantLearningsFor(ho).map((l) => l.id));
    if (results.some((r) => relevant.has(r.id))) bmHits++;
  }
  let bmTotalBytes = 0;
  for (const ho of heldOut) {
    const results = rankLearnings({ workspace, query: episodeQuery(ho), limit: 3, home });
    for (const r of results) bmTotalBytes += Buffer.byteLength(`${r.trigger} ${r.claimLine}`, 'utf8');
  }
  const bmAvgBytes = heldOut.length ? bmTotalBytes / heldOut.length : 0;
  const bm25 = {
    hitRate: scorable.length ? round3(bmHits / scorable.length) : 0,
    falseSurfaceRate: round3(
      falseSurfaceRateFor(negativeQueries, (q) => {
        const results = rankLearnings({ workspace, query: q, limit: 3, home });
        return results.length ? results[0].score : 0;
      })
    ),
    injectedTokens: Math.ceil(bmAvgBytes / BYTES_PER_TOKEN),
  };

  const totalActiveTriggerBytes = active.reduce((n, l) => n + Buffer.byteLength(l.fm.trigger || '', 'utf8'), 0);
  const recommendation = totalActiveTriggerBytes <= RECOMMENDATION_BYTE_CEILING ? 'whole-index' : 'bm25-top3';

  return {
    pass: true,
    exitCode: 0,
    split: { train: train.length, heldOut: heldOut.length, cutoff, undated, unscorable },
    arms: { none, frontmatter, wholeIndex, bm25 },
    recommendation,
  };
}
