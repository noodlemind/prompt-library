const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

/**
 * Okapi BM25 IDF for term t with document frequency df in corpus of N docs.
 */
export function idf(N, df) {
  if (N <= 0 || df <= 0) return 0;
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

/**
 * BM25 term score for one query term against a document.
 */
export function termScore(tf, docLength, avgdl, idfVal, k1 = DEFAULT_K1, b = DEFAULT_B) {
  if (tf <= 0 || idfVal <= 0) return 0;
  const norm = 1 - b + b * (docLength / Math.max(avgdl, 1));
  return idfVal * ((tf * (k1 + 1)) / (tf + k1 * norm));
}

export function scoreDocuments(queryTerms, index) {
  const { N, avgdl, docLengths, terms } = index;
  const scores = new Map();
  const uniqueTerms = [...new Set(queryTerms)];

  for (const term of uniqueTerms) {
    const postings = terms[term];
    if (!postings) continue;
    const df = Object.keys(postings).length;
    const idfVal = idf(N, df);
    if (idfVal <= 0) continue;

    for (const [docId, tf] of Object.entries(postings)) {
      const dl = docLengths[docId] ?? 0;
      const s = termScore(tf, dl, avgdl, idfVal);
      scores.set(docId, (scores.get(docId) || 0) + s);
    }
  }

  return scores;
}

/**
 * Normalize raw BM25 scores to 0–1 range (max score = 1).
 */
export function normalizeScores(scores) {
  if (!scores.size) return scores;
  let max = 0;
  for (const v of scores.values()) max = Math.max(max, v);
  if (max <= 0) return scores;
  const out = new Map();
  for (const [k, v] of scores) out.set(k, v / max);
  return out;
}
