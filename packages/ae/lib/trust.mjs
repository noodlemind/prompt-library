import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EXIT } from './style.mjs';
import { writeFileContained, readFileNoFollow, canonicalPath, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';
import { runtimeSetting } from '../corpus/hooks/lib/runtime-identity.mjs';
import { aeWorktreePrimary } from './worktree.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';

import { resolveProjectAuthority } from './project-authority.mjs';

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

export function policyDigest(workspace, files = PINNED_FILES, options) {
  const hash = crypto.createHash('sha256');
  let root, authority;
  try {
    root = canonicalPath(path.resolve(workspace));
    authority = resolveProjectAuthority(root, options);
  } catch { return null; }
  // Preserve existing shared approvals; local authority has a distinct identity.
  if (authority.mode === 'local') hash.update(`local-authority-v1\0${authority.directory}\0`);
  for (const rel of files) {
    const full = path.join(authority.directory, path.basename(rel));
    hash.update(rel);
    try {
      if (!assertNoSymlinkAncestors(authority.root, path.relative(authority.root, full))) return null;
      hash.update('\0present\0');
      const stat = fs.lstatSync(full, { throwIfNoEntry: false });
      if (!stat) { hash.update('\0absent\0'); continue; }
      const content = readFileNoFollow(full, { root: authority.root, maxBytes: 1024 * 1024, encoding: null });
      if (content === null) return null;
      hash.update(content);
    } catch { return null; }
  }
  return hash.digest('hex');
}

function routingFilePresent(workspace, options) {
  try { return Boolean(fs.lstatSync(resolveProjectAuthority(workspace, options).files['routing.yaml'], { throwIfNoEntry: false })); }
  catch { return true; }
}

/** Current digest, or the pre-routing digest when that file is still absent. */
export function digestMatchesApproval(recordDigest, workspace, options) {
  if (!recordDigest) return false;
  const current = policyDigest(workspace, PINNED_FILES, options);
  if (!current) return false;
  if (recordDigest === current) return true;
  if (!routingFilePresent(workspace, options) && recordDigest === policyDigest(workspace, LEGACY_PINNED_FILES, options)) return true;
  return false;
}

function parseStoreFile(file, root) {
  try {
    if (!assertNoSymlinkAncestors(root, path.relative(root, file))) throw new Error('unsafe trust store');
    const doc = YAML.parse(readFileNoFollow(file, { root, maxBytes: 1024 * 1024 }) || 'null', { maxAliasCount: 50 });
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

function withTrustStoreLock(options, action) {
  const root = trustRoot(options);
  if (!assertNoSymlinkAncestors(root, 'trust.yaml')) throw Object.assign(new Error('trust store path is unsafe or symlinked'), { code: 'E_TARGET', exit: 1 });
  fs.mkdirSync(root, { recursive: true });
  return withPlanUpdateLock(path.join(root, 'trust.yaml'), action);
}

function readStore({ copilotHome, home } = {}, { locked = false, migrate = true } = {}) {
  const file = trustStorePath({ copilotHome, home });
  try {
    const root = trustRoot({ copilotHome, home });
    if (!assertNoSymlinkAncestors(root, 'trust.yaml')) throw new Error('unsafe trust store');
    if (fs.lstatSync(file, { throwIfNoEntry: false })) return parseStoreFile(file, root);
    const legacyRoot = path.resolve(copilotHome || resolveCopilotHome(undefined));
    const legacy = legacyTrustStorePath(legacyRoot);
    if (path.resolve(legacy) === path.resolve(file)) return { version: TRUST_SCHEMA_VERSION, projects: {} };
    if (!assertNoSymlinkAncestors(legacyRoot, path.relative(legacyRoot, legacy))) throw new Error('unsafe legacy trust store');
    if (!fs.lstatSync(legacy, { throwIfNoEntry: false })) return { version: TRUST_SCHEMA_VERSION, projects: {} };
    if (!locked && migrate) return withTrustStoreLock({ copilotHome, home }, () => readStore({ copilotHome, home }, { locked: true }));
    const parsed = parseStoreFile(legacy, legacyRoot);
    if (parsed.unreadable || !migrate) return parsed;
    writeStore({ copilotHome, home }, parsed);
    return parsed;
  } catch {
    return { version: TRUST_SCHEMA_VERSION, projects: {}, unreadable: true };
  }
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

function approvalState(record, workspace, store, options) {
  if (store.unreadable) return { state: 'untrusted', reason: 'the trust store could not be read, so nothing is trusted' };
  if (record?.status === 'conflict') return { state: 'untrusted', reason: 'conflicting approvals for this project require a new approval' };
  if (record?.status === 'revoked') return { state: 'revoked', reason: 'trust was explicitly revoked' };
  if (policyDigest(workspace, PINNED_FILES, options) === null) return { state: 'untrusted', reason: 'a pinned policy source is unreadable, unsafe, nonregular or larger than 1 MiB' };
  if (record?.status === 'trusted') {
    if (digestMatchesApproval(record.digest, workspace, options)) return { state: 'trusted', reason: `approved ${record.approvedAt}` };
    return { state: 'stale', reason: 'the policy files have changed since this project was approved' };
  }
  return { state: 'untrusted', reason: 'this project has never been approved' };
}

function approvalMatches(root, identity) {
  const anchor = path.parse(root).root;
  return path.isAbsolute(root) && assertNoSymlinkAncestors(anchor, path.relative(anchor, root)) && projectIdentity(root).root === identity.root;
}

function projectApproval(store, identity) {
  const matches = Object.entries(store.projects).filter(([root]) => approvalMatches(root, identity));
  if (matches.length > 1) return { status: 'conflict' };
  return matches[0]?.[1] ?? null;
}

function setProjectApproval(store, identity, record) {
  for (const root of Object.keys(store.projects)) {
    if (approvalMatches(root, identity)) delete store.projects[root];
  }
  store.projects[identity.root] = record;
}

export function trustStatus({ workspace, copilotHome, home }) {
  const identity = projectIdentity(workspace);
  const store = readStore({ copilotHome, home });
  const record = projectApproval(store, identity);
  const digest = policyDigest(workspace, PINNED_FILES, { home: home || harnessGlobalHome() });
  const authorityOptions = { home: home || harnessGlobalHome() };
  const own = approvalState(record, workspace, store, authorityOptions);
  let state = own.state;
  let reason = own.reason;
  let inherited = false;
  let inheritedFrom = null;
  let approvedAt = record?.approvedAt ?? null;
  let approvedDigest = record?.digest ?? null;
  const ownDecides = store.unreadable || digest === null || record?.status === 'revoked' || record?.status === 'trusted' || record?.status === 'conflict';
  if (!ownDecides) {
    const primary = aeWorktreePrimary(workspace);
    if (primary) {
      const primaryIdentity = projectIdentity(primary);
      const primaryRecord = projectApproval(store, primaryIdentity);
      inheritedFrom = primaryIdentity.root;
      if (approvalState(primaryRecord, primary, store, authorityOptions).state === 'trusted' && digestMatchesApproval(primaryRecord.digest, workspace, authorityOptions)) {
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
    pinned: (() => { try { return Object.values(resolveProjectAuthority(workspace, authorityOptions).files); } catch { return [...PINNED_FILES]; } })(),
    authority: (() => { try { const selected = resolveProjectAuthority(workspace, authorityOptions); return { mode: selected.mode, directory: selected.directory }; } catch (error) { return { mode: 'unavailable', error: error.message }; } })(),
    store: trustStorePath({ copilotHome, home }),
  };
}

/** Whether project-authored policy and configuration may take effect here. */
export function isProjectTrusted({ workspace, copilotHome, home }) {
  return trustStatus({ workspace, copilotHome, home }).trusted;
}

export function approveProject({ workspace, copilotHome, home, now = new Date().toISOString() }) {
  return withTrustStoreLock({ copilotHome, home }, () => {
    const identity = projectIdentity(workspace);
    const store = readStore({ copilotHome, home }, { locked: true, migrate: false });
    if (store.unreadable) {
      throw Object.assign(new Error('refusing to write over an unreadable trust store'), {
        code: 'E_TARGET',
        exit: 1,
        hint: `inspect ${trustStorePath({ copilotHome, home })} by hand — overwriting it would silently discard every approval it holds`,
      });
    }
    const digest = policyDigest(workspace, PINNED_FILES, { home: home || harnessGlobalHome() });
    if (!digest) throw Object.assign(new Error('refusing to approve unreadable, unsafe, nonregular or oversized pinned policy sources'), { code: 'E_TARGET', exit: 1, hint: 'inspect the pinned files and restore bounded regular sources inside the project before approving' });
    store.version = TRUST_SCHEMA_VERSION;
    setProjectApproval(store, identity, { status: 'trusted', approvedAt: now, digest });
    writeStore({ copilotHome, home }, store);
    return trustStatus({ workspace, copilotHome, home });
  });
}

export function revokeProject({ workspace, copilotHome, home, now = new Date().toISOString() }) {
  return withTrustStoreLock({ copilotHome, home }, () => {
    const identity = projectIdentity(workspace);
    const store = readStore({ copilotHome, home }, { locked: true, migrate: false });
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
  });
}

export function trustError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_DENIED', exit: EXIT.needsApproval, hint });
}
