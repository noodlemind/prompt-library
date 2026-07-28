import fs from 'node:fs';
import { storeDir, listLearnings, readStaleExclusions } from './store.mjs';
import { tokenize } from '../tokenize.mjs';

/**
 * Rank learnings for the orient pack. Read-only and advisory: never creates
 * the store, never throws into orientation. Deterministic given identical
 * store contents — no per-machine ranking state.
 */
export function rankLearnings({ workspace, query, limit = 3, home, include }) {
  let learnings = [];
  let staleExcluded = {};
  try {
    const dir = storeDir(workspace, { home });
    if (!fs.existsSync(dir)) return [];
    learnings = listLearnings(dir);
    staleExcluded = readStaleExclusions(dir).excluded;
  } catch {
    return [];
  }

  const queryTokens = new Set(tokenize(query || ''));
  if (!queryTokens.size) return [];

  const results = [];
  for (const l of learnings) {
    if (l.fm.superseded_by) continue;
    if (l.fm.promoted_to) continue;
    if (['retired', 'disputed'].includes(l.fm.status)) continue;
    if (staleExcluded[l.id]) continue;
    // Optional caller-supplied predicate (e.g. the knowledge eval's temporal
    // pre-cutoff filter), applied after the standard status/stale filters and
    // before scoring — additive, default undefined means no extra filtering.
    if (include && !include(l)) continue;
    const claimLine = (l.body.split('\n').find((x) => x.trim()) || '').trim();
    const hay = new Set(tokenize(`${l.fm.trigger || ''} ${claimLine}`));
    let hits = 0;
    for (const t of queryTokens) if (hay.has(t)) hits++;
    if (!hits) continue;
    let score = hits / queryTokens.size;
    // Provisional learnings are rank-damped until a verified confirmation.
    if (l.fm.status === 'provisional') score *= 0.5;
    const advisory =
      (l.fm.episodes || []).length > 0 && (l.fm.episodes || []).every((e) => e.kind === 'insight');
    results.push({
      id: l.id,
      trigger: l.fm.trigger || '',
      claimLine: claimLine.slice(0, 140),
      status: l.fm.status || 'active',
      advisory,
      score: Number(score.toFixed(3)),
    });
  }

  return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
