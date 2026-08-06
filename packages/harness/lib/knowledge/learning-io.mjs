import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_BYTES, readFileNoFollow, writeFileContained, assertNoSymlinkAncestors, assertRealpathContained } from '../fs-safe.mjs';

/**
 * THE ONE CHOKE POINT FOR LEARNING-FILE I/O (S1).
 *
 * A learning file is the only content in the store a human hand-edits in
 * place, so its path is the store's single largest attacker-influenced
 * surface: anyone who can write into `<store>/learnings/` can replace a
 * learning with a SYMLINK and, unless every reader and writer refuses to
 * follow it, make the CLI read an arbitrary outside file into store history /
 * a workspace mirror, or overwrite an arbitrary outside file with a rendered
 * learning.
 *
 * Four consecutive rounds of review fixed this ONE CALL SITE AT A TIME —
 * absorb refused the symlink while `listLearnings`, `mirrorLearnings`,
 * `updateFrontmatterField`, the ADD/SUPERSEDE/STRENGTHEN writers, the
 * promotion tombstone, the purge delink, and lifecycle's status write all
 * still followed it. The class survived every fix because the class was still
 * REPRESENTABLE: `fs.readFileSync(learning.file)` was a legal thing to write.
 *
 * This module removes that. Every read, write, delete, and size check of a
 * learning file goes through the four functions below; `fs` is not imported
 * for learning paths anywhere else in lib/knowledge/. A symlink planted at a
 * learning path is therefore INERT EVERYWHERE:
 *   - never read through          (readLearningFile → readFileNoFollow)
 *   - never written through       (writeLearningFile → writeFileContained)
 *   - never deleted through       (removeLearningFile → assertRealpathContained)
 *   - never listed as a learning  (listLearnings skips a null read)
 *   - never mirrored              (mirrorLearnings skips a null read)
 * and the planted link ITSELF is quarantined out of `learnings/` by the next
 * absorb (quarantineSymlinkedLearning) rather than left live for the next
 * reader to trip over — leaving it in place is exactly what let the previous
 * round's "refused in absorb" fix still end in a truncated `~/.zshrc`.
 *
 * NO ROOT ARGUMENT, BY DESIGN. An earlier draft took `(root, file)`; that just
 * moves the defect to "which root did this caller pass?" — a caller holding a
 * bucket root (`<store>/branches/<key>`) would contain against the bucket, and
 * a symlinked `<store>/branches` would escape containment while satisfying it.
 * The containment root is DERIVED from the path's own required shape instead,
 * so no caller can supply a wrong one:
 *
 *     <storeRoot>/learnings/<domain>/<slug>.md
 *     <storeRoot>/branches/<key>/learnings/<domain>/<slug>.md
 *
 * Anything not matching that allow-listed shape (rule 3: allow-lists, not
 * deny-lists) is refused outright — there is no "unknown shape, assume the
 * caller knows best" path.
 */

/** Quarantine bucket for planted symlinks. Gitignored by ensureStore (S2), so
 * a quarantined link is never staged into store history nor swept by
 * `git clean -fd`. */
export const QUARANTINE_DIR = '.quarantine';

/**
 * Derive `{ storeRoot, rel }` from a learning file path's own shape, or null
 * when the path is not a learning path at all. Purely lexical (path.resolve +
 * component inspection) — it never touches the filesystem, so it cannot be
 * raced, and it is the single definition of "which root contains this file"
 * that every function below shares.
 */
export function learningPathParts(file) {
  if (typeof file !== 'string' || !file) return null;
  const full = path.resolve(file);
  const parts = full.split(path.sep);
  const n = parts.length;
  // <layerRoot>/learnings/<domain>/<slug>.md — exactly one domain level.
  if (n < 4) return null;
  if (parts[n - 3] !== 'learnings') return null;
  if (!parts[n - 2] || !parts[n - 1].endsWith('.md')) return null;
  const layerParts = parts.slice(0, n - 3);
  // A bucket layer root is `<storeRoot>/branches/<key>`; golden's layer root
  // IS the store root. Contain against the STORE root in both cases so a
  // symlinked `branches/` component is inside the walked span, not above it.
  const isBucket = layerParts.length >= 2 && layerParts[layerParts.length - 2] === 'branches';
  const rootParts = isBucket ? layerParts.slice(0, layerParts.length - 2) : layerParts;
  const storeRoot = rootParts.join(path.sep) || path.sep;
  const rel = path.relative(storeRoot, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { storeRoot, rel, full, bucket: isBucket };
}

/**
 * Read a learning file, or null when it must not be read: not a learning
 * path, a symlink at the leaf or any ancestor between the store root and it,
 * resolving outside the store, over DEFAULT_MAX_BYTES (the read-size DoS cap
 * every other less-trusted read shares), or simply absent. Null is the ONE
 * signal every caller acts on — skip the entry, refuse the op — so a symlink
 * and a missing file are indistinguishable to a reader, which is exactly the
 * inertness this module promises.
 */
export function readLearningFile(file) {
  const p = learningPathParts(file);
  if (!p) return null;
  // Cheap scan-time ancestor pre-filter first (short-circuits before any
  // open), then readFileNoFollow's canonicalize-after-acquire closes the
  // ancestor-swap window the walk cannot.
  if (!assertNoSymlinkAncestors(p.storeRoot, p.rel)) return null;
  return readFileNoFollow(p.full, { root: p.storeRoot, maxBytes: DEFAULT_MAX_BYTES });
}

/**
 * Contained, atomic learning write (create-empty → verify → write-through-fd →
 * rename). Returns true only when the bytes landed at a path proven inside the
 * store; false on any refusal. The rename REPLACES a leaf rather than writing
 * through it, and `assertNoSymlinkAncestors` inside `writeFileContained`
 * refuses a symlinked leaf before that — so neither the link nor its target is
 * ever written.
 */
export function writeLearningFile(file, content) {
  const p = learningPathParts(file);
  if (!p) return false;
  return Boolean(writeFileContained(p.storeRoot, p.rel, content));
}

/**
 * Remove a learning file. Refuses a symlink (assertRealpathContained rejects a
 * symlinked leaf or ancestor) and anything whose real path escapes the store,
 * so a purge cascade can never unlink an outside file. Returns true only when
 * something was actually removable.
 */
export function removeLearningFile(file) {
  const p = learningPathParts(file);
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
 * Move a symlink planted AT a learning path out of `learnings/` and into
 * `<store>/.quarantine/`, returning the store-relative quarantine path (or
 * null when there was nothing to quarantine).
 *
 * WHY MOVE RATHER THAN LEAVE OR DELETE. Leaving it is what caused the finding
 * this module closes: every reader refused it, but it stayed on disk looking
 * like an active learning to anything that only checked `readdir`, and the
 * next writer to reach for that id had a live link waiting. Deleting it would
 * destroy something a human may have put there deliberately. Renaming the LINK
 * (rename never follows a symlink, and never touches its target) makes it
 * inert while preserving it for inspection, and the move is reported by the
 * caller so a person sees that it happened.
 *
 * Only the leaf may be a symlink: every ancestor from the store root down to
 * the containing domain directory must be a real directory, or the rename
 * itself could be steered outside the store — in that case this refuses and
 * the caller simply logs.
 */
export function quarantineSymlinkedLearning(file) {
  const p = learningPathParts(file);
  if (!p) return null;
  const parentRel = path.dirname(p.rel);
  if (!assertNoSymlinkAncestors(p.storeRoot, parentRel)) return null;
  let stat;
  try {
    stat = fs.lstatSync(p.full);
  } catch {
    return null; // nothing there (or unreadable) — nothing to quarantine
  }
  if (!stat.isSymbolicLink()) return null;
  const destRel = path.join(
    QUARANTINE_DIR,
    `${p.rel.split(path.sep).join('__')}.${Date.now()}-${process.pid}.symlink`
  );
  const dest = assertNoSymlinkAncestors(p.storeRoot, destRel);
  if (!dest) return null;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(p.full, dest);
  } catch {
    return null;
  }
  return destRel.split(path.sep).join('/');
}
