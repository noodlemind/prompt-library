import fs from 'node:fs';
import { storeDir, listLearnings, inertLine } from './store.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { readEvents, EVENTS_MAX_LIMIT } from '../events.mjs';
import { verifiedAndPlans, isPromotionEligible, consolidateStatus } from './consolidate.mjs';

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

/**
 * EVERY SCALAR THIS MODULE EMITS IS SANITIZED HERE, NOT AT THE RENDER SITE.
 *
 * `trigger`, `claimLine`, and episode `path`/`plan` were already passed through
 * `inertLine` — but `status`, `source`, episode `kind`, `id`, `supersededBy`,
 * `promotedTo`, `mergedFrom`, and `lastConfirmed` were emitted RAW. They are
 * `unquote`d frontmatter scalars, and `unquote` DECODES `\n`/`\r`/`\t` escapes
 * back into real control characters — so a hand-edited or legacy learning can
 * carry an embedded newline in any of them, and every one of them lands in a
 * single-line human surface (`ui.line`, the `learningNote` status string, the
 * muted episode bullets) as well as in `--json`.
 *
 * Fixing this at the render sites in commands.mjs would leave `--json` raw and
 * would have to be re-remembered at every new surface. Fixing it HERE means the
 * view objects these two functions return simply cannot carry a control char,
 * whoever renders them.
 *
 * `status`, `source`, and episode `kind` are CODE SETS, so they get the
 * stronger treatment: an allow-list (rule 3), not an escape pass. A value
 * outside the set renders as `unknown` rather than as itself-with-spaces —
 * a code set with an open range is not a code set.
 */
const STATUS_VALUES = new Set(['active', 'provisional', 'retired', 'disputed', 'superseded', 'promoted']);
const SOURCE_VALUES = new Set(['auto', 'human']);
const EPISODE_KINDS = new Set(['fix', 'insight', 'human-teaching']);

const allowed = (set, value, fallback) => (set.has(value) ? value : fallback);

// fm.status never literally holds "superseded" (apply.mjs tracks it via the
// separate superseded_by pointer) — synthesize it here since the listing row
// carries a single status field and the render step needs it to fence pending rows.
function effectiveStatus(fm) {
  if (fm.superseded_by) return 'superseded';
  if (fm.promoted_to) return 'promoted';
  return allowed(STATUS_VALUES, fm.status || 'active', 'unknown');
}

// Exported so apply.mjs's own STRENGTHEN path (the only other place that
// reads a persisted, already-rendered `merged_from` string back off disk) can
// reuse this exact parse instead of drifting a second implementation.
export function parseMergedFrom(raw) {
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

/** parseMergedFrom for a RENDER surface: the same parse, then inertLine per id
 * (see the code-set note above — merged_from ids are free-form scalars off a
 * hand-editable frontmatter line, not a code set). apply.mjs's re-render path
 * deliberately keeps using the raw parseMergedFrom: it is writing the value
 * back to disk, where yamlQuote re-escapes it, not rendering it. */
export function parseMergedFromForRender(raw) {
  const items = parseMergedFrom(raw);
  return items ? items.map((id) => inertLine(id)) : null;
}

export function listingView({ workspace, copilotHome, domain, home }) {
  const dir = storeDir(workspace, { home });
  // Read-only: a storeless workspace must never be materialized by a listing
  // call — an absent store just means nothing to list yet.
  if (!fs.existsSync(dir)) return { learnings: [], counts: { active: 0, total: 0 }, quarantined: [] };
  const all = listLearnings(dir);
  const scoped = domain ? all.filter((l) => l.domain === domain) : all;
  const failures = failureCounts(workspace);

  const learnings = scoped
    .map((l) => {
      const { verified, plans } = verifiedAndPlans(l.fm);
      return {
        // A learning id is built from directory and file names, which on POSIX
        // may contain any byte but `/` and NUL — including control chars.
        id: inertLine(l.id),
        status: effectiveStatus(l.fm),
        source: allowed(SOURCE_VALUES, l.fm.source || 'auto', 'unknown'),
        // inertLine: a legacy/hand-edited learning's trigger can still carry
        // an embedded control char (store.mjs's doc comment) — collapsed to
        // a space so this listing row always renders as one line.
        trigger: inertLine(redactSecrets(l.fm.trigger || '')),
        verified,
        plans,
        // A promoted learning is never eligible for promotion again — its
        // behavior already lives in a primitive — regardless of how many fix
        // links/plans it has on record.
        promotionEligible: l.fm.promoted_to ? false : isPromotionEligible(verified, plans),
        failures: failures.get(l.id) || 0,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const active = learnings.filter((l) => !['retired', 'disputed', 'superseded', 'promoted'].includes(l.status)).length;
  // Same source of truth consolidateStatus/doctor K2 use — non-creating, the
  // store already exists per the guard above, so this never materializes it.
  const quarantined = consolidateStatus({ workspace, copilotHome, home }).quarantined.map((q) => ({
    path: q.path,
    sha256: q.sha256,
  }));
  return { learnings, counts: { active, total: learnings.length }, quarantined };
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
  // Redact BEFORE the cap (same order as retrieve.mjs's retrievedText): slicing
  // first cuts a credential that straddles byte 140 into a fragment the secret
  // scanner no longer matches, so the tail leaks unredacted.
  const claimLine = inertLine(redactSecrets((body.split('\n').find((line) => line.trim()) || '').trim())).slice(0, 140);
  const failures = failureCounts(workspace).get(id) || 0;

  return {
    // `id` is the caller's lookup string echoed back into a rendered row.
    id: inertLine(id),
    // inertLine: same render-side normalization as listingView above — a
    // legacy/hand-edited trigger can still carry an embedded control char.
    trigger: inertLine(redactSecrets(fm.trigger || '')),
    claimLine,
    status: effectiveStatus(fm),
    source: allowed(SOURCE_VALUES, fm.source || 'auto', 'unknown'),
    // The remaining frontmatter scalars are free-form (a date, two learning
    // ids, a workspace-relative primitive path), all `unquote`d off a
    // hand-editable line, all rendered on a single line — same treatment.
    lastConfirmed: fm.last_confirmed ? inertLine(fm.last_confirmed) : null,
    supersededBy: fm.superseded_by ? inertLine(fm.superseded_by) : null,
    promotedTo: fm.promoted_to ? inertLine(redactSecrets(String(fm.promoted_to))) : null,
    mergedFrom: parseMergedFromForRender(fm.merged_from),
    // Episode paths and plan refs come from learning frontmatter, which is
    // hand-editable — same untrusted class as trigger/claim, so they get the
    // same treatment rather than being emitted raw.
    episodes: (fm.episodes || []).map((e) => ({
      path: inertLine(redactSecrets(String(e.path || ''))),
      // Code set (episodeLines normalizes an unknown kind to 'fix' at WRITE
      // time; a legacy or hand-edited file can still carry anything here).
      kind: allowed(EPISODE_KINDS, e.kind, 'unknown'),
      plan: e.plan ? inertLine(redactSecrets(String(e.plan))) : null,
    })),
    verified,
    plans,
    // Same guard as listingView: a promoted learning is never eligible for
    // promotion again, regardless of link counts.
    promotionEligible: fm.promoted_to ? false : isPromotionEligible(verified, plans),
    failures,
  };
}
