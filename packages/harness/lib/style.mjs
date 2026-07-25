/**
 * Harness Design System v0.1 — one grammar, two readers.
 *
 * Every human-facing line is a ledger row:
 *   glyph  key  value  · note  → next
 * Column-stable so it reads as a table to the eye and splits on whitespace
 * for a parser. Color and glyph carry weight only where attention is owed;
 * everything nominal stays plain ink.
 *
 * Degradation ladder: truecolor → 256 → ascii/no-color. Same meaning at
 * every fidelity — never fake a capability the terminal doesn't have.
 * JSON output (--json) is produced elsewhere and is never styled.
 */

// Stable exit codes — the agent contract. Values are append-only.
export const EXIT = Object.freeze({
  ok: 0,
  usage: 2,
  notInitialized: 3,
  needsApproval: 4,
  syncConflict: 5,
  doctorFailed: 6,
  network: 7,
  interrupted: 130,
});

// token → [truecolor rgb, 256-color index]
const PALETTE = {
  ok: [[134, 201, 154], 114], // #86c99a — success, nominal, done
  warn: [[217, 164, 65], 179], // #d9a441 — attention, stale, degraded
  error: [[217, 124, 116], 174], // #d97c74 — failure, blocked, expired
  info: [[127, 166, 207], 110], // #7fa6cf — keys & fields in machine surface
  muted: [[111, 110, 105], 243], // #6f6e69 — notes, next actions, chrome
};

// state → [unicode glyph, ascii twin, paint token]
const GLYPHS = {
  ok: ['✓', '[ok]', 'ok'],
  warn: ['!', '[!]', 'warn'],
  error: ['✗', '[x]', 'error'],
  active: ['◐', '-', 'warn'],
  pending: ['·', '.', 'muted'],
};

const ASCII_GLYPH_WIDTH = 4; // '[ok]' — the widest twin

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function detectColor({ stream, env, argv }) {
  if (argv.includes('--no-color')) return 'none';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (!stream || !stream.isTTY) return 'none';
  if (env.TERM === 'dumb') return 'none';
  if (/truecolor|24bit/i.test(env.COLORTERM || '')) return 'truecolor';
  if (/-256color$/i.test(env.TERM || '')) return '256';
  return 'none'; // degrade honestly — never fake a capability the terminal didn't declare
}

function detectUnicode({ env, platform, color }) {
  if (color === 'none') return false; // the ascii surface is the no-color surface
  if (platform === 'win32') return Boolean(env.WT_SESSION || env.TERM_PROGRAM);
  return /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
}

/**
 * Build a style renderer bound to one output stream's capabilities.
 * All inputs are injectable for tests; defaults read the real process.
 */
export function createStyle({
  stream = process.stdout,
  env = process.env,
  argv = process.argv.slice(2),
  platform = process.platform,
} = {}) {
  const color = detectColor({ stream, env, argv });
  const unicode = detectUnicode({ env, platform, color });

  function paint(token, text) {
    const entry = PALETTE[token];
    if (!entry || color === 'none') return text;
    const open =
      color === 'truecolor'
        ? `\x1b[38;2;${entry[0][0]};${entry[0][1]};${entry[0][2]}m`
        : `\x1b[38;5;${entry[1]}m`;
    return `${open}${text}\x1b[0m`;
  }

  function glyph(state) {
    const g = GLYPHS[state];
    if (!g) return '';
    return paint(g[2], unicode ? g[0] : g[1]);
  }

  // The glyph gutter is column-stable per fidelity: 1 cell + space for
  // unicode, 4 cells + 2 spaces for ascii twins.
  function glyphGutter(state) {
    const g = GLYPHS[state];
    if (!g) return '';
    const raw = unicode ? g[0] : g[1];
    const pad = ' '.repeat((unicode ? 1 : ASCII_GLYPH_WIDTH) - raw.length);
    return `${paint(g[2], raw)}${pad}  `;
  }

  const arrow = unicode ? '→' : '->';

  /**
   * One ledger row. `state` is optional — nominal rows in a pure ledger
   * (report, status) carry no glyph at all.
   */
  function line({ state, key, value = '', note, next, keyWidth = 10 }) {
    let out = state ? glyphGutter(state) : '';
    out += `${String(key).padEnd(keyWidth)}  `;
    out += value;
    if (note) out += paint('muted', ` · ${note}`);
    if (next) out += paint('muted', ` ${arrow} ${next}`);
    return out.trimEnd();
  }

  /** The closing tally: "2 ok · 1 warn · 1 err → exit 6", all muted. */
  function summary({ ok = 0, warn = 0, err = 0, exit = 0 }) {
    const parts = [`${ok} ok`];
    if (warn) parts.push(`${warn} warn`);
    if (err) parts.push(`${err} err`);
    return paint('muted', `${parts.join(' · ')} ${arrow} exit ${exit}`);
  }

  /** Error & recovery block: code, plain message, one fix, optional docs. */
  function errorBlock({ code, message, fix, docs, exit = 1 }) {
    const lines = [`${glyph('error')} ${paint('error', code)}`];
    if (message) lines.push(`  ${message}`);
    if (fix) lines.push(paint('muted', `  ${arrow} fix   ${fix}`));
    if (docs) lines.push(paint('muted', `  ${arrow} docs  ${docs}`));
    lines.push(paint('muted', `  exit ${exit}`));
    return lines;
  }

  function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
  }

  return { color, unicode, arrow, paint, glyph, line, summary, errorBlock, stripAnsi };
}

/** Fixed key gutter for a set of rows so columns hold across a command. */
export function keyWidthFor(keys, min = 10) {
  return Math.max(min, ...[...keys].map((k) => String(k).length));
}

/**
 * A row's note or next is one glance, not a report. Clamp long tails and
 * point at --verbose for the rest; verbose surfaces render the full text.
 */
export function clampNote(text, max = 160) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}… (--verbose for full)`;
}
