import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  readFileNoFollow,
  writeFileContained,
  appendFileContained,
  assertNoSymlinkAncestors,
  assertRealpathContained,
} from '../fs-safe.mjs';

/**
 * THE ONE CHOKE POINT FOR STORE-FILE I/O (S1/R1).
 *
 * Everything the knowledge store owns lives in ONE directory a human writes
 * to, so every file in it is equally symlink-plantable: anyone who can write
 * into `<store>/` can replace ANY of them with a symlink and, unless every
 * reader and writer refuses to follow it, make the CLI read an arbitrary
 * outside file into store history / a workspace mirror, or overwrite (or
 * truncate) an arbitrary outside file.
 *
 * Round after round of review fixed this ONE CALL SITE AT A TIME. Round 5
 * finally made LEARNING files structurally safe by routing every read, write
 * and delete of one through this module — but it drew the boundary at
 * "learning files" and scoped store METADATA out as "a separate class". It is
 * not a separate class, by that same round's own reasoning: it converted
 * `<store>/.gitignore` on the grounds that "the store root is a directory a
 * human writes to, so it is as symlink-plantable as any learning path". Every
 * metadata file sits in that same directory, and the survivors were live:
 * `ln -sf ~/.zshrc <store>/INDEX.md` plus any `harness learning retire` (which
 * runs rebuildIndex) truncated and replaced `~/.zshrc`, while `ensureStore`'s
 * `fs.existsSync` followed the link and never noticed.
 *
 * This module removes the whole class. Every read, write, append, delete and
 * existence check of a STORE-OWNED file — learning, index, ledger, governance
 * ledger, config, schema marker, stale report, bucket metadata, the lock owner
 * stamp, the transaction journal — goes through the functions below; `fs` is
 * not used on a store-owned path anywhere else in lib/knowledge/. A symlink
 * planted at ANY store FILE path is therefore INERT:
 *   - never read through          (readStoreFile → readFileNoFollow)
 *   - never written through       (writeStoreFile quarantines the link first)
 *   - never appended through      (appendStoreFile → O_NOFOLLOW append)
 *   - never deleted through       (removeStoreFile → assertRealpathContained)
 *   - never existsSync-trusted    (storeFileState reports 'symlink', not 'file')
 *   - never listed as a learning  (listLearnings skips a null read)
 * and the planted link ITSELF is moved into `<store>/.quarantine/` rather than
 * left live for the next reader to trip over — leaving it in place is exactly
 * what let an earlier "refused in absorb" fix still end in a truncated
 * `~/.zshrc`.
 *
 * FILE LEAVES ARE ONLY HALF THE STORE. The paragraph above was, for one round,
 * written as if it covered every plant; it covered every plant AT A FILE. A
 * symlink at a store-owned DIRECTORY (`<store>/learnings`, a domain directory,
 * `<store>/branches`, a bucket, a bucket's learnings tree) produced no absorb
 * entry at all — LEARNING_FILE_RE (store.mjs) matches
 * `…/<domain>/<slug>.md` and nothing else — so nothing quarantined it, every
 * read path silently returned NOTHING (assertNoSymlinkAncestors correctly
 * refuses the whole subtree), and the next `git add -A` recorded the link as a
 * `120000` blob while the CLI reported success. That plant is self-reviving
 * once tracked: every rollback `git reset --hard` re-materializes it and
 * `git clean -fd` cannot sweep a tracked path. There is no arbitrary-file
 * READ or WRITE in it — git stores the link's target path, not the target's
 * bytes, and writes still refuse via the ancestor walk — but silent,
 * committed, reported-as-success data loss is its own failure.
 * `findSymlinkedStoreDirectories` / `reclaimSymlinkedStoreDirectory` below
 * close it, and `commitStore` (store.mjs) refuses to stage while one stands.
 *
 * NO ROOT ARGUMENT FOR A FILE PATH, BY DESIGN. An earlier draft took
 * `(root, file)`; that just moves the defect to "which root did this caller
 * pass?" — a caller holding a bucket root (`<store>/branches/<key>`) would
 * contain against the bucket, and a symlinked `<store>/branches` would escape
 * containment while satisfying it. The containment root is DERIVED from the
 * path's own required shape instead. Extending the module to metadata
 * therefore extends the ALLOW-LIST of shapes, never the signature:
 *
 *     <storeRoot>/learnings/<domain>/<slug>.md
 *     <storeRoot>/branches/<key>/learnings/<domain>/<slug>.md
 *     <storeRoot>/<INDEX.md|consolidated.jsonl|governance.jsonl|config.json
 *                 |store.json|stale.json|.gitignore>
 *     <storeRoot>/branches/<key>/<INDEX.md|consolidated.jsonl|meta.json>
 *     <storeRoot>/.git/harness-txn.json
 *     <storeRoot>/.lock/owner.json
 *
 * Anything not matching that allow-listed shape (rule 3: allow-lists, not
 * deny-lists) is refused outright — there is no "unknown shape, assume the
 * caller knows best" path.
 *
 * WHAT THAT DERIVATION DOES AND DOES NOT PROVE. It proves the containment root
 * is a fixed function of the path, so two callers holding the same path always
 * contain against the same root; it does NOT prove the path is a store path.
 * The shape match is by BASENAME, anywhere on the filesystem, so
 * `<anything>/config.json` matched and `writeStoreFile('/Users/x/.ssh/config.json')`
 * was accepted with `/Users/x/.ssh` as its own containment root — harmless
 * only because every present-day caller happens to pass a real store path,
 * which is an argument about callers, not about this module. The
 * `isPlausibleStoreRoot` check below removes the "happens to" from that
 * sentence: every store this CLI can build lives at `<home>/knowledge/<id>`
 * (storeDirForId, store.mjs is the ONE constructor), so a derived root whose
 * parent is not named `knowledge` is not a store root and the path is refused.
 */

/** Quarantine bucket for planted symlinks. Gitignored by the store `.gitignore`
 * (S2), so a quarantined link is never staged into store history nor swept by
 * `git clean -fd`. */
export const QUARANTINE_DIR = '.quarantine';

/** Store-root metadata files. Bucket roots get their OWN, smaller set below:
 * a bucket has no config/governance/schema/stale state of its own, and the
 * store root has no `meta.json` — being strict about WHICH name is legal at
 * WHICH layer is the allow-list doing its job. */
const STORE_ROOT_FILES = new Set([
  'INDEX.md',
  'consolidated.jsonl',
  'governance.jsonl',
  'config.json',
  'store.json',
  'stale.json',
  '.gitignore',
]);
const BUCKET_FILES = new Set(['INDEX.md', 'consolidated.jsonl', 'meta.json']);
/** Store-owned files one directory DOWN from the store root. `.git/` and
 * `.lock/` are both directories a human can reach, so the two files the CLI
 * owns inside them are contained against the STORE root — not against `.git`
 * or `.lock` — so a symlinked `.git`/`.lock` component is inside the walked
 * span rather than above it. */
const NESTED_STORE_FILES = new Set(['.git/harness-txn.json', '.lock/owner.json']);

/**
 * The directory every knowledge store sits directly inside. `storeDirForId`
 * (store.mjs) is the ONE place a store path is ever constructed, and it is
 * always `path.join(home, 'knowledge', id)` — so `<parent>/knowledge/<id>` is
 * not a heuristic about store paths, it is their definition.
 */
const STORE_PARENT_DIR = 'knowledge';

/**
 * Whether a DERIVED root can be a knowledge store root at all. Without this,
 * the shape allow-list matches by basename ANYWHERE on the filesystem: a
 * caller passing `/Users/x/.ssh/config.json` derived `/Users/x/.ssh` as "the
 * store root" and was accepted, contained against a directory that is not a
 * store. Refusing an implausible root turns "no present-day caller passes a
 * wrong path" (a claim about callers) into "a wrong path is refused" (a claim
 * about this module).
 */
function isPlausibleStoreRoot(storeRoot) {
  return path.basename(path.dirname(storeRoot)) === STORE_PARENT_DIR;
}

function parts(rootParts, full, kind, bucket) {
  const storeRoot = rootParts.join(path.sep) || path.sep;
  if (!isPlausibleStoreRoot(storeRoot)) return null;
  const rel = path.relative(storeRoot, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { storeRoot, rel, full, kind, bucket };
}

/**
 * Derive `{ storeRoot, rel, full, kind, bucket }` from a store file path's own
 * shape, or null when the path is not an allow-listed store file at all.
 * Purely lexical (path.resolve + component inspection) — it never touches the
 * filesystem, so it cannot be raced, and it is the single definition of "which
 * root contains this file" that every function below shares.
 */
export function storePathParts(file) {
  if (typeof file !== 'string' || !file) return null;
  const full = path.resolve(file);
  const seg = full.split(path.sep);
  const n = seg.length;
  const at = (i) => (i >= 0 && i < n ? seg[i] : undefined);

  // <layerRoot>/learnings/<domain>/<slug>.md — exactly one domain level.
  if (n >= 4 && at(n - 3) === 'learnings' && at(n - 2) && String(at(n - 1)).endsWith('.md')) {
    const layerParts = seg.slice(0, n - 3);
    // A bucket layer root is `<storeRoot>/branches/<key>`; golden's layer root
    // IS the store root. Contain against the STORE root in both cases so a
    // symlinked `branches/` component is inside the walked span, not above it.
    const isBucket = layerParts.length >= 2 && layerParts[layerParts.length - 2] === 'branches';
    const rootParts = isBucket ? layerParts.slice(0, layerParts.length - 2) : layerParts;
    return parts(rootParts, full, 'learning', isBucket);
  }
  // <storeRoot>/.git/harness-txn.json, <storeRoot>/.lock/owner.json
  if (n >= 3 && NESTED_STORE_FILES.has(`${at(n - 2)}/${at(n - 1)}`)) {
    return parts(seg.slice(0, n - 2), full, 'nested', false);
  }
  // <storeRoot>/branches/<key>/<bucket metadata>. Checked BEFORE the store-root
  // shape so `branches/<key>/INDEX.md` contains against the store, not the
  // bucket.
  if (n >= 4 && at(n - 3) === 'branches' && at(n - 2) && BUCKET_FILES.has(at(n - 1))) {
    return parts(seg.slice(0, n - 3), full, 'bucket-meta', true);
  }
  // <storeRoot>/<store metadata>
  if (n >= 2 && STORE_ROOT_FILES.has(at(n - 1))) {
    return parts(seg.slice(0, n - 1), full, 'store-meta', false);
  }
  return null;
}

/** The learning-only view of the same derivation: used by the learning-specific
 * wrappers below so a caller reaching for `writeLearningFile` can never be
 * handed a metadata path (and vice versa). */
export function learningPathParts(file) {
  const p = storePathParts(file);
  return p && p.kind === 'learning' ? p : null;
}

/**
 * `'absent'` (nothing at the path), `'file'` (a real regular file, safely
 * reachable), `'symlink'` (a planted link — NEVER 'file'), `'other'` (a
 * directory or special file), or `'blocked'` (not a store path at all, or a
 * symlinked ancestor stands between the store root and it).
 *
 * This is the ONLY existence check any store caller may use. `fs.existsSync`
 * FOLLOWS a symlink, so `if (!fs.existsSync(indexPath))` read a planted link
 * as "already fine" and left it live for the next writer to follow — the exact
 * step that made the INDEX.md exploit reachable.
 */
export function storeFileState(file) {
  const p = storePathParts(file);
  if (!p) return 'blocked';
  if (!assertNoSymlinkAncestors(p.storeRoot, path.dirname(p.rel))) return 'blocked';
  let stat;
  try {
    stat = fs.lstatSync(p.full);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) return 'symlink';
  return stat.isFile() ? 'file' : 'other';
}

/**
 * Read a store file, or null when it must not be read: not a store path, a
 * symlink at the leaf or any ancestor between the store root and it, resolving
 * outside the store, over DEFAULT_MAX_BYTES (the read-size DoS cap every other
 * less-trusted read shares), or simply absent. Null is the ONE signal every
 * caller acts on — skip the entry, refuse the op, fall back to a default — so a
 * symlink and a missing file are indistinguishable to a reader, which is
 * exactly the inertness this module promises. A caller that must tell "absent"
 * from "present but unreadable" apart (never truncate what you could not read)
 * asks `storeFileState` as well.
 */
export function readStoreFile(file) {
  const p = storePathParts(file);
  if (!p) return null;
  // Cheap scan-time ancestor pre-filter first (short-circuits before any
  // open), then readFileNoFollow's canonicalize-after-acquire closes the
  // ancestor-swap window the walk cannot.
  if (!assertNoSymlinkAncestors(p.storeRoot, p.rel)) return null;
  return readFileNoFollow(p.full, { root: p.storeRoot, maxBytes: DEFAULT_MAX_BYTES });
}

/**
 * Contained, atomic store write (create-empty → verify → write-through-fd →
 * rename). Returns true only when the bytes landed at a path proven inside the
 * store; false on any refusal.
 *
 * A SYMLINK AT THE LEAF IS QUARANTINED, NOT MERELY REFUSED. Refusing alone
 * leaves the link standing at a live store path forever — the CLI silently
 * stops maintaining that file, and the next reader/writer meets the link
 * again. Moving the LINK (rename never follows a symlink, and never touches
 * its target) into `<store>/.quarantine/` makes it inert AND lets the real
 * file be rebuilt, while preserving the link for inspection.
 */
export function writeStoreFile(file, content) {
  const p = storePathParts(file);
  if (!p) return false;
  quarantineSymlinkedStorePath(p.full);
  return Boolean(writeFileContained(p.storeRoot, p.rel, content));
}

/**
 * Contained append for the store's append-only ledgers. Same quarantine-first
 * rule as writeStoreFile, then a real O_NOFOLLOW/O_APPEND write (fs-safe.mjs)
 * rather than a read-modify-write — an append must be able to succeed on a
 * ledger it cannot read whole, or an over-cap/unreadable ledger would be
 * silently TRUNCATED by its next append. `newlineGuard` inserts a separating
 * newline when the file is non-empty and does not already end in one.
 */
export function appendStoreFile(file, content, { newlineGuard = false } = {}) {
  const p = storePathParts(file);
  if (!p) return false;
  quarantineSymlinkedStorePath(p.full);
  return Boolean(appendFileContained(p.storeRoot, p.rel, content, { newlineGuard }));
}

/**
 * Remove a store file. Refuses a symlink (assertRealpathContained rejects a
 * symlinked leaf or ancestor) and anything whose real path escapes the store,
 * so a purge cascade — or a journal cleanup — can never unlink an outside
 * file. Returns true only when something was actually removable.
 */
export function removeStoreFile(file) {
  const p = storePathParts(file);
  if (!p) return false;
  const full = assertRealpathContained(p.storeRoot, p.rel);
  if (!full) return false;
  try {
    fs.rmSync(full, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a symlink planted AT a store path out of the store's live tree and into
 * `<store>/.quarantine/`, returning the store-relative quarantine path (or
 * null when there was nothing to quarantine).
 *
 * WHY MOVE RATHER THAN LEAVE OR DELETE. Leaving it is the defect this module
 * closes: every reader refused it, but it stayed on disk looking like an
 * active store file to anything that only checked `readdir`/`existsSync`, and
 * the next writer to reach for that path had a live link waiting. Deleting it
 * would destroy something a human may have put there deliberately. Renaming
 * the LINK (rename never follows a symlink, and never touches its target)
 * makes it inert while preserving it for inspection.
 *
 * Only the leaf may be a symlink: every ancestor from the store root down to
 * the containing directory must be a real directory, or the rename itself
 * could be steered outside the store — in that case this refuses.
 */
export function quarantineSymlinkedStorePath(file) {
  const p = storePathParts(file);
  if (!p) return null;
  return quarantineLink(p.storeRoot, p.rel);
}

/**
 * The rename itself, shared by the file-shaped and directory-shaped entry
 * points: verify every ancestor from the store root down is a real directory,
 * verify the leaf really IS a symlink, then rename the LINK (never its target)
 * into `<store>/.quarantine/`. Returns the store-relative quarantine path, or
 * null when there was nothing to quarantine or it could not be moved.
 */
function quarantineLink(storeRoot, rel) {
  if (!assertNoSymlinkAncestors(storeRoot, path.dirname(rel))) return null;
  const full = path.join(storeRoot, rel);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return null; // nothing there (or unreadable) — nothing to quarantine
  }
  if (!stat.isSymbolicLink()) return null;
  const destRel = path.join(QUARANTINE_DIR, `${rel.split(path.sep).join('__')}.${Date.now()}-${process.pid}.symlink`);
  const dest = assertNoSymlinkAncestors(storeRoot, destRel);
  if (!dest) return null;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(full, dest);
  } catch {
    return null;
  }
  return destRel.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Store-owned DIRECTORY shapes.
//
// WHY THE DERIVATION RUNS THE OTHER WAY HERE. A store FILE names its own root
// (see storePathParts): the shape is long enough that the root is a function of
// the path. A store DIRECTORY is not — `<anything>/learnings` is one path
// component, so deriving a root upward from it would accept any directory on
// the filesystem called `learnings`. These functions therefore ENUMERATE
// DOWNWARD from a store root the caller already holds (store.mjs's `dir`, the
// same value it passes to `commitStore` and every git call), and every `rel`
// they act on is produced by their OWN walk — never taken from a caller, never
// derived from attacker-controlled text. `isPlausibleStoreRoot` still gates the
// root, so a caller cannot point the sweep at an arbitrary directory tree.
//
// The walk never follows a link: `lstat` decides each component, and
// `readdirSync(withFileTypes)` reports a child's OWN type, so a symlinked
// directory is detected instead of being descended into.
// ---------------------------------------------------------------------------

/** `learnings/` and, one level down, its domain directories. A store `learnings`
 * directory may contain ONLY real domain directories, so ANY symlink directly
 * inside it is a plant regardless of name. */
function scanLearningsTree(storeRoot, layerRel, found) {
  const rel = layerRel ? path.join(layerRel, 'learnings') : 'learnings';
  const full = path.join(storeRoot, rel);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return; // absent — nothing to scan
  }
  if (stat.isSymbolicLink()) {
    found.push(rel);
    return; // never descend through a link
  }
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = fs.readdirSync(full, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) found.push(path.join(rel, e.name));
  }
}

/**
 * Every store-owned DIRECTORY that is currently a symlink, as `/`-joined
 * store-relative paths:
 *
 *     learnings                              learnings/<domain>
 *     branches                               branches/<key>
 *     branches/<key>/learnings               branches/<key>/learnings/<domain>
 *
 * Returns `[]` for a clean store, an implausible root, or an unreadable one —
 * a scan that cannot see is never mistaken for a scan that found nothing,
 * because callers treat a NON-empty result as the alarm and pair this with the
 * `commitStore` refusal that fails closed either way.
 */
export function findSymlinkedStoreDirectories(storeRoot) {
  const root = path.resolve(storeRoot);
  if (!isPlausibleStoreRoot(root)) return [];
  const found = [];
  scanLearningsTree(root, '', found);
  const branchesFull = path.join(root, 'branches');
  let branchesStat = null;
  try {
    branchesStat = fs.lstatSync(branchesFull);
  } catch {
    branchesStat = null;
  }
  if (branchesStat) {
    if (branchesStat.isSymbolicLink()) {
      found.push('branches');
    } else if (branchesStat.isDirectory()) {
      let keys = [];
      try {
        keys = fs.readdirSync(branchesFull, { withFileTypes: true });
      } catch {
        keys = [];
      }
      for (const k of keys) {
        const keyRel = path.join('branches', k.name);
        if (k.isSymbolicLink()) found.push(keyRel);
        else if (k.isDirectory()) scanLearningsTree(root, keyRel, found);
      }
    }
  }
  return found.map((r) => r.split(path.sep).join('/'));
}

/**
 * Make a symlinked store DIRECTORY inert and put the real directory back:
 * quarantine the link (same rename discipline as the file case — the link
 * itself moves, its target is never touched) and recreate an empty real
 * directory in its place, so the learnings the plant hid can be restored into
 * it and every read path stops silently returning nothing.
 *
 * Returns `{ quarantined, ok }`. `ok` is false when the link is still standing
 * at a live store path — the caller must then refuse rather than proceed, since
 * a `git add -A` would record it as a `120000` blob.
 */
export function reclaimSymlinkedStoreDirectory(storeRoot, rel) {
  const root = path.resolve(storeRoot);
  if (!isPlausibleStoreRoot(root)) return { quarantined: null, ok: false };
  const relNative = String(rel).split('/').join(path.sep);
  const quarantinedTo = quarantineLink(root, relNative);
  if (!quarantinedTo) return { quarantined: null, ok: false };
  const full = assertNoSymlinkAncestors(root, relNative);
  if (!full) return { quarantined: quarantinedTo, ok: false };
  try {
    fs.mkdirSync(full, { recursive: true });
  } catch {
    return { quarantined: quarantinedTo, ok: false };
  }
  return { quarantined: quarantinedTo, ok: true };
}

// ---------------------------------------------------------------------------
// Learning-shaped wrappers.
//
// Same guards, narrowed to `kind: 'learning'`: a caller reaching for the
// learning API can never be handed a metadata path by a crafted id, and a
// metadata writer can never be routed through the learning API. Every existing
// call site keeps its precise, self-documenting name.
// ---------------------------------------------------------------------------

/** Read a learning file, or null when it must not be read (see readStoreFile). */
export function readLearningFile(file) {
  return learningPathParts(file) ? readStoreFile(file) : null;
}

/** Contained, atomic learning write. False on any refusal. */
export function writeLearningFile(file, content) {
  return learningPathParts(file) ? writeStoreFile(file, content) : false;
}

/** Remove a learning file; refuses a symlink or an escaping path. */
export function removeLearningFile(file) {
  return learningPathParts(file) ? removeStoreFile(file) : false;
}

/** Quarantine a symlink planted at a LEARNING path (absorb's reporting path). */
export function quarantineSymlinkedLearning(file) {
  return learningPathParts(file) ? quarantineSymlinkedStorePath(file) : null;
}
