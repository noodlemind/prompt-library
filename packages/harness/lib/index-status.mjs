import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveIndexDir } from './recall-config.mjs';
import { POSTINGS_INDEX_VERSION } from './postings-index.mjs';

function git(workspace, args) {
  const r = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Deterministic freshness report for the knowledge index (zero model cost).
 * The repo map itself is regenerated on every `orient`, so it is never stale;
 * this measures how far the knowledge index has drifted from the working tree
 * since it was last built, so the user knows when to re-run `harness index`.
 */
export function indexStatus({ workspace, copilotHome }) {
  const indexDir = resolveIndexDir(copilotHome, workspace);
  const metaPath = path.join(indexDir, 'meta.json');
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    meta = null;
  }
  if (!meta) return { indexed: false, recommendation: 'run `harness index` — no index built yet' };

  if (meta.version !== POSTINGS_INDEX_VERSION) {
    return {
      indexed: true,
      updated: meta.updated || null,
      indexedHead: meta.headSha || null,
      currentHead: git(workspace, ['rev-parse', 'HEAD']),
      commitsSince: null,
      filesChanged: null,
      stale: true,
      recommendation: `index format ${meta.version ?? 'unknown'} is obsolete — run \`harness index\` to rebuild format ${POSTINGS_INDEX_VERSION}`,
    };
  }

  const head = git(workspace, ['rev-parse', 'HEAD']);

  // An index without a stamped HEAD (older format, or a rebuild that never
  // captured HEAD) has an unknown baseline — treat it as stale, not current,
  // so the user is nudged to rebuild rather than trusting a silent gap.
  if (!meta.headSha) {
    return {
      indexed: true,
      updated: meta.updated || null,
      indexedHead: null,
      currentHead: head || null,
      commitsSince: null,
      filesChanged: null,
      stale: true,
      recommendation: 'index has no recorded HEAD baseline — run `harness index` to refresh knowledge',
    };
  }

  let commitsSince = null;
  let filesChanged = null;
  if (head && meta.headSha !== head) {
    const count = git(workspace, ['rev-list', '--count', `${meta.headSha}..HEAD`]);
    commitsSince = count ? Number(count) : null;
    const diff = git(workspace, ['diff', '--name-only', meta.headSha, 'HEAD']);
    filesChanged = diff ? diff.split('\n').filter(Boolean).length : null;
  }

  // A baseline is current only when it exactly matches a resolvable HEAD.
  // Commit counts are diagnostics, not proof of equivalence: checking out an
  // ancestor yields zero for indexedHead..HEAD while still changing content.
  const stale = !head || meta.headSha !== head;
  return {
    indexed: true,
    updated: meta.updated || null,
    indexedHead: meta.headSha,
    currentHead: head || null,
    commitsSince,
    filesChanged,
    stale,
    recommendation: stale
      ? `${commitsSince ?? '?'} commits / ${filesChanged ?? '?'} files since last index — run \`harness index\` to refresh knowledge`
      : 'index is current with HEAD',
  };
}
