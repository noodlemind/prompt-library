/**
 * Session Ledger modals — product settings sheets, not CLI verb dumps.
 * Pattern shared with Grok Build / Claude Code / Codex: one entry → modal of values or actions.
 */
import { CONFIG_KEYS, CONFIG_SCHEMA, resolveConfig } from '../config.mjs';
import { isProjectTrusted } from '../trust.mjs';
import { getCommand } from '../registry.mjs';
import { buildCommandIndex } from '../command-index.mjs';
import { signatureOf } from './palette.mjs';

/** Family titles for the main palette when a command opens a modal. */
export const MODAL_FAMILY_LABELS = Object.freeze({
  config: 'Settings',
  model: 'Model',
  checks: 'Checks',
  trust: 'Trust',
  run: 'Runs',
  todo: 'Todos',
  inspect: 'Inspect',
  resources: 'Resources',
  knowledge: 'Knowledge',
  learning: 'Learning',
  lookup: 'Lookup',
  undo: 'Undo',
  tree: 'Tree',
});

/** Short action names inside a family sheet. */
export const ACTION_LABELS = Object.freeze({
  'config:show': 'Show all',
  'config:get': 'Get one value',
  'config:set': 'Set a value',
  'config:validate': 'Validate',
  'checks:list': 'List checks',
  'checks:show': 'Show a check',
  'checks:run': 'Run a check',
  'trust:status': 'Status',
  'trust:approve': 'Approve this project',
  'trust:revoke': 'Revoke trust',
  'run:list': 'List past runs',
  'run:show': 'Show a run',
  'run:tree': 'Event tree',
  'run:resume': 'Resume check',
  'todo:list': 'List items',
  'todo:add': 'Add item',
  'todo:complete': 'Complete item',
  'todo:clear': 'Clear all',
  'inspect:config': 'Config provenance',
  'inspect:permissions': 'Permissions',
  'inspect:workspace': 'Workspace',
  'inspect:tools': 'Tools',
  'tree:workspace': 'Workspace files',
  'tree:knowledge': 'Knowledge store',
  'undo:list': 'List undos',
});

function formatValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(',') : '(empty)';
  if (value === null || value === undefined) return '(unset)';
  return String(value);
}

/**
 * Settings modal: every config key with effective value + source.
 * Enter a key → change it (scope defaults to user).
 */
export function configSettingsRows({ workspace, copilotHome } = {}) {
  const projectTrusted = isProjectTrusted({ workspace, copilotHome });
  const resolved = resolveConfig({ copilotHome, workspace, projectTrusted });
  const rows = [];
  rows.push({
    section: true,
    label: 'settings',
    note: 'effective values · enter to change · scope user by default',
  });
  for (const key of CONFIG_KEYS) {
    const schema = CONFIG_SCHEMA[key];
    const prov = resolved.provenance[key] || {};
    const value = resolved.values[key];
    rows.push({
      label: key,
      note: `${formatValue(value)} · ${prov.source || 'default'}`,
      sideEffect: null,
      configKey: key,
      configSchema: schema,
      currentValue: value,
    });
  }
  rows.push({ section: true, label: 'actions', note: '' });
  rows.push({
    label: 'Show all in ledger',
    note: 'print every key with provenance',
    sideEffect: 'read',
    openArgv: ['config', 'show'],
  });
  rows.push({
    label: 'Validate config files',
    note: 'schema check both scopes',
    sideEffect: 'read',
    openArgv: ['config', 'validate'],
  });
  return rows;
}

/**
 * Action sheet for a multi-verb command family (checks, trust, run, todo, …).
 * Rows are real CLI verb rows (full argvTokens) with human labels for the sheet.
 */
export function verbActionRows(noun, { workspace = process.cwd() } = {}) {
  const entry = getCommand(noun);
  if (!entry) return [];
  const cli = buildCommandIndex({ surface: 'cli', workspace });
  const rows = [];
  rows.push({
    section: true,
    label: MODAL_FAMILY_LABELS[noun] || noun,
    note: entry.summary || 'choose an action',
  });
  for (const row of cli.rows) {
    if (row.noun !== noun || row.kind !== 'verb') continue;
    const verb = String(row.verb || '').split(/\s+/)[0];
    const human = ACTION_LABELS[`${noun}:${verb}`] || row.summary || `${noun} ${verb}`;
    rows.push({
      ...row,
      label: human,
      signature: signatureOf(row),
      note: row.summary || '',
    });
  }
  return rows;
}
