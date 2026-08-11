/**
 * A typed line that names a real command but cannot run as typed.
 *
 * THE DIVERGENCE THIS CLOSES. The same command behaved differently depending on
 * how it was reached:
 *
 *   `config set` chosen from the palette → "3 value(s) needed", pickers open
 *   `config set` typed as a line         → E_USAGE: config set requires a key
 *
 * Both are the same operator asking for the same thing. The palette knew the
 * registry declares `key` and `value` and that both have sources that can be
 * enumerated; the typed line threw that away and printed the CLI's error. An
 * operator who types faster than they navigate was punished for it, and the
 * palette contract — "nothing dead-ends in a usage error" — held down exactly
 * one of the two paths into every command.
 *
 * WHAT THIS DOES NOT DO. It routes exactly one class of failure: a MISSING
 * VALUE the registry can ask for. An unknown flag, a bad enum, a malformed
 * number, too many words — all still produce the usage error they should,
 * because the operator asserted something specific and wrong, and opening a
 * picker over it would hide the mistake rather than fix it. The rule is "the
 * words so far are consistent with this command and it needs more", never
 * "something went wrong, try a menu".
 *
 * Hand-typed FLAG SYNTAX also declines to route. Someone writing `--scope user`
 * is speaking CLI, and `validateArgs` gives them a precise answer about the
 * flag they got wrong; interrupting that with a value picker would answer a
 * question they did not ask.
 */
import { getCommand, hasCommand, validateArgs } from '../registry.mjs';
import { buildCommandIndex } from '../command-index.mjs';
import { selectionPlan } from './palette.mjs';

/**
 * Would dispatch reject this argv before any handler runs?
 *
 * Used only to widen the net, never to narrow it. The tempting design — "route
 * only when dispatch would refuse" — does not work, because the defect that
 * started this is a command whose requirement lives in its HANDLER: `config
 * set` passes `validateArgs`, declares no `requireArgs`, and raises "config set
 * requires a key" from inside `cmdConfig`. A gate built on dispatch's answer
 * therefore said "this runs" about the exact line that does not.
 *
 * So the decision is made from the ROW'S DECLARATIONS instead — the same source
 * the palette uses, which is what makes the two paths agree by construction
 * rather than by two implementations happening to match.
 */
function rejectedByValidation(name, rest) {
  const entry = getCommand(name);
  if (!entry) return true;
  try {
    validateArgs(entry, rest);
  } catch {
    return true;
  }
  return false;
}

/**
 * The words a row begins with, AS THE PALETTE SPELLS THEM.
 *
 * Command and subcommand tokens contribute themselves. A `flag` token
 * contributes its bare name, because the palette renders `--apply` as the row
 * `consolidate apply` and that is therefore what an operator copying the
 * palette will type. Matching on the argv spelling instead left
 * `consolidate apply` as the one row in the index a typed line could not reach
 * — the palette offered a word the typed path did not recognise, which is the
 * same divergence in miniature.
 */
function leadingWords(row) {
  const words = [];
  for (const token of row.argvTokens || []) {
    if (token.kind === 'command' || token.kind === 'subcommand') words.push(token.value);
    else if (token.kind === 'flag') words.push(String(token.value).replace(/^-+/, ''));
    else break;
  }
  return words;
}

/**
 * The row the typed words are reaching for.
 *
 * Longest match wins: `config set` must resolve to the `config set` row and not
 * to the bare `config` row that would treat "set" as its verb positional and
 * then ask for the verb again. Ties cannot occur — two rows with identical
 * leading words would be the same row.
 */
function bestRow(rows, argv) {
  let best = null;
  for (const row of rows) {
    const words = leadingWords(row);
    if (!words.length || words.length > argv.length) continue;
    if (words.some((w, i) => w !== argv[i])) continue;
    if (!best || words.length > leadingWords(best).length) best = row;
  }
  return best;
}

/**
 * Route a typed line into the value queue, or decline.
 *
 * Returns `{ row, values }` when the line names a command that needs values it
 * can offer, with everything already typed mapped onto the slots it fills.
 * Returns null whenever the line should take the ordinary dispatch path —
 * including when it simply runs, which is most of the time.
 */
export function routeTypedLine(argv, { workspace = process.cwd(), index = null } = {}) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const [name, ...rest] = argv;
  if (typeof name !== 'string' || !hasCommand(name)) return null;
  // `--` and anything after it is payload for the command (`bash -- "script"`),
  // and a flag anywhere means the operator is writing CLI syntax.
  if (argv.some((a) => typeof a === 'string' && (a === '--' || a.startsWith('-')))) return null;
  // A malformed argument is the operator asserting something specific and
  // wrong. `validateArgs` names it precisely; a picker over the top would hide
  // the mistake instead of correcting it.
  if (rejectedByValidation(name, rest)) return null;

  const rows = (index ?? buildCommandIndex({ surface: 'tui', workspace })).rows.filter((r) => r.noun === name);
  const row = bestRow(rows, argv);
  if (!row) return null;

  const words = leadingWords(row);
  const supplied = argv.slice(words.length);

  // A command the palette folds into ONE picker row (`model`) has no verb rows
  // to match against, so `model set` finds only the bare `model` row and its
  // extra word has nowhere to go. Typed, it dead-ended in a usage error listing
  // thirteen provider ids — the same wall of enum the picker exists to replace.
  // Any trailing word therefore opens the picker: `model set`, `model clear`
  // and `model refresh` are all requests to change the model, and the picker is
  // where that happens. A BARE `model` still dispatches, because it prints the
  // catalogue and answers a real question rather than dead-ending.
  if (row.picker) return supplied.length ? { row, values: {}, plan: null, picker: row.picker } : null;

  const slots = (row.argvTokens || []).filter((t) => t.kind === 'value');
  // More words than the row has slots for: the operator typed something this
  // command has no place to put, which is a usage error and not a gap to fill.
  if (supplied.length > slots.length) return null;

  const values = {};
  for (let i = 0; i < supplied.length; i += 1) {
    const slot = slots[i];
    if (!slot) return null;
    // A slot whose answers the registry states OUTRIGHT can be checked now. If
    // the operator typed something that is not one of them, that is a mistake
    // to show them, not a gap to open a picker over — and the usage error names
    // the alternatives. Source-backed slots (a config key, a branch) are
    // resolved at open time and cannot be judged here, so they pass through.
    const allowed = slot.choices?.literal;
    if (Array.isArray(allowed) && allowed.length && !allowed.includes(supplied[i])) return null;
    values[slot.flag ?? slot.positional] = supplied[i];
  }

  // The queue is computed the SAME way the palette computes it, with the typed
  // words already filled in — so the two paths cannot answer "what does this
  // still need" differently, which is the whole defect being fixed.
  const plan = selectionPlan(row, values);
  if (!plan.queue.length) return null;

  return { row, values, plan };
}
