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

/**
 * Escape sequences — never content, never a cell.
 *
 * BROADER THAN SGR, deliberately. `displayWidth` strips before measuring, and
 * a strip that only knew `…m` sequences counted an OSC title's payload and a
 * CSI's parameter bytes as text — so the three width helpers disagreed about
 * any string carrying a non-colour escape. One alternation covers the forms a
 * captured child process actually emits: CSI with any final byte (`\x1b[K`),
 * OSC terminated by BEL or ST (`\x1b]0;title\x07`), and the single-character
 * escapes (`\x1b7`).
 */
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[0-Z\\-_])/g;
/** Just the SGR form — the one kind of escape clip and wrap PRESERVE, because
 * colour survives a cut and everything else must not. */
const SGR_RE = /^\x1b\[[0-9;]*m/;
/** Any escape sequence at the start of a string, for consuming without keeping. */
const ESCAPE_RE = /^\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[0-Z\\-_])/;

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
 * Walk a string as a sequence of SGR runs and grapheme clusters.
 *
 * WHY EVERY HELPER BELOW NEEDS THIS. `displayWidth` strips ANSI before
 * measuring; `clipTo` and `wrapCells` originally did not, so the three
 * disagreed with each other about the same string. `clusterWidth` drops the
 * `\x1b` as a control character and then counts the remaining
 * `[38;2;134;201;154m` as eighteen cells — so a painted row measured as fitting
 * by one helper was cut a third of the way through by another, and the cut
 * landed inside an escape sequence, leaving the colour open for the rest of the
 * terminal.
 *
 * Yielding the runs instead of stripping them means a clip can keep the colour
 * it was given and still close it.
 */
function* tokens(text) {
  const s = String(text ?? '');
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const sgr = SGR_RE.exec(s.slice(i));
      if (sgr) {
        yield { ansi: sgr[0] };
        i += sgr[0].length;
        continue;
      }
      // A NON-SGR ESCAPE IS CONSUMED AND DROPPED — never yielded, never left.
      // Leaving it made the plain-run scan below stop immediately at the same
      // ESC, slice nothing, and loop forever: any `\x1b[K` or OSC title in a
      // child's captured output hung the whole TUI process. And it cannot be
      // passed through either — an erase-line sequence surviving into a padded,
      // tinted row would wipe the row it was wrapped in. Colour is the only
      // escape a clip can honestly keep; everything else is dropped, exactly as
      // `stripAnsi` and therefore `displayWidth` treat it. The final arm
      // consumes a lone or malformed ESC one byte at a time, so progress is
      // unconditional.
      const esc = ESCAPE_RE.exec(s.slice(i));
      i += esc ? esc[0].length : 1;
      continue;
    }
    // Grapheme-cluster the remaining plain run in one pass rather than
    // per character, so combining marks and ZWJ sequences stay whole.
    let j = i;
    while (j < s.length && s[j] !== '\x1b') j += 1;
    for (const g of graphemes(s.slice(i, j))) yield { cluster: g, width: clusterWidth(g) };
    i = j;
  }
}

/**
 * Clip to `width` cells, cluster-wise and ANSI-aware.
 *
 * A wide cluster that would straddle the boundary is dropped rather than split:
 * half of `日` is not a character, and terminals disagree about what to do with
 * the leftover cell. Colour is preserved and CLOSED when anything was dropped —
 * a clip that ends mid-colour leaves the rest of the screen painted. *
 * CLOSERS ARE SGR 39, NOT SGR 0, for the same reason `style.mjs#paint` closes
 * that way: these helpers run INSIDE a tinted row, and `tintRow` wraps their
 * output with a background. `0m` would reset that background from the first
 * closer onward, which is exactly the defect a per-cell screen reading caught
 * once already — reintroducing it here, one layer down, would have been the
 * same bug with a better disguise.
 */
export function clipTo(text, width) {
  if (width <= 0) return '';
  let used = 0;
  let out = '';
  let sawAnsi = false;
  let dropped = false;
  for (const t of tokens(text)) {
    if (t.ansi) {
      // An escape costs no cells, so it is kept even at the boundary — but only
      // while there is still content to colour.
      if (!dropped) { out += t.ansi; sawAnsi = true; }
      continue;
    }
    if (used + t.width > width) { dropped = true; break; }
    out += t.cluster;
    used += t.width;
  }
  return dropped && sawAnsi ? `${out}\x1b[39m` : out;
}

/**
 * Break one logical line into rows of at most `width` cells.
 *
 * Cluster-wise and ANSI-aware, so a wide character is never split, a combining
 * mark never leaves its base behind, and an escape sequence is never cut in
 * half. The active SGR state is carried onto each continuation row and closed
 * at the end of every row, because a terminal does not re-apply colour across a
 * newline for you.
 *
 * An empty line yields one empty row, because a blank line in the editor is
 * still a line you can put the cursor on.
 */
export function wrapCells(line, width) {
  if (width <= 0) return [''];
  const rows = [];
  let current = '';
  let used = 0;
  let open = '';
  let openInRow = false;

  const flush = () => {
    rows.push(openInRow ? `${current}\x1b[39m` : current);
    current = open;
    openInRow = Boolean(open);
    used = 0;
  };

  for (const t of tokens(line)) {
    if (t.ansi) {
      // A closer clears what would otherwise be carried onto the next row.
      // `0m` closes everything; `39m`/`49m` close the foreground and background
      // that `paint` and `tintRow` open. Carrying an open sequence AND its
      // closer forward is visually a no-op but leaves both on every row.
      open = /^\x1b\[(0|39|49)?m$/.test(t.ansi) ? '' : `${open}${t.ansi}`;
      current += t.ansi;
      openInRow = openInRow || Boolean(open);
      continue;
    }
    if (used + t.width > width && used > 0) flush();
    current += t.cluster;
    used += t.width;
  }
  if (used > 0 || !rows.length) rows.push(openInRow ? `${current}\x1b[39m` : current);
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
