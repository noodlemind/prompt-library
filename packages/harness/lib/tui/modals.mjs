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
  trust: 'Project trust',
  run: 'Past runs',
  todo: 'Todos',
  inspect: 'Inspect',
  resources: 'Skills & agents',
  knowledge: 'Knowledge layer',
  learning: 'Manage a learning',
  lookup: 'Open by id',
  undo: 'Undo list',
  tree: 'Browse files & knowledge',
});

/** Short action names inside a family sheet. */
export const ACTION_LABELS = Object.freeze({
  'config:show': 'Show all settings',
  'config:get': 'Get one setting',
  'config:set': 'Change a setting',
  'config:validate': 'Validate config files',
  'checks:list': 'List checks',
  'checks:show': 'Show a check',
  'checks:run': 'Run a check',
  'trust:status': 'Trust status',
  'trust:approve': 'Trust this project',
  'trust:revoke': 'Revoke trust',
  'run:list': 'List past runs',
  'run:show': 'Show a run',
  'run:tree': 'Event tree',
  'run:resume': 'Can this run resume?',
  'todo:list': 'List items',
  'todo:add': 'Add item',
  'todo:complete': 'Complete item',
  'todo:clear': 'Clear all',
  'inspect:config': 'Why is this setting this value?',
  'inspect:permissions': 'What is allowed here?',
  'inspect:workspace': 'Where is this workspace?',
  'inspect:tools': 'Which tools are on?',
  'tree:workspace': 'Browse project files',
  'tree:knowledge': 'Browse knowledge store',
  'undo:list': 'List undos',
  'lookup:plan': 'Open a plan by id',
  'lookup:learning': 'Open a learning by id',
  'lookup:run': 'Open a run by id',
});

/** Human titles for settings keys (schema id stays in the note). */
export const SETTING_LABELS = Object.freeze({
  'agent.enabled': 'Agent loop',
  'agent.providers': 'Allowed providers',
  'agent.provider': 'Default provider',
  'agent.model': 'Default model',
  'agent.max_turns': 'Agent max turns',
  'agent.max_seconds': 'Agent max seconds',
  'agent.profile': 'Agent profile',
  'exec.timeout_seconds': 'Command timeout',
  'exec.bash_enabled': 'Shell (bash)',
  'exec.allow_env': 'Env allowlist',
  'exec.network': 'Network for exec',
  'checks.env_allowlist': 'Checks use env allowlist',
  'runs.retention_days': 'Run history retention',
  'tui.density': 'TUI density',
  'tui.dividers': 'TUI dividers',
  'tui.statusline': 'Status line items',
  'tui.scheme': 'Color scheme',
  'tui.tint': 'Row tint',
  'tui.palette_chord': 'Palette chord',
  'tui.startup': 'Startup panels',
  'tui.verbosity': 'Ledger verbosity',
  'tui.alt_screen': 'Alternate screen',
  'tui.restore': 'Restore on exit',
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
    note: 'enter to change · saved to user by default',
  });
  for (const key of CONFIG_KEYS) {
    const schema = CONFIG_SCHEMA[key];
    const prov = resolved.provenance[key] || {};
    const value = resolved.values[key];
    const human = SETTING_LABELS[key] || schema?.description || key;
    const title = SETTING_LABELS[key] || key;
    rows.push({
      label: title,
      note: `${formatValue(value)} · ${prov.source || 'default'} · ${key}`,
      sideEffect: null,
      configKey: key,
      configSchema: schema,
      currentValue: value,
      // Keep machine key for search/filter.
      keywords: `${key} ${human}`,
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
    note: 'choose an action',
  });
  for (const row of cli.rows) {
    if (row.noun !== noun || row.kind !== 'verb') continue;
    const verb = String(row.verb || '').split(/\s+/)[0];
    const key = `${noun}:${verb}`;
    const human = ACTION_LABELS[key]
      || ACTION_LABELS[`${noun}:${row.verb}`]
      || row.label
      || `${noun} ${verb}`;
    rows.push({
      ...row,
      label: human,
      signature: signatureOf(row),
      note: row.note || row.summary || '',
    });
  }
  return rows;
}
