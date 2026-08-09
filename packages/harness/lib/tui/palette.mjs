/**
 * The command palette — noun + verb in, argv out (P4bAC6–AC8).
 *
 * NOBODY TYPES `--` IN HERE. That is the settled contract, and it came from
 * surveying eight agent CLIs: not one accepts flag syntax inside a slash
 * command, because a palette is a place to *choose* a capability, not to spell
 * one. The palette presents a row, collects any values that row declares as
 * prompts, and resolves the argv itself.
 *
 * The index and `resolveArgv` are Phase 2's, unchanged. This module is
 * deliberately thin: it ranks, it validates, and it hands back an argv. Keeping
 * it free of terminal I/O is what lets the whole palette contract be tested
 * without a terminal — every assertion below the render layer is a pure
 * function call.
 */
import { buildCommandIndex, resolveArgv } from '../command-index.mjs';
import { getCommand, validateArgs } from '../registry.mjs';
import { parseFlags } from '../flags.mjs';
import { rankRows } from './ranking.mjs';

/** Flag syntax must never appear in a row a person is asked to read, nor in
 * anything they are asked to type. Exported so the contract test and the
 * renderer share one definition rather than two that can drift. */
export const FLAG_SYNTAX = /(^|\s)--(\s|$)|(^|\s)--[a-z]/i;

export function containsFlagSyntax(text) {
  return FLAG_SYNTAX.test(String(text ?? ''));
}

/**
 * The palette for one workspace: the rows a person can choose from, ranked.
 *
 * `unavailable` rows are kept and marked rather than hidden. A capability that
 * silently disappears teaches people it does not exist; one that appears greyed
 * with a reason teaches them what to fix. That is the contract's wording and it
 * is the more useful behavior besides.
 */
export function openPalette({ workspace = process.cwd(), query = '' } = {}) {
  const index = buildCommandIndex({ surface: 'tui', workspace });
  const rows = rankRows(index.rows, query);
  return {
    query,
    total: index.rows.length,
    rows,
    generation: index.generation ?? null,
  };
}

/**
 * Turn a chosen row plus collected values into an argv the CLI accepts.
 *
 * Returns `{ argv, missing, invalid }`. A row whose required prompts are
 * unanswered yields `missing` rather than a half-formed argv, because the
 * palette's job is to produce something the CLI would accept — handing dispatch
 * an incomplete command just moves the error somewhere the user cannot act on.
 *
 * The resolved argv is then VALIDATED against the entry that will receive it,
 * so P4bAC7 ("every palette row resolves to an argv the CLI accepts") is a
 * property of the code rather than a hope pinned by a test. This caught a real
 * drift: `consolidate apply` resolved to `consolidate --apply`, which the CLI
 * refuses because `--apply` requires `--ops`. The palette offering a row that
 * dispatch would reject is exactly the failure every surveyed tool has shipped.
 */
export function resolveSelection(row, values = {}) {
  if (!row) return { argv: null, missing: [], invalid: null };
  const missing = [];
  for (const token of row.argvTokens || []) {
    if (token.kind !== 'value') continue;
    const key = token.flag ?? token.positional;
    const value = values[key];
    if (value === undefined || value === null || value === '') missing.push(key);
  }
  if (missing.length) return { argv: null, missing, invalid: null };

  const argv = resolveArgv(row, values);
  if (!argv || !argv.length) return { argv: null, missing: [], invalid: 'this row resolves to no command' };
  const [name, ...rest] = argv;
  const entry = getCommand(name);
  if (!entry) return { argv: null, missing: [], invalid: `unknown command: ${name}` };
  try {
    validateArgs(entry, rest);
    if (typeof entry.requireArgs === 'function') {
      // Parsed flags, not `{}`. Dispatch calls this with `parseFlags(rest)`, so
      // handing it an empty object asked a different question than the one the
      // CLI will ask — `get --docid=doc-1` was rejected here and accepted
      // there. A validator that disagrees with dispatch is worse than none.
      const message = entry.requireArgs(rest, parseFlags(rest));
      if (message) return { argv: null, missing: [], invalid: message };
    }
  } catch (error) {
    return { argv: null, missing: [], invalid: error.message };
  }
  return { argv, missing: [], invalid: null };
}

/**
 * The name a person is asked for.
 *
 * A flag definition may carry its aliases in the name (`-c, --collection`), and
 * showing that to someone choosing from a palette would be asking them to read
 * the CLI's spelling of a thing rather than the thing. Take the long form and
 * drop the dashes: `collection`.
 */
function humanLabel(flagOrPositional) {
  const raw = String(flagOrPositional ?? '');
  const long = raw.match(/--([A-Za-z0-9][A-Za-z0-9-]*)/);
  if (long) return long[1];
  return raw.replace(/^-+/, '');
}

/**
 * What a person is asked for after choosing a row. Only the values the row
 * itself declares — the palette never invents a question, and never offers a
 * raw flag string as an answer.
 */
export function promptsFor(row) {
  if (!row) return [];
  const fromTokens = (row.argvTokens || [])
    .filter((t) => t.kind === 'value')
    .map((t) => ({
      key: t.flag ?? t.positional,
      // The label a person reads. Never the flag spelling: `--query` is how the
      // CLI names it, and "query" is what a human is being asked for.
      label: humanLabel(t.flag ?? t.positional),
      // A required positional is required whether the session is interactive or
      // piped. Hardcoding true here matches argvTokens; the flag-derived prompts
      // below honor their own `required` field.
      required: t.required !== false,
      type: 'string',
      description: t.valueName || '',
    }));
  const fromPrompts = (row.prompts || []).map((p) => ({
    key: p.flag,
    label: humanLabel(p.flag),
    // Honor the index. The previous hard-coded `false` made plan-new's required
    // --type/--slug/--intent look optional, so the ledger never asked for them
    // and resolveSelection failed with a CLI usage string after the choice.
    required: Boolean(p.required),
    type: p.type || 'string',
    description: p.description || '',
  }));
  const seen = new Set();
  return [...fromTokens, ...fromPrompts].filter((p) => {
    if (!p.key || seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  });
}

/**
 * What must be collected before a palette row can become a runnable argv.
 *
 * Three sources, in order of certainty:
 *   1. Prompts marked required on the row (positionals and required flags).
 *   2. Keys `resolveSelection` reports as `missing` for an empty values map.
 *   3. When the row still cannot resolve (e.g. `get` needs --docid OR --path,
 *      neither required alone), the optional non-boolean prompts — collected
 *      until resolve succeeds, empty answers skipped.
 *
 * Returns `{ ready, queue, untilResolves, invalid }`. `ready` is a finished
 * argv when nothing is needed; `queue` is the ordered list of prompts to ask;
 * `untilResolves` means later prompts may be skipped once resolve succeeds.
 */
export function selectionPlan(row) {
  if (!row) return { ready: null, queue: [], untilResolves: false, invalid: 'no row' };

  const all = promptsFor(row);
  const required = all.filter((p) => p.required);
  if (required.length) {
    return { ready: null, queue: required, untilResolves: false, invalid: null };
  }

  const empty = resolveSelection(row, {});
  if (empty.argv) return { ready: empty.argv, queue: [], untilResolves: false, invalid: null };
  if (empty.missing?.length) {
    const byKey = new Map(all.map((p) => [p.key, p]));
    const queue = empty.missing.map((key) => byKey.get(key) || {
      key, label: humanLabel(key), required: true, type: 'string', description: '',
    });
    return { ready: null, queue, untilResolves: false, invalid: null };
  }

  // Either/or and similar requireArgs gates: no single prompt is required, but
  // the empty form is invalid. Offer the optional non-boolean prompts and stop
  // as soon as resolveSelection accepts the values.
  const optional = all.filter((p) => !p.required && p.type !== 'boolean');
  if (optional.length) {
    return { ready: null, queue: optional, untilResolves: true, invalid: null };
  }
  return { ready: null, queue: [], untilResolves: false, invalid: empty.invalid || 'this row cannot be resolved' };
}
