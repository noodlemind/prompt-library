/**
 * `harness config show|get|set|validate` — the configuration surface.
 *
 * `show` leads with PROVENANCE rather than values alone. The question an
 * operator actually has is not "what is the timeout" but "why is it that, when
 * I set something else" — a config command that prints an effective value
 * without saying where it came from leaves the interesting half unanswered, and
 * this harness merges three sources with one of them deliberately able to lose.
 *
 * `set` is the only verb with a mutate side effect, declared per verb rather
 * than inherited from the entry's maximum, for the same reason `checks list`
 * does not inherit `checks run`'s execute class.
 */
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import {
  CONFIG_KEYS,
  CONFIG_SCHEMA,
  SCOPES,
  configPathFor,
  resolveConfig,
  setConfigValue,
} from './config.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const CONFIG_VERBS = Object.freeze(['show', 'get', 'set', 'validate']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

/**
 * `--scope` is read straight from argv rather than added to lib/flags.mjs, the
 * same reason `--match` and `--source` are: parseFlags is shared by every
 * command, and a new value-flag there would also have to join
 * `FLAGS_WITH_VALUES` in argv.mjs or free-text parsing would swallow its value.
 */
function readValueFlag(argv, name) {
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  const eq = scan.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = scan.indexOf(name);
  if (i === -1) return null;
  const next = scan[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

function context(argv) {
  const flags = parseFlags(argv);
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      if (!a.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i += 1;
      continue;
    }
    positionals.push(a);
    if (positionals.length === 3) break;
  }
  return {
    flags,
    scope: readValueFlag(argv, '--scope'),
    verb: positionals[0] ?? null,
    key: positionals[1] ?? null,
    value: positionals[2] ?? null,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export async function configResultOf(argv, ctx = {}) {
  const { verb, key, value, scope: rawScope, workspace, copilotHome } = context(argv);
  if (!verb) throw usageError('config requires a verb', `harness config <${CONFIG_VERBS.join('|')}>`);
  if (!CONFIG_VERBS.includes(verb)) {
    throw usageError(`unknown config verb: ${verb}`, `one of ${CONFIG_VERBS.join(', ')}`);
  }

  const projectTrusted = isProjectTrusted({ workspace, copilotHome });
  const resolved = resolveConfig({ copilotHome, workspace, projectTrusted });

  if (verb === 'show') {
    return {
      schema: 1,
      verb,
      // Same reason as `checks`: without a `status` the envelope's default
      // `ok` stood next to a body full of parse errors.
      status: resolved.errors.length ? 'failed' : 'ok',
      files: resolved.files,
      settings: CONFIG_KEYS.map((k) => ({
        key: k,
        value: resolved.values[k],
        default: CONFIG_SCHEMA[k].default,
        description: CONFIG_SCHEMA[k].description,
        ...resolved.provenance[k],
      })),
      errors: resolved.errors,
    };
  }

  if (verb === 'validate') {
    // Exits non-zero on a broken file so CI can gate on it. A config that does
    // not parse is a policy nobody is enforcing, which is worse than an absent
    // one because it looks present.
    return {
      schema: 1,
      verb,
      status: resolved.errors.length ? 'failed' : 'ok',
      files: resolved.files,
      valid: resolved.errors.length === 0,
      errors: resolved.errors,
    };
  }

  if (!key) throw usageError(`config ${verb} requires a key`, `known keys: ${CONFIG_KEYS.join(', ')}`);
  if (!(key in CONFIG_SCHEMA)) {
    throw notFoundError(`unknown config key: ${key}`, `known keys: ${CONFIG_KEYS.join(', ')}`);
  }

  if (verb === 'get') {
    return {
      schema: 1,
      verb,
      key,
      value: resolved.values[key],
      default: CONFIG_SCHEMA[key].default,
      ...resolved.provenance[key],
    };
  }

  // `set`.
  if (value === null) throw usageError(`config set requires a value`, `harness config set ${key} <value> --scope user|project`);
  const scope = rawScope || null;
  if (!scope) {
    // No default scope, deliberately: guessing wrong writes a machine-wide
    // decision into a repository, or a repository's needs onto a machine.
    throw usageError('config set requires --scope', `--scope ${SCOPES.join(' or --scope ')}`);
  }
  if (!SCOPES.includes(scope)) throw usageError(`unknown scope: ${scope}`, `--scope ${SCOPES.join(' or --scope ')}`);

  const written = setConfigValue({ scope, key, value, copilotHome, workspace });
  // Trust is recomputed AFTER the write. `config.yaml` is a pinned file, so
  // writing the project scope invalidates the approval that was covering it —
  // reusing the pre-write boolean reported an effective value from a project
  // that had just become `stale`, and the very next read disagreed. Found by
  // the Codex phase review.
  const trustedAfter = isProjectTrusted({ workspace, copilotHome });
  const after = resolveConfig({ copilotHome, workspace, projectTrusted: trustedAfter });
  return {
    schema: 1,
    verb,
    key,
    scope,
    written: written.value,
    file: written.file,
    // The effective value AFTER the write, which is not always what was just
    // written — a restrictive key set loosely in the project scope leaves the
    // user's value in force, and saying so here prevents the operator walking
    // away believing a limit changed when it did not.
    value: after.values[key],
    ...after.provenance[key],
    effectiveChanged: after.values[key] === written.value,
    // Surfaced because it is the likeliest surprise: a project-scope write makes
    // the project's own approval stale, so the value just written does not take
    // effect until someone re-approves after reading the change.
    ...(scope === 'project' && !trustedAfter ? { trustNowStale: true } : {}),
  };
}

function renderShow(result) {
  const keyWidth = keyWidthFor(['config', ...CONFIG_KEYS]);
  console.log(ui.line({ key: 'config', value: `${result.settings.length} keys`, note: `user: ${result.files.user.exists ? 'set' : 'unset'} · project: ${result.files.project.exists ? 'set' : 'unset'}`, keyWidth }));
  for (const s of result.settings) {
    const note = [s.source, s.note].filter(Boolean).join(' · ');
    console.log(ui.line({
      state: s.source === 'default' ? 'muted' : 'ok',
      key: s.key,
      value: Array.isArray(s.value) ? (s.value.length ? s.value.join(',') : '(empty)') : String(s.value),
      note,
      keyWidth,
    }));
  }
  for (const error of result.errors) console.log(ui.line({ state: 'error', key: 'error', value: error, keyWidth }));
}

export async function cmdConfig(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await configResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (result.verb === 'show') {
    renderShow(result);
  } else if (result.verb === 'validate') {
    const keyWidth = keyWidthFor(['config', 'errors']);
    console.log(ui.line({ state: result.valid ? 'ok' : 'error', key: 'config', value: result.valid ? 'valid' : 'invalid', keyWidth }));
    for (const error of result.errors) console.log(ui.line({ state: 'error', key: 'error', value: error, keyWidth }));
  } else if (result.verb === 'get') {
    const keyWidth = keyWidthFor([result.key, 'source']);
    console.log(ui.line({ key: result.key, value: Array.isArray(result.value) ? result.value.join(',') : String(result.value), note: [result.source, result.note].filter(Boolean).join(' · '), keyWidth }));
  } else {
    const keyWidth = keyWidthFor(['set', 'file', 'effective']);
    console.log(ui.line({ state: 'ok', key: 'set', value: `${result.key} = ${Array.isArray(result.written) ? result.written.join(',') : String(result.written)}`, note: result.scope, keyWidth }));
    console.log(ui.line({ key: 'file', value: result.file, keyWidth }));
    console.log(ui.line({
      state: result.effectiveChanged ? 'ok' : 'warn',
      key: 'effective',
      value: Array.isArray(result.value) ? result.value.join(',') : String(result.value),
      note: [result.source, result.note].filter(Boolean).join(' · '),
      keyWidth,
    }));
  }

  // One rule, shared with the lane path through the registry's `exitOf`.
  return configExitFor(result);
}

/**
 * The exit code for a `config` result, on EVERY lane.
 *
 * `config validate` is meant to be gated on in CI, and `dispatchLane` returns 0
 * on any success path unless the entry declares this — so `config validate
 * --output json-envelope` exited 0 over a body saying `"valid": false`. Same
 * defect the Codex review found in `checks run`, in a command whose whole
 * purpose is likewise the exit code.
 */
export function configExitFor(result) {
  if (result?.verb === 'validate') return result.valid ? EXIT.ok : 1;
  if (result?.verb === 'show') return result.errors?.length ? 1 : EXIT.ok;
  return EXIT.ok;
}

export { configPathFor };
