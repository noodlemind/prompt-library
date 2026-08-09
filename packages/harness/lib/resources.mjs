/**
 * Resource bundles — third-party contributions that ride the EXISTING
 * hydration pipeline (P5AC1).
 *
 * The temptation in a plugin system is a parallel install path: a second
 * directory, a second sync, a second retirement mechanism. The contract forbids
 * it and the reason is concrete — `install`/`upgrade`/`retired.json` already
 * know how to place files, detect stale orphans, and withdraw something that
 * shipped. A second pipeline would need all three again and would get the third
 * one wrong, because retirement is the part nobody remembers until a file that
 * should have vanished is still being loaded a version later.
 *
 * So a bundle is a MANIFEST plus a directory of the same asset kinds the
 * harness already hydrates. Everything below is about deciding which bundles
 * are allowed to contribute and in what order — not about a new way to copy
 * files.
 *
 * PRECEDENCE IS DETERMINISTIC AND INSPECTABLE (P5AC2). Two bundles contributing
 * the same skill is not an error; silently picking one is. Every resource
 * carries where it came from, and `resources show` prints the losers alongside
 * the winner, because "why is my version not the one running" is the question a
 * precedence rule exists to answer.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { byteCompare } from './tui/ranking.mjs';

export const MANIFEST_FILE = 'harness-resource.yaml';
export const RESOURCES_DIRNAME = 'resources';
export const MANIFEST_SCHEMA = 1;

/** The contribution kinds a bundle may declare. Closed, for the same reason the
 * event-type allow-list is closed: an unlisted kind that silently contributes
 * nothing is invisible by construction. */
export const CONTRIBUTION_KINDS = Object.freeze(['skills', 'agents', 'instructions', 'checks']);

/** Capabilities a bundle may request. A bundle that asks for nothing gets
 * nothing; there is no implicit grant. */
export const CAPABILITIES = Object.freeze(['read-workspace', 'read-knowledge', 'network', 'execute']);

export function resourcesRoot(copilotHome) {
  return path.join(copilotHome, RESOURCES_DIRNAME);
}

function fail(errors, message) {
  errors.push(message);
  return errors;
}

/**
 * Parse and validate one manifest.
 *
 * An invalid manifest is REPORTED and its bundle disabled, never silently
 * skipped — the same rule as a malformed config. A bundle whose author believes
 * it is contributing while it quietly does nothing is the worst outcome for
 * both sides.
 */
export function parseManifest(text, { source = '(inline)' } = {}) {
  const errors = [];
  let doc;
  try {
    doc = YAML.parse(text, { maxAliasCount: 50 });
  } catch (error) {
    return { manifest: null, errors: [`${source}: ${error.message}`] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { manifest: null, errors: [`${source}: expected a YAML mapping`] };
  }
  if (doc.schema !== MANIFEST_SCHEMA) fail(errors, `${source}: schema must be ${MANIFEST_SCHEMA}`);
  if (!doc.name || typeof doc.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(doc.name)) {
    fail(errors, `${source}: name must be a lowercase slug`);
  }
  if (!doc.version || typeof doc.version !== 'string') fail(errors, `${source}: version is required`);
  if (doc.priority !== undefined && !Number.isInteger(doc.priority)) {
    fail(errors, `${source}: priority must be an integer when present`);
  }

  const contributes = doc.contributes && typeof doc.contributes === 'object' && !Array.isArray(doc.contributes)
    ? doc.contributes
    : {};
  for (const kind of Object.keys(contributes)) {
    if (!CONTRIBUTION_KINDS.includes(kind)) {
      fail(errors, `${source}: unknown contribution kind ${kind} (one of ${CONTRIBUTION_KINDS.join(', ')})`);
      continue;
    }
    const list = contributes[kind];
    if (!Array.isArray(list)) {
      fail(errors, `${source}: contributes.${kind} must be a list of paths`);
      continue;
    }
    // A contributed path is a path INSIDE the bundle, and nothing else. A
    // manifest declaring `../../../etc/passwd` was previously accepted without
    // complaint — this is a third-party file describing what the harness should
    // load, which makes it the least trustworthy input in the system and the
    // one place a traversal must be refused rather than normalized away.
    for (const rel of list) {
      if (typeof rel !== 'string' || !rel) {
        fail(errors, `${source}: contributes.${kind} entries must be non-empty strings`);
        continue;
      }
      if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
        fail(errors, `${source}: contributes.${kind} entry must be relative to the bundle: ${rel}`);
        continue;
      }
      const normalized = path.normalize(rel).split(path.sep).join('/');
      if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        fail(errors, `${source}: contributes.${kind} entry escapes the bundle: ${rel}`);
      }
    }
  }
  const capabilities = Array.isArray(doc.capabilities) ? doc.capabilities : [];
  for (const cap of capabilities) {
    if (!CAPABILITIES.includes(cap)) {
      fail(errors, `${source}: unknown capability ${cap} (one of ${CAPABILITIES.join(', ')})`);
    }
  }

  if (errors.length) return { manifest: null, errors };
  return {
    manifest: {
      schema: doc.schema,
      name: doc.name,
      version: doc.version,
      description: typeof doc.description === 'string' ? doc.description : '',
      // Carried through, not merely validated: without this the documented
      // precedence rule ("an explicit priority outranks the name tie-break")
      // could never fire, because `resolvePrecedence` read a field the parser
      // had dropped.
      priority: Number.isInteger(doc.priority) ? doc.priority : 0,
      contributes,
      capabilities,
      // A plugin entry point is optional: a bundle may contribute only files.
      plugin: typeof doc.plugin === 'string' ? doc.plugin : null,
      integrity: typeof doc.integrity === 'string' ? doc.integrity : null,
    },
    errors: [],
  };
}

/**
 * Files that are OPERATOR STATE rather than bundle content, and so must not
 * participate in the integrity digest.
 *
 * `.enabled` is written by `resources enable`. Including it meant approving a
 * pinned bundle changed its digest and immediately marked it `tampered` — the
 * pin catching the operator's own approval instead of the tampering it exists
 * for. Found by the Phase 5 integrity test.
 */
const NON_CONTENT_FILES = new Set(['.enabled', '.disabled']);

/** The digest a bundle's integrity pin is checked against: every contributed
 * file's path and content, in a stable order. */
export function bundleDigest(dir) {
  const files = [];
  const walk = (current, rel = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile() && !NON_CONTENT_FILES.has(relative)) files.push([relative, full]);
      // F3 (Codex phase-5 review): a symlink is neither a directory nor a file
      // to `Dirent`, so it fell out of the digest entirely — the pin approved a
      // bundle without covering the one entry whose content is decided
      // elsewhere. It is HASHED AS A LINK, by its target string, so repointing
      // it breaks the pin. `bundle-sync` refuses to place one regardless; this
      // makes the integrity record honest about what is in the directory.
      else if (entry.isSymbolicLink()) files.push([relative, full, 'symlink']);
    }
  };
  walk(dir);
  const hash = crypto.createHash('sha256');
  for (const [rel, full, kind] of files) {
    hash.update(rel);
    hash.update('\0');
    if (kind === 'symlink') {
      hash.update('symlink\0');
      hash.update(fs.readlinkSync(full));
      continue;
    }
    if (rel === MANIFEST_FILE) {
      // The manifest IS covered, minus the `integrity:` line that states the
      // digest — excluding it entirely meant changing `plugin: safe.mjs` to
      // `plugin: ../../outside.mjs` left the pin matching. A pin that does not
      // authorize the file declaring what to load authorizes very little.
      hash.update(fs.readFileSync(full, 'utf8').split(/\r?\n/).filter((l) => !/^\s*integrity\s*:/.test(l)).join('\n'));
    } else {
      hash.update(fs.readFileSync(full));
    }
  }
  return `sha256-${hash.digest('hex')}`;
}

/**
 * Every bundle under the resources root, with its state and the reason for it.
 *
 * `trustedNames` defaults to EMPTY, not to "trust everything". Defaulting to
 * null-means-trusted made `discoverBundles(home)` report an unapproved bundle
 * as `enabled`, so any caller that forgot the argument silently bypassed
 * approval. A trust check whose default is open is not a trust check.
 *
 * It is keyed by DIRECTORY name, matching where the marker lives. Keying the
 * marker by directory and the check by MANIFEST name let a directory `grant`
 * whose manifest called itself `decoy` hand its approval to a different bundle
 * that called itself `grant` — bundle content transferring an operator's
 * approval to something else.
 *
 * `state` is one of `enabled`, `disabled`, `invalid`, `untrusted`, or
 * `tampered`. Each is reported rather than filtered away — a bundle a user
 * installed and cannot see is a support ticket; one shown greyed with a reason
 * is a fix they can make.
 */
export function discoverBundles(copilotHome, { trustedNames = new Set() } = {}) {
  const root = resourcesRoot(copilotHome);
  if (!fs.existsSync(root)) return [];
  const bundles = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => byteCompare(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      bundles.push({ dir, name: entry.name, manifest: null, state: 'invalid', reason: `no ${MANIFEST_FILE}`, errors: [] });
      continue;
    }
    const { manifest, errors } = parseManifest(fs.readFileSync(manifestPath, 'utf8'), { source: `${entry.name}/${MANIFEST_FILE}` });
    if (!manifest) {
      bundles.push({ dir, name: entry.name, manifest: null, state: 'invalid', reason: errors[0], errors });
      continue;
    }

    const disabled = fs.existsSync(path.join(dir, '.disabled'));
    let state = disabled ? 'disabled' : 'enabled';
    let reason = disabled ? 'disabled by the operator' : null;

    // P5AC3: a distributed bundle carries an integrity pin, and a mismatch is
    // `tampered` rather than a warning — the pin exists precisely so that
    // content changing under an approval is loud.
    const digest = bundleDigest(dir);
    if (manifest.integrity && manifest.integrity !== digest) {
      state = 'tampered';
      reason = `integrity pin does not match the bundle's contents (${manifest.integrity} vs ${digest})`;
    } else if (state === 'enabled' && !trustedNames.has(entry.name)) {
      state = 'untrusted';
      reason = 'not approved — run `harness resources enable` after reading what it contributes';
    }

    bundles.push({ dir, name: manifest.name, manifest, state, reason, errors: [], digest });
  }
  return bundles;
}

/**
 * Resolve which bundle wins each contributed path.
 *
 * PRECEDENCE: an explicit `priority` first (higher wins), then bundle name,
 * ascending. Name is a deterministic tie-break rather than install order or
 * directory-read order, both of which vary by filesystem and would make the
 * answer machine-dependent — the exact property `resources show` exists to make
 * inspectable.
 *
 * Losers are RETAINED per path, because the useful question is not "what won"
 * but "why did mine not".
 */
export function resolvePrecedence(bundles) {
  const enabled = bundles.filter((b) => b.state === 'enabled' && b.manifest);
  const ordered = [...enabled].sort((a, b) => (
    (b.manifest.priority ?? 0) - (a.manifest.priority ?? 0)
    || byteCompare(a.name, b.name)
  ));
  const byPath = new Map();
  for (const bundle of ordered) {
    for (const kind of CONTRIBUTION_KINDS) {
      for (const rel of bundle.manifest.contributes[kind] || []) {
        const key = `${kind}/${rel}`;
        if (!byPath.has(key)) byPath.set(key, { kind, path: rel, winner: bundle.name, shadowed: [] });
        else byPath.get(key).shadowed.push(bundle.name);
      }
    }
  }
  return [...byPath.values()].sort((a, b) => byteCompare(`${a.kind}/${a.path}`, `${b.kind}/${b.path}`));
}
