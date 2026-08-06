import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { storeDir, withStoreTransaction, StoreTransactionAbort, listLearnings } from './store.mjs';
import { listBuckets } from './overlay.mjs';
import { absorbOrAbort } from './admin.mjs';
import { resolveDefaultBranch } from '../git-context.mjs';

/**
 * `harness knowledge prune` (blueprint P6/§5): delete branch buckets. HUMAN
 * AUTHORITY — never mode-gated (exactly like `knowledge purge`: a person
 * reaching in directly always wins, in every knowledge mode including off).
 * Removal is one store commit through the standard single-writer transaction.
 *
 * Selectors (union when combined):
 *   --branch <key>   exact bucket key
 *   --merged         buckets whose branch is merged into the resolved default
 *                    branch (workspace git state), plus fully-tombstoned
 *                    buckets (every entry promoted to golden — nothing left)
 *   --stale <days>   buckets whose meta createdAt is older than N days
 */

/** Local branches fully merged into the resolved default branch. */
function mergedBranches(workspace, defaultBranch) {
  if (!defaultBranch) return null;
  for (const ref of [`origin/${defaultBranch.name}`, defaultBranch.name]) {
    const res = spawnSync('git', ['branch', '--format=%(refname:short)', '--merged', ref], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (res.status === 0) {
      return new Set(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    }
  }
  return null;
}

/** True when every learning in the bucket is a promoted_to_golden tombstone
 * (and there is at least one) — the bucket's work fully landed golden. */
function fullyPromoted(bucket) {
  let entries;
  try {
    entries = listLearnings(bucket.dir);
  } catch {
    return false;
  }
  return entries.length > 0 && entries.every((l) => Boolean(l.fm.promoted_to_golden));
}

export function pruneBuckets({ workspace, home, branchKey = null, merged = false, staleDays = null, log = () => {} } = {}) {
  if (!branchKey && !merged && staleDays === null) {
    return { pass: false, exitCode: 2, removed: [], blockedReason: 'prune needs --branch <key>, --merged, or --stale <days>' };
  }
  const dir = storeDir(workspace, { home });
  if (!fs.existsSync(dir)) {
    return { pass: false, exitCode: 2, removed: [], blockedReason: 'nothing to prune — no knowledge store yet' };
  }
  const buckets = listBuckets(dir);
  if (!buckets.length) {
    return { pass: false, exitCode: 2, removed: [], blockedReason: 'nothing to prune — no branch buckets exist' };
  }

  const selected = new Map();
  if (branchKey) {
    const hit = buckets.find((b) => b.key === branchKey);
    if (!hit) {
      return {
        pass: false,
        exitCode: 2,
        removed: [],
        blockedReason: `no bucket ${branchKey} — known buckets: ${buckets.map((b) => b.key).join(', ')}`,
      };
    }
    selected.set(hit.key, hit);
  }
  if (merged) {
    const defaultBranch = resolveDefaultBranch(workspace, { home });
    const mergedSet = mergedBranches(workspace, defaultBranch);
    if (mergedSet === null) {
      return {
        pass: false,
        exitCode: 2,
        removed: [],
        blockedReason: 'cannot determine merged branches — default branch unresolvable (set store config.json defaultBranch or origin/HEAD)',
      };
    }
    for (const b of buckets) {
      if ((b.meta?.branch && mergedSet.has(b.meta.branch)) || fullyPromoted(b)) selected.set(b.key, b);
    }
  }
  if (staleDays !== null) {
    const cutoff = Date.now() - staleDays * 86_400_000;
    for (const b of buckets) {
      const createdAt = b.meta?.createdAt ? Date.parse(b.meta.createdAt) : NaN;
      if (!Number.isNaN(createdAt) && createdAt < cutoff) selected.set(b.key, b);
    }
  }

  if (!selected.size) {
    return { pass: false, exitCode: 2, removed: [], blockedReason: 'no buckets match the given selectors — nothing pruned' };
  }

  const keys = [...selected.keys()].sort();
  const tx = withStoreTransaction(workspace, { home, label: `knowledge: prune ${keys.join(', ')}` }, ({ recordCheckpoint }) => {
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
      if (err instanceof StoreTransactionAbort) throw err;
      // best effort — any other absorb hiccup never blocks a human prune.
    }
    for (const b of selected.values()) {
      fs.rmSync(b.dir, { recursive: true, force: true });
      log(`pruned bucket ${b.key}${b.meta?.branch ? ` (${b.meta.branch})` : ''}`);
    }
    return { kind: 'success', commitMessage: `knowledge: prune ${keys.join(', ')}` };
  });

  if (!tx.ok) {
    return {
      pass: false,
      exitCode: 1,
      removed: [],
      blockedReason: tx.locked
        ? 'E_LOCKED: another operation holds the store lock'
        : `prune failed: ${tx.error?.message || 'store transaction failed'}`,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }
  return {
    pass: true,
    exitCode: 0,
    removed: keys,
    blockedReason: null,
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}
