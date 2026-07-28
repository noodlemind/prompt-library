import fs from 'node:fs';
import { storeDir, listLearnings, readStaleExclusions } from './store.mjs';
import { tokenize } from '../tokenize.mjs';

/**
 * Read the raw learning set + stale-anchor exclusions for a workspace.
 * Read-only and advisory: never creates the store, never throws — a missing
 * or unreadable store just means "nothing to rank/explain".
 */
function loadLearnings({ workspace, home }) {
  try {
    const dir = storeDir(workspace, { home });
    if (!fs.existsSync(dir)) return { learnings: [], staleExcluded: {} };
    return { learnings: listLearnings(dir), staleExcluded: readStaleExclusions(dir).excluded };
  } catch {
    return { learnings: [], staleExcluded: {} };
  }
}

/**
 * Single scoring/filter core shared by rankLearnings and explainLearnings —
 * the only place that encodes the filter order and score formula, so the
 * two can never drift apart (explain's decomposition always matches what
 * actually got surfaced).
 *
 * Filter order (first match wins, historical order from rankLearnings):
 * superseded_by → promoted_to → retired/disputed status → stale-anchor
 * exclusion → caller `include` predicate → zero query-token hits.
 *
 * Honesty note: there is no date/recency term anywhere below — a learning
 * written yesterday and one written a year ago score identically for the
 * same trigger/claim token overlap. Callers (and `orient --explain`'s
 * render) must never imply otherwise.
 */
function scoreLearning(l, { queryTokens, staleExcluded, include }) {
  if (l.fm.superseded_by) return { excluded: 'superseded' };
  if (l.fm.promoted_to) return { excluded: 'promoted' };
  if (l.fm.status === 'retired') return { excluded: 'retired' };
  if (l.fm.status === 'disputed') return { excluded: 'disputed' };
  if (staleExcluded[l.id]) return { excluded: 'stale-anchor' };
  // Optional caller-supplied predicate (e.g. the knowledge eval's temporal
  // pre-cutoff filter), applied after the standard status/stale filters and
  // before scoring — additive, default undefined means no extra filtering.
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

/**
 * Rank learnings for the orient pack. Read-only and advisory: never creates
 * the store, never throws into orientation. Deterministic given identical
 * store contents — no per-machine ranking state.
 */
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
      trigger: l.fm.trigger || '',
      claimLine: scored.claimLine.slice(0, 140),
      status: l.fm.status || 'active',
      advisory,
      score: scored.score,
    });
  }

  return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/**
 * Decompose every learning's ranking outcome for a query: either the reason
 * it was excluded, or its full score decomposition (hits/matched tokens/
 * base/damping/score). Shares scoreLearning with rankLearnings, so a
 * surfaced learning's `score` here is always identical to what rankLearnings
 * returned for the same store + query — never an approximation.
 *
 * Read-only and advisory, same as rankLearnings: a missing/unreadable store
 * yields an empty candidate list rather than throwing.
 */
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
    };
  });

  return { queryTokens: [...queryTokens], candidates };
}
