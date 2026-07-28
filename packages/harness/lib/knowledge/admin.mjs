import fs from 'node:fs';
import path from 'node:path';
import {
  ensureStore,
  storeDir,
  listLearnings,
  readLedger,
  commitStore,
  parseLearningFrontmatter,
  readStoreConfig,
} from './store.mjs';
import { rebuildIndex, todayClamped } from './apply.mjs';
import { consolidateStatus } from './consolidate.mjs';

/**
 * Human deletion always wins: purge is never mode-gated — it runs in every
 * knowledge mode, including 'off'. Mode is the kill switch for the harness's
 * own writes (remember, consolidate, insight capture); purge is a person
 * reaching in directly, so it always executes.
 */

function yamlQuote(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Rewrite one learning file dropping its link to `targetPath`, preserving
 * every other field in the exact order `renderLearning` (apply.mjs) writes
 * so the file stays byte-shape-compatible with the sole-writer's output.
 */
export function removeEpisodeLink(file, targetPath) {
  const text = fs.readFileSync(file, 'utf8');
  const { fm, body } = parseLearningFrontmatter(text);
  const episodes = (fm.episodes || []).filter((e) => e.path !== targetPath);
  const anchors = fm.anchors || [];
  const lines = [
    '---',
    'schema: 1',
    `trigger: ${yamlQuote(fm.trigger || '')}`,
    `status: ${fm.status || 'active'}`,
    `source: ${fm.source || 'auto'}`,
    'episodes:',
  ];
  for (const e of episodes) {
    lines.push(`  - path: ${e.path}`);
    lines.push(`    sha256: ${yamlQuote(e.sha256)}`);
    lines.push(`    kind: ${e.kind}`);
    lines.push(`    plan: ${e.plan || ''}`);
  }
  if (anchors.length) {
    lines.push('anchors:');
    for (const a of anchors) lines.push(`  - ${a}`);
  } else {
    lines.push('anchors: []');
  }
  lines.push(`superseded_by: ${fm.superseded_by || 'null'}`);
  // Preserve the parsed value — a purge is a negative event on this
  // learning's remaining evidence, not a fresh human confirmation, so it must
  // never refresh the last_confirmed trust signal.
  lines.push(`last_confirmed: ${fm.last_confirmed || todayClamped()}`);
  if (fm.merged_from) lines.push(`merged_from: ${fm.merged_from}`);
  lines.push(`origin: ${fm.origin || 'unknown'}`);
  lines.push('---', '', body.trim(), '');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return episodes;
}

/**
 * Cascade-delete one episode (design §3): the episode file itself, every
 * learning it was the sole evidence for, and its link inside learnings that
 * cite it alongside other evidence. Ledger entries for the path are dropped
 * and INDEX.md is rebuilt so nothing dangling survives the purge.
 */
export function purgeEpisode({ workspace, target, home }) {
  if (!target) {
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: 'purge needs a target file path or --all',
    };
  }
  // Containment guard: a target that escapes the workspace (e.g.
  // `../../file.md`) must never reach the deletion below — checked before
  // any store access or filesystem mutation. Learnings/ledger matching still
  // uses the repo-relative `target` string as-is; only this resolved check
  // differs.
  const full = path.resolve(workspace, target);
  if (full !== workspace && !full.startsWith(workspace + path.sep)) {
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: 'purge target escapes the workspace',
    };
  }
  const { dir } = ensureStore(workspace, { home });

  const removedLearnings = [];
  const removedLinks = [];
  for (const l of listLearnings(dir)) {
    const episodes = l.fm.episodes || [];
    if (!episodes.some((e) => e.path === target)) continue;
    // Decide by the post-filter count, not the pre-filter episode count: a
    // learning can cite the same path twice with different sha256 values
    // (ADD then STRENGTHEN after the episode file was edited), so "one
    // episode total" is not the same thing as "one episode after this path
    // is removed" — removeEpisodeLink strips every link to `target`
    // regardless of sha256, so this must match that filter exactly.
    const remaining = episodes.filter((e) => e.path !== target);
    if (remaining.length === 0) {
      // No evidence left once every link to this path is gone.
      fs.rmSync(l.file, { force: true });
      removedLearnings.push(l.id);
    } else {
      removeEpisodeLink(l.file, target);
      removedLinks.push(l.id);
    }
  }

  const ledger = readLedger(dir);
  const keptLedger = ledger.filter((e) => e.path !== target);
  fs.writeFileSync(
    path.join(dir, 'consolidated.jsonl'),
    keptLedger.length ? keptLedger.map((e) => JSON.stringify(e)).join('\n') + '\n' : '',
    'utf8'
  );

  let episodeRemoved = false;
  const episodeFull = path.join(workspace, target);
  if (fs.existsSync(episodeFull)) {
    fs.rmSync(episodeFull, { force: true });
    episodeRemoved = true;
  }

  rebuildIndex(dir);
  commitStore(dir, `purge: ${target}`);

  return {
    pass: true,
    exitCode: 0,
    removed: {
      episode: episodeRemoved ? target : null,
      learnings: removedLearnings,
      links: removedLinks,
      ledger: ledger.length - keptLedger.length,
    },
    blockedReason: null,
  };
}

/**
 * Reset T2 (the learnings store) to empty: consolidated learnings and the
 * ledger are wiped, config.json (the mode) is kept. Episode files on disk
 * are untouched — they simply re-enter the consolidation debt count on the
 * next `consolidate --status`.
 */
export function purgeAll({ workspace, home }) {
  const { dir } = ensureStore(workspace, { home });
  const learningsDir = path.join(dir, 'learnings');
  let n = 0;
  if (fs.existsSync(learningsDir)) {
    for (const domain of fs.readdirSync(learningsDir, { withFileTypes: true })) {
      if (!domain.isDirectory()) continue;
      const dPath = path.join(learningsDir, domain.name);
      n += fs.readdirSync(dPath).filter((f) => f.endsWith('.md')).length;
      fs.rmSync(dPath, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(dir, 'consolidated.jsonl'), '', 'utf8');
  rebuildIndex(dir);
  commitStore(dir, 'purge: --all (store reset)');
  return { pass: true, exitCode: 0, removed: { learnings: n }, blockedReason: null };
}

/**
 * T2 reset for model-upgrade regeneration (design §2's re-derivability
 * invariant): every learning is discarded — git history in the store repo
 * still holds them, `--yes` is the only undo — and every episode, including
 * `kind: human-teaching` ones written by `remember`, re-enters consolidation
 * debt so `source: human` learnings regenerate with full authority. Unlike
 * `purgeAll`, rebuild also drops `stale.json`: a fresh model gets a clean
 * stale-anchor slate rather than exclusions computed against the old corpus.
 * Mode-gated like every other knowledge write — human purge is the only
 * always-on path.
 */
export function rebuildStore({ workspace, home, yes }) {
  const { mode } = readStoreConfig(workspace, { home });
  if (mode !== 'on') {
    return {
      pass: false,
      exitCode: 2,
      archived: null,
      debt: null,
      blockedReason: `knowledge mode is ${mode} — run: harness knowledge on`,
      nextTools: ['harness knowledge on'],
    };
  }

  // Non-creating read: a workspace/home with no store yet must never be
  // materialized by a blocked (no --yes) call — "no mutation" has to hold
  // even for the store's own existence, not just its contents.
  const storePath = storeDir(workspace, { home });
  const archivedPreview = fs.existsSync(storePath) ? listLearnings(storePath).length : 0;

  if (!yes) {
    return {
      pass: false,
      exitCode: 2,
      archived: null,
      debt: null,
      blockedReason: `rebuild resets ${archivedPreview} learnings (git history retains them) — re-run with --yes`,
      nextTools: ['harness consolidate --rebuild --yes'],
    };
  }

  // Mutation branch only: creating the store here (if absent) is expected —
  // --yes is an explicit go-ahead, unlike the preview above.
  const { dir } = ensureStore(workspace, { home });
  const archived = listLearnings(dir).length;

  const learningsDir = path.join(dir, 'learnings');
  if (fs.existsSync(learningsDir)) {
    for (const domain of fs.readdirSync(learningsDir, { withFileTypes: true })) {
      if (!domain.isDirectory()) continue;
      fs.rmSync(path.join(learningsDir, domain.name), { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(dir, 'consolidated.jsonl'), '', 'utf8');
  rebuildIndex(dir);
  fs.rmSync(path.join(dir, 'stale.json'), { force: true });
  commitStore(dir, `consolidate: rebuild reset (${archived} learnings archived to git history)`);

  const { debt } = consolidateStatus({ workspace, home });
  return {
    pass: true,
    exitCode: 0,
    archived,
    debt,
    blockedReason: null,
    nextTools: ['harness consolidate --candidates'],
  };
}
