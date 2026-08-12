export function byteCompare(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Score bands, highest first. Kept as named constants so a reader can see the
 * intended hierarchy without decoding arithmetic. */
export const SCORE = Object.freeze({
  EXACT: 1000,
  PREFIX: 800,
  WORD_BOUNDARY: 600,
  ALL_WORDS: 400,
    INTERIOR: 200,
  SUBSEQUENCE: 100,
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

export function scoreRow(row, rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase();
  const label = String(row.label || '').toLowerCase();
  if (!query) return 0;
  if (!label) return null;

  if (label === query) return SCORE.EXACT;
  if (label.startsWith(query)) return SCORE.PREFIX;

  const labelWords = words(label);
    if (labelWords.some((w) => w.startsWith(query))) return SCORE.WORD_BOUNDARY;

    const queryWords = words(query);
  if (queryWords.length > 1 && queryWords.every((q) => labelWords.some((w) => w.startsWith(q)))) {
    return SCORE.ALL_WORDS;
  }

  if (label.includes(query)) return SCORE.INTERIOR;
    if (isSubsequence(query, label)) return SCORE.SUBSEQUENCE;
  return null;
}

export function rankRows(rows, query) {
  const scored = [];
  for (const row of rows) {
    const score = scoreRow(row, query);
    if (score === null) continue;
    scored.push({ row, score });
  }
    const strong = scored.filter((s) => s.score > SCORE.SUBSEQUENCE);
  const kept = strong.length ? strong : scored;
  kept.sort((a, b) => (
    b.score - a.score
    || String(a.row.label).length - String(b.row.label).length
    || byteCompare(a.row.label, b.row.label)
    || byteCompare(a.row.id, b.row.id)
  ));
  return kept.map((s) => s.row);
}

