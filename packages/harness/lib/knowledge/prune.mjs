import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { storeDir, withStoreTransaction, StoreTransactionAbort, listLearnings } from './store.mjs';
import { listBuckets, safeBranchName } from './overlay.mjs';
import { bucketCounts } from './consolidate.mjs';
import { absorbOrAbort } from './admin.mjs';
import { resolveDefaultBranch } from '../git-context.mjs';
import { assertRealpathContained } from '../fs-safe.mjs';

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
 *
 * CONFIRMATION (P2 finding): the selectors above are not occupancy tests. A
 * merged branch, a 30-day-old bucket, or an explicitly named key can still
 * hold ACTIVE, UNPROMOTED learnings — `knowledge status` reports exactly those
 * buckets as NOT prunable, while prune deleted them anyway with no preview and
 * no confirmation. Both surfaces now share ONE predicate (`bucketCounts`,
 * consolidate.mjs): anything status calls prunable (`active === 0`) still
 * prunes unattended; anything holding active work needs an explicit `--yes`,
 * and every run — refused or applied — returns a per-bucket `preview` of what
 * is at stake.
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

/** Per-bucket occupancy, via the same predicate `knowledge status` reports.
 * A bucket whose directory is unreadable counts as holding nothing knowable —
 * `active: null` — which the confirmation gate below treats as needing --yes. */
function bucketPreview(bucket) {
  let counts;
  try {
    counts = bucketCounts(listLearnings(bucket.dir));
  } catch {
    counts = null;
  }
  return {
    key: bucket.key,
    // Same untrusted-branch-name treatment `knowledge status` applies — this
    // preview is a `--json` surface too.
    branch: safeBranchName(bucket.meta?.branch),
    active: counts ? counts.active : null,
    promoted: counts ? counts.promoted : null,
    total: counts ? counts.total : null,
  };
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

export function pruneBuckets({ workspace, home, branchKey = null, merged = false, staleDays = null, yes = false, log = () => {} } = {}) {
  if (!branchKey && !merged && staleDays === null) {
    return { pass: false, exitCode: 2, removed: [], preview: [], blockedReason: 'prune needs --branch <key>, --merged, or --stale <days>' };
  }
  // Boundary validation for direct callers (the CLI's flag parser validates
  // too): a fractional or non-numeric staleDays would silently shift the
  // cutoff and prune the wrong buckets.
  if (staleDays !== null && !(Number.isSafeInteger(staleDays) && staleDays > 0)) {
    return { pass: false, exitCode: 2, removed: [], preview: [], blockedReason: `--stale needs a positive whole number of days (got ${staleDays})` };
  }
  const dir = storeDir(workspace, { home });
  if (!fs.existsSync(dir)) {
    return { pass: false, exitCode: 2, removed: [], preview: [], blockedReason: 'nothing to prune — no knowledge store yet' };
  }

  // Bucket discovery and selector evaluation both run INSIDE the transaction,
  // under the store lock — never before it — so a concurrent writer landing
  // fresh learnings in a same-key bucket can't race a stale pre-lock selection
  // into deleting them (TOCTOU). Only flag validation stays outside.
  const tx = withStoreTransaction(workspace, { home, label: 'knowledge: prune' }, ({ dir: txDir, recordCheckpoint }) => {
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
      if (err instanceof StoreTransactionAbort) throw err;
      // best effort — any other absorb hiccup never blocks a human prune.
    }

    const buckets = listBuckets(txDir);
    if (!buckets.length) {
      return { kind: 'reject', exitCode: 2, blockedReason: 'nothing to prune — no branch buckets exist' };
    }

    const selected = new Map();
    if (branchKey) {
      const hit = buckets.find((b) => b.key === branchKey);
      if (!hit) {
        return {
          kind: 'reject',
          exitCode: 2,
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
          kind: 'reject',
          exitCode: 2,
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
      return { kind: 'reject', exitCode: 2, blockedReason: 'no buckets match the given selectors — nothing pruned' };
    }

    // Preview FIRST — computed for every run, returned on both the refusal and
    // the success path, and logged line by line so a human sees what a prune
    // costs before (or as) it happens.
    const preview = [...selected.values()].map(bucketPreview).sort((a, b) => a.key.localeCompare(b.key));
    for (const p of preview) {
      log(
        `prune preview ${p.key}${p.branch ? ` (${p.branch})` : ''}: ${p.active ?? '?'} active · ${p.promoted ?? '?'} promoted · ${p.total ?? '?'} total`
      );
    }
    const losing = preview.filter((p) => p.active === null || p.active > 0);
    if (losing.length && !yes) {
      return {
        kind: 'reject',
        exitCode: 2,
        preview,
        blockedReason: `prune would delete ${losing.reduce((n, p) => n + (p.active || 0), 0)} active, unpromoted learning(s) in ${losing
          .map((p) => p.key)
          .join(', ')} — promote them first (harness knowledge promote) or re-run with --yes`,
      };
    }

    const keys = [...selected.keys()].sort();
    // ALL-OR-NOTHING (review finding). Defense in depth (fs-safe.mjs): a
    // recursive delete is the single most destructive syscall in this module,
    // and `branches/` is a hand-editable tree, so a bucket whose real path
    // resolves outside the store is refused rather than letting rmSync follow a
    // swapped ancestor. That check used to run INSIDE the delete loop, which
    // made the refusal PARTIAL: the buckets ahead of the offending one were
    // already gone, the run returned `removed: []` (this reject path reports
    // nothing removed), and withStoreTransaction still committed the deletion
    // under the generic label — a silent, unreported loss. Every selected
    // bucket is therefore containment-verified BEFORE the first rmSync; a
    // refusal now costs the whole prune, not half of it.
    const targets = [];
    for (const b of selected.values()) {
      const contained = assertRealpathContained(txDir, path.join('branches', b.key));
      if (!contained) {
        return {
          kind: 'reject',
          exitCode: 1,
          preview,
          blockedReason: `refused to prune ${b.key} — its real path resolves outside the knowledge store`,
        };
      }
      targets.push({ bucket: b, contained });
    }
    for (const { bucket, contained } of targets) {
      fs.rmSync(contained, { recursive: true, force: true });
      const shown = safeBranchName(bucket.meta?.branch);
      log(`pruned bucket ${bucket.key}${shown ? ` (${shown})` : ''}`);
    }
    return { kind: 'success', commitMessage: `knowledge: prune ${keys.join(', ')}`, keys, preview };
  });

  if (!tx.ok) {
    return {
      pass: false,
      exitCode: 1,
      removed: [],
      preview: [],
      blockedReason: tx.locked
        ? 'E_LOCKED: another operation holds the store lock'
        : `prune failed: ${tx.error?.message || 'store transaction failed'}`,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }
  const inner = tx.result;
  if (inner.kind === 'reject') {
    return {
      pass: false,
      exitCode: inner.exitCode,
      removed: [],
      preview: inner.preview || [],
      blockedReason: inner.blockedReason,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }
  return {
    pass: true,
    exitCode: 0,
    removed: inner.keys,
    preview: inner.preview || [],
    blockedReason: null,
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}
