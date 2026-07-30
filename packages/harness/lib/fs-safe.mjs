import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared symlink-safe filesystem primitives for every writer/reader that
 * touches paths derived from repo-tracked or otherwise less-trusted content
 * (episode files under docs/solutions, mirror destinations under
 * docs/knowledge/learnings, purge targets, the committed codebase map). A
 * symlink planted at (or above) any of these paths must never let a read
 * exfiltrate an outside file's content, nor let a write/delete land outside
 * the intended root — extracted from lib/repo-map/index.mjs, the first
 * adopter of this pattern, so every later adopter shares ONE implementation
 * instead of re-deriving the same lstat/O_NOFOLLOW/realpath idioms.
 */

// Only defined where the platform supports it (Linux/macOS; absent on
// Windows) — feature-checked so the read path below can degrade gracefully
// instead of throwing on an unsupported flag.
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : null;
const DEFAULT_MAX_BYTES = 10_000_000;

/**
 * Walk from `root` down to (and including) `rel`'s final path component,
 * refusing as soon as ANY component along the way already exists as a
 * symlink — a symlinked ancestor directory (or a pre-planted symlink at the
 * leaf itself) could otherwise redirect a read, write, or delete entirely
 * outside `root`. A missing component simply means the rest of the path
 * doesn't exist yet (nothing to be a symlink), so the walk stops there and
 * the remainder is treated as safe to create. Returns the resolved absolute
 * path, or null when `rel` escapes `root` lexically OR any existing
 * ancestor component (including the leaf) is a symlink.
 *
 * The ROOT ARGUMENT ITSELF is checked too, not just what's appended to it
 * (adversarial-review finding): every caller treats `root` as the trusted
 * boundary everything below it is validated against, but a caller-computed
 * root — `copilotHome/knowledge`, a mirror root under the workspace — is
 * itself just a path built from a less-trusted base, and can be replaced
 * with a symlink by anyone with filesystem access to that base. Without
 * this check, a symlinked `root` would pass containment against ITSELF: the
 * component walk below only ever inspects what's APPENDED to root, never
 * root's own final path component. A missing root is fine (nothing to be a
 * symlink yet) — same tolerance as a missing intermediate component.
 *
 * THREAT-MODEL HONESTY: this is a SCAN-TIME check — an lstat walk, not an
 * atomic descriptor-relative (openat-style) traversal, which Node does not
 * portably expose. It reliably catches a symlinked component that exists
 * when the walk runs (the practical planted-symlink case every caller
 * guards against), but a local attacker with concurrent filesystem write
 * access can still swap an ancestor for a symlink in the window between
 * this walk and the caller's subsequent open/write/delete — a residual
 * TOCTOU that callers narrow (never fully close) by pairing this with an
 * O_NOFOLLOW leaf open (readFileNoFollow) or a realpath re-validation
 * immediately before the mutation (writeFileContained, purgeEpisode's
 * re-check-before-delete).
 */
export function assertNoSymlinkAncestors(root, rel) {
  const rootFull = path.resolve(root);
  try {
    if (fs.lstatSync(rootFull).isSymbolicLink()) return null;
  } catch {
    // root doesn't exist yet — nothing to be a symlink; same tolerance as a
    // missing intermediate component in the walk below.
  }
  const full = path.resolve(rootFull, rel);
  const relative = path.relative(rootFull, full);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) return null;
  let cur = rootFull;
  const parts = relative === '' ? [] : relative.split(path.sep);
  for (const part of parts) {
    cur = path.join(cur, part);
    let stat;
    try {
      stat = fs.lstatSync(cur);
    } catch {
      break; // nothing here yet — the rest of the path is safe to create
    }
    if (stat.isSymbolicLink()) return null;
  }
  return full;
}

/**
 * Read a file refusing a symlink at the FINAL path component atomically:
 * opening with O_NOFOLLOW asks the kernel to fail the open if the leaf is a
 * symlink — no lstat-then-open gap at the leaf, and the fstat on the
 * returned fd (regular-file + size checks) inspects the object actually
 * opened, not the path again. WHAT THIS DOES NOT COVER: O_NOFOLLOW says
 * nothing about ANCESTOR components — a symlinked parent directory is still
 * followed by the kernel, so callers must validate the ancestry themselves
 * (assertNoSymlinkAncestors) before calling this, and even then a
 * same-instant ancestor swap between that walk and this open remains a
 * theoretical residual (see assertNoSymlinkAncestors' threat-model note;
 * Node has no portable openat-style traversal to close it). On a platform
 * without O_NOFOLLOW (Windows) the leaf guarantee is weaker still: an
 * lstat-then-read guard, non-atomic even at the leaf — it narrows the
 * window there but cannot close it. Returns null (never throws) on a
 * missing file, a symlink, a non-regular file, or anything over `maxBytes`
 * — callers decide what a null means for their own control flow (skip, try
 * the next candidate root, fail closed).
 */
export function readFileNoFollow(full, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (O_NOFOLLOW !== null) {
    let fd;
    try {
      fd = fs.openSync(full, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      const buf = Buffer.alloc(stat.size);
      fs.readSync(fd, buf, 0, stat.size, 0);
      return buf.toString('utf8');
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Contained, atomic write: refuses when `rel` escapes `root` or any
 * component along the way (assertNoSymlinkAncestors) is a symlink, then
 * re-validates the REAL parent directory physically sits inside the REAL
 * root (realpath, not just the lexical check above) immediately before
 * writing — narrowing the window between the ancestor check and this write
 * (e.g. the `mkdir` below creating a fresh directory that a racing process
 * then swaps for a symlink) — before writing via a temp-file + rename in the
 * SAME directory so a concurrent reader never observes a partial write.
 * The realpath re-check is itself scan-time, not atomic with the rename: a
 * same-instant parent swap between the re-check and the rename remains the
 * same theoretical local-attacker residual assertNoSymlinkAncestors
 * documents — this helper delivers the strongest ordering Node's portable
 * fs API allows, not an openat-grade guarantee. Returns the written
 * absolute path, or null when the write was refused.
 */
export function writeFileContained(root, rel, content) {
  const rootFull = path.resolve(root);
  const full = assertNoSymlinkAncestors(rootFull, rel);
  if (!full) return null;
  const parent = path.dirname(full);
  fs.mkdirSync(parent, { recursive: true });
  let realParent;
  let realRoot;
  try {
    realParent = fs.realpathSync(parent);
    realRoot = fs.realpathSync(rootFull);
  } catch {
    return null;
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return null;
  const tmp = path.join(parent, `.tmp-${path.basename(full)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, full);
  return full;
}
