import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveIndexDir } from './recall-config.mjs';

function git(workspace, args) {
  const r = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

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

  const head = git(workspace, ['rev-parse', 'HEAD']);

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

  const stale = (commitsSince || 0) > 0;
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
