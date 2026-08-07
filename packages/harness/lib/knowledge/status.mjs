import fs from 'node:fs';
import { storeDir, listLearnings, readStoreConfig } from './store.mjs';
import { isActiveFm, bucketCounts } from './consolidate.mjs';
import { listBuckets, bucketAncestryOk, safeBranchName, isBucketBaseSha } from './overlay.mjs';
import { deriveGitContext, isDetachedKey } from '../git-context.mjs';
import { indexStatus } from '../index-status.mjs';

/**
 * `harness knowledge status` (blueprint P6, Phase 1): a read-only, layer-aware
 * report — golden per-domain counts, branch-bucket rows when buckets exist,
 * and the recall-index drift line (index-status.mjs's existing signals,
 * labeled as exactly what they measure). Never creates the store, never
 * mutates anything.
 *
 * Promotability is DERIVED from the key shape at decision time
 * (`detached-*` is never promotable) — bucket meta.json is a cache, never
 * authority. A bucket whose recorded baseSha provably shares no history with
 * the current HEAD (force-push name reuse) is flagged `ancestryOk: false`,
 * matching the overlay's read-time exclusion.
 */
export function knowledgeStatus({ workspace, copilotHome, home } = {}) {
  const dir = storeDir(workspace, { home });
  const storeExists = fs.existsSync(dir);
  const { mode, commit } = readStoreConfig(workspace, { home });

  let context = null;
  try {
    const derived = deriveGitContext({ workspace, home });
    if (derived.branch || derived.detached) {
      context = { branch: safeBranchName(derived.branch), branchKey: derived.branchKey, detached: derived.detached };
    }
  } catch {
    context = null;
  }

  const domainsMap = new Map();
  let goldenActive = 0;
  let goldenTotal = 0;
  if (storeExists) {
    for (const l of listLearnings(dir)) {
      goldenTotal += 1;
      const bucket = domainsMap.get(l.domain) || { domain: l.domain, active: 0, total: 0 };
      bucket.total += 1;
      if (isActiveFm(l.fm)) {
        bucket.active += 1;
        goldenActive += 1;
      }
      domainsMap.set(l.domain, bucket);
    }
  }
  const domains = [...domainsMap.values()].sort((a, b) => a.domain.localeCompare(b.domain));

  const buckets = [];
  if (storeExists) {
    for (const { key, dir: bucketDir, meta } of listBuckets(dir)) {
      // ONE occupancy predicate, shared with `knowledge prune`'s confirmation
      // gate (bucketCounts, consolidate.mjs) — the two used to disagree about
      // which buckets held live work.
      let active = 0;
      let total = 0;
      let promoted = 0;
      try {
        ({ active, promoted, total } = bucketCounts(listLearnings(bucketDir)));
      } catch {
        // unreadable bucket — counts stay zero, the row still surfaces
      }
      const createdAt = typeof meta?.createdAt === 'string' ? meta.createdAt : null;
      const ageDays = createdAt && !Number.isNaN(Date.parse(createdAt))
        ? Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000))
        : null;
      buckets.push({
        key,
        branch: safeBranchName(meta?.branch),
        // Same 40-hex gate `bucketAncestryOk` applies before handing the value
        // to git (isBucketBaseSha, overlay.mjs). meta.json is hand-editable, so
        // an arbitrary string here reached both the rendered row and the
        // `--json` lane verbatim — the one untreated field on a report whose
        // every other untrusted string is shape-checked or redacted.
        baseSha: isBucketBaseSha(meta?.baseSha) ? meta.baseSha : null,
        createdAt,
        ageDays,
        // Derived from the key shape, never trusted from meta (cache only).
        promotable: !isDetachedKey(key),
        active,
        total,
        promoted,
        prunable: total > 0 && active === 0,
        ancestryOk: bucketAncestryOk(workspace, meta),
      });
    }
  }

  let drift = null;
  try {
    const status = indexStatus({ workspace, copilotHome });
    drift = {
      indexed: Boolean(status.indexed),
      stale: Boolean(status.stale),
      commitsSince: status.commitsSince ?? null,
      filesChanged: status.filesChanged ?? null,
      recommendation: status.recommendation,
    };
  } catch {
    drift = null;
  }

  return {
    pass: true,
    exitCode: 0,
    storeExists,
    storeDir: dir,
    mode,
    commit,
    context,
    golden: { active: goldenActive, total: goldenTotal, domains },
    buckets,
    drift,
  };
}
