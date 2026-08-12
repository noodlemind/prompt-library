import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveIndexDir } from './recall-config.mjs';
import { structuralIndexDir, readStructuralIndex } from './repo-map/structural-index.mjs';

function git(workspace, args) {
  const r = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function driftFromHead(workspace, indexedHead) {
  const head = git(workspace, ['rev-parse', 'HEAD']);
  let commitsSince = null;
  let filesChanged = null;
  if (head && indexedHead && indexedHead !== head) {
    const count = git(workspace, ['rev-list', '--count', `${indexedHead}..HEAD`]);
    commitsSince = count ? Number(count) : null;
    const diff = git(workspace, ['diff', '--name-only', indexedHead, 'HEAD']);
    filesChanged = diff ? diff.split('\n').filter(Boolean).length : null;
  }
  // Any HEAD mismatch is stale — including checkouts of ancestors (commitsSince
  // is 0) and divergent histories where rev-list cannot count a range.
  const stale = Boolean(head && indexedHead && indexedHead !== head);
  return { head, commitsSince, filesChanged, stale };
}

/**
 * Knowledge / BM25 postings index under ~/.copilot/knowledge/.harness-index.
 * Built by bare `harness index`.
 */
export function knowledgeIndexStatus({ workspace, copilotHome }) {
  const indexDir = resolveIndexDir(copilotHome, workspace);
  const metaPath = path.join(indexDir, 'meta.json');
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    meta = null;
  }
  if (!meta) {
    return {
      plane: 'knowledge',
      indexed: false,
      empty: null,
      entryCount: null,
      updated: null,
      indexedHead: null,
      currentHead: git(workspace, ['rev-parse', 'HEAD']),
      commitsSince: null,
      filesChanged: null,
      stale: false,
      recommendation: 'run `harness index` — knowledge index not built yet',
      next: 'harness index',
    };
  }

  const entryCount = Number.isFinite(meta.entryCount) ? meta.entryCount : null;
  const empty = entryCount === 0;
  const { head, commitsSince, filesChanged, stale } = driftFromHead(workspace, meta.headSha || null);

  if (!meta.headSha) {
    return {
      plane: 'knowledge',
      indexed: true,
      empty,
      entryCount,
      updated: meta.updated || null,
      indexedHead: null,
      currentHead: head || null,
      commitsSince: null,
      filesChanged: null,
      stale: true,
      recommendation: empty
        ? 'knowledge index is empty (0 solutions) and has no HEAD baseline — run `harness index` after compound/remember'
        : 'index has no recorded HEAD baseline — run `harness index` to refresh knowledge',
      next: 'harness index',
    };
  }

  let recommendation;
  let next = null;
  if (empty && !stale) {
    recommendation =
      'knowledge index built but empty (0 solutions) — `harness compound` or `harness remember`, then `harness index`';
    next = 'harness compound / harness remember';
  } else if (stale) {
    recommendation = `${commitsSince ?? '?'} commits / ${filesChanged ?? '?'} files since last knowledge index — run \`harness index\``;
    next = 'harness index';
  } else {
    recommendation = empty
      ? 'knowledge index current with HEAD (empty corpus)'
      : 'knowledge index is current with HEAD';
  }

  return {
    plane: 'knowledge',
    indexed: true,
    empty,
    entryCount,
    updated: meta.updated || null,
    indexedHead: meta.headSha,
    currentHead: head || null,
    commitsSince,
    filesChanged,
    stale,
    recommendation,
    next,
  };
}

/**
 * Structural / code-symbol index under ~/.harness/index/.../structural.
 * Built by `harness index --structural`.
 */
export function structuralIndexStatus(workspace) {
  const index = readStructuralIndex(workspace);
  if (!index?.meta) {
    return {
      plane: 'structural',
      indexed: false,
      filesIndexed: null,
      tier: null,
      indexedHead: null,
      currentHead: git(workspace, ['rev-parse', 'HEAD']),
      commitsSince: null,
      filesChanged: null,
      stale: false,
      unreadable: null,
      recommendation: 'run `harness index --structural` — code symbol index not built yet',
      next: 'harness index --structural',
    };
  }

  const meta = index.meta;
  const unreadable = Array.isArray(index.unreadable) ? index.unreadable.filter(Boolean) : [];
  if (unreadable.length) {
    return {
      plane: 'structural',
      indexed: true,
      filesIndexed: Number.isFinite(meta.filesIndexed) ? meta.filesIndexed : null,
      tier: meta.extractorTier || null,
      updated: meta.updated || meta.builtAt || null,
      indexedHead: meta.sha || meta.headSha || meta.baseSha || null,
      currentHead: git(workspace, ['rev-parse', 'HEAD']),
      commitsSince: null,
      filesChanged: null,
      stale: true,
      unreadable,
      recommendation: `code symbol index unreadable (${unreadable.join('; ')}) — run \`harness index --structural\``,
      next: 'harness index --structural',
    };
  }

  const indexedHead = meta.sha || meta.headSha || meta.baseSha || null;
  const { head, commitsSince, filesChanged, stale } = driftFromHead(workspace, indexedHead);
  const filesIndexed = Number.isFinite(meta.filesIndexed) ? meta.filesIndexed : null;
  const tier = meta.extractorTier || null;

  return {
    plane: 'structural',
    indexed: true,
    filesIndexed,
    tier,
    updated: meta.updated || meta.builtAt || null,
    indexedHead,
    currentHead: head || null,
    commitsSince,
    filesChanged,
    stale,
    unreadable: null,
    recommendation: stale
      ? `${commitsSince ?? '?'} commits / ${filesChanged ?? '?'} files since last code index — run \`harness index --structural\``
      : `code symbol index current${filesIndexed != null ? ` · ${filesIndexed} files` : ''}${tier ? ` · tier ${tier}` : ''}`,
    next: stale ? 'harness index --structural' : null,
  };
}

/**
 * Combined index status for CLI/TUI.
 * Backward-compatible top-level fields describe the **knowledge** plane
 * (what `indexed` historically meant). Prefer `knowledge` / `structural`.
 */
export function indexStatus({ workspace, copilotHome }) {
  const knowledge = knowledgeIndexStatus({ workspace, copilotHome });
  const structural = structuralIndexStatus(workspace);

  const parts = [];
  if (!knowledge.indexed) parts.push('knowledge: not built — run `harness index`');
  else if (knowledge.empty) parts.push('knowledge: empty (0 solutions)');
  else if (knowledge.stale) parts.push(`knowledge: stale (${knowledge.commitsSince ?? '?'} commits)`);
  else parts.push('knowledge: current');

  if (!structural.indexed) parts.push('code: not built — run `harness index --structural`');
  else if (structural.unreadable?.length) parts.push('code: unreadable — run `harness index --structural`');
  else if (structural.stale) parts.push(`code: stale (${structural.commitsSince ?? '?'} commits)`);
  else parts.push('code: current');

  return {
    indexed: knowledge.indexed,
    empty: knowledge.empty,
    entryCount: knowledge.entryCount,
    updated: knowledge.updated,
    indexedHead: knowledge.indexedHead,
    currentHead: knowledge.currentHead,
    commitsSince: knowledge.commitsSince,
    filesChanged: knowledge.filesChanged,
    stale: knowledge.stale,
    recommendation: parts.join(' · '),
    knowledge,
    structural,
    structuralDir: structural.indexed ? structuralIndexDir(workspace) : null,
  };
}
