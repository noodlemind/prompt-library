/**
 * The kinds of value a palette slot can be filled from.
 *
 * WHY THIS FILE EXISTS AT ALL. The registry declares that `model set` wants a
 * `provider`; lib/tui/values.mjs knows how to enumerate one. Those are two
 * different jobs and they belong to two different layers — the registry is pure
 * data (no filesystem, no environment, evaluated at import), while enumerating
 * providers needs the parent environment and enumerating paths needs the
 * workspace. This module is the shared vocabulary between them, and it has no
 * imports so that neither side pulls the other in.
 *
 * A declaration may instead carry a literal array (`choices: ['observe',
 * 'warn', 'enforce']`), which is the better form whenever the set is small,
 * fixed and knowable at import: it keeps the answer next to the question. Named
 * sources are for the sets that cannot be written down in advance.
 */

/**
 * Every named source, and what it enumerates.
 *
 * Each is resolved by lib/tui/values.mjs. Registration validates a declared
 * name against this list, so a typo fails at import rather than becoming an
 * empty picker three months later — the same reason `requires` and `verbs` are
 * checked at registration.
 */
export const VALUE_SOURCES = Object.freeze({
  /** Provider ids, the ones you can actually use first, each with its reason. */
  provider: 'a model provider',
  /** Models for the provider chosen in this same answer sequence. */
  model: 'a model offered by the chosen provider',
  /** Which file remembers a setting. */
  scope: 'user or project',
  /** Every declared configuration key. */
  'config-key': 'a configuration key',
  /** The legal values for the key chosen in this same answer sequence. */
  'config-value': 'a value the chosen key accepts',
  /** Workspace-relative file paths. */
  path: 'a file in this workspace',
  /** Plan files under docs/plans. */
  plan: 'a plan file',
  /** Runs from this workspace's journal, most recent first. */
  run: 'a run from the journal',
});

/** The names, for validation and for error messages. */
export const VALUE_SOURCE_NAMES = Object.freeze(Object.keys(VALUE_SOURCES));

/**
 * Normalize a `choices` declaration into `{ source, literal }`.
 *
 * Returns null when nothing was declared, which is the common case and must
 * stay cheap — most values are free text and always will be (a commit message,
 * a search query, an intent). Throws for a shape that is neither, so a
 * malformed declaration is a registration error rather than a silently absent
 * picker.
 */
export function normalizeChoices(choices, { where = 'a declaration' } = {}) {
  if (choices === undefined || choices === null) return null;
  if (typeof choices === 'string') {
    if (!Object.hasOwn(VALUE_SOURCES, choices)) {
      throw new Error(`${where}: unknown value source ${JSON.stringify(choices)} (expected ${VALUE_SOURCE_NAMES.join(' | ')})`);
    }
    return { source: choices, literal: null };
  }
  if (Array.isArray(choices)) {
    if (!choices.length || !choices.every((c) => typeof c === 'string' && c)) {
      throw new Error(`${where}: a literal choices array must be non-empty strings`);
    }
    return { source: null, literal: Object.freeze([...choices]) };
  }
  throw new Error(`${where}: choices must be a value-source name or an array of strings`);
}
