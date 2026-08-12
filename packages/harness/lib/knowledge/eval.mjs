import fs from 'node:fs';
import { storeDir, readLedger, readStaleExclusions } from './store.mjs';
import { collectEpisodes } from './consolidate.mjs';
import { rankLearnings, retrievalExclusion } from './retrieve.mjs';
import { loadLayeredLearnings } from './overlay.mjs';
import { tokenize } from '../tokenize.mjs';

export const MIN_SCORE = 0.15;
const BYTES_PER_TOKEN = 4;
const RECOMMENDATION_BYTE_CEILING = 1024; // half the 2KB pack (design §7)

export const DEFAULT_NEGATIVE_QUERIES = [
  'kubernetes ingress tls rotation',
  'graphql federation gateway caching',
  'terraform state locking dynamodb',
  'websocket backpressure flow control',
  'oauth device code grant flow',
  'redis cluster resharding',
];

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

    const cutoffIdx = Math.floor(dated.length / 2);
  const cutoff = dated[cutoffIdx].date;
  const train = dated.filter((e) => e.date <= cutoff);
  const heldOut = dated.filter((e) => e.date > cutoff);

    const learnings = loadLayeredLearnings({ workspace, home }).learnings;
    const staleExcluded = readStaleExclusions(dir).excluded;
  const active = learnings.filter((l) => !retrievalExclusion(l, staleExcluded));
  const ledger = readLedger(dir);
  const bySha = new Map(episodes.map((e) => [`${e.path}@${e.sha256}`, e]));

    const learningCategories = new Map();
  for (const entry of ledger) {
    if (!entry.learning) continue;
    const ep = bySha.get(`${entry.path}@${entry.sha256}`);
    if (!ep || !ep.date || ep.date > cutoff) continue;
    if (!learningCategories.has(entry.learning)) learningCategories.set(entry.learning, new Set());
    learningCategories.get(entry.learning).add(ep.category);
  }

    const episodesByPath = new Map(episodes.map((e) => [e.path, e]));
  function isPreCutoff(learning) {
    const links = learning.fm.episodes || [];
    if (!links.length) return false;
    return links.every((link) => {
      const ep = episodesByPath.get(link.path);
      return Boolean(ep && ep.date && ep.date <= cutoff);
    });
  }
  const preCutoffActive = active.filter(isPreCutoff);
  const preCutoffIds = new Set(preCutoffActive.map((l) => l.id));
  const preCutoffOnly = (l) => preCutoffIds.has(l.id);

  function relevantLearningsFor(ho) {
    return active.filter((l) => preCutoffIds.has(l.id) && learningCategories.get(l.id)?.has(ho.category));
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

    const wiTotalBytes = preCutoffActive.reduce((n, l) => n + Buffer.byteLength(l.fm.trigger || '', 'utf8'), 0);
  const wholeIndex = {
    hitRate: scorable.length ? 1 : 0,
    falseSurfaceRate: round3(
      falseSurfaceRateFor(negativeQueries, (q) => {
        const results = rankLearnings({
          workspace, query: q, limit: Math.max(preCutoffActive.length, 1), home, include: preCutoffOnly,
        });
        return results.length ? results[0].score : 0;
      })
    ),
    injectedTokens: Math.ceil(wiTotalBytes / BYTES_PER_TOKEN),
  };

    const scorableSet = new Set(scorable);
  let bmHits = 0;
  let bmTotalBytes = 0;
  for (const ho of heldOut) {
    const results = rankLearnings({ workspace, query: episodeQuery(ho), limit: 3, home, include: preCutoffOnly });
    if (scorableSet.has(ho)) {
      const relevant = new Set(relevantLearningsFor(ho).map((l) => l.id));
      if (results.some((r) => relevant.has(r.id))) bmHits++;
    }
    for (const r of results) bmTotalBytes += Buffer.byteLength(`${r.trigger} ${r.claimLine}`, 'utf8');
  }
  const bmAvgBytes = heldOut.length ? bmTotalBytes / heldOut.length : 0;
  const bm25 = {
    hitRate: scorable.length ? round3(bmHits / scorable.length) : 0,
    falseSurfaceRate: round3(
      falseSurfaceRateFor(negativeQueries, (q) => {
        const results = rankLearnings({ workspace, query: q, limit: 3, home, include: preCutoffOnly });
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
