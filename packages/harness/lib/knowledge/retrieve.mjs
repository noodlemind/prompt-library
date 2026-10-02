import fs from 'node:fs';
import { storeDir, readStaleExclusions, inertLine } from './store.mjs';
import { loadLayeredLearnings, layerTieRank } from './overlay.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { tokenize } from '../tokenize.mjs';

function retrievedText(value) {
  return inertLine(redactSecrets(String(value ?? '')));
}

function loadLearnings({ workspace, home }) {
  try {
    const dir = storeDir(workspace, { home });
    if (!fs.existsSync(dir)) return { learnings: [], staleExcluded: {} };
    return { learnings: loadLayeredLearnings({ workspace, home }).learnings, staleExcluded: readStaleExclusions(dir).excluded };
  } catch {
    return { learnings: [], staleExcluded: {} };
  }
}

export function retrievalExclusion(l, staleExcluded = {}) {
  if (l.fm.superseded_by) return 'superseded';
  if (l.fm.promoted_to) return 'promoted';
    if (l.fm.promoted_to_golden) return 'promoted-to-golden';
  if (l.fm.status === 'retired') return 'retired';
  if (l.fm.status === 'disputed') return 'disputed';
  if (staleExcluded[l.id]) return 'stale-anchor';
  return null;
}

function overlapCount(queryTokens, text) {
  const hay = new Set(tokenize(text));
  let count = 0;
  for (const token of queryTokens) if (hay.has(token)) count += 1;
  return count;
}

function signalTokenSet(signals) {
  const tokens = new Set();
  if (!Array.isArray(signals)) return tokens;
  for (const signal of signals) {
    if (typeof signal !== 'string') continue;
    for (const token of tokenize(signal)) tokens.add(token);
  }
  return tokens;
}

function scoreLearning(l, { queryTokens, signalTokens = new Set(), staleExcluded, include }) {
  const gate = retrievalExclusion(l, staleExcluded);
  if (gate) return { excluded: gate };
    if (include && !include(l)) return { excluded: 'filtered' };

  const triggerOverlap = overlapCount(queryTokens, l.fm.trigger || '');
  const excludedOverlap = overlapCount(queryTokens, l.fm.does_not_apply || '');
  if (excludedOverlap > 0 && excludedOverlap >= triggerOverlap) return { excluded: 'out-of-scope' };

  const claimLine = (l.body.split('\n').find((x) => x.trim()) || '').trim();
  const hay = new Set(tokenize(`${l.fm.trigger || ''} ${claimLine}`));
  const matched = [];
  for (const t of queryTokens) if (hay.has(t)) matched.push(t);
  const hits = matched.length;
  if (!hits) return { excluded: 'no-hits', hits: 0, matched, claimLine };

  const base = hits / queryTokens.size;
  // Provisional learnings are rank-damped until a verified confirmation.
  const damping = l.fm.status === 'provisional' ? 0.5 : 1;
  const score = Number((base * damping).toFixed(3));
  const appliesSignalHits = signalTokens.size ? overlapCount(signalTokens, l.fm.applies || '') : 0;
  return { excluded: null, hits, matched, base, damping, score, claimLine, appliesSignalHits };
}

export function rankLearnings({ workspace, query, limit = 3, home, include, signals }) {
  const { learnings, staleExcluded } = loadLearnings({ workspace, home });

  const queryTokens = new Set(tokenize(query || ''));
  const signalTokens = signalTokenSet(signals);
  for (const token of signalTokens) queryTokens.add(token);
  if (!queryTokens.size) return [];

  const results = [];
  const appliesBias = new Map();
  for (const l of learnings) {
    const scored = scoreLearning(l, { queryTokens, signalTokens, staleExcluded, include });
    if (scored.excluded) continue;
    const advisory =
      (l.fm.episodes || []).length > 0 && (l.fm.episodes || []).every((e) => e.kind === 'insight');
    const row = {
      id: l.id,
            trigger: retrievedText(l.fm.trigger),
      claimLine: retrievedText(scored.claimLine).slice(0, 140),
      ...(l.fm.applies ? { applies: retrievedText(l.fm.applies) } : {}),
      ...(l.fm.does_not_apply ? { does_not_apply: retrievedText(l.fm.does_not_apply) } : {}),
      ...(typeof l.fm.authority === 'string' && l.fm.authority ? { authority: retrievedText(l.fm.authority) } : {}),
      status: l.fm.status || 'active',
      advisory,
      score: scored.score,
            ...(l.layer === 'branch' ? { layer: 'branch', ...(l.subordinate ? { subordinate: true } : {}) } : {}),
    };
    appliesBias.set(row, scored.appliesSignalHits);
    results.push(row);
  }

    return results
    .sort((a, b) => b.score - a.score || layerTieRank(a) - layerTieRank(b) || appliesBias.get(b) - appliesBias.get(a) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function explainLearnings({ workspace, query, home, include }) {
  const { learnings, staleExcluded } = loadLearnings({ workspace, home });
  const queryTokens = new Set(tokenize(query || ''));

  const candidates = learnings.map((l) => {
    const scored = scoreLearning(l, { queryTokens, staleExcluded, include });
    return {
      id: l.id,
      status: l.fm.status || 'active',
      excluded: scored.excluded,
      hits: scored.hits ?? null,
      matched: scored.matched ?? null,
      base: scored.base ?? null,
      damping: scored.damping ?? null,
      score: scored.score ?? null,
      // Same additive layer marker as rankLearnings — absent without buckets.
      ...(l.layer === 'branch' ? { layer: 'branch' } : {}),
    };
  });

  return { queryTokens: [...queryTokens], candidates };
}
