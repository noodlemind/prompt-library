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

function scoreLearning(l, { queryTokens, staleExcluded, include }) {
  const gate = retrievalExclusion(l, staleExcluded);
  if (gate) return { excluded: gate };
    if (include && !include(l)) return { excluded: 'filtered' };

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
  return { excluded: null, hits, matched, base, damping, score, claimLine };
}

export function rankLearnings({ workspace, query, limit = 3, home, include }) {
  const { learnings, staleExcluded } = loadLearnings({ workspace, home });

  const queryTokens = new Set(tokenize(query || ''));
  if (!queryTokens.size) return [];

  const results = [];
  for (const l of learnings) {
    const scored = scoreLearning(l, { queryTokens, staleExcluded, include });
    if (scored.excluded) continue;
    const advisory =
      (l.fm.episodes || []).length > 0 && (l.fm.episodes || []).every((e) => e.kind === 'insight');
    results.push({
      id: l.id,
            trigger: retrievedText(l.fm.trigger),
      claimLine: retrievedText(scored.claimLine).slice(0, 140),
      status: l.fm.status || 'active',
      advisory,
      score: scored.score,
            ...(l.layer === 'branch' ? { layer: 'branch', ...(l.subordinate ? { subordinate: true } : {}) } : {}),
    });
  }

    return results
    .sort((a, b) => b.score - a.score || layerTieRank(a) - layerTieRank(b) || a.id.localeCompare(b.id))
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
