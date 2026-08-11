/**
 * Bare positionals from an argv, with flag VALUES skipped.
 *
 * WHY THIS EXISTS AS ONE MODULE. Four commands hand-rolled this scan and three
 * of them got it wrong the same way: they treated every `--flag` as taking a
 * value whenever the next token did not itself start with `--`. A BOOLEAN flag
 * before a positional therefore ate it, and each command failed differently and
 * silently:
 *
 *   harness trust --json approve   → `approve` read as the value of `--json`;
 *                                    no positional; fell back to `status`,
 *                                    printed the current state, exited 0. The
 *                                    approval never happened and nothing said so.
 *   harness checks --json list     → verb `null` → "checks requires a verb"
 *   harness run --status ok list   → the OPPOSITE error: a scan that skipped no
 *                                    value flags read `ok` as the verb
 *   harness agent --dry-run fix it → task silently became "it"
 *
 * A fifth copy would have been a fifth spelling of the same bug. The rule is
 * one rule, so it lives in one place.
 *
 * THE SET IS DERIVED, NOT REMEMBERED. `VALUE_FLAGS` is the union of every
 * non-boolean flag the registry declares and every flag `lib/flags.mjs` reads a
 * value for. Both authorities are real — command flags are parsed by their own
 * commands and never reach `parseFlags`, while several global value flags never
 * appear in the registry's help surface — so a hand-written list would drift
 * from one of them. `test/coderabbit-review-findings.test.mjs` asserts the union
 * matches, which turns "remember to update this" into a failing test. (The
 * comment previously named a file that does not exist — a pointer to nothing is
 * worse than no pointer, because it reads as coverage.)
 */

/**
 * Flags that consume the token after them.
 *
 * Includes short forms and `--output`, which `extractOutputLane` strips before
 * dispatch: listing it costs nothing and a caller that scans a raw argv gets the
 * right answer either way.
 */
export const VALUE_FLAGS = Object.freeze(new Set([
  '--agent', '--allow-env', '--autonomy', '--base', '--body', '--body-file', '--branch',
  '--category', '--claim', '--collection', '--command', '--content', '--copilot-home', '--criteria',
  '--cursor', '--cwd', '--date', '--depth', '--docid', '--domain', '--enforcement',
  '--expect', '--gap', '--host', '--ids', '--impacted', '--intent', '--layer', '--learnings',
  '--limit', '--lines', '--match', '--max-bytes', '--max-seconds', '--max-turns',
  '--min-score', '--model', '--new', '--offset', '--old', '--ops', '--output', '--path', '--phase', '--plan',
  '--provider', '--query', '--reason', '--risk', '--scope', '--session', '--since',
  '--slug', '--source', '--stale', '--status', '--tags', '--target', '--timeout',
  '--title', '--to', '--tool-timeout', '--trigger', '--type', '--until', '--why',
  '--workspace',
  '-c',
]));

export function isValueFlag(token, extra = null) {
  if (typeof token !== 'string' || !token.startsWith('-')) return false;
  if (token.includes('=')) return false; // `--limit=5` carries its own value
  return VALUE_FLAGS.has(token) || (extra ? extra.has(token) : false);
}

/**
 * Every bare positional in `argv`, in order.
 *
 * Stops at a bare `--`: everything after it belongs to a child process, not to
 * this command. `limit` lets a caller stop early when it only needs a verb and
 * an id.
 *
 * `extra` is for a command with a value flag of its own that predates the
 * shared set — it is a widening, never a replacement, so no caller can narrow
 * the rule for itself.
 */
export function positionalsOf(argv, { limit = Infinity, extra = null } = {}) {
  const out = [];
  const widen = extra ? new Set(extra) : null;
  for (let i = 0; i < argv.length && out.length < limit; i += 1) {
    const token = argv[i];
    if (token === '--') break;
    if (typeof token !== 'string') continue;
    if (token.startsWith('-') && token !== '-') {
      // A value flag consumes the NEXT token — unless that token is the `--`
      // boundary. `harness run --status -- resume <id>` used to read `--` as the
      // status value and then parse `resume <id>` from beyond a boundary that
      // was supposed to end parsing, turning a missing flag value into a
      // different, valid operation.
      if (isValueFlag(token, widen) && argv[i + 1] !== undefined && argv[i + 1] !== '--') i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * The verb a caller asked for: the first positional, once flag values are
 * skipped.
 *
 * `known` is accepted so callers read declaratively and so this signature can
 * validate later, but it is deliberately NOT searched. An earlier version
 * scanned every positional for a known verb, which fixed `trust --json approve`
 * and broke something worse: `harness trust frobnicate approve` found `approve`
 * further along and approved the workspace, turning a typo into a security
 * mutation. Skipping flag values was the right half of that fix. The caller
 * validates the returned verb and reports an unknown one.
 */
export function verbOf(argv, known, { fallback = null, extra = null } = {}) {
  // THE FIRST positional is the verb. Searching all of them — which is what the
  // previous fix did — meant `harness trust frobnicate approve` found `approve`
  // further along and APPROVED THE WORKSPACE, turning a typo into a security
  // mutation. Skipping flag values was the right half of that fix; scanning past
  // an unrecognised word was not.
  const positionals = positionalsOf(argv, { extra });
  return positionals.length ? positionals[0] : fallback;
}
