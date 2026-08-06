import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveGitContext, resolveDefaultBranch, isDetachedKey } from '../git-context.mjs';
import { branchesRoot, bucketDirFor, listBuckets, bucketAncestryOk, isSafeBucketKey } from './overlay.mjs';
import { readSession } from '../session.mjs';
import { assertRealpathContained, assertNoSymlinkAncestors } from '../fs-safe.mjs';
import { writeStoreFile, storeFileState } from './store-io.mjs';

/**
 * Layer-aware WRITE routing (blueprint P4, normative routing table):
 *
 *   | Git context            | Destination                              |
 *   |------------------------|------------------------------------------|
 *   | Feature branch         | branch bucket (`branches/<key>/`)        |
 *   | Default branch         | golden                                   |
 *   | Detached HEAD          | `branches/detached-<shortsha>/` (never   |
 *   |                        | promotable — derived from the key shape) |
 *   | `--layer golden`       | golden (explicit override, logged —      |
 *   |                        | HUMAN-GATED at admission, see apply.mjs) |
 *   | Non-git workspace      | golden (no branch concept exists)        |
 *
 * The layer is derived from git context AT WRITE TIME — the branch recorded
 * at orient is advisory only; when the two disagree the routing result
 * carries a warning the caller logs. Default-branch resolution follows
 * git-context.mjs's normative order (store config.json `defaultBranch` →
 * `origin/HEAD` → unresolved); when the default is UNRESOLVABLE on a real
 * branch, routing fails closed TO BRANCH-LOCAL — never golden.
 */
export function resolveWriteLayer({ workspace, home, layerOverride = null, log = () => {} } = {}) {
  const context = deriveGitContext({ workspace, home });
  const defaultBranch = resolveDefaultBranch(workspace, { home });

  // Orient-recorded branch is advisory: warn when write-time HEAD disagrees.
  let branchWarning = null;
  try {
    const session = readSession(workspace);
    const oriented = session?.gitBranch || null;
    const current = context.branch || (context.detached ? '(detached)' : null);
    if (oriented && current && oriented !== current) {
      branchWarning = `oriented on branch ${oriented} but writing from ${current} — layer routed from the write-time HEAD`;
      log(branchWarning);
    }
  } catch {
    branchWarning = null;
  }

  if (layerOverride === 'golden') {
    log('layer override: --layer golden (explicit) — writing to the golden layer');
    return { layer: 'golden', bucketKey: null, context, defaultBranch, override: true, branchWarning };
  }

  if (context.detached) {
    return { layer: 'branch', bucketKey: context.branchKey, context, defaultBranch, detached: true, branchWarning };
  }
  if (!context.branch) {
    // Non-git workspace (or unborn detached state with no commit): no branch
    // concept exists, so the pre-layer behavior — golden — stands.
    return { layer: 'golden', bucketKey: null, context, defaultBranch, branchWarning };
  }
  if (defaultBranch && context.branch === defaultBranch.name) {
    return { layer: 'golden', bucketKey: null, context, defaultBranch, branchWarning };
  }
  // Feature branch — or a real branch with an UNRESOLVABLE default, which
  // fails closed to branch-local (never golden).
  return {
    layer: 'branch',
    bucketKey: context.branchKey,
    context,
    defaultBranch,
    failedClosed: !defaultBranch,
    branchWarning,
  };
}

/**
 * Create (or refresh the cache of) a branch bucket inside an already-locked
 * store transaction. meta.json is a CACHE, never authority — promotability is
 * derived from the key shape at decision time (`detached-*` never
 * promotable); the recorded flag is display convenience only.
 */
export function ensureBucket(dir, { key, branch = null, baseSha = null }) {
  const bucketDir = bucketDirFor(dir, key);
  fs.mkdirSync(path.join(bucketDir, 'learnings'), { recursive: true });
  // Every bucket file goes through the choke point (R1), and `storeFileState`
  // — never `fs.existsSync`, which FOLLOWS a symlink — decides whether one is
  // already there: a planted link at a bucket's ledger/index/meta read as
  // "already fine" and was then written through by the next writer.
  // Same rule as ensureStore's seed: create only what is absent or a
  // quarantinable plant; never replace a real file or something that is not a
  // file at all.
  const seed = (file, content) => {
    const state = storeFileState(file);
    if (state !== 'absent' && state !== 'symlink') return;
    if (!writeStoreFile(file, content)) {
      throw new Error(`refused to create ${file} — the path does not resolve safely inside the knowledge store`);
    }
  };
  const ledgerPath = path.join(bucketDir, 'consolidated.jsonl');
  seed(ledgerPath, '');
  const indexPath = path.join(bucketDir, 'INDEX.md');
  seed(indexPath, '# Learnings Index (branch bucket)\n\n_Rebuilt by `harness consolidate --apply`._\n');
  const metaPath = path.join(bucketDir, 'meta.json');
  if (storeFileState(metaPath) !== 'file') {
    const meta = {
      branch,
      branchKey: key,
      baseSha,
      createdAt: new Date().toISOString(),
      promotable: !isDetachedKey(key),
    };
    seed(metaPath, JSON.stringify(meta) + '\n');
  }
  return bucketDir;
}

/** Every ref name (`refs/heads/...`, `refs/remotes/...`) in the workspace. */
function listRefs(workspace) {
  try {
    const res = spawnSync('git', ['show-ref'], { cwd: workspace, encoding: 'utf8', timeout: 10_000 });
    if (res.status !== 0) return null;
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')[1])
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** True when `branch` exists locally or on any remote; null when git state is
 * unreadable (callers treat null as "cannot verify", never as missing). */
export function branchExists(workspace, branch) {
  if (!branch) return null;
  const refs = listRefs(workspace);
  if (refs === null) return null;
  return refs.some((r) => {
    if (r === `refs/heads/${branch}`) return true;
    // A remote ref must be exactly `refs/remotes/<remote>/<branch>` — one
    // remote-name segment, then the FULL branch name. A bare endsWith
    // over-matches: refs/remotes/origin/release/main is not branch 'main'.
    if (!r.startsWith('refs/remotes/')) return false;
    const rest = r.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    return slash !== -1 && rest.slice(slash + 1) === branch;
  });
}

/**
 * Best-effort branch-rename auto-migration (blueprint P7), run inside the
 * write transaction when routing targets a bucket that does not exist yet:
 * when exactly ONE existing bucket names a branch that no longer exists
 * locally or on any remote AND its recorded base is an ancestor of the
 * current HEAD, that bucket is renamed to the new key and its meta cache
 * rewritten. Anything ambiguous (zero or several candidates, unverifiable
 * git state, detached buckets) is left untouched — the orphan surfaces via
 * `knowledge status` and doctor K5 for manual prune or migrate.
 */
export function migrateRenamedBucket(dir, { workspace, context }) {
  if (!context?.branchKey || !context.branch) return null;
  if (fs.existsSync(bucketDirFor(dir, context.branchKey))) return null;
  const candidates = [];
  for (const bucket of listBuckets(dir)) {
    if (isDetachedKey(bucket.key)) continue;
    const branch = bucket.meta?.branch;
    if (!branch || branch === context.branch) continue;
    if (branchExists(workspace, branch) !== false) continue; // exists or unverifiable — not a rename candidate
    if (bucketAncestryOk(workspace, bucket.meta) !== true) continue; // unrelated or unverifiable history
    candidates.push(bucket);
  }
  if (candidates.length !== 1) return null;
  const [source] = candidates;
  // Defense in depth (fs-safe.mjs): a rename moves a whole directory tree, and
  // both endpoints are derived from `branches/` — a hand-editable tree — and
  // from a branch name. Refuse unless both keys are plain bucket names, the
  // source's REAL path still sits inside the store, and no symlinked component
  // stands on the destination path.
  if (!isSafeBucketKey(source.key) || !isSafeBucketKey(context.branchKey)) return null;
  const containedSource = assertRealpathContained(dir, path.join('branches', source.key));
  if (!containedSource) return null;
  const target = assertNoSymlinkAncestors(dir, path.join('branches', context.branchKey));
  if (!target) return null;
  try {
    // Rewrite the meta cache in the SOURCE dir first, THEN rename: if the
    // meta write throws, the bucket has not moved yet, so nothing is left
    // migrated-but-unrecorded with a stale meta.branch. (Meta is a cache,
    // never authority — a failed rename leaving updated meta under the old
    // key is the recoverable orphan `knowledge status`/doctor K5 surface.)
    const meta = source.meta || {};
    // A refused meta write must STOP the migration: the rename below would
    // otherwise move the bucket with a stale `meta.branch`, which is exactly
    // the migrated-but-unrecorded state the write-then-rename order avoids.
    if (!writeStoreFile(path.join(source.dir, 'meta.json'), JSON.stringify({ ...meta, branch: context.branch, branchKey: context.branchKey }) + '\n')) {
      return null;
    }
    fs.renameSync(containedSource, target);
    return { migrated: true, from: source.key, to: context.branchKey };
  } catch {
    return null;
  }
}

/**
 * Per-layer episode eligibility (blueprint P4 + §5a rebuild routing), applied
 * to consolidation candidacy once a store HAS buckets:
 *
 *  - GOLDEN lane: only episodes whose `branch:` provenance names the
 *    resolved default branch are eligible. An episode naming an unpromoted
 *    non-default branch is skipped (merged evidence never becomes a golden
 *    claim without the explicit promotion step), and an episode WITHOUT
 *    provenance routes to branch-local review — never silently golden.
 *  - BRANCH lane: episodes from the CURRENT branch plus provenance-less
 *    episodes (the branch-local review destination) are eligible; episodes
 *    naming a DIFFERENT branch are that branch's business.
 *
 * A store with no buckets predates the layer model: everything stays
 * eligible, preserving pre-layer behavior byte-for-byte.
 */
export function episodeEligibleForLayer(episodeBranch, { layer, currentBranch, defaultBranchName, storeHasBuckets }) {
  if (!storeHasBuckets) return true;
  if (layer === 'golden') {
    return Boolean(episodeBranch) && Boolean(defaultBranchName) && episodeBranch === defaultBranchName;
  }
  return !episodeBranch || episodeBranch === currentBranch;
}

export function storeHasBuckets(dir) {
  try {
    return fs.existsSync(branchesRoot(dir)) && listBuckets(dir).length > 0;
  } catch {
    return false;
  }
}
