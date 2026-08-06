import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { storeDir, listLearnings, readGovernance } from './store.mjs';
import { deriveGitContext } from '../git-context.mjs';

/**
 * The layered read path (harness evolution blueprint §4) — ONE exported
 * overlay shared by production retrieval (retrieve.mjs) and the knowledge
 * eval (eval.mjs), so the two can never drift on which learnings are
 * candidates (the same reason retrievalExclusion is shared).
 *
 * Candidate set = golden actives ∪ current branch-key bucket actives, with
 * the approval-condition gates applied here — never bypassable downstream:
 *
 *  1. PROTECTED-SHADOW: a branch-local learning with the same id REPLACES the
 *     golden claim UNLESS the golden claim is protected (≥3 verified
 *     `kind: fix` episode links or `source: human`) — a protected claim is
 *     never shadowed; the branch-local claim stays as an additional,
 *     SUBORDINATE entry instead. This mirrors the write path's
 *     protected-target rule so the read path cannot bypass a gate the writer
 *     enforces.
 *  2. GOVERNANCE BINDS BOTH LAYERS: an id under a standing
 *     retire/dispute/promote decision (readGovernance replay) is NEVER
 *     surfaced from a bucket — reusing a governed id in a bucket triggers the
 *     standing decision, it does not escape it.
 *  3. ANCESTRY (P7, branch-name reuse): a bucket whose recorded meta.baseSha
 *     is not an ancestor of the current HEAD (force-push name reuse with
 *     unrelated history) is excluded from the overlay entirely and surfaced
 *     by `knowledge status`.
 *
 * Branch-layer entries carry `layer: 'branch'` (plus `subordinate: true` in
 * the protected-shadow case); golden entries are returned EXACTLY as
 * listLearnings hands them back — no extra fields — so with no `branches/`
 * directory the output is byte-identical to pre-overlay behavior (regression-
 * tested). Ranking uses the layer as a tiebreak BEFORE the id tiebreak:
 * branch-local wins equal-score ties, except a subordinate entry never
 * outranks the protected golden claim it shadows.
 */

const GOVERNED_EXCLUSION_ACTIONS = new Set(['retire', 'dispute', 'promote']);
const PROTECTED_FIX_THRESHOLD = 3;
const SHA_RE = /^[0-9a-f]{40}$/;

/** The write path's protected-target predicate (apply.mjs's
 * isDisputedTargetFm), re-stated for the read path: too well-evidenced or
 * human-taught to be displaced without a human. */
export function isProtectedFm(fm) {
  const fixes = (fm.episodes || []).filter((e) => e.kind === 'fix').length;
  return fixes >= PROTECTED_FIX_THRESHOLD || fm.source === 'human';
}

export function branchesRoot(dir) {
  return path.join(dir, 'branches');
}

export function bucketDirFor(dir, key) {
  return path.join(branchesRoot(dir), key);
}

/** Parsed bucket meta.json, or null. Meta is a CACHE, never authority —
 * promotability and detachment are re-derived from the key shape at decision
 * time; meta only carries display/ancestry hints. */
export function readBucketMeta(bucketDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(bucketDir, 'meta.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Every bucket under `branches/`, sorted by key: `[{ key, dir, meta }]`. */
export function listBuckets(dir) {
  const root = branchesRoot(dir);
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const bucketDir = path.join(root, e.name);
    out.push({ key: e.name, dir: bucketDir, meta: readBucketMeta(bucketDir) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Ancestry gate for a bucket's recorded baseSha against the workspace HEAD.
 * `true` = verified ancestor; `false` = verified NOT an ancestor (or the sha
 * is unknown to this repo — force-push name reuse); `null` = unverifiable
 * (no recorded base, or git itself unavailable) — unverifiable buckets stay
 * included, since exclusion is a defense against PROVEN unrelated history,
 * not against missing metadata on a legacy bucket.
 */
export function bucketAncestryOk(workspace, meta) {
  if (!meta || typeof meta.baseSha !== 'string' || !SHA_RE.test(meta.baseSha)) return null;
  try {
    const res = spawnSync('git', ['merge-base', '--is-ancestor', meta.baseSha, 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (res.error) return null;
    // A signal-killed git (status null, e.g. a timeout) proved nothing —
    // unverifiable, never "proven not an ancestor".
    if (typeof res.status !== 'number') return null;
    return res.status === 0;
  } catch {
    return null;
  }
}

/**
 * The overlay itself. Returns `{ learnings, layered, context }`:
 * `learnings` is the merged candidate list (sorted by id — the same order
 * listLearnings uses); `layered` is true only when a current-branch bucket
 * actually contributed; `context` is the derived git context (null on the
 * no-branches fast path, where git is never invoked at all).
 *
 * Read-only and tolerant like every retrieval read: a missing store, missing
 * bucket, or non-git workspace degrades to golden-only, never a throw.
 */
export function loadLayeredLearnings({ workspace, home } = {}) {
  let dir;
  try {
    dir = storeDir(workspace, { home });
  } catch {
    return { learnings: [], layered: false, context: null };
  }
  if (!fs.existsSync(dir)) return { learnings: [], layered: false, context: null };
  const golden = listLearnings(dir);

  // Fast path — no branches/ directory: golden only, byte-identical to
  // pre-overlay behavior, zero git spawns.
  if (!fs.existsSync(branchesRoot(dir))) return { learnings: golden, layered: false, context: null };

  let context = null;
  try {
    context = deriveGitContext({ workspace, home });
  } catch {
    context = null;
  }
  if (!context?.branchKey) return { learnings: golden, layered: false, context };

  const bucketDir = bucketDirFor(dir, context.branchKey);
  if (!fs.existsSync(path.join(bucketDir, 'learnings'))) {
    return { learnings: golden, layered: false, context };
  }

  // Ancestry gate (P7): a bucket whose recorded base provably shares no
  // history with the current HEAD is a name-reuse artifact — excluded whole.
  const meta = readBucketMeta(bucketDir);
  if (bucketAncestryOk(workspace, meta) === false) {
    return { learnings: golden, layered: false, context, excludedBucket: { key: context.branchKey, reason: 'ancestry' } };
  }

  let bucketLearnings;
  try {
    bucketLearnings = listLearnings(bucketDir);
  } catch {
    return { learnings: golden, layered: false, context };
  }
  if (!bucketLearnings.length) return { learnings: golden, layered: false, context };

  const governance = readGovernance(dir);
  const goldenById = new Map(golden.map((l) => [l.id, l]));
  const merged = new Map(goldenById);

  for (const b of bucketLearnings) {
    // Candidate set = golden actives ∪ branch ACTIVES (§4): an inactive or
    // tombstoned bucket entry (superseded, retired/disputed, promoted, or
    // `promoted_to_golden` after the §5 promotion) must never enter the set —
    // letting it SHADOW a golden twin and then be excluded downstream would
    // hide the golden claim entirely.
    if (
      b.fm.superseded_by ||
      b.fm.promoted_to ||
      b.fm.promoted_to_golden ||
      ['retired', 'disputed'].includes(b.fm.status)
    ) {
      continue;
    }
    // Governance binds both layers: a standing retire/dispute/promote on this
    // id is never escaped by re-minting it in a bucket.
    const decision = governance.get(b.id);
    if (decision && GOVERNED_EXCLUSION_ACTIONS.has(decision.action)) continue;

    const goldenTwin = goldenById.get(b.id);
    if (goldenTwin && isProtectedFm(goldenTwin.fm)) {
      // Protected golden is never shadowed — the branch claim rides along as
      // a subordinate sibling. Two entries share the id; the subordinate one
      // loses every tie to its protected twin (rank tiebreak).
      merged.set(`${b.id}#branch`, { ...b, layer: 'branch', subordinate: true });
      continue;
    }
    // Shadow (or plain addition): the branch-local claim IS the candidate.
    merged.set(b.id, { ...b, layer: 'branch' });
  }

  const learnings = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id) || (a.subordinate ? 1 : 0) - (b.subordinate ? 1 : 0));
  return { learnings, layered: true, context };
}

/**
 * Layer tiebreak rank for result sorting — applied BEFORE the id tiebreak
 * (blueprint §4): branch-local (0) wins equal-score ties over golden (1);
 * a subordinate branch entry (2) never outranks the protected golden claim
 * it shadows. Entries without layer fields (the no-bucket path) all rank 1,
 * leaving the historical `score desc, id asc` order byte-identical.
 */
export function layerTieRank(entry) {
  if (entry?.subordinate) return 2;
  return entry?.layer === 'branch' ? 0 : 1;
}
