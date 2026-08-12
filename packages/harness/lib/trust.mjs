import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EXIT } from './style.mjs';
import { writeFileContained } from './fs-safe.mjs';

export const TRUST_SCHEMA_VERSION = 1;

export const PINNED_FILES = Object.freeze([
  path.join('.github', 'harness', 'config.yaml'),
  path.join('.github', 'harness', 'policy.yaml'),
  path.join('.github', 'harness', 'checks.yaml'),
]);

export const TRUST_STATES = Object.freeze(['trusted', 'untrusted', 'stale', 'revoked']);

export function trustStorePath(copilotHome) {
  return path.join(copilotHome, 'harness', 'trust.yaml');
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

export function policyDigest(workspace) {
  const hash = crypto.createHash('sha256');
  for (const rel of PINNED_FILES) {
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

function readStore(copilotHome) {
  const file = trustStorePath(copilotHome);
  if (!fs.existsSync(file)) return { version: TRUST_SCHEMA_VERSION, projects: {} };
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

function writeStore(copilotHome, store) {
  const file = trustStorePath(copilotHome);
  const written = writeFileContained(copilotHome, path.relative(copilotHome, file), YAML.stringify(store));
  if (!written) {
    throw Object.assign(new Error(`could not write the trust store at ${file}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'the path is not writable, or an ancestor is a symlink out of the home directory',
    });
  }
  return written;
}

export function trustStatus({ workspace, copilotHome }) {
  const identity = projectIdentity(workspace);
  const store = readStore(copilotHome);
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
    if (record.digest === digest) {
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
    store: trustStorePath(copilotHome),
  };
}

/** Whether project-authored policy and configuration may take effect here. */
export function isProjectTrusted({ workspace, copilotHome }) {
  return trustStatus({ workspace, copilotHome }).trusted;
}

export function approveProject({ workspace, copilotHome, now = new Date().toISOString() }) {
  const identity = projectIdentity(workspace);
  const store = readStore(copilotHome);
  if (store.unreadable) {
    throw Object.assign(new Error('refusing to write over an unreadable trust store'), {
      code: 'E_TARGET',
      exit: 1,
      hint: `inspect ${trustStorePath(copilotHome)} by hand — overwriting it would silently discard every approval it holds`,
    });
  }
  const digest = policyDigest(workspace);
  store.version = TRUST_SCHEMA_VERSION;
  store.projects[identity.root] = { status: 'trusted', approvedAt: now, digest };
  writeStore(copilotHome, store);
  return trustStatus({ workspace, copilotHome });
}

export function revokeProject({ workspace, copilotHome, now = new Date().toISOString() }) {
  const identity = projectIdentity(workspace);
  const store = readStore(copilotHome);
  if (store.unreadable) {
    throw Object.assign(new Error('refusing to write over an unreadable trust store'), {
      code: 'E_TARGET',
      exit: 1,
      hint: `inspect ${trustStorePath(copilotHome)} by hand`,
    });
  }
    store.version = TRUST_SCHEMA_VERSION;
  store.projects[identity.root] = { status: 'revoked', revokedAt: now };
  writeStore(copilotHome, store);
  return trustStatus({ workspace, copilotHome });
}

export function trustError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_DENIED', exit: EXIT.needsApproval, hint });
}
