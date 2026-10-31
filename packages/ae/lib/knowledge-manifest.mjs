import fs from 'node:fs';
import path from 'node:path';
import { resolveIndexDir } from './recall-config.mjs';
import { repoId } from './knowledge/store.mjs';
import { readFileNoFollow, DEFAULT_MAX_BYTES } from './fs-safe.mjs';
import { manifestFingerprint } from './postings-index.mjs';

export const PROJECT_MANIFEST_FILE = 'manifest.json';
const HASH = /^[a-f0-9]{64}$/;
// Native indexes always declare scope. Unscoped legacy rows in the shared
// global manifest remain global notes; declared product scopes require identity.
const privateEntry = entry => typeof entry?.scope === 'string' && entry.scope !== 'global';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function manifestCorpusContent(entries) {
  const rows = entries.map(canonical);
  rows.sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return JSON.stringify(rows);
}

export function projectManifestContent(repository, updated, entries) {
  return JSON.stringify({ version: 1, repository, updated, entries: entries.filter(privateEntry) }) + '\n';
}

function readSnapshot(indexDir, repository) {
  const file = path.join(indexDir, PROJECT_MANIFEST_FILE);
  const exists = Boolean(fs.lstatSync(file, { throwIfNoEntry: false }));
  let meta = null;
  try { meta = JSON.parse(readFileNoFollow(path.join(indexDir, 'meta.json'), { root: indexDir }) || 'null'); } catch {}
  if (!exists && !meta?.manifestSnapshotSha256) return null;
  const fail = reason => { throw new Error(`project knowledge manifest snapshot ${reason}; run ae index in this repository`); };
  const content = exists ? readFileNoFollow(file, { root: indexDir, maxBytes: DEFAULT_MAX_BYTES }) : null;
  if (content === null) fail('is missing, unsafe or unreadable');
  if (!HASH.test(meta?.manifestSnapshotSha256 || '') || manifestFingerprint(content) !== meta.manifestSnapshotSha256) fail('does not match its index binding');
  let snapshot;
  try { snapshot = JSON.parse(content); } catch { fail('contains invalid JSON'); }
  if (!snapshot || snapshot.version !== 1 || snapshot.repository !== repository || !Array.isArray(snapshot.entries)
    || Object.keys(snapshot).some(key => !['version', 'repository', 'updated', 'entries'].includes(key))
    || snapshot.entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || !privateEntry(entry))) fail('has invalid fields or another repository identity');
  return { ...snapshot, path: file };
}

/** The shared manifest contributes global notes; private rows belong to one project. */
export function selectProjectManifest({ workspace, copilotHome, home, shared }) {
  const repository = repoId(workspace);
  const indexDir = resolveIndexDir(copilotHome, workspace, home);
  let snapshot;
  try { snapshot = readSnapshot(indexDir, repository); }
  catch (error) {
    return { entries: [], path: path.join(indexDir, PROJECT_MANIFEST_FILE), updated: shared.updated, error: error.message };
  }
  const all = Array.isArray(shared.entries) ? shared.entries : [];
  const global = all.filter(entry => !privateEntry(entry));
  const ownManifest = shared.repository === repository || !shared.repository && shared.workspaceBound;
  const selectedPrivate = snapshot ? snapshot.entries : ownManifest ? all.filter(privateEntry) : [];
  const omitted = !snapshot && !ownManifest ? all.filter(privateEntry).length : 0;
  const entries = [...global, ...selectedPrivate];
  return {
    ...shared,
    entries,
    path: shared.path || snapshot?.path || null,
    updated: shared.updated || snapshot?.updated || null,
    sha256: manifestFingerprint(manifestCorpusContent(entries)),
    ...(snapshot ? { projectSnapshot: snapshot.path } : {}),
    ...(omitted ? { warnings: [`${omitted} private knowledge row(s) omitted because the shared manifest is foreign or lacks repository identity; run ae index in this repository`] } : {}),
  };
}
