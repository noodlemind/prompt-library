/**
 * Locally-added primitives — skills and agents a user put into `~/.copilot`
 * themselves, from an external source, rather than receiving them from the
 * harness package.
 *
 * THE HARNESS COULD NOT PREVIOUSLY TELL THEM APART FROM CRUFT. Everything under
 * `skills/` and `agents/` was assumed to have been hydrated by the package, so
 * a file the package no longer ships looked like a leftover from an old
 * version. A hand-added skill therefore tripped doctor's stale-orphan check,
 * which told the operator to tombstone it in `retired.json` — advice that would
 * have made the next `upgrade` delete their own team's work.
 *
 * The lock file is what makes the distinction possible: it records every file
 * the harness hydrated. A file that is not shipped AND was never in the lock
 * was not put there by the harness, so it is a local addition, not an orphan.
 *
 * REGISTRATION IS AN OPERATOR ACT, RECORDED IN THE USER SCOPE. The marker lives
 * in `~/.copilot/harness/registered.yaml`, never inside the primitive — the
 * same reason the trust store lives outside the project it describes. A file
 * that could register itself would mean anything dropped into the directory
 * arrives pre-approved, which is the whole thing registration exists to prevent.
 *
 * REGISTRATION PINS CONTENT, for the same reason project trust does: a file
 * approved once and trusted forever means a later edit rides an approval nobody
 * re-read. A changed file becomes `stale` and asks to be looked at again.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { writeFileContained } from './fs-safe.mjs';

export const REGISTERED_FILE = path.join('harness', 'registered.yaml');
export const REGISTRY_SCHEMA = 1;

/** The directories a user may drop a primitive into, and what shape each
 * expects. Closed: a kind the harness cannot validate is one it should not
 * claim to have registered. */
export const PRIMITIVE_KINDS = Object.freeze({
  skills: { dir: 'skills', match: /^skills\/[^/]+\/SKILL\.md$/, describe: 'skills/<name>/SKILL.md' },
  agents: { dir: 'agents', match: /^agents\/[^/]+\.agent\.md$/, describe: 'agents/<name>.agent.md' },
  instructions: { dir: 'instructions', match: /^instructions\/[^/]+\.instructions\.md$/, describe: 'instructions/<name>.instructions.md' },
});

export function registeredPath(copilotHome) {
  return path.join(copilotHome, REGISTERED_FILE);
}

function walk(root, base = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(root, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export function fileDigest(full) {
  try {
    return `sha256-${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * Validate a primitive the harness did not ship (P5 workflow item 4).
 *
 * The point is that a malformed file fails LOUDLY here rather than silently
 * never loading in the host. A skill whose frontmatter does not parse is not
 * "not yet working" — from Copilot's side it simply does not exist, and the
 * person who added it has no signal at all.
 */
export function validatePrimitive(copilotHome, rel) {
  const errors = [];
  const kindKey = Object.keys(PRIMITIVE_KINDS).find((k) => rel.startsWith(`${PRIMITIVE_KINDS[k].dir}/`));
  const kind = kindKey ? PRIMITIVE_KINDS[kindKey] : null;
  if (!kind) return { valid: false, kind: null, name: null, errors: [`${rel}: not under a primitive directory`] };
  if (!kind.match.test(rel)) {
    errors.push(`${rel}: a ${kindKey.replace(/s$/, '')} must be ${kind.describe} — a file elsewhere is never discovered`);
  }

  const full = path.join(copilotHome, rel);
  let text = '';
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (error) {
    return { valid: false, kind: kindKey, name: null, errors: [`${rel}: unreadable (${error.code || error.message})`] };
  }

  // Frontmatter: the host reads it to learn the primitive exists at all.
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) {
    errors.push(`${rel}: no YAML frontmatter — the host cannot discover a primitive without it`);
    return { valid: false, kind: kindKey, name: null, errors };
  }
  let front;
  try {
    front = YAML.parse(match[1], { maxAliasCount: 50 });
  } catch (error) {
    errors.push(`${rel}: frontmatter is not valid YAML (${error.message})`);
    return { valid: false, kind: kindKey, name: null, errors };
  }
  if (!front || typeof front !== 'object' || Array.isArray(front)) {
    errors.push(`${rel}: frontmatter must be a mapping`);
    return { valid: false, kind: kindKey, name: null, errors };
  }
  const name = typeof front.name === 'string' ? front.name.trim() : '';
  if (!name) errors.push(`${rel}: frontmatter needs a name`);

  // The name and the path must agree, or two different things answer to one
  // identity and which one loads depends on the host.
  const onDisk = kindKey === 'skills'
    ? rel.split('/')[1]
    : path.basename(rel).replace(/\.(agent|instructions)\.md$/, '');
  if (name && onDisk && name !== onDisk) {
    errors.push(`${rel}: frontmatter name ${JSON.stringify(name)} does not match its path (${onDisk})`);
  }

  return { valid: errors.length === 0, kind: kindKey, name: name || null, errors };
}

function readRegistry(copilotHome) {
  const file = registeredPath(copilotHome);
  if (!fs.existsSync(file)) return { version: REGISTRY_SCHEMA, primitives: {} };
  try {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'), { maxAliasCount: 50 });
    const primitives = doc?.primitives;
    if (!primitives || typeof primitives !== 'object' || Array.isArray(primitives)) {
      // Present but structurally wrong: damaged, not empty. Overwriting it
      // would discard registrations nobody could read back — the same rule the
      // trust store follows.
      return { version: REGISTRY_SCHEMA, primitives: {}, unreadable: true };
    }
    return { version: doc.version || REGISTRY_SCHEMA, primitives };
  } catch {
    return { version: REGISTRY_SCHEMA, primitives: {}, unreadable: true };
  }
}

function writeRegistry(copilotHome, registry) {
  const written = writeFileContained(copilotHome, REGISTERED_FILE, YAML.stringify(registry));
  if (!written) {
    throw Object.assign(new Error(`could not write ${registeredPath(copilotHome)}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'the path is not writable, or an ancestor is a symlink out of the home directory',
    });
  }
  return written;
}

/**
 * Everything under the primitive directories, classified by ORIGIN.
 *
 *   shipped   the package ships it — the harness owns it
 *   orphan    the harness hydrated it once and no longer ships it
 *   local     never shipped, never in the lock: someone put it there
 *
 * `lockFiles` is what separates the last two, and getting it wrong is what
 * turned a team's own skill into a deletion recommendation.
 */
export function classifyPrimitives({ copilotHome, shippedFiles = new Set(), lockFiles = new Set() }) {
  const out = { shipped: [], orphan: [], local: [] };
  for (const key of Object.keys(PRIMITIVE_KINDS)) {
    const dir = PRIMITIVE_KINDS[key].dir;
    for (const file of walk(path.join(copilotHome, dir))) {
      const rel = `${dir}/${file}`;
      if (shippedFiles.has(rel)) out.shipped.push(rel);
      else if (lockFiles.has(rel)) out.orphan.push(rel);
      else out.local.push(rel);
    }
  }
  return out;
}

/**
 * Local primitives with their registration state.
 *
 * `state` is `registered`, `pending`, `stale`, or `invalid`. `pending` and
 * `invalid` are both reported rather than hidden: a file someone added that the
 * harness silently ignores is the failure this whole surface exists to end.
 */
export function localPrimitiveStatus({ copilotHome, shippedFiles = new Set(), lockFiles = new Set() }) {
  const registry = readRegistry(copilotHome);
  const { local } = classifyPrimitives({ copilotHome, shippedFiles, lockFiles });
  return local.map((rel) => {
    const validation = validatePrimitive(copilotHome, rel);
    const record = registry.primitives[rel] || null;
    const digest = fileDigest(path.join(copilotHome, rel));
    let state = 'pending';
    let reason = 'found but not registered — `harness resources register` after reading it';
    if (!validation.valid) {
      state = 'invalid';
      reason = validation.errors[0];
    } else if (registry.unreadable) {
      reason = 'the registration store could not be read, so nothing counts as registered';
    } else if (record) {
      if (record.digest === digest) {
        state = 'registered';
        reason = `registered ${record.registeredAt}`;
      } else {
        state = 'stale';
        reason = 'changed since it was registered — read it again, then re-register';
      }
    }
    return { path: rel, kind: validation.kind, name: validation.name, state, reason, digest, errors: validation.errors };
  });
}

export function registerPrimitive({ copilotHome, rel, now = new Date().toISOString(), shippedFiles = new Set(), lockFiles = new Set() }) {
  const { local } = classifyPrimitives({ copilotHome, shippedFiles, lockFiles });
  if (!local.includes(rel)) {
    throw Object.assign(new Error(`not a locally-added primitive: ${rel}`), {
      code: 'E_NOT_FOUND',
      exit: 9,
      hint: 'harness resources list — only files the harness did not ship can be registered',
    });
  }
  const validation = validatePrimitive(copilotHome, rel);
  if (!validation.valid) {
    // Validation gates registration, which is the whole point of the flow: a
    // primitive the host would never load must not be marked as working.
    throw Object.assign(new Error(`refusing to register an invalid primitive: ${validation.errors[0]}`), {
      code: 'E_USAGE',
      exit: 2,
      hint: `fix it, then: harness resources register ${rel}`,
    });
  }
  const registry = readRegistry(copilotHome);
  if (registry.unreadable) {
    throw Object.assign(new Error('refusing to write over an unreadable registration store'), {
      code: 'E_TARGET',
      exit: 1,
      hint: `inspect ${registeredPath(copilotHome)} by hand — overwriting it would discard every registration it holds`,
    });
  }
  registry.version = REGISTRY_SCHEMA;
  registry.primitives[rel] = {
    registeredAt: now,
    digest: fileDigest(path.join(copilotHome, rel)),
    kind: validation.kind,
    name: validation.name,
  };
  writeRegistry(copilotHome, registry);
  return { path: rel, state: 'registered', kind: validation.kind, name: validation.name };
}

export function unregisterPrimitive({ copilotHome, rel }) {
  const registry = readRegistry(copilotHome);
  if (registry.unreadable) {
    throw Object.assign(new Error('refusing to write over an unreadable registration store'), {
      code: 'E_TARGET', exit: 1, hint: `inspect ${registeredPath(copilotHome)} by hand`,
    });
  }
  if (!registry.primitives[rel]) {
    throw Object.assign(new Error(`not registered: ${rel}`), { code: 'E_NOT_FOUND', exit: 9, hint: 'harness resources list' });
  }
  delete registry.primitives[rel];
  writeRegistry(copilotHome, registry);
  // Deliberately does NOT delete the file. Unregistering withdraws the
  // harness's recognition; removing someone's work because they changed their
  // mind about a marker would be a much larger action than they asked for.
  return { path: rel, state: 'pending' };
}
