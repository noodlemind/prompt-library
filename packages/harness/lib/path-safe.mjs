import path from 'path';
import { assertNoSymlinkAncestors } from './fs-safe.mjs';

export function safeResolveUnderRoot(root, relPath) {
  if (!relPath || path.isAbsolute(relPath)) return null;
  return assertNoSymlinkAncestors(root, relPath);
}
