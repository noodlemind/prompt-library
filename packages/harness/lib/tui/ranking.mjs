/**
 * Palette ranking (P4bAC9).
 *
 * Deterministic by construction: the same query against the same index yields
 * the same order, every time, on every machine. That is not a nicety — a
 * palette whose order shifts between keystrokes trains people to stop reading
 * it and to memorize positions that then betray them.
 *
 * WORD-BOUNDARY MATCHES RANK ABOVE INTERIOR ONES, which is the whole reason
 * this is not a plain substring filter. Typing `run` should offer `run list`
 * before `prune`, because the person typing three letters is naming a thing,
 * not describing where those letters appear. Every surveyed tool that got this
 * wrong ended up with a palette people fought.
 *
 * Ties are broken by explicit, total ordering rather than left to sort
 * stability, because "stable" depends on the input order, and the input order
 * depends on registration order across files — which is incidental.
 */

/** Score bands, highest first. Kept as named constants so a reader can see the
 * intended hierarchy without decoding arithmetic. */
export const SCORE = Object.freeze({
  EXACT: 1000,
  PREFIX: 800,
  WORD_BOUNDARY: 600,
  ALL_WORDS: 400,
  SUBSEQUENCE: 200,
  INTERIOR: 100,
});

/** Split a label into the words a person would think of it as having.
 * `knowledge prune --merged` → knowledge, prune, merged. */
function words(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/** Is `query` a subsequence of `text` — every character present, in order?
 * This is the loosest match the palette accepts, and it scores lowest. */
function isSubsequence(query, text) {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i += 1;
    if (i === query.length) return true;
  }
  return query.length === 0;
}

/**
 * Score one row against a query. `null` means no match at all — the row is
 * dropped rather than shown at the bottom, because a palette that always shows
 * everything is a list, not a filter.
 */
export function scoreRow(row, rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase();
  const label = String(row.label || '').toLowerCase();
  if (!query) return 0;
  if (!label) return null;

  if (label === query) return SCORE.EXACT;
  if (label.startsWith(query)) return SCORE.PREFIX;

  const labelWords = words(label);
  // A query word that begins any word of the label — `run` matching `run list`,
  // or `pru` matching `knowledge prune`.
  if (labelWords.some((w) => w.startsWith(query))) return SCORE.WORD_BOUNDARY;

  // Multi-word query: every word must land on some word of the label, so
  // `kn pr` finds `knowledge prune` without matching `knowledge status`.
  const queryWords = words(query);
  if (queryWords.length > 1 && queryWords.every((q) => labelWords.some((w) => w.startsWith(q)))) {
    return SCORE.ALL_WORDS;
  }

  if (label.includes(query)) return SCORE.INTERIOR;
  if (isSubsequence(query, label)) return SCORE.SUBSEQUENCE;
  return null;
}

/**
 * Rank an index's rows against a query.
 *
 * The tie-break is a TOTAL ordering — score, then label length (a shorter label
 * containing the query is the more likely target), then the label itself, then
 * the row id. Sort stability is deliberately not relied upon: it would make the
 * result depend on registration order across files, which is incidental and
 * would drift the moment someone moved a `registerCommand` call.
 */
export function rankRows(rows, query) {
  const scored = [];
  for (const row of rows) {
    const score = scoreRow(row, query);
    if (score === null) continue;
    scored.push({ row, score });
  }
  scored.sort((a, b) => (
    b.score - a.score
    || String(a.row.label).length - String(b.row.label).length
    || String(a.row.label).localeCompare(String(b.row.label))
    || String(a.row.id).localeCompare(String(b.row.id))
  ));
  return scored.map((s) => s.row);
}
