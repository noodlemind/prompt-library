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
 *
 * Fix-wave (AC6 absolute-guarantee widening): the human ledger is now an
 * emission boundary in scope for redaction, exactly like the machine sinks.
 * Every string this renderer emits — a painted fragment, a ledger row, a
 * summary tally, an error block line — passes through the shared secret
 * redactor (lib/redact.mjs) before it is returned to a caller's console.log.
 * A ledger row routinely echoes caller-typed args (`learnings --why <token>`)
 * or retrieved store content (a learning's trigger/claim/path), so this is
 * where a human-facing leak would otherwise escape. The pass is a genuine
 * no-op for secret-free text (redactText returns its input unchanged), so
 * every existing ledger byte is unaffected; only a real secret shape changes.
 * Idempotent, so the overlap between a composite row and the fragments it
 * paints internally is harmless.
 */
import { createRedactor } from './redact.mjs';

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
  // The runner's `status: 'cancelled'` outcome (an AbortSignal fired) is the
  // same process-level exit family as an interactive SIGINT — 130 already
  // means "the run stopped because something asked it to, not because it
  // failed" — so `cancelled` reuses `interrupted`'s value instead of
  // claiming a new one. Kept as its own key (not just an alias reference)
  // so callers can name the status-vocabulary term they mean.
  cancelled: 130,
  // Distinct from every status above: a `status: 'timed-out'` outcome must
  // never collapse into a generic failure (exit 1) or into `cancelled` — the
  // agent contract needs to tell "ran out of time" apart from "was stopped"
  // apart from "errored". Next free append-only low value after `network:7`.
  timedOut: 8,
  // `lookup` asked for a specific entity and the entity does not exist. It is
  // neither a usage error (the command was well-formed and the kind was valid)
  // nor an internal fault, and collapsing it into either would make "you asked
  // for something that isn't here" indistinguishable from "you called this
  // wrong" or "the harness broke" — the distinction a caller scripting against
  // lookup needs most. Next free append-only value after `timedOut: 8`.
  notFound: 9,
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
  // Fix-wave C1: only honor --no-color BEFORE a literal `--` boundary —
  // post-boundary tokens are free-text content, never flags (same rule as
  // lib/flags.mjs#parseFlags / lib/registry.mjs#validateArgs).
  const boundary = argv.indexOf('--');
  const flagArgs = boundary === -1 ? argv : argv.slice(0, boundary);
  if (flagArgs.includes('--no-color')) return 'none';
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
  redactor,
} = {}) {
  const color = detectColor({ stream, env, argv });
  const unicode = detectUnicode({ env, platform, color });
  // One redactor bound to this renderer's env snapshot (injectable for tests).
  // Applied to every emitted string below so no human-facing surface can leak
  // a secret. redactText never throws and no-ops on secret-free text.
  const activeRedactor = redactor || createRedactor({ env });
  const scrub = (text) => (typeof text === 'string' && text ? activeRedactor.redactText(text) : text);

  function paint(token, text) {
    const safe = scrub(text);
    const entry = PALETTE[token];
    if (!entry || color === 'none') return safe;
    const open =
      color === 'truecolor'
        ? `\x1b[38;2;${entry[0][0]};${entry[0][1]};${entry[0][2]}m`
        : `\x1b[38;5;${entry[1]}m`;
    return `${open}${safe}\x1b[0m`;
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
    // `value` is inserted verbatim (unpainted), so scrub the whole composed
    // row — this is the choke point where a ledger `value` echoing a secret
    // (e.g. `learnings --why <token>`'s id row) would otherwise reach stdout.
    out += value;
    if (note) out += paint('muted', ` · ${note}`);
    if (next) out += paint('muted', ` ${arrow} ${next}`);
    return scrub(out.trimEnd());
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
    // `message` is inserted unpainted, so scrub it explicitly; code/fix/docs
    // flow through paint (already scrubbed). An error's message/fix routinely
    // echoes caller input (a bad flag value, an unknown target id).
    const lines = [`${glyph('error')} ${paint('error', code)}`];
    if (message) lines.push(`  ${scrub(String(message))}`);
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
