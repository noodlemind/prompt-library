/**
 * inspect — effective config / permissions provenance (Grok inspect / Codex debug-config).
 * Kernel-pure: no LLM.
 */
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';
import { CONFIG_KEYS, CONFIG_SCHEMA, resolveConfig } from './config.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { modelStatus } from './model-cmd.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const INSPECT_VERBS = Object.freeze(['config', 'permissions', 'workspace', 'tools']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function context(argv) {
  const flags = parseFlags(argv);
  const positionals = [];
  for (const a of argv) {
    if (a === '--') break;
    if (a.startsWith('--')) continue;
    positionals.push(a);
    if (positionals.length === 2) break;
  }
  return {
    flags,
    verb: positionals[0] || 'config',
    key: positionals[1] || null,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export async function inspectResultOf(argv, ctx = {}) {
  void ctx;
  const { verb, key, workspace, copilotHome, flags } = context(argv);
  if (!INSPECT_VERBS.includes(verb)) {
    throw usageError(`unknown inspect verb: ${verb}`, `one of ${INSPECT_VERBS.join(', ')}`);
  }

  const projectTrusted = isProjectTrusted({ workspace, copilotHome });
  const resolved = resolveConfig({ copilotHome, workspace, projectTrusted });
  let model = null;
  try {
    model = modelStatus({ workspace, copilotHome });
  } catch {
    model = null;
  }

  if (verb === 'config') {
    const keys = key ? [key] : ['agent.enabled', 'agent.providers', 'agent.model', 'exec.bash_enabled', 'exec.timeout_seconds'];
    const settings = [];
    for (const k of keys) {
      if (!(k in CONFIG_SCHEMA) && !Object.hasOwn(resolved.values, k)) {
        if (key) throw Object.assign(new Error(`unknown config key: ${k}`), { code: 'E_NOT_FOUND', exit: EXIT.notFound });
        continue;
      }
      const schema = CONFIG_SCHEMA[k];
      const prov = resolved.provenance[k] || {};
      settings.push({
        key: k,
        value: resolved.values[k],
        default: schema?.default,
        source: prov.source || 'default',
        note: prov.note || null,
        description: schema?.description || null,
      });
    }
    return {
      schema: 1,
      verb: 'config',
      workspace,
      files: resolved.files,
      settings,
      model: model ? {
        agentEnabled: model.agentEnabled,
        provider: model.provider,
        model: model.model,
      } : null,
    };
  }

  if (verb === 'permissions') {
    return {
      schema: 1,
      verb: 'permissions',
      workspace,
      projectTrusted,
      agentEnabled: model?.agentEnabled === true,
      bashEnabled: resolved.values['exec.bash_enabled'] !== false,
      network: resolved.values['exec.network'] ?? null,
      timeoutSeconds: resolved.values['exec.timeout_seconds'] ?? null,
    };
  }

  if (verb === 'workspace') {
    return {
      schema: 1,
      verb: 'workspace',
      workspace,
      copilotHome,
      projectTrusted,
      configFiles: resolved.files,
    };
  }

  // tools — light surface: list config keys that gate tool classes
  return {
    schema: 1,
    verb: 'tools',
    bashEnabled: resolved.values['exec.bash_enabled'] !== false,
    agentEnabled: model?.agentEnabled === true,
    keys: CONFIG_KEYS.filter((k) => k.startsWith('exec.') || k.startsWith('agent.')),
  };
}

export async function cmdInspect(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await inspectResultOf(argv, ctx);
  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return;
  }
  if (result.verb === 'config') {
    const keyWidth = keyWidthFor(['inspect', ...result.settings.map((s) => s.key), 'file', 'model']);
    console.log(ui.line({ key: 'inspect', value: 'config', note: result.workspace, keyWidth }));
    for (const s of result.settings) {
      const val = Array.isArray(s.value) ? (s.value.length ? s.value.join(',') : '(empty)') : String(s.value);
      console.log(ui.line({
        state: s.source === 'default' ? 'muted' : 'ok',
        key: s.key,
        value: val,
        note: [s.source, s.note].filter(Boolean).join(' · '),
        keyWidth,
      }));
    }
    if (result.model) {
      console.log(ui.line({
        key: 'model',
        value: result.model.model || '(none)',
        note: result.model.agentEnabled ? `agent on · ${result.model.provider || ''}` : 'agent off',
        keyWidth,
      }));
    }
    return;
  }
  if (result.verb === 'permissions') {
    const keyWidth = keyWidthFor(['inspect', 'trusted', 'agent', 'bash', 'network', 'timeout']);
    console.log(ui.line({ key: 'inspect', value: 'permissions', keyWidth }));
    console.log(ui.line({ state: result.projectTrusted ? 'ok' : 'warn', key: 'trusted', value: String(result.projectTrusted), keyWidth }));
    console.log(ui.line({ key: 'agent', value: result.agentEnabled ? 'on' : 'off', keyWidth }));
    console.log(ui.line({ key: 'bash', value: result.bashEnabled ? 'allowed' : 'denied', keyWidth }));
    if (result.network != null) console.log(ui.line({ key: 'network', value: String(result.network), keyWidth }));
    if (result.timeoutSeconds != null) console.log(ui.line({ key: 'timeout', value: `${result.timeoutSeconds}s`, keyWidth }));
    return;
  }
  if (result.verb === 'workspace') {
    const keyWidth = keyWidthFor(['inspect', 'workspace', 'home', 'trusted']);
    console.log(ui.line({ key: 'inspect', value: 'workspace', keyWidth }));
    console.log(ui.line({ key: 'workspace', value: result.workspace, keyWidth }));
    console.log(ui.line({ key: 'home', value: result.copilotHome, keyWidth }));
    console.log(ui.line({ key: 'trusted', value: String(result.projectTrusted), keyWidth }));
    return;
  }
  const keyWidth = keyWidthFor(['inspect', 'bash', 'agent']);
  console.log(ui.line({ key: 'inspect', value: 'tools', keyWidth }));
  console.log(ui.line({ key: 'bash', value: result.bashEnabled ? 'on' : 'off', keyWidth }));
  console.log(ui.line({ key: 'agent', value: result.agentEnabled ? 'on' : 'off', keyWidth }));
}

export function inspectExitFor() {
  return EXIT.ok;
}
