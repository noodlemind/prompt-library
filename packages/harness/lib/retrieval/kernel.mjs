import { redactSecrets } from '../secret-scan.mjs';

export const RETRIEVAL_RECORD_VERSION = 1;

export const SOURCES = Object.freeze(['code', 'knowledge', 'learnings', 'plans']);

const SOURCE_RANK = new Map(SOURCES.map((s, i) => [s, i]));

/** Terminal states a source can report. `failed` is never silently dropped. */
export const SOURCE_STATUSES = Object.freeze(['ok', 'failed', 'skipped']);

const UNTRUSTED_FIELDS = Object.freeze(['id', 'location', 'title', 'snippet', 'reason']);

export const SCORE_PRECISION = 6;

const roundScore = (n) => Number(n.toFixed(SCORE_PRECISION));

function redactField(value) {
  return typeof value === 'string' && value ? redactSecrets(value) : value;
}

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
        sourceScore: score,
    score: 0,
    generation,
    reason,
  };
  for (const field of UNTRUSTED_FIELDS) record[field] = redactField(record[field]);
  return record;
}

const IDENTITY_SEPARATOR = String.fromCharCode(0);

export function resultIdentity(result) {
  return `${result.source}${IDENTITY_SEPARATOR}${result.id}`;
}

export function normalizeSourceScores(results) {
  const max = results.reduce((m, r) => (r.sourceScore > m ? r.sourceScore : m), 0);
  return results.map((r) => ({ ...r, score: max > 0 ? roundScore(r.sourceScore / max) : 0 }));
}

export function compareResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const rank = SOURCE_RANK.get(a.source) - SOURCE_RANK.get(b.source);
  if (rank !== 0) return rank;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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
        partial: reported.some((s) => s.status === 'failed'),
  };
}
