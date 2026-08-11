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
  'checks.env_allowlist': {
    type: 'boolean',
    // OFF by default, deliberately — see the note in `runNamedCheck`. A named
    // check runs only after `trust approve`, so the allowlist is
    // defence-in-depth there rather than the boundary, and defaulting it on
    // would break every check that needs a variable nobody enumerated.
    default: false,
    // Restrictive by OR: turning the allowlist ON is the safer state, so a
    // project may enable it and may not switch it back off.
    merge: 'restrictive',
    restrict: (a, b) => a || b,
    description: 'apply the exec environment allowlist to named checks too',
  },
  'runs.retention_days': {
    type: 'number',
    default: 30,
    // Plain precedence (default < user < project), NOT restrictive. Every other
    // key here gates authority, where a project must never be able to loosen
    // what the user set. Retention length is not authority — it is how much
    // history a team wants to keep — so the ordinary "more specific wins" rule
    // applies and a repository may state its own policy.
    merge: 'override',
    description: 'days of run and event history to keep before pruning',
    validate: (value) => {
      if (!Number.isInteger(value) || value < 1 || value > 3650) {
        throw usageError('runs.retention_days must be an integer from 1 to 3650');
      }
      return value;
    },
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

  /**
   * WHICH MODEL ANSWERS, remembered.
   *
   * `--provider` defaulted to one provider with no fallback, so an operator on
   * a Copilot subscription retyped `--provider github-copilot` on every single
   * invocation — and whenever they forgot, the run failed asking for a
   * credential belonging to a provider they had never chosen. Every surveyed
   * CLI persists this choice (`/model` in Claude Code, Amp, OpenCode, Pi);
   * `harness model set` writes these two keys.
   *
   * (The default's own key variable is deliberately NOT named here: the seam
   * is the only module in core allowed to know a credential exists — P5AC7 —
   * and it scans prose too, which is the point.)
   *
   * Plain precedence, not restrictive: which model a repository prefers is a
   * statement about the work, not a grant of authority — and the credential
   * itself never lives here, only the choice of endpoint.
   */
  'agent.provider': {
    type: 'string',
    // COPILOT IS PRIMARY. It is the provider this project's users already
    // have — the hydration target is Copilot, the personas are Copilot
    // agents — and it is the only one that needs no key exported: an editor
    // sign-in is the credential. A default nobody can use is a default that
    // teaches people to pass a flag.
    default: 'github-copilot',
    merge: 'override',
    description: 'default provider for `harness agent` (see: harness model)',
  },
  'agent.model': {
    type: 'string',
    default: '',
    merge: 'override',
    description: 'default model id; empty means the provider\'s own default',
  },

  // ── Session Ledger presentation ────────────────────────────────────────
  //
  // These exist because the design mock's §6 makes an argument worth taking:
  // the things people argue about are the things a terminal tool should make
  // configurable rather than decide for them. Every one of them is taste or
  // accessibility, never authority, so they all merge by plain precedence —
  // a repository may state how its ledger looks and can grant nothing by
  // doing so.
  'tui.density': {
    type: 'enum',
    values: ['compact', 'comfortable'],
    // COMFORTABLE IS THE MOCK'S OWN RENDERING. Its ledger separates every
    // block with untinted ground (`.blk+.blk{margin-top:9px}`), and that gap
    // is what distinguishes two consecutive same-state blocks — two ok blocks
    // with identical tints and no gap read as one. The §6 table's word
    // "compact" described that 9px gap, not zero; a terminal's smallest gap is
    // one blank row, so one blank row is the default and `compact` is the
    // zero-gap opt-in for those who want maximum density.
    default: 'comfortable',
    merge: 'override',
    description: 'blank line between ledger blocks (comfortable, default) or none (compact)',
  },
  'tui.dividers': {
    type: 'boolean',
    default: false,
    merge: 'override',
    description: 'draw a rule between ledger blocks instead of relying on the tint',
  },
  'tui.statusline': {
    type: 'list',
    // A SEQUENCE, not a set — see the `ordered` note in `resolveConfig`. The
    // order is the setting.
    ordered: true,
    default: ['plan', 'gate', 'run', 'knowledge'],
    merge: 'override',
    description: 'footer items, in order (plan, gate, run, knowledge)',
    validate: (value) => {
      const allowed = ['plan', 'gate', 'run', 'knowledge'];
      for (const item of value) {
        if (!allowed.includes(item)) {
          throw usageError(`tui.statusline entries must be one of ${allowed.join(', ')} (got ${JSON.stringify(item)})`);
        }
      }
      return value;
    },
  },
  'tui.tint': {
    type: 'enum',
    values: ['auto', 'dark', 'light', 'off'],
    default: 'auto',
    merge: 'override',
    // `off` IS the minimum-contrast answer the mock lists as an unfilled gap.
    // Nothing is painted over the operator's own background, and block state
    // falls back to the stripe, the glyph and the word in the record line —
    // three channels that never depended on the tint in the first place.
    description: 'block tint ground: auto-detect, force dark/light, or off for maximum contrast',
  },
  'tui.palette_chord': {
    type: 'enum',
    values: ['ctrl+p', 'ctrl+k', 'ctrl+space'],
    default: 'ctrl+p',
    merge: 'override',
    // Ctrl-P by contract, because Ctrl-K is readline's kill-to-end-of-line and
    // taking it costs a reflex every shell user has. Ctrl-K still opens the
    // palette when the line is empty, where there is nothing to kill.
    description: 'chord that opens the command palette',
  },
  'tui.startup': {
    type: 'list',
    default: ['context', 'knowledge', 'shortcuts'],
    merge: 'override',
    description: 'sections shown when the ledger opens (context, knowledge, shortcuts)',
    validate: (value) => {
      const allowed = ['context', 'knowledge', 'shortcuts'];
      for (const item of value) {
        if (!allowed.includes(item)) {
          throw usageError(`tui.startup entries must be one of ${allowed.join(', ')} (got ${JSON.stringify(item)})`);
        }
      }
      return value;
    },
  },
  'tui.verbosity': {
    type: 'enum',
    values: ['normal', 'screen-reader'],
    default: 'normal',
    merge: 'override',
    // The mock names screen-reader verbosity as a gap that must be specified in
    // 4b rather than discovered later. `screen-reader` drops the tints and the
    // live repaint — a region that redraws on every streamed line is read aloud
    // on every streamed line — and states each block's status in words.
    description: 'screen-reader mode: no repainting region, no tints, status stated in words',
  },
  'tui.alt_screen': {
    type: 'boolean',
    default: false,
    merge: 'override',
    // Main buffer by default is a design commitment, not a default worth
    // flipping casually: the alternate screen costs scrollback, selection and
    // the terminal's own search. It is a config because Codex and Amp both
    // shipped alt-screen and were both forced to add an escape hatch, and the
    // same pressure exists in reverse.
    description: 'render in the alternate screen instead of the main buffer (costs scrollback)',
  },
  'tui.restore': {
    type: 'number',
    default: 8,
    merge: 'override',
    description: 'how many prior runs the ledger restores from the journal on open',
    validate: (value) => {
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw usageError('tui.restore must be an integer from 0 to 100');
      }
      return value;
    },
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
  // `Object.hasOwn`, not `in`/plain lookup: `CONFIG_SCHEMA` is a plain object,
  // so `constructor`, `toString`, `valueOf` and `__proto__` resolve to
  // INHERITED members. Each of those passed both this guard and the unknown-key
  // check below, then `spec.type` and `spec.validate` came back undefined — so
  // the value skipped every coercion and validation branch and was returned
  // unchanged, and the key was recorded rather than reported. Nothing reads
  // those keys today; the bypass was on the surface that gates execution.
  const spec = Object.hasOwn(CONFIG_SCHEMA, key) ? CONFIG_SCHEMA[key] : null;
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
  } else if (spec.type === 'string') {
    if (typeof value !== 'string') throw usageError(`${key} must be a string (got ${JSON.stringify(raw)})`);
    value = value.trim();
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
    if (!Object.hasOwn(CONFIG_SCHEMA, key)) {
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
      if (spec.merge === 'restrictive') {
        // Folded against whatever is currently effective — the USER value when
        // there is one, otherwise the DEFAULT. Comparing only when a user value
        // existed made the arithmetic depend on whether a second scope happened
        // to be present: with no user config, a project could raise
        // `exec.timeout_seconds` from the 600 default to 3600 and the rule
        // "a project may tighten and never loosen" quietly did not apply.
        //
        // The USER scope is deliberately NOT folded against the default. The
        // default is a starting point, not a ceiling; folding it would make it
        // impossible for the operator to raise their own timeout, which turns
        // the escape hatch into a wall.
        const restricted = spec.restrict(value, projectValue);
        if (restricted !== value) {
          value = restricted;
          source = 'project';
          file = projectFile;
        } else if (restricted !== projectValue) {
          note = source === 'default'
            ? 'project asked for a less restrictive value than the default; the default wins'
            : 'project asked for a less restrictive value; the user scope wins';
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

    // Normalized regardless of how many scopes contributed. Previously a
    // user-only list came back verbatim (`["A","A"]`) while the same list
    // merged with a project scope was deduplicated and sorted through the
    // `Set` above — the shape of a value should not depend on how many files
    // happened to mention it.
    // ORDERED lists keep the order they were written in. Sorting is right for a
    // list that is a SET — `exec.allow_env` means the same thing in any order,
    // and normalizing it makes two files that grant the same access compare
    // equal. It is wrong for a list that is a SEQUENCE: `tui.statusline` is a
    // footer's left-to-right order, and sorting it silently rearranges the
    // thing the operator was configuring. Dedup still applies to both, since a
    // repeated entry is a mistake in either reading.
    values[key] = spec.type === 'list' && Array.isArray(value)
      ? (spec.ordered ? [...new Set(value)] : [...new Set(value)].sort())
      : value;
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
