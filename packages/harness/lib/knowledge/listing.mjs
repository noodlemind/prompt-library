import fs from 'node:fs';
import { storeDir, listLearnings } from './store.mjs';
import { readEvents, EVENTS_MAX_LIMIT } from '../events.mjs';
import { verifiedAndPlans, isPromotionEligible } from './consolidate.mjs';

/**
 * Read-only fenced listing and single-learning provenance view over the
 * knowledge store. Never writes — no events, no store mutation; matches the
 * recall/report convention (harness-tool-contract.md:176).
 *
 * The promotion signal (≥3 fix-kind episode links across ≥2 distinct plans)
 * is defined once in consolidate.mjs (verifiedAndPlans/isPromotionEligible)
 * and shared with promotionCandidates there, so the thresholds never drift
 * between the two surfaces.
 */

/**
 * id → count of workspace verify-fail events that named it. Tolerates a
 * missing/corrupt events file. Pre-filters to failures (readEvents' own
 * `failures` predicate: result === 'fail' || decision === 'block' ||
 * blockedReason) before applying the max window, so unrelated event types
 * (orient, gate, pre_tool, ...) can never dilute a verify-fail out of the
 * window the way the plain default (unfiltered, 20-event) window would —
 * same pre-filter-then-slice pattern as cmdEvents (commands.mjs).
 */
function failureCounts(workspace) {
  const counts = new Map();
  try {
    for (const e of readEvents(workspace, { failures: true, limit: EVENTS_MAX_LIMIT })) {
      if (e.type === 'verify' && e.result === 'fail' && Array.isArray(e.learnings)) {
        for (const id of e.learnings) counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
  } catch {
    // missing/corrupt events file — no failure annotations
  }
  return counts;
}

// fm.status never literally holds "superseded" (apply.mjs tracks it via the
// separate superseded_by pointer) — synthesize it here since the listing row
// carries a single status field and the render step needs it to fence pending rows.
function effectiveStatus(fm) {
  if (fm.superseded_by) return 'superseded';
  return fm.status || 'active';
}

function parseMergedFrom(raw) {
  if (!raw) return null;
  const items = String(raw)
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

export function listingView({ workspace, domain, home }) {
  const dir = storeDir(workspace, { home });
  // Read-only: a storeless workspace must never be materialized by a listing
  // call — an absent store just means nothing to list yet.
  if (!fs.existsSync(dir)) return { learnings: [], counts: { active: 0, total: 0 } };
  const all = listLearnings(dir);
  const scoped = domain ? all.filter((l) => l.domain === domain) : all;
  const failures = failureCounts(workspace);

  const learnings = scoped
    .map((l) => {
      const { verified, plans } = verifiedAndPlans(l.fm);
      return {
        id: l.id,
        status: effectiveStatus(l.fm),
        source: l.fm.source || 'auto',
        trigger: l.fm.trigger || '',
        verified,
        plans,
        promotionEligible: isPromotionEligible(verified, plans),
        failures: failures.get(l.id) || 0,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const active = learnings.filter((l) => !['retired', 'disputed', 'superseded'].includes(l.status)).length;
  return { learnings, counts: { active, total: learnings.length } };
}

export function whyView({ workspace, id, home }) {
  const dir = storeDir(workspace, { home });
  // Read-only: a storeless workspace must never be materialized by a --why
  // lookup — an absent store just means the target can't exist either.
  if (!fs.existsSync(dir)) return null;
  const learning = listLearnings(dir).find((l) => l.id === id);
  if (!learning) return null;

  const { fm, body } = learning;
  const { verified, plans } = verifiedAndPlans(fm);
  const claimLine = (body.split('\n').find((line) => line.trim()) || '').trim().slice(0, 140);
  const failures = failureCounts(workspace).get(id) || 0;

  return {
    id,
    trigger: fm.trigger || '',
    claimLine,
    status: effectiveStatus(fm),
    source: fm.source || 'auto',
    lastConfirmed: fm.last_confirmed || null,
    supersededBy: fm.superseded_by || null,
    mergedFrom: parseMergedFrom(fm.merged_from),
    episodes: (fm.episodes || []).map((e) => ({ path: e.path, kind: e.kind, plan: e.plan || null })),
    verified,
    plans,
    promotionEligible: isPromotionEligible(verified, plans),
    failures,
  };
}
