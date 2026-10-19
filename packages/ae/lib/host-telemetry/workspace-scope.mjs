import fs from 'node:fs';
import path from 'node:path';

/** Resolve an existing directory to its filesystem identity. Invalid,
 * unreadable, missing, and non-directory roots fail closed. */
export function canonicalDirectoryRoot(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const canonical = fs.realpathSync.native(path.resolve(value));
    return fs.statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

/** Compare two canonical directory roots as one workspace scope. A repository
 * root and any real descendant overlap; siblings and unresolved roots do not. */
export function directoryRootsOverlap(left, right) {
  if (left == null || right == null) return false;
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}
