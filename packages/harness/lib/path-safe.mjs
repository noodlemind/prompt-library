import path from 'path';

/**
 * Resolve relPath under root; return null if it escapes root or is absolute.
 */
export function safeResolveUnderRoot(root, relPath) {
  if (!relPath || path.isAbsolute(relPath)) return null;
  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, relPath);
  const rel = path.relative(rootResolved, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return candidate;
}
