import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EXIT } from './style.mjs';
import { writeFileContained } from './fs-safe.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';

export const TRUST_SCHEMA_VERSION = 1;

export const PINNED_FILES = Object.freeze([
  path.join('.github', 'harness', 'config.yaml'),
  path.join('.github', 'harness', 'policy.yaml'),
  path.join('.github', 'harness', 'checks.yaml'),
  path.join('.github', 'harness', 'routing.yaml'),
]);

/** Pins hashed before routing.yaml joined the list. */
export const LEGACY_PINNED_FILES = Object.freeze(PINNED_FILES.filter((rel) => !rel.endsWith(`${path.sep}routing.yaml`)));

export const TRUST_STATES = Object.freeze(['trusted', 'untrusted', 'stale', 'revoked']);

function trustRoot({ home, copilotHome } = {}) {
  if (home) return path.resolve(home);
  if (process.env.HARNESS_HOME) return path.resolve(process.env.HARNESS_HOME);
  if (copilotHome) {
    const given = path.resolve(copilotHome);
    const usual = path.resolve(resolveCopilotHome(undefined));
    if (given !== usual) return given;
  }
  return harnessGlobalHome();
}

/** User-scope approval file. A string argument is a copilot or fixture home. */
export function trustStorePath(homeOrCopilot) {
  if (typeof homeOrCopilot === 'string') return path.join(trustRoot({ copilotHome: homeOrCopilot }), 'trust.yaml');
  return path.join(trustRoot(homeOrCopilot || {}), 'trust.yaml');
}

export function legacyTrustStorePath(copilotHome) {
  return path.join(path.resolve(copilotHome || resolveCopilotHome(undefined)), 'harness', 'trust.yaml');
}

export function projectIdentity(workspace) {
  let root;
  try {
    root = fs.realpathSync(path.resolve(workspace));
  } catch {
    root = path.resolve(workspace);
  }
  return { root, id: crypto.createHash('sha256').update(root).digest('hex').slice(0, 16) };
}

export function policyDigest(workspace, files = PINNED_FILES) {
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    const full = path.join(workspace, rel);
    hash.update(rel);
    try {
      hash.update('\0present\0');
      hash.update(fs.readFileSync(full));
    } catch {
      hash.update('\0absent\0');
    }
  }
  return hash.digest('hex');
}

function routingFilePresent(workspace) {
  return fs.existsSync(path.join(workspace, '.github', 'harness', 'routing.yaml'));
}

/** Current digest, or the pre-routing digest when that file is still absent. */
export function digestMatchesApproval(recordDigest, workspace) {
  if (!recordDigest) return false;
  if (recordDigest === policyDigest(workspace)) return true;
  if (!routingFilePresent(workspace) && recordDigest === policyDigest(workspace, LEGACY_PINNED_FILES)) return true;
  return false;
}

function parseStoreFile(file) {
  try {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'), { maxAliasCount: 50 });
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { version: TRUST_SCHEMA_VERSION, projects: {}, unreadable: true };
    }
    const projects = doc.projects;
    if (projects === undefined || projects === null || typeof projects !== 'object' || Array.isArray(projects)) {
      return { version: TRUST_SCHEMA_VERSION, projects: {}, unreadable: true };
    }
    return { version: doc.version || TRUST_SCHEMA_VERSION, projects };
  } catch {
    return { version: TRUST_SCHEMA_VERSION, projects: {}, unreadable: true };
  }
}

function readStore({ copilotHome, home } = {}) {
  const file = trustStorePath({ copilotHome, home });
  if (fs.existsSync(file)) return parseStoreFile(file);
  const legacy = legacyTrustStorePath(copilotHome || resolveCopilotHome(undefined));
  if (path.resolve(legacy) === path.resolve(file) || !fs.existsSync(legacy)) {
    return { version: TRUST_SCHEMA_VERSION, projects: {} };
  }
  const parsed = parseStoreFile(legacy);
  if (parsed.unreadable) return parsed;
  try {
    writeStore({ copilotHome, home }, parsed);
  } catch {
    return parsed;
  }
  return parsed;
}

function writeStore({ copilotHome, home } = {}, store) {
  const root = trustRoot({ home, copilotHome });
  const written = writeFileContained(root, 'trust.yaml', YAML.stringify(store));
  if (!written) {
    throw Object.assign(new Error(`could not write the trust store at ${path.join(root, 'trust.yaml')}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'the path is not writable, or an ancestor is a symlink out of the home directory',
    });
  }
  return written;
}

export function trustStatus({ workspace, copilotHome, home }) {
  const identity = projectIdentity(workspace);
  const store = readStore({ copilotHome, home });
  const record = store.projects[identity.root] || null;
  const digest = policyDigest(workspace);

  let state = 'untrusted';
  let reason = 'this project has never been approved';
  if (store.unreadable) {
    reason = 'the trust store could not be read, so nothing is trusted';
  } else if (record?.status === 'revoked') {
    state = 'revoked';
    reason = 'trust was explicitly revoked';
  } else if (record?.status === 'trusted') {
    if (digestMatchesApproval(record.digest, workspace)) {
      state = 'trusted';
      reason = `approved ${record.approvedAt}`;
    } else {
      state = 'stale';
      reason = 'the policy files have changed since this project was approved';
    }
  }

  return {
    schema: 1,
    project: identity.root,
    id: identity.id,
    state,
    trusted: state === 'trusted',
    reason,
    digest,
    approvedAt: record?.approvedAt ?? null,
    approvedDigest: record?.digest ?? null,
    pinned: [...PINNED_FILES],
    store: trustStorePath({ copilotHome, home }),
  };
}

/** Whether project-authored policy and configuration may take effect here. */
export function isProjectTrusted({ workspace, copilotHome, home }) {
  return trustStatus({ workspace, copilotHome, home }).trusted;
}

export function approveProject({ workspace, copilotHome, home, now = new Date().toISOString() }) {
  const identity = projectIdentity(workspace);
  const store = readStore({ copilotHome, home });
  if (store.unreadable) {
    throw Object.assign(new Error('refusing to write over an unreadable trust store'), {
      code: 'E_TARGET',
      exit: 1,
      hint: `inspect ${trustStorePath({ copilotHome, home })} by hand — overwriting it would silently discard every approval it holds`,
    });
  }
  const digest = policyDigest(workspace);
  store.version = TRUST_SCHEMA_VERSION;
  store.projects[identity.root] = { status: 'trusted', approvedAt: now, digest };
  writeStore({ copilotHome, home }, store);
  return trustStatus({ workspace, copilotHome, home });
}

export function revokeProject({ workspace, copilotHome, home, now = new Date().toISOString() }) {
  const identity = projectIdentity(workspace);
  const store = readStore({ copilotHome, home });
  if (store.unreadable) {
    throw Object.assign(new Error('refusing to write over an unreadable trust store'), {
      code: 'E_TARGET',
      exit: 1,
      hint: `inspect ${trustStorePath({ copilotHome, home })} by hand`,
    });
  }
  store.version = TRUST_SCHEMA_VERSION;
  store.projects[identity.root] = { status: 'revoked', revokedAt: now };
  writeStore({ copilotHome, home }, store);
  return trustStatus({ workspace, copilotHome, home });
}

export function trustError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_DENIED', exit: EXIT.needsApproval, hint });
}
