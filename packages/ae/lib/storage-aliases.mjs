import fs from 'node:fs';
import path from 'node:path';
import { harnessGlobalHome } from './paths.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContainedExclusive } from './fs-safe.mjs';

const LOCAL_ID = /^local-[0-9a-f]{12}$/;
const REPO_ID = /^[a-z0-9][a-z0-9.-]{0,255}$/;
const REMOTE_ID = /^[a-z0-9][a-z0-9.-]*-[0-9a-f]{8}$/;

export function validStorageSourceId(id) {
  return typeof id === 'string' && id.length <= 256 && (LOCAL_ID.test(id) || REMOTE_ID.test(id));
}

function failure(message) {
  return Object.assign(new Error(message), { code: 'E_STORAGE_ALIAS', exit: 1 });
}

function safePath(home, rel) {
  const full = assertNoSymlinkAncestors(home, rel);
  if (!full) throw failure(`storage alias path is symlinked or outside the Harness home: ${rel}`);
  return full;
}

function aliasPath(id) {
  if (!REPO_ID.test(id)) throw failure('invalid repository storage ID');
  return path.join('storage-aliases', `${id}.json`);
}

function readAlias(id, home) {
  const full = safePath(home, aliasPath(id));
  if (!fs.lstatSync(full, { throwIfNoEntry: false })) return null;
  const text = readFileNoFollow(full, { root: home, maxBytes: 2048 });
  let alias;
  try { alias = JSON.parse(text); } catch { /* rejected below */ }
  if (!alias || ![1, 2].includes(alias.schema) || alias.repoId !== id
      || !(alias.schema === 1 ? LOCAL_ID.test(alias.storageId) : validStorageSourceId(alias.storageId)) || alias.storageId === id) {
    throw failure(`invalid or unreadable storage alias: ${full}`);
  }
  return alias.storageId;
}

function savedFile(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return true;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '.lock' || entry.name === '.quarantine') continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) return true;
      if (entry.name === 'store.json' || entry.name === '.gitignore') continue;
      if (entry.name === 'INDEX.md') {
        if (fs.readFileSync(full, 'utf8').includes('\n- [')) return true;
        continue;
      }
      if (entry.name === 'consolidated.jsonl' || entry.name === 'governance.jsonl') {
        if (fs.readFileSync(full, 'utf8').trim()) return true;
        continue;
      }
      return true;
    }
  }
  return false;
}

function hasData(id, home) {
  if (!REPO_ID.test(id)) throw failure('invalid repository storage ID');
  return ['knowledge', 'projects'].map((namespace) => {
    const full = safePath(home, path.join(namespace, id));
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(`storage path is not a directory: ${full}`);
    return savedFile(full);
  }).some(Boolean);
}

function refuseCanonicalData(id, home) {
  if (hasData(id, home)) throw failure(`canonical storage ${id} is non-empty; refusing to hide or overwrite saved records`);
}

export function storageIdForRepo(id, { home = harnessGlobalHome(), legacyIds = [] } = {}) {
  home ||= harnessGlobalHome();
  const recorded = readAlias(id, home);
  if (recorded) {
    refuseCanonicalData(id, home);
    hasData(recorded, home);
    return recorded;
  }
  const candidates = [...new Set(legacyIds)].filter((candidate) => candidate !== id && LOCAL_ID.test(candidate) && hasData(candidate, home));
  if (!candidates.length || hasData(id, home) || candidates.length !== 1) return id;
  return candidates[0];
}

export function adoptStorageAlias(id, storageId, { home = harnessGlobalHome(), dryRun = false } = {}) {
  home ||= harnessGlobalHome();
  if (!validStorageSourceId(storageId) || storageId === id) throw failure('source must be a different local-<12 hex digits> or canonical remote storage ID');
  if (readAlias(storageId, home)) throw failure('source is itself an alias; select its physical storage ID');
  const existing = readAlias(id, home);
  if (existing && existing !== storageId) throw failure(`repository already uses storage ${existing}; refusing to replace its binding`);
  refuseCanonicalData(id, home);
  if (!hasData(storageId, home)) throw failure(`no saved knowledge or project files found for ${storageId}`);
  if (existing) return { storageId, unchanged: true };
  if (dryRun) return { storageId, unchanged: false, dryRun: true };
  const rel = aliasPath(id);
  const schema = LOCAL_ID.test(storageId) ? 1 : 2;
  const written = writeFileContainedExclusive(home, rel, JSON.stringify({ schema, repoId: id, storageId }) + '\n');
  if (!written && readAlias(id, home) !== storageId) throw failure('storage binding publication failed or conflicted');
  try {
    refuseCanonicalData(id, home);
  } catch (error) {
    if (written) fs.unlinkSync(written);
    throw error;
  }
  return { storageId, unchanged: !written };
}
