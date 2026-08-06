import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { storeDir, listLearnings, readGovernance } from './store.mjs';
import { isActiveFm, MAX_OPS_PER_RUN } from './consolidate.mjs';
import { bucketDirFor, readBucketMeta, listBuckets, bucketAncestryOk, isSafeBucketKey } from './overlay.mjs';
import { deriveGitContext, isDetachedKey } from '../git-context.mjs';
import { writeFileContained } from '../fs-safe.mjs';
import { readLearningFile } from './learning-io.mjs';

/**
 * `harness knowledge promote` (blueprint §5): emits a REVIEWABLE op-set at
 * the distinct path `.harness/promote-ops.json` — it never writes the store
 * itself. The op-set is applied only through `consolidate --apply` running in
 * promotion mode (apply.mjs recognizes the `promotion` envelope), where the
 * §5 mechanics bind: candidacy exemption backed by the sha256s recorded at
 * branch-apply time, a never-strike rejection class, the protected-target
 * dispute rule, and the `absorb-branch` audit ledger action.
 *
 * Shadow mapping: a branch claim whose golden twin carries the SAME trigger
 * and body is an episodes-only overlap → STRENGTHEN (just the new evidence);
 * any other same-id twin → SUPERSEDE (the branch claim becomes the
 * authoritative version); no twin → ADD.
 *
 * `--all` chunks under MAX_OPS_PER_RUN with deterministic id ordering as the
 * cursor — the emitted set is always the first chunk; `remaining: N` reports
 * what a later run will pick up once these land and are tombstoned.
 */

export const PROMOTE_OPS_REL = path.join('.harness', 'promote-ops.json');

export function promotionDigest(ops) {
  return crypto.createHash('sha256').update(JSON.stringify(ops)).digest('hex');
}

export function buildPromotionOps({ workspace, home, branchKey = null, ids = null, all = false, log = () => {} } = {}) {
  const dir = storeDir(workspace, { home });
  if (!fs.existsSync(dir)) {
    return { pass: false, exitCode: 2, opsPath: null, ops: 0, remaining: 0, skipped: [], blockedReason: 'no knowledge store — nothing to promote' };
  }

  // Resolve the source bucket: explicit --branch key, else the current
  // branch's bucket from write-time git context.
  let key = branchKey;
  if (!key) {
    try {
      key = deriveGitContext({ workspace, home }).branchKey;
    } catch {
      key = null;
    }
  }
  if (!key) {
    return { pass: false, exitCode: 2, opsPath: null, ops: 0, remaining: 0, skipped: [], blockedReason: 'no branch bucket resolvable — pass --branch <key> (see harness knowledge status)' };
  }
  // Path-safety: a bucket key is a plain directory name under branches/,
  // never a path — ONE shared shape check (isSafeBucketKey, overlay.mjs) that
  // apply.mjs re-derives on the promotion envelope's branchKey at write time,
  // so an explicit --branch value can never traverse outside the store via
  // bucketDirFor's path.join and the emitter/writer can never drift.
  if (!isSafeBucketKey(key)) {
    return { pass: false, exitCode: 2, opsPath: null, ops: 0, remaining: 0, skipped: [], blockedReason: `invalid branch key ${key} — bucket keys are plain directory names (see harness knowledge status)` };
  }
  if (isDetachedKey(key)) {
    return { pass: false, exitCode: 2, opsPath: null, ops: 0, remaining: 0, skipped: [], blockedReason: `${key} is a detached-HEAD bucket — never promotable (derived from the key shape)` };
  }
  const bucketDir = bucketDirFor(dir, key);
  if (!fs.existsSync(path.join(bucketDir, 'learnings'))) {
    const known = listBuckets(dir).map((b) => b.key);
    return {
      pass: false,
      exitCode: 2,
      opsPath: null,
      ops: 0,
      remaining: 0,
      skipped: [],
      blockedReason: `no bucket ${key}${known.length ? ` — known buckets: ${known.join(', ')}` : ' — no buckets exist yet'}`,
    };
  }

  // Ancestry gate (P7): a bucket whose recorded base PROVABLY shares no
  // history with the current HEAD (force-push branch-name reuse) is excluded
  // from the overlay — it must never promote to golden either. Matching the
  // read path's semantics, only a verified `false` refuses; `null`
  // (unverifiable — no recorded base, or git unavailable) stays allowed.
  const bucketMeta = readBucketMeta(bucketDir);
  if (bucketAncestryOk(workspace, bucketMeta) === false) {
    return {
      pass: false,
      exitCode: 2,
      opsPath: null,
      ops: 0,
      remaining: 0,
      skipped: [],
      blockedReason: `bucket ${key} has unrelated history — its recorded base is not an ancestor of HEAD (branch-name reuse); prune it instead: harness knowledge prune --branch ${key}`,
    };
  }

  const requested = ids && ids.length ? new Set(ids) : null;
  if (!requested && !all) {
    return { pass: false, exitCode: 2, opsPath: null, ops: 0, remaining: 0, skipped: [], blockedReason: 'promote needs --ids a,b or --all' };
  }

  const governance = readGovernance(dir);
  const goldenById = new Map(listLearnings(dir).map((l) => [l.id, l]));
  const sources = listLearnings(bucketDir)
    .filter((l) => !l.fm.promoted_to_golden && isActiveFm(l.fm))
    .filter((l) => !requested || requested.has(l.id))
    .sort((a, b) => a.id.localeCompare(b.id)); // deterministic ordering IS the cursor

  const skipped = [];
  const promotable = [];
  // Through the choke point (S1), and the SAME reader apply.mjs re-hashes with
  // at write time — so the emitted `source.sha256` and the write-time
  // re-verification can never disagree about what the file's bytes are, and
  // neither of them can be steered onto an outside file by a planted symlink.
  const sourceSha = (learning) => {
    const text = readLearningFile(learning.file);
    return text === null ? null : crypto.createHash('sha256').update(text).digest('hex');
  };
  for (const source of sources) {
    const decision = governance.get(source.id);
    if (decision && ['retire', 'dispute', 'promote'].includes(decision.action)) {
      skipped.push({ id: source.id, reason: `standing governance decision: ${decision.action}` });
      continue;
    }
    const sha256 = sourceSha(source);
    if (sha256 === null) {
      skipped.push({ id: source.id, reason: 'learning file could not be read safely from the store' });
      continue;
    }
    const twin = goldenById.get(source.id);
    if (twin) {
      const sameClaim = (twin.fm.trigger || '') === (source.fm.trigger || '') && twin.body.trim() === source.body.trim();
      if (sameClaim) {
        const known = new Set((twin.fm.episodes || []).map((e) => `${e.path}@${e.sha256}`));
        const newEpisodes = (source.fm.episodes || []).filter((e) => e.path && !known.has(`${e.path}@${e.sha256}`));
        if (!newEpisodes.length) {
          skipped.push({ id: source.id, reason: 'identical to golden with no new evidence — prune the bucket instead' });
          continue;
        }
        promotable.push({
          op: 'STRENGTHEN',
          target: source.id,
          episodes: newEpisodes.map((e) => ({ path: e.path, sha256: e.sha256, kind: e.kind, plan: e.plan || null })),
          source: { id: source.id, sha256 },
        });
        continue;
      }
    }
    promotable.push({
      op: twin ? 'SUPERSEDE' : 'ADD',
      ...(twin ? { target: source.id } : {}),
      domain: source.domain,
      slug: source.slug,
      trigger: source.fm.trigger || '',
      body: source.body,
      episodes: (source.fm.episodes || []).filter((e) => e.path).map((e) => ({ path: e.path, sha256: e.sha256, kind: e.kind, plan: e.plan || null })),
      source: { id: source.id, sha256 },
    });
  }

  if (requested) {
    for (const id of requested) {
      if (!sources.some((s) => s.id === id)) skipped.push({ id, reason: 'not an active, unpromoted learning in this bucket' });
    }
  }

  // Chunk under MAX_OPS_PER_RUN (each promotion op touches one file).
  const chunk = promotable.slice(0, MAX_OPS_PER_RUN);
  const remaining = promotable.length - chunk.length;

  if (!chunk.length) {
    return { pass: false, exitCode: 2, opsPath: null, ops: 0, remaining: 0, skipped, blockedReason: 'nothing promotable in this bucket' };
  }

  const opset = {
    schema: 1,
    promotion: { branchKey: key, meta: bucketMeta, digest: promotionDigest(chunk) },
    ops: chunk,
  };
  // Contained, atomic write (fs-safe.mjs) — the same discipline every sibling
  // workspace write uses. A symlinked `.harness/` (or any ancestor of it)
  // must never let this op-set land outside the workspace, and a partially
  // written op-set must never be readable by a concurrent `consolidate
  // --apply`.
  const written = writeFileContained(workspace, PROMOTE_OPS_REL, JSON.stringify(opset, null, 2) + '\n');
  if (!written) {
    return {
      pass: false,
      exitCode: 1,
      opsPath: null,
      ops: 0,
      remaining: 0,
      skipped,
      blockedReason: `refused to write ${PROMOTE_OPS_REL} — a symlinked path component would place it outside the workspace`,
    };
  }
  log(`wrote ${PROMOTE_OPS_REL} (${chunk.length} op(s), ${remaining} remaining)`);
  return {
    pass: true,
    exitCode: 0,
    opsPath: PROMOTE_OPS_REL,
    ops: chunk.length,
    remaining,
    skipped,
    bucketKey: key,
    blockedReason: null,
    nextTools: [`harness consolidate --apply --ops ${PROMOTE_OPS_REL}`],
  };
}
