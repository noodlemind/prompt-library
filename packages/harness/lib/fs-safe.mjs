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
 *
 * THREAT MODEL — canonicalize-after-acquire. A pre-open ancestor walk
 * (assertNoSymlinkAncestors) is a SCAN-TIME check: it reliably catches a
 * symlinked component that exists when it runs, but a local attacker with
 * concurrent filesystem write access can swap an ancestor directory for a
 * symlink pointing outside the root in the window between that walk and the
 * subsequent open/write/delete — a TOCTOU escape. Node exposes no portable
 * openat-style descriptor-relative traversal to make the walk atomic, so the
 * robust achievable defense is to VERIFY AFTER ACQUIRING the handle: open (or
 * exclusively create) the leaf, then prove — via realpath + inode identity —
 * that the object now in hand is the SAME inode as a canonical path that
 * physically lives inside the canonical root. A swap that redirects to a
 * DIFFERENT inode outside the root changes realpath and/or dev+ino and is
 * detected; a swap that preserves the exact dev+ino cannot point at different
 * content, so it is not an escape. See each function for the precise steps.
 */

// Only defined where the platform supports it (Linux/macOS; absent on
// Windows) — feature-checked so the read path below can degrade gracefully
// instead of throwing on an unsupported flag.
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : null;
// The one read-size cap for every less-trusted read. Exported (sweep P3) so the
// two readers that DON'T go through readFileNoFollow — loadManifest
// (recall-rank.mjs) and listLearnings (store.mjs) — enforce the SAME cap
// uniformly, skipping an over-cap manifest/learning file instead of reading a
// crafted multi-hundred-MB file whole on every session (DoS surface).
export const DEFAULT_MAX_BYTES = 10_000_000;

/**
 * Canonicalize `root` (fully resolving every symlink) to compare canonical
 * against canonical — a workspace root legitimately reached through a symlink
 * (e.g. macOS /var -> /private/var, or a symlinked temp dir) must not read as
 * an escape, and a maliciously symlinked ancestor must not be able to hide by
 * matching only a lexical prefix. Returns null when `root` can't be resolved
 * (missing/unreadable) so callers fail closed. `null`/`undefined` root means
 * "no containment root requested".
 */
function canonicalRoot(root) {
  if (root == null) return null;
  try {
    return fs.realpathSync(path.resolve(root));
  } catch {
    return null;
  }
}

/** Is the already-canonical absolute `candidate` inside the canonical `realRoot`? */
function containedUnder(candidate, realRoot) {
  return candidate === realRoot || candidate.startsWith(realRoot + path.sep);
}

/**
 * The heart of canonicalize-after-acquire: given an open descriptor `fd` for
 * `full` and its `fdStat` (from fstat — the REAL inode actually opened),
 * prove that (a) the canonical resolution of `full` lives inside `realRoot`,
 * and (b) that canonical path is the SAME dev+ino as the fd we hold. realpath
 * follows every symlink INCLUDING an ancestor swapped in after any pre-open
 * walk, so an ancestor redirect outside the root is caught by (a); an
 * inode-preserving path substitution is caught by (b). Returns true only when
 * both hold. dev+ino are fully reliable on Linux/macOS; on Windows they are
 * best-effort (see readFileNoFollow's Windows note) and containment (a) is the
 * load-bearing guard there.
 */
function fdMatchesCanonicalUnderRoot(full, fdStat, realRoot) {
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    return false;
  }
  if (!containedUnder(real, realRoot)) return false;
  let lst;
  try {
    lst = fs.lstatSync(real);
  } catch {
    return false;
  }
  return lst.dev === fdStat.dev && lst.ino === fdStat.ino;
}

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
 * THREAT-MODEL HONESTY: this remains a SCAN-TIME check — an lstat walk, not
 * an atomic descriptor-relative (openat-style) traversal, which Node does not
 * portably expose. It is the FIRST, cheap layer: it catches a symlinked
 * component that exists when the walk runs (the practical planted-symlink
 * case) and short-circuits directory listings before they are ever read. It
 * does NOT, on its own, close the ancestor-swap TOCTOU window between the walk
 * and the caller's subsequent syscall — that residual is closed by pairing
 * this with the canonicalize-after-acquire verify in readFileNoFollow /
 * writeFileContained, or assertRealpathContained for a delete/rename target.
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
 * Stronger sibling of assertNoSymlinkAncestors for a mutation about to act on
 * an EXISTING path (a delete, or a rename source): run the cheap ancestor
 * walk first, then — because that walk is scan-time — additionally resolve the
 * path's REAL canonical location (realpath, which follows every symlink,
 * including an ancestor swapped in after the walk) and require it to sit
 * inside the REAL (canonical) `root`. A symlinked ancestor redirecting outside
 * makes realpath land outside realRoot → refused, so a subsequent rmSync /
 * renameSync of the returned lexical path cannot be steered onto an arbitrary
 * external file. Returns the lexical full path (the thing to delete/rename),
 * or null when the target escapes, an ancestor/leaf is a symlink, the target
 * doesn't exist, or its canonical location escapes the root. This is still not
 * atomic with the caller's syscall (Node has no openat), but it narrows the
 * window to the same self-detecting near-zero residual the read/write paths
 * document: an inode-preserving swap can't redirect the target's content out
 * of the root.
 */
export function assertRealpathContained(root, rel) {
  const rootFull = path.resolve(root);
  const full = assertNoSymlinkAncestors(rootFull, rel);
  if (!full) return null;
  const realRoot = canonicalRoot(rootFull);
  if (realRoot === null) return null;
  let realFull;
  try {
    realFull = fs.realpathSync(full);
  } catch {
    return null; // target doesn't exist / unreadable — nothing safe to act on
  }
  if (!containedUnder(realFull, realRoot)) return null;
  return full;
}

/**
 * Read a file, closing the symlink-ancestor TOCTOU window via
 * canonicalize-after-acquire. On Linux/macOS:
 *   1. Open the leaf with O_NOFOLLOW — the kernel refuses the open atomically
 *      if the FINAL component is a symlink (no lstat-then-open gap at the leaf).
 *   2. fstat the returned fd — the REAL dev+ino + type + size of what was
 *      actually opened, inspected on the descriptor, never the path again.
 *   3+4+5. When a `root` is given, realpath(full) fully resolves every
 *      symlink (including an ANCESTOR swapped in between any caller-side
 *      ancestor walk and this open), require that canonical path inside
 *      realpath(root), and require lstat(realpath).dev+ino to EQUAL the fstat
 *      from step 2 — proving the fd in hand is the same inode as the canonical
 *      contained path (fdMatchesCanonicalUnderRoot).
 *   6. Read via the fd (fs.readSync on the descriptor), NOT by re-opening the
 *      path — so the bytes returned are the exact inode just verified.
 * Any failure → close fd, return null. To ESCAPE, an attacker would have to
 * make realpath resolve inside the root AND the opened-fd inode match a
 * canonical path inside the root — i.e. the content is genuinely inside the
 * root, which by definition is not an escape.
 *
 * Pass `root` (the trusted containment boundary this file must live under) to
 * enable the containment verify; omit it and only the atomic O_NOFOLLOW leaf
 * guard applies (weaker — used only where no single root is meaningful).
 *
 * WINDOWS / no O_NOFOLLOW: the flag is absent or ignored, so the leaf open
 * cannot atomically refuse a symlink. We instead open normally, fstat, then
 * lstat the path to detect a symlinked leaf (non-atomic — narrows, cannot
 * fully close the leaf window) and, with a `root`, run the SAME realpath
 * containment + inode verify. dev+ino are less reliable on Windows (ino can be
 * 0 on some filesystems), so realpath CONTAINMENT is the load-bearing guard
 * there — it still catches an ancestor redirect because NTFS/ReFS junctions
 * and symlinks resolve through realpath; the inode check is best-effort. This
 * Windows branch is inspection-verified only (no Windows CI here).
 *
 * Returns null (never throws) on a missing file, a symlink, a non-regular
 * file, anything over `maxBytes`, or any containment failure — callers decide
 * what null means for their control flow (skip, try the next candidate root,
 * fail closed).
 */
export function readFileNoFollow(full, { maxBytes = DEFAULT_MAX_BYTES, root = null } = {}) {
  const realRoot = canonicalRoot(root);
  // A root was requested but could not be canonicalized → fail closed rather
  // than silently reading without the containment guarantee.
  if (root != null && realRoot === null) return null;

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
      if (realRoot !== null && !fdMatchesCanonicalUnderRoot(full, stat, realRoot)) return null;
      const buf = Buffer.alloc(stat.size);
      fs.readSync(fd, buf, 0, stat.size, 0);
      return buf.toString('utf8');
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  // Windows / no O_NOFOLLOW.
  let fd;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    // Detect a symlinked leaf the non-atomic way (O_NOFOLLOW unavailable): if
    // the leaf is a symlink the open above followed it, but we refuse here
    // before reading a single byte.
    try {
      if (fs.lstatSync(full).isSymbolicLink()) return null;
    } catch {
      return null;
    }
    if (realRoot !== null && !fdMatchesCanonicalUnderRoot(full, stat, realRoot)) return null;
    const buf = Buffer.alloc(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Post-acquire parent-containment verify for a file that was JUST created IN
 * PLACE — an exclusive `wx`/O_EXCL create, as compound.mjs's reserveEpisodePath
 * does, NOT a temp+rename. realpath the file's PARENT (which follows every
 * symlink, including an ancestor swapped in AFTER a scan-time
 * assertNoSymlinkAncestors walk) and require it inside realpath(root). This is
 * writeFileContained's step-3 check factored out (canonicalize-after-acquire),
 * so the exclusive-create episode writer shares the EXACT same guard instead of
 * stopping at the scan-time walk + O_EXCL leaf guard — neither of which can see
 * an ancestor redirected out of the root between the walk and the create.
 * Returns true only when the parent canonically resolves inside the root; false
 * on an unresolvable root/parent or an escape, so the caller can unlink the
 * just-created file and refuse.
 */
export function realpathParentContained(root, full) {
  const realRoot = canonicalRoot(root);
  if (realRoot === null) return false;
  let realParent;
  try {
    realParent = fs.realpathSync(path.dirname(full));
  } catch {
    return false;
  }
  return containedUnder(realParent, realRoot);
}

/**
 * Contained APPEND via canonicalize-after-acquire — the append-only sibling of
 * writeFileContained, for the store's two append-only ledgers
 * (consolidated.jsonl, governance.jsonl).
 *
 * WHY NOT read-modify-write. Rewriting the whole file to append one line makes
 * the append inherit the READ's failure modes: a ledger over DEFAULT_MAX_BYTES
 * (or unreadable for any other reason) would read as empty and the "append"
 * would TRUNCATE it. An append must be able to succeed on a file it cannot
 * read, so it is a real O_APPEND write:
 *   1. assertNoSymlinkAncestors — cheap lexical + ancestor-symlink pre-filter.
 *   2. open O_RDWR|O_APPEND|O_CREAT|O_NOFOLLOW — O_NOFOLLOW makes the kernel
 *      refuse atomically if the FINAL component is a symlink, so a planted link
 *      is never appended through; O_APPEND makes every write land at EOF.
 *   3. fstat the fd, then realpath-contain + inode-match it against the root
 *      (fdMatchesCanonicalUnderRoot) — closing the ancestor-swap window step 1
 *      cannot. On failure the fd is closed and, if THIS call created the file,
 *      the empty file is unlinked again; a pre-existing file is left untouched.
 *   4. Write through the verified descriptor, never by re-opening the path.
 * `newlineGuard` reproduces the store's own append idiom (insert a separating
 * newline when the file is non-empty and does not already end in one) by
 * reading the last byte THROUGH the verified fd rather than re-reading the
 * whole file. Returns the appended-to absolute path, or null on any refusal.
 */
export function appendFileContained(root, rel, content, { newlineGuard = false } = {}) {
  const rootFull = path.resolve(root);
  const full = assertNoSymlinkAncestors(rootFull, rel);
  if (!full) return null;
  const realRoot = canonicalRoot(rootFull);
  if (realRoot === null) return null;
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
  } catch {
    return null;
  }
  let existedBefore = true;
  try {
    fs.lstatSync(full);
  } catch {
    existedBefore = false;
  }
  const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | (O_NOFOLLOW === null ? 0 : O_NOFOLLOW);
  let fd;
  try {
    fd = fs.openSync(full, flags, 0o666);
  } catch {
    return null;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      fs.closeSync(fd);
    } catch {
      /* already gone */
    }
  };
  const refuse = () => {
    close();
    // Only ever unlink a file THIS call brought into existence — a
    // pre-existing file is never ours to remove on a refusal.
    if (!existedBefore) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* best effort */
      }
    }
    return null;
  };
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return refuse();
    // Windows / no O_NOFOLLOW: the open above followed a symlinked leaf, so
    // detect it the non-atomic way before writing a single byte.
    if (O_NOFOLLOW === null) {
      try {
        if (fs.lstatSync(full).isSymbolicLink()) return refuse();
      } catch {
        return refuse();
      }
    }
    if (!fdMatchesCanonicalUnderRoot(full, stat, realRoot)) return refuse();
    let prefix = '';
    if (newlineGuard && stat.size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, stat.size - 1);
      if (last.toString('utf8') !== '\n') prefix = '\n';
    }
    fs.writeSync(fd, Buffer.from(prefix + content, 'utf8'));
    close();
    return full;
  } catch {
    return refuse();
  }
}

/**
 * Contained, atomic write via canonicalize-after-acquire. The sequence is
 * create-EMPTY → verify → write-through-fd → rename, so no content byte is ever
 * placed at a path that has not already passed the containment check — even for
 * the instant before a failing verify unlinks it:
 *   1. assertNoSymlinkAncestors — cheap lexical + ancestor-symlink pre-filter.
 *   2. mkdir the parent, then exclusively create the temp file EMPTY with flag
 *      'wx' (O_CREAT|O_EXCL): O_EXCL refuses to follow/overwrite a pre-planted
 *      symlink at the temp leaf, atomically, and creating zero bytes means an
 *      ancestor-swap race can only ever expose an EMPTY file, never content.
 *   3. Now that the (empty) file exists, realpath its PARENT and require it
 *      inside realpath(root). A symlinked ANCESTOR swapped in after step 1
 *      makes the temp land outside and realpath(parent) resolve outside
 *      realRoot → close the fd, UNLINK the just-created empty temp and refuse.
 *   4. Only AFTER the verify passes, write the content THROUGH the verified
 *      descriptor (so the bytes land in the exact object just proven contained,
 *      not a re-opened path), close it, then rename the temp onto the final
 *      name IN THE SAME directory so a concurrent reader never sees a partial
 *      write.
 * The rename is not atomic with the realpath check (Node has no openat), but
 * because the file is created empty, verified in place, and only THEN filled,
 * the only residual is the same inode-preserving parent swap the module note
 * documents — which cannot redirect the write's content out of the root.
 * Returns the written absolute path, or null when the write was refused.
 */
export function writeFileContained(root, rel, content) {
  const rootFull = path.resolve(root);
  const full = assertNoSymlinkAncestors(rootFull, rel);
  if (!full) return null;
  const parent = path.dirname(full);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.tmp-${path.basename(full)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let fd;
  try {
    // Exclusive create, EMPTY (zero bytes): O_CREAT|O_EXCL never
    // follows/overwrites an existing leaf, and no content exists yet.
    fd = fs.openSync(tmp, 'wx');
  } catch {
    return null;
  }
  const cleanup = () => {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort — a swapped-away temp is not ours to chase */
    }
  };
  // Post-create containment (shared with reserveEpisodePath): the empty file
  // now exists, so realpath resolves through any ancestor a racing process
  // swapped for a symlink after step 1. On an escape, only a zero-byte file was
  // ever exposed — no content bytes — before it is closed and unlinked here.
  if (!realpathParentContained(rootFull, full)) {
    try {
      fs.closeSync(fd);
    } catch {
      /* fd may already be gone if the leaf was swapped away */
    }
    cleanup();
    return null;
  }
  // Verify passed: write content THROUGH the verified descriptor, then close.
  try {
    fs.writeFileSync(fd, content, { encoding: 'utf8' });
    fs.closeSync(fd);
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed / gone */
    }
    cleanup();
    return null;
  }
  try {
    fs.renameSync(tmp, full);
  } catch {
    cleanup();
    return null;
  }
  return full;
}
