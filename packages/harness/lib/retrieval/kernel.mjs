/**
 * Retrieval kernel — one result record and one federation point for every
 * retrieval command (`search`, `lookup`, `tree`, and the existing `recall`/
 * `orient` fan-out as they migrate).
 *
 * Why this exists (P2.1). Today four corpora are reached by four unrelated call
 * sites — `rankRecall` (knowledge docs), `rankLearnings` (learnings),
 * `findMatchingPlans` (plans), `buildRepoMap`/structural index (code) — and
 * `runOrient` is the only place that fans out across all four. It merges
 * nothing: each lands in its own result field. There is no score normalization
 * across sources, no dedup identity, and no cursor anywhere. Adding three more
 * commands on top of that would mean three more private shapes, and P2AC3's
 * determinism requirement would become a reconciliation job across all of them
 * instead of a property of one function.
 *
 * `source` is the CORPUS axis and is deliberately NOT called `scope`. `scope`
 * already means `'global' | 'product'` — which knowledge root a doc came from —
 * and it rides on every recall/orient result and every postings entry, where
 * AC9 forbids reshaping it. The delivery doc's P2AC2 lists both fields ("source,
 * scope, location/entity id") for exactly this reason: they are two axes, not
 * one renamed.
 */
import { redactSecrets } from '../secret-scan.mjs';

export const RETRIEVAL_RECORD_VERSION = 1;

/**
 * The corpora, in tie-break order. This order is part of the determinism
 * contract (P2AC3): when two results score identically, the earlier source
 * wins, so the same query against the same generation always yields the same
 * sequence. Appending a source is safe; reordering changes published output.
 */
export const SOURCES = Object.freeze(['code', 'knowledge', 'learnings', 'plans']);

const SOURCE_RANK = new Map(SOURCES.map((s, i) => [s, i]));

/** Terminal states a source can report. `failed` is never silently dropped. */
export const SOURCE_STATUSES = Object.freeze(['ok', 'failed', 'skipped']);

/**
 * Free-text fields that carry corpus content and must be redacted at the DATA
 * boundary — in the result builder, before any lane sees them — mirroring
 * `redactRecallEntry`'s discipline. A render-boundary-only screen missed the
 * raw `--json` emit and the path/id fields entirely in Phase 1.
 *
 * `source`, `scope`, `kind`, `generation` and `score` are code-set
 * classification, enum, and numeric tokens rather than free-text credential
 * carriers, so they are left untouched — the same line `redactRecallEntry`
 * draws, for the same reason.
 */
const UNTRUSTED_FIELDS = Object.freeze(['id', 'location', 'title', 'snippet', 'reason']);

/**
 * Scores are compared after rounding to this many decimals. Normalization
 * divides by a per-source maximum, and raw IEEE-754 quotients can differ in the
 * last bits for values that are mathematically equal — enough to swap two rows
 * between runs and break the byte-identity guarantee. Rounding first makes the
 * comparison exact.
 */
export const SCORE_PRECISION = 6;

const roundScore = (n) => Number(n.toFixed(SCORE_PRECISION));

function redactField(value) {
  return typeof value === 'string' && value ? redactSecrets(value) : value;
}

/**
 * Build one retrieval result. `score` is the source's own native score — the
 * corpora do not share a scale (BM25 sums vs. hit ratios vs. repo-map weights),
 * so normalization is `federate`'s job, not the caller's.
 *
 * Throws on an unknown source or a missing id: a result that cannot be
 * identified cannot be deduped, cursored, or looked up, and silently admitting
 * one would surface later as a nondeterministic ordering bug.
 */
export function createRetrievalResult({
  source,
  scope = null,
  id,
  location = null,
  title = null,
  snippet = null,
  score = 0,
  generation = null,
  reason = null,
  kind = null,
}) {
  if (!SOURCE_RANK.has(source)) {
    throw new Error(`createRetrievalResult: unknown source ${JSON.stringify(source)} (expected ${SOURCES.join(' | ')})`);
  }
  if (typeof id !== 'string' || !id) {
    throw new Error(`createRetrievalResult: id (non-empty string) is required for source ${source}`);
  }
  if (!Number.isFinite(score)) {
    throw new Error(`createRetrievalResult: score must be a finite number, got ${JSON.stringify(score)}`);
  }
  const record = {
    source,
    scope,
    id,
    location,
    title,
    snippet,
    kind,
    // `sourceScore` is retained so `--explain` can show the native number the
    // corpus actually produced; `score` below is the cross-source comparable.
    sourceScore: score,
    score: 0,
    generation,
    reason,
  };
  for (const field of UNTRUSTED_FIELDS) record[field] = redactField(record[field]);
  return record;
}

/**
 * Stable dedup identity. `(source, id)` is unique by construction.
 *
 * NUL as the separator, written as an explicit escape so it is visible in
 * source: it cannot occur in a source name (closed set) nor in any id the
 * corpora produce (paths, docids, `domain/slug`), so the key cannot be forged
 * by an id that happens to contain the separator character. A printable
 * separator would make `{source:'a', id:'b c'}` and `{source:'a b', id:'c'}`
 * collide if a source name ever gained a space.
 */
const IDENTITY_SEPARATOR = String.fromCharCode(0);

export function resultIdentity(result) {
  return `${result.source}${IDENTITY_SEPARATOR}${result.id}`;
}

/**
 * Map one source's native scores onto 0..1 by dividing by that source's own
 * maximum. Deliberately max-relative rather than min-max: min-max would push a
 * source's worst hit to exactly 0 and drop it below every other source's floor,
 * so a corpus whose results are all similarly good would be systematically
 * buried. Dividing by the max keeps a source's internal spread while making the
 * best hit from each corpus comparable.
 *
 * A non-positive max (every score 0, or a corpus with no scoring) maps every
 * result to 0 and leaves ordering to the source/id tie-break rather than
 * dividing by zero.
 */
export function normalizeSourceScores(results) {
  const max = results.reduce((m, r) => (r.sourceScore > m ? r.sourceScore : m), 0);
  return results.map((r) => ({ ...r, score: max > 0 ? roundScore(r.sourceScore / max) : 0 }));
}

/**
 * Total ordering over federated results: score desc, then source rank, then id.
 * Total — never a coin flip — because `(source, id)` is unique, which is what
 * makes the same query against the same generation byte-identical (P2AC3).
 */
export function compareResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const rank = SOURCE_RANK.get(a.source) - SOURCE_RANK.get(b.source);
  if (rank !== 0) return rank;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A cursor pins the exact position in the total order, not an offset: an offset
 * silently skips or repeats rows when the underlying corpus changes between
 * pages. It also carries the generation each source was read at, so a caller
 * paging across an index rebuild can be told rather than served a torn result
 * set.
 */
export function encodeCursor({ score, source, id, generations }) {
  return Buffer.from(JSON.stringify({ v: RETRIEVAL_RECORD_VERSION, score, source, id, generations }), 'utf8').toString('base64url');
}

export function decodeCursor(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid --cursor: not a cursor this build issued'), { code: 'E_USAGE' });
  }
  if (!parsed || parsed.v !== RETRIEVAL_RECORD_VERSION || typeof parsed.id !== 'string' || !SOURCE_RANK.has(parsed.source)) {
    throw Object.assign(new Error('invalid --cursor: not a cursor this build issued'), { code: 'E_USAGE' });
  }
  return parsed;
}

/**
 * Merge per-source result sets into one deterministic, paginated set.
 *
 * `sources` is an array of `{ source, status, results?, generation?, reason? }`.
 * A source that failed reports `status: 'failed'` with a reason and is carried
 * into the response rather than dropped — P2AC3 requires partial-source failure
 * to be explicit, because a silently missing corpus is indistinguishable from
 * one with no matches, and the two mean opposite things to the caller.
 */
export function federate({ sources = [], limit = 20, cursor = null } = {}) {
  const after = decodeCursor(cursor);
  const generations = {};
  const reported = [];
  let merged = [];

  for (const entry of sources) {
    const { source, status = 'ok', results = [], generation = null, reason = null } = entry;
    if (!SOURCE_RANK.has(source)) {
      throw new Error(`federate: unknown source ${JSON.stringify(source)}`);
    }
    if (!SOURCE_STATUSES.includes(status)) {
      throw new Error(`federate: unknown status ${JSON.stringify(status)} for source ${source}`);
    }
    if (generation !== null) generations[source] = generation;
    reported.push({ source, status, reason, generation, count: status === 'ok' ? results.length : 0 });
    if (status !== 'ok') continue;
    merged = merged.concat(normalizeSourceScores(results));
  }

  const seen = new Set();
  const ordered = merged
    .filter((r) => {
      const key = resultIdentity(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareResults);

  const start = after
    ? ordered.findIndex((r) => compareResults(r, { score: after.score, source: after.source, id: after.id }) > 0)
    : 0;
  // A cursor whose position no longer exists (the row was removed between
  // pages) yields -1; treat that as "past the end" rather than restarting from
  // the top, which would silently re-serve rows the caller already saw.
  const from = start === -1 ? ordered.length : start;
  const page = ordered.slice(from, from + limit);
  const last = page[page.length - 1];
  const more = from + page.length < ordered.length;

  return {
    schema: RETRIEVAL_RECORD_VERSION,
    results: page,
    sources: reported,
    total: ordered.length,
    truncated: more,
    nextCursor: more && last ? encodeCursor({ score: last.score, source: last.source, id: last.id, generations }) : null,
    generations,
    // Explicit rather than derived by the caller: a partial result set that
    // reads as complete is the failure mode this field exists to prevent.
    partial: reported.some((s) => s.status === 'failed'),
  };
}
