import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { storeDir } from './knowledge/store.mjs';

/**
 * Branch/worktree detection and branch-key derivation (harness evolution
 * blueprint P1/P7). Read-only and fail-tolerant: a non-git workspace, an
 * unborn branch, or a missing git binary degrade to null fields — never a
 * throw into a caller's orientation or write path.
 *
 * Everything here is derived from the CURRENT git state at call time. Nothing
 * is cached: layer routing must reflect write-time HEAD (blueprint P1), and a
 * branch recorded earlier (e.g. at orient) is advisory display only.
 */

const BRANCH_SLUG_CAP = 64;
const DETACHED_SHORT_SHA_LEN = 12;

function gitOut(cwd, args) {
  try {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
    return res.status === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic, filesystem-safe slug for a RAW branch name: lowercased,
 * every char outside [a-z0-9._-] collapsed to '-' (runs collapse to one),
 * trimmed of leading/trailing '-', capped at 64 chars. A branch name that
 * slugs to nothing (e.g. fully non-latin) falls back to 'branch' — the
 * 8-hex hash suffix in branchKeyFor still disambiguates.
 */
export function branchSlug(branch) {
  return (
    String(branch)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, BRANCH_SLUG_CAP) || 'branch'
  );
}

/**
 * The bucket key for a branch: `<slug>-<8hex>` where the 8 hex chars are the
 * first 8 of sha256 over the RAW branch name (pre-slug), so two branches
 * whose slugs collide ("Feature/Foo" vs "feature/foo", 65+-char names that
 * truncate identically) still get distinct keys. Deterministic across
 * platforms and runs — pure string function, no git involved.
 */
export function branchKeyFor(branch) {
  const hash = crypto.createHash('sha256').update(String(branch)).digest('hex').slice(0, 8);
  return `${branchSlug(branch)}-${hash}`;
}

/** The non-promotable bucket key for a detached HEAD at `headSha`. */
export function detachedKeyFor(headSha) {
  return `detached-${String(headSha).slice(0, DETACHED_SHORT_SHA_LEN)}`;
}

/** True for the `detached-<12hex>` key shape — never promotable, derived from
 * the key at decision time (bucket meta.json is a cache, never authority). */
export function isDetachedKey(key) {
  return /^detached-[0-9a-f]{12}$/.test(String(key || ''));
}

/**
 * Default-branch resolution (blueprint P1, normative): the store config.json
 * `defaultBranch` field wins; else the branch `origin/HEAD` points at; else
 * null — NEVER guessed. Callers that route writes fail closed to branch-local
 * on null; `base:` provenance is simply omitted.
 */
export function resolveDefaultBranch(workspace, { home } = {}) {
  try {
    const dir = storeDir(workspace, { home });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (parsed && typeof parsed.defaultBranch === 'string' && parsed.defaultBranch.trim()) {
      return { name: parsed.defaultBranch.trim(), source: 'config' };
    }
  } catch {
    // absent/corrupt config — fall through to origin/HEAD
  }
  const originHead = gitOut(workspace, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead && originHead.startsWith('refs/remotes/origin/')) {
    return { name: originHead.slice('refs/remotes/origin/'.length), source: 'origin-head' };
  }
  return null;
}

/** merge-base of HEAD with the resolved default branch, or null when the
 * default branch is unresolvable or shares no history. Tries the remote
 * tracking ref first (the fetched baseline a feature branch actually forked
 * from), then the local branch. */
function mergeBaseWithDefault(workspace, defaultBranch) {
  if (!defaultBranch) return null;
  for (const ref of [`refs/remotes/origin/${defaultBranch.name}`, `refs/heads/${defaultBranch.name}`]) {
    if (gitOut(workspace, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === null) continue;
    const base = gitOut(workspace, ['merge-base', 'HEAD', ref]);
    if (base) return base;
  }
  return null;
}

/**
 * Derive `{ branch, branchKey, worktree, detached, headSha, baseSha }` from a
 * workspace directory.
 *
 * - `branch` — the RAW current branch name (`git symbolic-ref --short HEAD`),
 *   null when detached or not a repo. symbolic-ref (not
 *   `rev-parse --abbrev-ref`) so an unborn branch (fresh `git init`, no
 *   commits) still reports its name, and a rebase/bisect state — where HEAD
 *   is genuinely detached and abbrev-ref would print the literal `HEAD` —
 *   resolves to detached like any other detached state.
 * - `branchKey` — `<slug>-<8hex>` (branchKeyFor), or `detached-<12hex>` on a
 *   detached HEAD, or null when neither a branch nor a commit exists.
 * - `worktree` — `git rev-parse --show-toplevel` (the checkout root this
 *   workspace resolves into; a linked worktree reports its own root).
 * - `detached` — true whenever HEAD is not on a branch (plain detach,
 *   rebase, bisect).
 * - `headSha` — full current commit sha, null on an unborn branch.
 * - `baseSha` — merge-base with the configured default branch
 *   (resolveDefaultBranch), null when unresolvable. Never guessed.
 */
export function deriveGitContext({ workspace, home } = {}) {
  const empty = { branch: null, branchKey: null, worktree: null, detached: false, headSha: null, baseSha: null };
  if (!workspace) return empty;
  const worktree = gitOut(workspace, ['rev-parse', '--show-toplevel']);
  if (!worktree) return empty;

  const headSha = gitOut(workspace, ['rev-parse', 'HEAD']);
  const branch = gitOut(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const detached = !branch && Boolean(headSha);

  let branchKey = null;
  if (branch) branchKey = branchKeyFor(branch);
  else if (detached) branchKey = detachedKeyFor(headSha);

  const baseSha = headSha ? mergeBaseWithDefault(workspace, resolveDefaultBranch(workspace, { home })) : null;

  return { branch: branch || null, branchKey, worktree, detached, headSha: headSha || null, baseSha };
}
