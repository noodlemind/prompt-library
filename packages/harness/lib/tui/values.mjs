/**
 * What a picker offers — the other half of the palette's oldest promise.
 *
 * lib/command-index.mjs has said since it was written that a `value` slot is
 * "filled in later from a picker (never typed)". The data model landed; the
 * picker did not. What shipped instead completed the composer to `model set `
 * and asked the operator to type the rest, which is how `model set` came to
 * fail with a usage error listing thirteen providers separated by pipes. A
 * palette that knows the legal answers and asks you to remember them is worse
 * than no palette, because it looked like help.
 *
 * THE SPLIT. The registry declares the KIND of value a slot wants (`choices:
 * 'provider'`); this module knows how to ENUMERATE that kind. Registration is
 * pure data evaluated at import, and enumerating providers needs the parent
 * environment while enumerating paths needs the workspace — so the two cannot
 * live together. lib/value-sources.mjs is the vocabulary they share.
 *
 * TYPING IS NEVER TAKEN AWAY. Every list is offered with a filter, and a source
 * that declares `free` accepts an answer that is not on it. The provider is the
 * authority on which models it serves, the filesystem on which files exist —
 * this module is trying to save keystrokes, not to become a second opinion
 * about what is legal. Where a source cannot enumerate anything (no journal
 * yet, an unreadable directory), it returns an empty list and the caller falls
 * back to the free-text prompt that has always been there. A picker that fails
 * must degrade to the old behaviour, never to a dead end.
 */
import { PROVIDER_MODELS, providerReadiness } from '../provider.mjs';
import { readModelCache } from '../model-cache.mjs';
import { CONFIG_SCHEMA, CONFIG_KEYS, SCOPES } from '../config.mjs';
import { readJournal, foldRuns } from '../run-journal.mjs';
import { completePath } from './complete.mjs';

/** How many rows a value picker offers before it stops being a glance. Paths
 * and runs are truncated to this; the filter is how you reach the rest. */
export const MAX_VALUES = 40;

/** One offerable value. `value` is what goes on argv; everything else is for
 * the eye. `unavailable` greys the row and states why, the same contract the
 * command palette follows for a command that cannot run. */
function item(value, { label = null, note = '', unavailable = null } = {}) {
  return { value, label: label ?? String(value), note, unavailable };
}

/**
 * Providers, the ones you can actually use first.
 *
 * An unusable provider is listed rather than hidden, with the reason that would
 * otherwise only appear after choosing it — "a menu of failures is a menu of
 * disappointments" argues for ordering, not for concealment, and an operator
 * deciding whether to set up a key needs to see the option exists.
 */
function providers({ parentEnv }) {
  const ready = providerReadiness({ parentEnv });
  return [...ready]
    .sort((a, b) => (a.ready === b.ready ? a.id.localeCompare(b.id) : a.ready ? -1 : 1))
    .map((p) => item(p.id, {
      note: p.ready ? p.how || 'ready' : p.reason || 'not configured',
      unavailable: p.ready ? null : p.reason || 'not configured',
    }));
}

/**
 * The models one provider is known to serve.
 *
 * Reads the provider from the answers collected so far — `model set` asks for a
 * provider first, and the second question is only answerable in terms of the
 * first. Falls back to every known model when no provider has been chosen, so
 * the source is still useful for a flag (`--model`) asked in isolation.
 *
 * THE FETCHED CATALOGUE WINS. The model overlay has preferred what `model
 * refresh` recorded since the cache existed; this picker kept offering the
 * static table, so the same question got two different answers depending on
 * which surface asked it. The static list survives as what it is everywhere
 * else — the answer for a provider nobody has asked yet.
 */
function models({ values, copilotHome }) {
  const cache = copilotHome ? readModelCache(copilotHome) : {};
  const listFor = (id) => {
    const fetched = cache?.[id];
    if (fetched?.models?.length) return { models: fetched.models, labels: fetched.labels ?? {}, fetched: true };
    return { models: PROVIDER_MODELS[id] ?? [], labels: {}, fetched: false };
  };
  const chosen = values?.provider ?? values?.['--provider'] ?? null;
  if (chosen && (PROVIDER_MODELS[chosen] || cache?.[chosen]?.models?.length)) {
    const { models: list, labels, fetched } = listFor(chosen);
    return list.map((m, i) => item(m, {
      note: labels[m] || (i === 0 ? (fetched ? 'provider default · fetched' : 'provider default') : ''),
    }));
  }
  const out = [];
  const ids = new Set([...Object.keys(PROVIDER_MODELS), ...Object.keys(cache ?? {})]);
  for (const provider of ids) {
    for (const m of listFor(provider).models) out.push(item(m, { note: provider }));
  }
  return out;
}

/** Configuration keys, each with the sentence the schema already carries. */
function configKeys() {
  return CONFIG_KEYS.map((key) => item(key, { note: CONFIG_SCHEMA[key]?.description || '' }));
}

/**
 * What one configuration key accepts.
 *
 * The schema has always known this — ten keys declare `type: 'enum'` with their
 * own `values` array, and every boolean key accepts exactly two words. Asking
 * an operator to type `colorblind` when the schema can name it was never a
 * decision, only an omission.
 */
function configValues({ values }) {
  const key = values?.key ?? null;
  const schema = key ? CONFIG_SCHEMA[key] : null;
  if (!schema) return [];
  if (schema.type === 'enum' && Array.isArray(schema.values)) {
    return schema.values.map((v) => item(v, { note: v === schema.default ? 'default' : '' }));
  }
  if (schema.type === 'boolean') {
    return [true, false].map((v) => item(String(v), { note: v === schema.default ? 'default' : '' }));
  }
  return [];
}

/** Workspace-relative paths. `completePath` already refuses traversal, so the
 * picker inherits the confinement rather than re-deciding it. */
function paths({ workspace, query }) {
  return completePath(String(query ?? ''), { workspace, limit: MAX_VALUES })
    .map((hit) => item(hit.path, { note: hit.kind === 'dir' ? 'directory' : '' }));
}

/** Plan files, newest name first — plans are date-prefixed, so a reverse sort
 * on the name is a reverse sort on the date without reading any of them. */
function plans({ workspace }) {
  // TRUNCATE LAST. Capping the listing at MAX_VALUES first meant the sort only
  // ordered whatever the directory scan happened to hand back — in a repository
  // with more plans than the cap, the newest ones could be dropped before the
  // "newest first" ordering ever saw them, so the picker confidently offered
  // the oldest.
  return completePath('docs/plans/', { workspace, limit: Number.MAX_SAFE_INTEGER })
    .filter((hit) => hit.kind === 'file' && hit.path.endsWith('.md'))
    .sort((a, b) => b.path.localeCompare(a.path))
    .slice(0, MAX_VALUES)
    .map((hit) => item(hit.path, { note: '' }));
}

/** Runs from the journal, most recent first. Degrades to nothing in a
 * workspace that has never run a command, which is a normal state and not an
 * error worth reporting inside a picker. */
function runs({ workspace }) {
  // SORTED BY WHEN THEY STARTED, not by where they sit in the file. Reversing
  // the folded list assumed journal order is chronological order — true for an
  // append-only file read start-to-finish, and not true once folding merges a
  // late `run.result` back onto an early `run.start`. The timestamp is the only
  // thing that actually says which run is newest.
  const folded = foldRuns(readJournal(workspace));
  return [...folded]
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
    .slice(0, MAX_VALUES)
    .map((r) => item(r.run, {
      // The short form is what the ledger prints and what a person recognises;
      // the full id is what goes on argv, because that is what `run show` takes.
      label: String(r.run ?? '').slice(0, 8),
      note: [r.command, r.status].filter(Boolean).join(' · '),
    }));
}

/**
 * Which sources accept an answer that is not on their list.
 *
 * A path is free because a file the walk did not reach is still a real file. A
 * model is free because the provider, not this table, is the authority on what
 * it serves. A scope is not free: there are two config files and naming a third
 * is a typo, and accepting it would produce a confusing failure one layer down
 * instead of a clear refusal here.
 */
const FREE = new Set(['path', 'plan', 'model', 'config-value']);

const RESOLVERS = {
  provider: providers,
  model: models,
  scope: () => SCOPES.map((s) => item(s, {
    note: s === 'user' ? 'applies everywhere for you' : 'applies to this project, for everyone',
  })),
  'config-key': configKeys,
  'config-value': configValues,
  path: paths,
  plan: plans,
  run: runs,
};

/**
 * Resolve one slot's offerable values.
 *
 * `choices` is the normalized `{source, literal}` from lib/value-sources.mjs.
 * `values` carries the answers already collected in this sequence, which is
 * what lets the model question depend on the provider one.
 *
 * Returns `{items, free}`. An empty `items` with `free: true` is the signal to
 * ask for free text — the behaviour that existed before pickers did, kept as
 * the floor under every source so a failure to enumerate never blocks a
 * command that would otherwise run.
 */
export function resolveValues(choices, { workspace = process.cwd(), copilotHome = null, parentEnv = process.env, values = {}, query = '' } = {}) {
  if (!choices) return { items: [], free: true };
  if (choices.literal) {
    return { items: choices.literal.map((v) => item(v)), free: false };
  }
  const resolver = RESOLVERS[choices.source];
  if (!resolver) return { items: [], free: true };
  let items = [];
  try {
    items = resolver({ workspace, copilotHome, parentEnv, values, query }) || [];
  } catch {
    // An unreadable directory, a half-written journal: fall through to typing.
    // The command still runs; only the convenience is lost.
    return { items: [], free: true };
  }
  return { items: items.slice(0, MAX_VALUES), free: FREE.has(choices.source) || items.length === 0 };
}
