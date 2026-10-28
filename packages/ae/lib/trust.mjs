import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EXIT } from './style.mjs';
import { writeFileContained, readFileNoFollow, canonicalPath } from './fs-safe.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';
import { runtimeSetting } from '../corpus/hooks/lib/runtime-identity.mjs';
import { aeWorktreePrimary } from './worktree.mjs';

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
  const selected = runtimeSetting('HOME');
  if (selected) return path.resolve(selected);
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
    root = canonicalPath(path.resolve(workspace));
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
      const content = readFileNoFollow(full, { root: workspace, maxBytes: 1024 * 1024, encoding: null });
      if (content === null && !fs.existsSync(full)) throw new Error('absent');
      hash.update(content === null ? 'unreadable' : content);
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
    const doc = YAML.parse(readFileNoFollow(file, { maxBytes: 1024 * 1024 }) || 'null', { maxAliasCount: 50 });
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

function approvalState(record, workspace, store) {
  if (store.unreadable) return { state: 'untrusted', reason: 'the trust store could not be read, so nothing is trusted' };
  if (record?.status === 'revoked') return { state: 'revoked', reason: 'trust was explicitly revoked' };
  if (record?.status === 'trusted') {
    if (digestMatchesApproval(record.digest, workspace)) return { state: 'trusted', reason: `approved ${record.approvedAt}` };
    return { state: 'stale', reason: 'the policy files have changed since this project was approved' };
  }
  return { state: 'untrusted', reason: 'this project has never been approved' };
}

function projectApproval(store, identity) {
  const matches = Object.entries(store.projects).filter(([root]) => path.isAbsolute(root) && projectIdentity(root).root === identity.root);
  return matches.length === 1 ? matches[0][1] : null;
}

function setProjectApproval(store, identity, record) {
  for (const root of Object.keys(store.projects)) {
    if (path.isAbsolute(root) && projectIdentity(root).root === identity.root) delete store.projects[root];
  }
  store.projects[identity.root] = record;
}

export function trustStatus({ workspace, copilotHome, home }) {
  const identity = projectIdentity(workspace);
  const store = readStore({ copilotHome, home });
  const record = projectApproval(store, identity);
  const digest = policyDigest(workspace);
  const own = approvalState(record, workspace, store);
  let state = own.state;
  let reason = own.reason;
  let inherited = false;
  let inheritedFrom = null;
  let approvedAt = record?.approvedAt ?? null;
  let approvedDigest = record?.digest ?? null;
  const ownDecides = store.unreadable || record?.status === 'revoked' || record?.status === 'trusted';
  if (!ownDecides) {
    const primary = aeWorktreePrimary(workspace);
    if (primary) {
      const primaryIdentity = projectIdentity(primary);
      const primaryRecord = projectApproval(store, primaryIdentity);
      inheritedFrom = primaryIdentity.root;
      if (approvalState(primaryRecord, primary, store).state === 'trusted' && digestMatchesApproval(primaryRecord.digest, workspace)) {
        state = 'trusted';
        inherited = true;
        reason = `inherited from trusted primary ${primaryIdentity.root}`;
        approvedAt = primaryRecord.approvedAt ?? null;
        approvedDigest = primaryRecord.digest ?? null;
      } else if (primaryRecord?.status === 'revoked') {
        reason = `inherited trust removed because primary ${primaryIdentity.root} was revoked`;
      } else if (primaryRecord?.status === 'trusted') {
        state = 'stale';
        reason = `ae worktree of ${primaryIdentity.root}, but the primary or worktree policy files differ from that approval`;
      }
    }
  }

  return {
    schema: 1,
    project: identity.root,
    id: identity.id,
    state,
    trusted: state === 'trusted',
    inherited,
    inheritedFrom,
    reason,
    digest,
    approvedAt,
    approvedDigest,
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
  setProjectApproval(store, identity, { status: 'trusted', approvedAt: now, digest });
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
  setProjectApproval(store, identity, { status: 'revoked', revokedAt: now });
  writeStore({ copilotHome, home }, store);
  return trustStatus({ workspace, copilotHome, home });
}

export function trustError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_DENIED', exit: EXIT.needsApproval, hint });
}
