import fs from 'node:fs';
import path from 'node:path';

const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : null;
export const DEFAULT_MAX_BYTES = 10_000_000;

function canonicalPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return fs.realpathSync(p);
  }
}

function canonicalRoot(root) {
  if (root == null) return null;
  try {
    return canonicalPath(path.resolve(root));
  } catch {
    return null;
  }
}

/** Is the already-canonical absolute `candidate` inside the canonical `realRoot`? */
function containedUnder(candidate, realRoot) {
  return candidate === realRoot || candidate.startsWith(realRoot + path.sep);
}

function fdMatchesCanonicalUnderRoot(full, fdStat, realRoot) {
  let real;
  try {
    real = canonicalPath(full);
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

export function assertNoSymlinkAncestors(root, rel) {
  const rootFull = path.resolve(root);
  try {
    if (fs.lstatSync(rootFull).isSymbolicLink()) return null;
  } catch {
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

export function assertRealpathContained(root, rel) {
  const rootFull = path.resolve(root);
  const full = assertNoSymlinkAncestors(rootFull, rel);
  if (!full) return null;
  const realRoot = canonicalRoot(rootFull);
  if (realRoot === null) return null;
  let realFull;
  try {
    realFull = canonicalPath(full);
  } catch {
    return null; // target doesn't exist / unreadable — nothing safe to act on
  }
  if (!containedUnder(realFull, realRoot)) return null;
  return full;
}

export function readFileNoFollow(full, { maxBytes = DEFAULT_MAX_BYTES, root = null } = {}) {
  const realRoot = canonicalRoot(root);
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

export function realpathParentContained(root, full) {
  const realRoot = canonicalRoot(root);
  if (realRoot === null) return false;
  let realParent;
  try {
    realParent = canonicalPath(path.dirname(full));
  } catch {
    return false;
  }
  return containedUnder(realParent, realRoot);
}

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
        const buf = Buffer.from(prefix + content, 'utf8');
    let written = 0;
    while (written < buf.length) {
      const n = fs.writeSync(fd, buf, written, buf.length - written);
      if (!(n > 0)) return refuse();
      written += n;
    }
    close();
    return full;
  } catch {
    return refuse();
  }
}

export function writeFileContained(root, rel, content) {
  const rootFull = path.resolve(root);
  const full = assertNoSymlinkAncestors(rootFull, rel);
  if (!full) return null;
  const parent = path.dirname(full);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.tmp-${path.basename(full)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let fd;
  try {
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
