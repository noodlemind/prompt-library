/**
 * How wide a string actually is on screen.
 *
 * THE BUG THIS EXISTS TO KILL. Every measurement in the first composer was
 * `[...text].length` — code points, not cells. A code point is not a cell three
 * separate ways, and each one broke the layout differently:
 *
 *   - `日本語` is 3 code points and 6 cells, so a hairline computed from it came
 *     out 3 cells short and the rule stopped mid-line.
 *   - `é` written as `e` + U+0301 is 2 code points and 1 cell, so the same rule
 *     came out a cell long.
 *   - `👩‍💻` is 3 code points (woman, ZWJ, computer) and 2 cells, and splitting it
 *     for a wrap emits half a person.
 *
 * So: cluster first, then measure each cluster. `Intl.Segmenter` does the
 * clustering — it has been in Node since 16 and knows the current Unicode
 * version, which a hand-rolled combining-mark scan never does. The width table
 * below is the part `Intl` has no API for.
 *
 * The table is DERIVED FROM EAST ASIAN WIDTH (UAX #11), keeping only the `W`
 * and `F` ranges, which are the ones that occupy two cells. It is deliberately
 * range-based rather than exhaustive: the ranges are stable across Unicode
 * revisions in a way individual assignments are not, so this ages slowly and
 * fails narrow (a new wide character measured as 1) rather than wide.
 */

/** ANSI SGR — colour, not content, and never occupies a cell. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

/**
 * East Asian Wide + Fullwidth, as inclusive code-point ranges.
 * Sorted, so lookup is a binary search rather than a scan.
 */
const WIDE_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat, CJK compat
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // emoji: symbols & pictographs, emoticons
  [0x1f900, 0x1f9ff], // emoji: supplemental symbols & pictographs
  [0x1fa70, 0x1faff], // emoji: extended-A
  [0x20000, 0x2fffd], // CJK Extension B..F
  [0x30000, 0x3fffd], // CJK Extension G
];

function isWideCodePoint(cp) {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = WIDE_RANGES[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Zero-width: combining marks, joiners, variation selectors.
 *
 * These attach to the cluster before them. Measured individually they would
 * each claim a cell that the terminal never gives them.
 */
function isZeroWidthCodePoint(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) // combining diacritical marks
    || (cp >= 0x1ab0 && cp <= 0x1aff)
    || (cp >= 0x20d0 && cp <= 0x20ff) // combining marks for symbols
    || (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
    || (cp >= 0xfe20 && cp <= 0xfe2f) // combining half marks
    || cp === 0x200b || cp === 0x200c || cp === 0x200d // ZW space / non-joiner / joiner
    || cp === 0xfeff // BOM / ZWNBSP
    || (cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
  );
}

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/**
 * Split into grapheme clusters — what a person calls "one character".
 *
 * Without `Intl.Segmenter` this degrades to code points, which is wrong for
 * combining sequences but never *crashes* and never splits a surrogate pair.
 * A degraded measurement beats a thrown one in a terminal renderer.
 */
export function graphemes(text) {
  const s = String(text ?? '');
  if (!s) return [];
  if (!segmenter) return [...s];
  const out = [];
  for (const { segment } of segmenter.segment(s)) out.push(segment);
  return out;
}

/** Cells one grapheme cluster occupies: 0, 1, or 2. */
export function clusterWidth(cluster) {
  const s = String(cluster ?? '');
  if (!s) return 0;
  let width = 0;
  let sawBase = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isZeroWidthCodePoint(cp)) continue;
    // C0/C1 controls print nothing. A tab is ambiguous by nature (it depends on
    // where the cursor already is) and is expanded before it reaches here.
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    const w = isWideCodePoint(cp) ? 2 : 1;
    // A ZWJ sequence (👩‍💻) renders as ONE glyph, so only the first base counts.
    // Taking the max rather than the first keeps a narrow+wide join at 2.
    if (sawBase) width = Math.max(width, w);
    else { width = w; sawBase = true; }
  }
  return width;
}

/** Display width of a string, ignoring colour. */
export function displayWidth(text) {
  let total = 0;
  for (const g of graphemes(stripAnsi(text))) total += clusterWidth(g);
  return total;
}

/**
 * Pad to `width` cells. Never truncates — a caller that wants clipping asks
 * for it, so padding cannot silently lose the end of a line.
 */
export function padTo(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? `${text}${' '.repeat(gap)}` : String(text ?? '');
}

/**
 * Clip to `width` cells, cluster-wise.
 *
 * A wide cluster that would straddle the boundary is dropped rather than split:
 * half of `日` is not a character, and terminals disagree about what to do with
 * the leftover cell. Returns at most `width` cells, possibly one short.
 */
export function clipTo(text, width) {
  if (width <= 0) return '';
  let used = 0;
  let out = '';
  for (const g of graphemes(String(text ?? ''))) {
    const w = clusterWidth(g);
    if (used + w > width) break;
    out += g;
    used += w;
  }
  return out;
}

/**
 * Break one logical line into rows of at most `width` cells.
 *
 * Cluster-wise, so a wide character is never split and a combining mark never
 * leaves its base behind. An empty line yields one empty row, because a blank
 * line in the editor is still a line you can put the cursor on.
 */
export function wrapCells(line, width) {
  if (width <= 0) return [''];
  const clusters = graphemes(String(line ?? ''));
  if (!clusters.length) return [''];
  const rows = [];
  let current = '';
  let used = 0;
  for (const g of clusters) {
    const w = clusterWidth(g);
    if (used + w > width && current) {
      rows.push(current);
      current = '';
      used = 0;
    }
    current += g;
    used += w;
  }
  if (current || !rows.length) rows.push(current);
  return rows;
}

/**
 * Where the cursor sits, in cells, after `index` clusters of `line`.
 * The composer stores the cursor as a cluster offset; the terminal wants cells.
 */
export function cellOffset(line, clusterIndex) {
  let cells = 0;
  const clusters = graphemes(String(line ?? ''));
  for (let i = 0; i < Math.min(clusterIndex, clusters.length); i += 1) {
    cells += clusterWidth(clusters[i]);
  }
  return cells;
}
