/**
 * Harness configuration — user and project scopes, effective values with
 * provenance, schema validation, atomic writes.
 *
 * THE KEY SET IS DELIBERATELY SMALL. Every key here is read by code that
 * exists: `exec.timeout_seconds` and `exec.allow_env` feed `exec-policy.mjs`,
 * and `exec.bash_enabled` is the policy gate that lets `bash` be denied
 * separately from `exec`. A configuration surface whose keys nothing consumes
 * is the same dead seam `runProcess`'s unused `env` parameter already was —
 * correct, documented, and doing nothing. Keys arrive when their reader does.
 *
 * PRECEDENCE is default < user < project, with one exception that matters:
 * keys marked `merge: 'restrictive'` take the SAFER of the two scopes rather
 * than the more specific one. A repository is content; a user's config is a
 * decision about their own machine. Letting a checked-in file re-enable a shell
 * its owner turned off would make the user-scope setting advisory, which is not
 * what a person disabling `bash` globally means by it. Restrictive keys can be
 * tightened by a project and never loosened.
 *
 * Project scope is additionally gated on TRUST (P3AC6): an unapproved project's
 * config is parsed for display but never contributes an effective value, so
 * cloning a hostile repository cannot change how the harness executes before
 * anyone has looked at it.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EXIT } from './style.mjs';
import { writeFileContained } from './fs-safe.mjs';

export const CONFIG_SCHEMA_VERSION = 1;

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/**
 * The declared key space. Data, not convention — `config` renders from this,
 * validation reads it, and the merge rule per key lives here rather than in a
 * branch someone has to remember to update.
 */
export const CONFIG_SCHEMA = Object.freeze({
  'exec.timeout_seconds': {
    type: 'number',
    default: 600,
    // Restrictive by MINIMUM: a shorter deadline is the safer one. A project
    // that needs longer than the user allows has to say so to the user.
    merge: 'restrictive',
    restrict: (a, b) => Math.min(a, b),
    description: 'default seconds before an executed process tree is terminated',
    validate: (value) => {
      if (!Number.isInteger(value) || value < 1 || value > 3600) {
        throw usageError('exec.timeout_seconds must be an integer from 1 to 3600');
      }
      return value;
    },
  },
  'exec.allow_env': {
    type: 'list',
    default: [],
    // Union: an allowlist entry is an operator decision in both scopes, and
    // `NEVER_ALLOWED` in exec-policy.mjs still refuses the three names that are
    // not decisions. Trust is what keeps an unreviewed project out of this set,
    // not per-key arithmetic.
    merge: 'union',
    description: 'environment variable names passed through to executed processes',
    validate: (value) => {
      for (const name of value) {
        if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw usageError(`exec.allow_env entries must be environment variable names (got ${JSON.stringify(name)})`);
        }
      }
      return value;
    },
  },
  'exec.network': {
    type: 'enum',
    values: ['allow', 'deny'],
    default: 'allow',
    // Restrictive: `deny` always wins. Same rule as the shell gate — a project
    // may cut network access off and may never restore it.
    merge: 'restrictive',
    restrict: (a, b) => (a === 'deny' || b === 'deny' ? 'deny' : 'allow'),
    description: 'whether executed processes may reach the network (deny is enforced only where the platform has a primitive)',
  },
  'exec.bash_enabled': {
    type: 'boolean',
    default: true,
    // Restrictive by AND. This is the P3AC2 gate: `bash` is allowed or denied
    // separately from `exec`, and a project can deny it but never grant it.
    merge: 'restrictive',
    restrict: (a, b) => a && b,
    description: 'whether `harness bash` may run a shell at all',
  },
});

export const CONFIG_KEYS = Object.freeze(Object.keys(CONFIG_SCHEMA));

export const SCOPES = Object.freeze(['user', 'project']);

/** Where each scope's file lives. Project sits beside policy.yaml and
 * checks.yaml, because a reader looking for harness configuration should find
 * all of it in one directory. */
export function configPathFor(scope, { copilotHome, workspace }) {
  if (scope === 'user') return path.join(copilotHome, 'harness', 'config.yaml');
  if (scope === 'project') return path.join(workspace, '.github', 'harness', 'config.yaml');
  throw usageError(`unknown scope: ${scope}`, `scope must be one of: ${SCOPES.join(', ')}`);
}

/**
 * Coerce and validate one raw value against its key's declared type.
 *
 * Coercion is from STRINGS because that is what a CLI hands you; a value read
 * from YAML arrives already typed and passes through the same validator, so a
 * hand-edited file and a `config set` cannot disagree about what is legal.
 */
export function coerceValue(key, raw) {
  const spec = CONFIG_SCHEMA[key];
  if (!spec) {
    throw usageError(`unknown config key: ${key}`, `known keys: ${CONFIG_KEYS.join(', ')}`);
  }
  let value = raw;
  if (spec.type === 'number') {
    if (typeof raw === 'string') {
      if (!/^-?\d+$/.test(raw.trim())) throw usageError(`${key} must be an integer (got ${JSON.stringify(raw)})`);
      value = Number(raw.trim());
    }
    if (typeof value !== 'number') throw usageError(`${key} must be a number (got ${JSON.stringify(raw)})`);
  } else if (spec.type === 'boolean') {
    if (typeof raw === 'string') {
      const t = raw.trim().toLowerCase();
      if (!['true', 'false'].includes(t)) throw usageError(`${key} must be true or false (got ${JSON.stringify(raw)})`);
      value = t === 'true';
    }
    if (typeof value !== 'boolean') throw usageError(`${key} must be a boolean (got ${JSON.stringify(raw)})`);
  } else if (spec.type === 'list') {
    if (typeof raw === 'string') {
      value = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(value)) throw usageError(`${key} must be a list (got ${JSON.stringify(raw)})`);
  } else if (spec.type === 'enum') {
    if (typeof value !== 'string' || !spec.values.includes(value)) {
      throw usageError(`${key} must be one of ${spec.values.join(', ')} (got ${JSON.stringify(raw)})`);
    }
  }
  return spec.validate ? spec.validate(value) : value;
}

/**
 * Read one scope's file.
 *
 * A malformed or unknown-key file is REPORTED, never silently skipped: a
 * configuration that does not take effect because nobody could parse it is the
 * failure mode where an operator believes a limit is enforced and it is not.
 */
export function loadConfigFile(file) {
  if (!fs.existsSync(file)) return { exists: false, values: {}, errors: [] };
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'), { maxAliasCount: 50 });
  } catch (error) {
    return { exists: true, values: {}, errors: [`${file}: ${error.message}`] };
  }
  if (doc === null || doc === undefined) return { exists: true, values: {}, errors: [] };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return { exists: true, values: {}, errors: [`${file}: expected a YAML mapping`] };
  }

  const errors = [];
  const values = {};
  const settings = doc.config && typeof doc.config === 'object' && !Array.isArray(doc.config) ? doc.config : doc;
  for (const [key, raw] of Object.entries(settings)) {
    if (key === 'version') continue;
    if (!(key in CONFIG_SCHEMA)) {
      errors.push(`${file}: unknown key ${key}`);
      continue;
    }
    try {
      values[key] = coerceValue(key, raw);
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  return { exists: true, values, errors };
}

/**
 * The effective configuration, with provenance for every key.
 *
 * `provenance[key]` records which scope supplied the value and, for a
 * restrictive key that two scopes both set, that the safer one won — otherwise
 * a user who set a 60-second timeout and sees 60 while the project asked for
 * 900 has no way to learn why.
 */
export function resolveConfig({ copilotHome, workspace, projectTrusted = true } = {}) {
  const userFile = configPathFor('user', { copilotHome, workspace });
  const projectFile = configPathFor('project', { copilotHome, workspace });
  const user = loadConfigFile(userFile);
  const project = loadConfigFile(projectFile);

  const values = {};
  const provenance = {};
  for (const key of CONFIG_KEYS) {
    const spec = CONFIG_SCHEMA[key];
    let value = spec.default;
    let source = 'default';
    let file = null;
    let note;

    if (key in user.values) {
      value = user.values[key];
      source = 'user';
      file = userFile;
    }

    const projectSets = key in project.values;
    if (projectSets && !projectTrusted) {
      // Parsed and shown, never applied — see the module note on trust.
      note = 'ignored: project is not trusted';
    } else if (projectSets) {
      const projectValue = project.values[key];
      if (source !== 'default' && spec.merge === 'restrictive') {
        const restricted = spec.restrict(value, projectValue);
        if (restricted !== value) {
          value = restricted;
          source = 'project';
          file = projectFile;
        } else if (restricted !== projectValue) {
          note = 'project asked for a less restrictive value; the user scope wins';
        }
      } else if (spec.merge === 'union') {
        const merged = [...new Set([...(Array.isArray(value) ? value : []), ...projectValue])].sort();
        value = merged;
        source = source === 'default' ? 'project' : 'user+project';
        file = projectFile;
      } else {
        value = projectValue;
        source = 'project';
        file = projectFile;
      }
    }

    values[key] = value;
    provenance[key] = { source, file, ...(note ? { note } : {}) };
  }

  return {
    values,
    provenance,
    errors: [...user.errors, ...project.errors],
    files: {
      user: { path: userFile, exists: user.exists },
      project: { path: projectFile, exists: project.exists, trusted: projectTrusted },
    },
  };
}

/**
 * Write one key into one scope, atomically.
 *
 * `writeFileContained` (lib/fs-safe.mjs) does the work: exclusive create,
 * containment verified through the open descriptor, content written only after
 * that check, then a same-directory rename — so a concurrent reader sees either
 * the old file or the new one and never a half-written config that would parse
 * as a weaker policy than either.
 */
export function setConfigValue({ scope, key, value, copilotHome, workspace }) {
  if (!SCOPES.includes(scope)) {
    throw usageError(`unknown scope: ${scope}`, `scope must be one of: ${SCOPES.join(', ')}`);
  }
  const coerced = coerceValue(key, value);
  const file = configPathFor(scope, { copilotHome, workspace });
  const existing = loadConfigFile(file);
  if (existing.errors.length && existing.exists) {
    // Refusing beats silently rewriting: overwriting a file we could not fully
    // parse would discard settings the operator believes are in effect.
    throw Object.assign(new Error(`refusing to write over a config with errors: ${existing.errors[0]}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'fix the file by hand, or run `harness config validate` to see every error',
    });
  }

  const merged = { version: CONFIG_SCHEMA_VERSION, ...existing.values, [key]: coerced };
  const root = scope === 'user' ? copilotHome : workspace;
  const rel = path.relative(root, file);
  const written = writeFileContained(root, rel, YAML.stringify(merged));
  if (!written) {
    throw Object.assign(new Error(`could not write ${file}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'the path is not writable, or an ancestor is a symlink out of the scope root',
    });
  }
  return { file: written, key, value: coerced, scope };
}
