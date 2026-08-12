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
            const message = entry.requireArgs(rest, parseFlags(rest));
      if (message) return { argv: null, missing: [], invalid: message };
    }
  } catch (error) {
    return { argv: null, missing: [], invalid: error.message };
  }
  return { argv, missing: [], invalid: null };
}

export function signatureOf(row) {
  if (!row) return '';
  const parts = [];
  for (const token of row.argvTokens || []) {
    if (token.kind !== 'value') continue;
    const name = token.valueName || token.positional || String(token.flag ?? '').replace(/^--/, '');
    parts.push(token.required === false ? `[${name}]` : `<${name}>`);
  }
  const flags = row.prompts || [];
  for (const flag of flags.filter((f) => f.required)) {
    parts.push(`${flag.flag} <${String(flag.flag).replace(/^--/, '')}>`);
  }
  const optional = flags.filter((f) => !f.required).length;
  if (optional) parts.push(`[+${optional}]`);
  return parts.join(' ');
}

function humanLabel(flagOrPositional) {
  const raw = String(flagOrPositional ?? '');
  const long = raw.match(/--([A-Za-z0-9][A-Za-z0-9-]*)/);
  if (long) return long[1];
  return raw.replace(/^-+/, '');
}

export function promptsFor(row) {
  if (!row) return [];
  const fromTokens = (row.argvTokens || [])
    .filter((t) => t.kind === 'value')
    .map((t) => ({
      key: t.flag ?? t.positional,
            label: humanLabel(t.flag ?? t.positional),
            required: t.required !== false,
      type: 'string',
      description: t.valueName || '',
      // Where the answer can be picked from, when the registry declared it.
      choices: t.choices ?? null,
    }));
  const fromPrompts = (row.prompts || []).map((p) => ({
    key: p.flag,
    label: humanLabel(p.flag),
        required: Boolean(p.required),
    type: p.type || 'string',
    description: p.description || '',
    choices: p.choices ?? null,
  }));
  const seen = new Set();
  return [...fromTokens, ...fromPrompts].filter((p) => {
    if (!p.key || seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  });
}

export function selectionPlan(row, values = {}) {
  if (!row) return { ready: null, queue: [], untilResolves: false, invalid: 'no row' };

    const known = (key) => values[key] !== undefined && values[key] !== null && values[key] !== '';

  const all = promptsFor(row);
  const required = all.filter((p) => p.required && !known(p.key));
  if (required.length) {
    return { ready: null, queue: required, untilResolves: false, invalid: null };
  }

  const empty = resolveSelection(row, values);
  if (empty.argv) return { ready: empty.argv, queue: [], untilResolves: false, invalid: null };
  if (empty.missing?.length) {
    const byKey = new Map(all.map((p) => [p.key, p]));
    const queue = empty.missing.filter((key) => !known(key)).map((key) => byKey.get(key) || {
      key, label: humanLabel(key), required: true, type: 'string', description: '',
    });
    if (queue.length) return { ready: null, queue, untilResolves: false, invalid: null };
  }

    const optional = all.filter((p) => !p.required && p.type !== 'boolean' && !known(p.key));
  if (optional.length) {
    return { ready: null, queue: optional, untilResolves: true, invalid: null };
  }
  return { ready: null, queue: [], untilResolves: false, invalid: empty.invalid || 'this row cannot be resolved' };
}
