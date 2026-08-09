/**
 * Project trust — whether this workspace's own files are allowed to change how
 * the harness behaves.
 *
 * THE TRUST RECORD LIVES IN THE USER SCOPE, never in the workspace. A project
 * that could ship its own approval would be self-certifying, which is the
 * entire vulnerability: cloning a repository would grant it the authority it
 * claims for itself. `<copilotHome>/harness/trust.yaml` is a record of
 * decisions the person at this machine made, and nothing inside a repository
 * can write to it.
 *
 * TRUST IS PINNED TO CONTENT, not only to a path. Approving a directory once
 * and trusting it forever means a `git pull` can change the policy files under
 * an approval nobody re-examined — the same repository, the same path, new
 * authority. Approval therefore records a digest of the policy-bearing files,
 * and a change makes the trust STALE rather than silently continuing. Stale is
 * a third state on purpose: "you approved this project, and the thing you
 * approved has changed" is different information from "you never approved it",
 * and collapsing them would either nag about untouched projects or wave through
 * edited ones.
 *
 * WHAT TRUST GATES, in this phase: project `config.yaml` and project
 * `policy.yaml` — the two files that change harness behavior without executing
 * anything. Both fail SAFE when untrusted: configuration falls back to the user
 * and default scopes, and policy falls back to built-in enforcement, so an
 * untrusted project gets the stricter treatment rather than the looser one.
 *
 * WHAT IT DOES NOT GATE YET: executing the repo-authored argv in `checks.yaml`.
 * That is the larger hole and it is deliberately left to P3.5, where the
 * enforcement-class model arrives — gating execution needs a way to express the
 * CI case (an unattended runner cannot answer an approval prompt), and bolting
 * a bypass onto trust before that vocabulary exists would produce exactly the
 * escape hatch that makes the whole gate decorative. Recorded here rather than
 * left to be discovered.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EXIT } from './style.mjs';
import { writeFileContained } from './fs-safe.mjs';

export const TRUST_SCHEMA_VERSION = 1;

/** The files whose content an approval pins. Each one can change how the
 * harness behaves; a change to any of them is a change to what was approved. */
export const PINNED_FILES = Object.freeze([
  path.join('.github', 'harness', 'config.yaml'),
  path.join('.github', 'harness', 'policy.yaml'),
]);

export const TRUST_STATES = Object.freeze(['trusted', 'untrusted', 'stale', 'revoked']);

export function trustStorePath(copilotHome) {
  return path.join(copilotHome, 'harness', 'trust.yaml');
}

/**
 * A project's stable identity.
 *
 * The realpath, not the spelling: two paths that resolve to the same directory
 * are the same project, and a symlink is not a second identity to approve.
 */
export function projectIdentity(workspace) {
  let root;
  try {
    root = fs.realpathSync(path.resolve(workspace));
  } catch {
    root = path.resolve(workspace);
  }
  return { root, id: crypto.createHash('sha256').update(root).digest('hex').slice(0, 16) };
}

/**
 * A digest over the pinned files' CONTENT.
 *
 * Absent files are hashed as an explicit absence rather than skipped, so that
 * ADDING a policy file to an approved project invalidates the approval. A repo
 * that gains a `policy.yaml` after approval has gained authority it did not
 * have when someone looked at it, and skipping absent files would let exactly
 * that through.
 */
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
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { version: TRUST_SCHEMA_VERSION, projects: {} };
    return { version: doc.version || TRUST_SCHEMA_VERSION, projects: doc.projects && typeof doc.projects === 'object' ? doc.projects : {} };
  } catch {
    // An unreadable trust store denies rather than grants. The alternative —
    // treating a corrupt file as "no record, so proceed" — turns damaging the
    // file into a way to bypass every approval it held.
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

/**
 * This project's trust state, with everything needed to explain it.
 *
 * `trusted` is the ONLY state that grants anything — `stale` deliberately does
 * not, because the point of pinning is that changed policy files get looked at
 * again.
 */
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
  // Recorded as revoked rather than deleted: an absent record means "never
  // decided", and a person who revoked deliberately should not have that read
  // back later as an omission.
  store.version = TRUST_SCHEMA_VERSION;
  store.projects[identity.root] = { status: 'revoked', revokedAt: now };
  writeStore(copilotHome, store);
  return trustStatus({ workspace, copilotHome });
}

export function trustError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_DENIED', exit: EXIT.needsApproval, hint });
}
