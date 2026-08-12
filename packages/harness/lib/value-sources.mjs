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
