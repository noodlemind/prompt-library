import fs from 'node:fs';
import { storeDir, readStaleExclusions, inertLine } from './store.mjs';
import { loadLayeredLearnings, layerTieRank } from './overlay.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { tokenize } from '../tokenize.mjs';

/**
 * Retrieved learning text, screened at the DATA boundary — the same doctrine
 * redactRecallEntry (secret-scan.mjs) applies to recall results, for the same
 * reason: a render-boundary-only screen misses the `--json` sibling, which
 * serializes this object raw. Learning content is HAND-EDITABLE and human
 * authority deliberately overrides the write-time secret screen for hand edits
 * (absorbHandEdits keeps a secret-shaped human claim, skipping only the
 * snapshot), so a stored credential is a supported state — it must simply
 * never be rendered back to an agent. inertLine additionally flattens the
 * control characters a legacy or hand-edited file can carry.
 */
function retrievedText(value) {
  return inertLine(redactSecrets(String(value ?? '')));
}

/**
 * Read the raw learning set + stale-anchor exclusions for a workspace.
 * Read-only and advisory: never creates the store, never throws — a missing
 * or unreadable store just means "nothing to rank/explain".
 *
 * The learning set comes from the SHARED layer overlay (overlay.mjs) — the
 * one function eval.mjs also uses — so production retrieval and the eval can
 * never drift on the golden ∪ branch-bucket candidate set or its
 * protected-shadow/governance gates. With no `branches/` directory the
 * overlay returns listLearnings' output untouched (byte-identical behavior).
 */
function loadLearnings({ workspace, home }) {
  try {
    const dir = storeDir(workspace, { home });
    if (!fs.existsSync(dir)) return { learnings: [], staleExcluded: {} };
    return { learnings: loadLayeredLearnings({ workspace, home }).learnings, staleExcluded: readStaleExclusions(dir).excluded };
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
/**
 * The production retrieval eligibility gate — the standard status/stale
 * filters below, returned as the exclusion REASON (or null when eligible), so
 * `scoreLearning` here and the knowledge eval (eval.mjs) share ONE encoding
 * and can never drift. The eval previously kept its own looser active-set that
 * omitted `promoted_to` and stale-anchor exclusions and could therefore score
 * hits on content a real orient would never surface.
 *
 * Filter order (first match wins, historical order from rankLearnings):
 * superseded_by → promoted_to → retired → disputed → stale-anchor exclusion.
 */
export function retrievalExclusion(l, staleExcluded = {}) {
  if (l.fm.superseded_by) return 'superseded';
  if (l.fm.promoted_to) return 'promoted';
  // Branch→golden promotion tombstone (blueprint §5): a bucket entry whose
  // claim was absorbed into golden is excluded exactly like promoted_to.
  if (l.fm.promoted_to_golden) return 'promoted-to-golden';
  if (l.fm.status === 'retired') return 'retired';
  if (l.fm.status === 'disputed') return 'disputed';
  if (staleExcluded[l.id]) return 'stale-anchor';
  return null;
}

function scoreLearning(l, { queryTokens, staleExcluded, include }) {
  const gate = retrievalExclusion(l, staleExcluded);
  if (gate) return { excluded: gate };
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
      // Redact BEFORE the cap: slicing first could cut a credential in half
      // and leave the fragment unmatched (and therefore unredacted).
      trigger: retrievedText(l.fm.trigger),
      claimLine: retrievedText(scored.claimLine).slice(0, 140),
      status: l.fm.status || 'active',
      advisory,
      score: scored.score,
      // Layer marker (blueprint §4): only branch-bucket entries carry the
      // extra fields — golden results stay byte-identical to pre-overlay
      // output, and the no-bucket path never adds a key.
      ...(l.layer === 'branch' ? { layer: 'branch', ...(l.subordinate ? { subordinate: true } : {}) } : {}),
    });
  }

  // Equal-score ties break by layer BEFORE id (blueprint §4): branch-local
  // wins, except a subordinate entry never outranks the protected golden
  // claim it shadows. Entries without layer fields all rank identically, so
  // the historical `score desc, id asc` order is unchanged without buckets.
  return results
    .sort((a, b) => b.score - a.score || layerTieRank(a) - layerTieRank(b) || a.id.localeCompare(b.id))
    .slice(0, limit);
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
      // Same additive layer marker as rankLearnings — absent without buckets.
      ...(l.layer === 'branch' ? { layer: 'branch' } : {}),
    };
  });

  return { queryTokens: [...queryTokens], candidates };
}
