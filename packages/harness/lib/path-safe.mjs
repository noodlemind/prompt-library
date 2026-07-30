import path from 'path';
import { assertNoSymlinkAncestors } from './fs-safe.mjs';

/**
 * Resolve relPath under root; return null if it escapes root lexically, is
 * absolute, or resolves through a symlinked ancestor directory or leaf
 * (adversarial-review finding, probe G): a purely lexical check (the
 * previous implementation — path.relative + a `..` check, zero lstats)
 * lets `fs.existsSync`/`fs.readFileSync` in this function's consumers
 * (get-cmd.mjs, recall-rank.mjs's resolveDocPath) follow a symlinked
 * ancestor at the OS level and read straight outside `root`.
 * `assertNoSymlinkAncestors` (fs-safe.mjs) — the same helper the knowledge
 * layer's episode readers and purge use — closes that: it re-derives the
 * same lexical containment check internally, then additionally lstats every
 * existing path component from `root` down, refusing as soon as any of them
 * (including the leaf) is a symlink.
 */
export function safeResolveUnderRoot(root, relPath) {
  if (!relPath || path.isAbsolute(relPath)) return null;
  return assertNoSymlinkAncestors(root, relPath);
}
