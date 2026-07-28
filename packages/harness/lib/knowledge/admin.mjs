import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  ensureStore,
  storeDir,
  listLearnings,
  readLedger,
  appendLedger,
  commitStore,
  parseLearningFrontmatter,
  serializeLearning,
  readStoreConfig,
} from './store.mjs';
import { rebuildIndex, todayClamped } from './apply.mjs';
import { consolidateStatus, LEARNING_BYTE_CAP, isActiveFm } from './consolidate.mjs';
import { scanSecrets } from '../secret-scan.mjs';

/**
 * Human deletion always wins: purge is never mode-gated — it runs in every
 * knowledge mode, including 'off'. Mode is the kill switch for the harness's
 * own writes (remember, consolidate, insight capture); purge is a person
 * reaching in directly, so it always executes.
 */

// Episode-header quoting (docs/solutions/<category>/*.md frontmatter) — the
// same escaping shape as compound.mjs's own local yamlQuote, kept separate
// from store.mjs's learning-file yamlQuote since the two are different file
// formats with independent schemas.
function yamlQuote(v) {
  return `"${String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * Rewrite one learning file dropping its link to `targetPath`, preserving
 * every other field via `serializeLearning` (store.mjs) so the file stays
 * byte-shape-compatible with the sole-writer's output.
 */
export function removeEpisodeLink(file, targetPath) {
  const text = fs.readFileSync(file, 'utf8');
  const { fm, body } = parseLearningFrontmatter(text);
  // Preserve every other field, including last_confirmed as parsed — a purge
  // is a negative event on this learning's remaining evidence, not a fresh
  // human confirmation, so it must never refresh the last_confirmed trust
  // signal.
  fm.episodes = (fm.episodes || []).filter((e) => e.path !== targetPath);
  fs.writeFileSync(file, serializeLearning(fm, body), 'utf8');
  return fm.episodes;
}

/**
 * Opt-in commit mode (Milestone 3 Task 6, design §11): when
 * knowledge.commit === 'repo', mirror every ACTIVE learning verbatim into
 * <workspace>/docs/knowledge/learnings/<domain>/<slug>.md plus an INDEX.md in
 * the same format the store's own rebuildIndex (apply.mjs) uses, so a human
 * skimming the product repo sees the same shape `harness learnings` does.
 * The CLI NEVER git-commits the product repo — these files land in the
 * working tree and ride the team's normal PR flow (branch protection is
 * their routing).
 *
 * Never-ingest: this is the ONLY function that ever writes to
 * docs/knowledge/learnings/ — nothing anywhere reads that directory back
 * into the store, so a foreign copy (another machine's commit, or a
 * hand-planted file) is read-only reference until a future
 * propose-then-ratify phase. The sweep below only ever removes a file whose
 * `<domain>/<slug>` matches a CURRENT store learning that is now inactive —
 * anything else (an id the store has no entry for at all, whether never
 * seen, purged away, or genuinely foreign) is left untouched. Simpler and
 * safer than trying to reconstruct "this id used to exist" from git history.
 *
 * commit === 'none' is a no-op: an existing mirror (e.g. left over from a
 * prior 'repo' period) is left exactly as it is.
 */
export function mirrorLearnings({ workspace, home, log = () => {} }) {
  const { commit } = readStoreConfig(workspace, { home });
  if (commit !== 'repo') return { mirrored: 0, skipped: 0 };

  const dir = storeDir(workspace, { home });
  const mirrorRoot = path.join(workspace, 'docs', 'knowledge', 'learnings');
  const storeLearnings = fs.existsSync(dir) ? listLearnings(dir) : [];
  const byId = new Map(storeLearnings.map((l) => [l.id, l]));
  const active = storeLearnings.filter((l) => isActiveFm(l.fm)).sort((a, b) => a.id.localeCompare(b.id));

  let mirrored = 0;
  let skipped = 0;

  fs.mkdirSync(mirrorRoot, { recursive: true });

  for (const learning of active) {
    const text = fs.readFileSync(learning.file, 'utf8');
    const secrets = scanSecrets(text);
    if (secrets.length) {
      skipped++;
      log(`mirror: secret-shaped content (${secrets.map((s) => s.id).join(', ')}) — skipped ${learning.id}`);
      continue;
    }
    const destDir = path.join(mirrorRoot, learning.domain);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, `${learning.slug}.md`), text, 'utf8');
    mirrored++;
  }

  // Sweep: remove mirror files for ids the CURRENT store still knows about
  // but that are no longer active. Unknown files (no matching store id —
  // whether genuinely foreign or an id the store has fully forgotten) are
  // left alone; only files matching a local learning id are ever managed.
  for (const domainEnt of fs.readdirSync(mirrorRoot, { withFileTypes: true })) {
    if (!domainEnt.isDirectory()) continue;
    const domainPath = path.join(mirrorRoot, domainEnt.name);
    for (const f of fs.readdirSync(domainPath)) {
      if (!f.endsWith('.md')) continue;
      const id = `${domainEnt.name}/${f.replace(/\.md$/, '')}`;
      const known = byId.get(id);
      if (known && !isActiveFm(known.fm)) {
        fs.rmSync(path.join(domainPath, f), { force: true });
      }
    }
  }

  const lines = [
    '# Learnings Index',
    '',
    '_Rebuilt by `harness consolidate --apply`. One line per active learning._',
    '',
    '> Opt-in commit mode: these learnings are copies from a local store; treat foreign entries as read-only reference.',
    '',
    ...active.map((l) => `- [${l.id}] ${l.fm.trigger || ''}`),
    '',
  ];
  fs.writeFileSync(path.join(mirrorRoot, 'INDEX.md'), lines.join('\n'), 'utf8');

  return { mirrored, skipped };
}

const LEARNING_FILE_RE = /^learnings\/([^/]+)\/([^/]+)\.md$/;

/** Parse one `git status --porcelain` line into its status code and path. */
function parsePorcelainLine(line) {
  const status = line.slice(0, 2);
  let rest = line.slice(3);
  const arrow = rest.indexOf(' -> ');
  if (arrow !== -1) rest = rest.slice(arrow + 4); // rename/copy: use the new path
  if (rest.startsWith('"') && rest.endsWith('"')) {
    rest = rest.slice(1, -1).replace(/\\(.)/g, '$1'); // git-quoted path (rare)
  }
  return { status, path: rest };
}

/**
 * Absorb hand edits to the learnings store: a human can edit or delete a
 * `learnings/<domain>/<slug>.md` file directly in the store repo, bypassing
 * every CLI write path entirely. Every mutation entry point calls this FIRST
 * (advisory, best effort — see each call site's try/catch) so a human's edit
 * is captured and given its own `human edit: <ids>` commit before the entry
 * point's own mutation runs. The motivation is applyOps's failure-path
 * `git reset --hard`: without absorbing first, a dirty tree sitting through
 * that reset would silently destroy an uncommitted hand edit along with the
 * partial op-write it's cleaning up.
 *
 * Non-creating: a storeless workspace or a store with no git repo returns the
 * same empty result as an already-clean tree — this function never
 * materializes the store. Only `learnings/<domain>/<slug>.md` entries are
 * absorbed; untracked/modified non-learning store files (config.json,
 * stale.json, INDEX.md) are left alone for the next normal commit's own
 * `git add -A` to pick up.
 */
export function absorbHandEdits({ workspace, home, log = () => {} }) {
  const empty = { absorbed: [], deleted: [], committed: false };
  const dir = storeDir(workspace, { home });
  if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, '.git'))) return empty;

  const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  const lines = (status.status === 0 ? status.stdout : '').split('\n').filter(Boolean);
  if (!lines.length) return empty;

  const at = todayClamped();
  const absorbed = [];
  const deleted = [];
  const ledgerEntries = [];

  for (const line of lines) {
    const { status: code, path: rel } = parsePorcelainLine(line);
    const m = LEARNING_FILE_RE.exec(rel);
    if (!m) continue; // non-learning file — left for the normal commit
    const [, domain, slug] = m;
    const id = `${domain}/${slug}`;

    if (code.includes('D')) {
      // Human deletion always wins — nothing left to parse or re-render.
      deleted.push(id);
      continue;
    }
    if (!code.includes('M')) continue; // untracked/other — out of absorb scope

    const file = path.join(dir, rel);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // vanished between status and read — nothing to absorb
    }
    const { fm, body } = parseLearningFrontmatter(text);

    // Human-teaching snapshot: captures the edited body verbatim, so a later
    // `--rebuild` re-derives the same human authority from disk instead of
    // trusting the learning file's own (now human) source label alone.
    const trigger = fm.trigger || '';
    const fmLines = [
      `title: ${yamlQuote(`hand edit: ${id}`)}`,
      'kind: human-teaching',
      `date: ${at}`,
      `trigger: ${yamlQuote(trigger)}`,
    ];
    const doc = `---\n${fmLines.join('\n')}\n---\n\n${body.trim()}\n`;

    let snapshot = null;
    const secrets = scanSecrets(doc);
    if (secrets.length) {
      log(
        `hand-edit absorb: secret-shaped content (${secrets.map((s) => s.id).join(', ')}) — skipped snapshot for ${id}, still absorbing`
      );
    } else {
      const teachDirRel = path.join('docs', 'solutions', 'teachings');
      let snapRel = path.join(teachDirRel, `${at}-hand-edit-${slug}.md`);
      let n = 2;
      while (fs.existsSync(path.join(workspace, snapRel))) {
        snapRel = path.join(teachDirRel, `${at}-hand-edit-${slug}-${n}.md`);
        n += 1;
      }
      snapshot = snapRel.split(path.sep).join('/');
      fs.mkdirSync(path.join(workspace, teachDirRel), { recursive: true });
      fs.writeFileSync(path.join(workspace, snapshot), doc, 'utf8');
      const sha256 = crypto.createHash('sha256').update(doc).digest('hex');
      fm.episodes = [...(fm.episodes || []), { path: snapshot, sha256, kind: 'human-teaching', plan: null }];
      ledgerEntries.push({ path: snapshot, sha256, learning: id, at });
    }

    fm.source = 'human';
    const content = serializeLearning(fm, body);
    // Byte-cap note: the cap binds the sole writer's ops (apply.mjs), not a
    // human hand-editing the file directly — human authority overrides it,
    // logged rather than rejected.
    if (Buffer.byteLength(content, 'utf8') > LEARNING_BYTE_CAP) {
      log(`hand-edit absorb: ${id} exceeds ${LEARNING_BYTE_CAP} bytes after absorb — kept anyway (human authority)`);
    }
    fs.writeFileSync(file, content, 'utf8');
    absorbed.push({ id, snapshot });
  }

  if (!absorbed.length && !deleted.length) return empty;

  if (ledgerEntries.length) appendLedger(dir, ledgerEntries);
  rebuildIndex(dir);
  const ids = [...absorbed.map((a) => a.id), ...deleted].join(', ');
  const { committed } = commitStore(dir, `human edit: ${ids}`);
  try {
    mirrorLearnings({ workspace, home, log });
  } catch {
    // best effort — a mirror failure must never block absorb.
  }
  return { absorbed, deleted, committed };
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
  // differs. The workspace itself is resolved first so a non-normalized or
  // trailing-slash `workspace` can't produce a false negative.
  const root = path.resolve(workspace);
  const full = path.resolve(root, target);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: 'purge target escapes the workspace',
    };
  }
  const episodeFull = path.join(workspace, target);
  const episodeExistsOnDisk = fs.existsSync(episodeFull);

  // Non-creating gate: a storeless workspace must never be materialized just
  // to discover there's nothing in it to purge. The workspace episode FILE
  // is a separate concern from the store, though — deleting it (if present)
  // is the human's explicit intent even with no store at all, so that still
  // runs; every store-side stage below is skipped entirely.
  const storePath = storeDir(workspace, { home });
  if (!fs.existsSync(storePath)) {
    if (episodeExistsOnDisk) {
      fs.rmSync(episodeFull, { force: true });
      return {
        pass: true,
        exitCode: 0,
        removed: { episode: target, learnings: [], links: [], ledger: 0 },
        blockedReason: null,
      };
    }
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: `nothing references ${target} — nothing to purge`,
    };
  }

  const { dir } = ensureStore(workspace, { home });
  try {
    absorbHandEdits({ workspace, home });
  } catch {
    // best effort — a hand-edit absorb failure must never block purge.
  }

  // Read-only discovery pass first: decide whether anything actually
  // references `target` before mutating anything, so a no-match purge can
  // bail with zero side effects (no commit) instead of reporting a false
  // "pass" for a target nothing ever cited.
  const matchingLearnings = listLearnings(dir).filter((l) => (l.fm.episodes || []).some((e) => e.path === target));
  const ledger = readLedger(dir);
  const ledgerHits = ledger.filter((e) => e.path === target).length;

  if (!episodeExistsOnDisk && matchingLearnings.length === 0 && ledgerHits === 0) {
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: `nothing references ${target} — nothing to purge`,
    };
  }

  const removedLearnings = [];
  const removedLinks = [];
  for (const l of matchingLearnings) {
    const episodes = l.fm.episodes || [];
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

  const keptLedger = ledger.filter((e) => e.path !== target);
  fs.writeFileSync(
    path.join(dir, 'consolidated.jsonl'),
    keptLedger.length ? keptLedger.map((e) => JSON.stringify(e)).join('\n') + '\n' : '',
    'utf8'
  );

  let episodeRemoved = false;
  if (episodeExistsOnDisk) {
    fs.rmSync(episodeFull, { force: true });
    episodeRemoved = true;
  }

  rebuildIndex(dir);
  commitStore(dir, `purge: ${target}`);
  try {
    mirrorLearnings({ workspace, home });
  } catch {
    // best effort — a mirror failure must never block purge.
  }

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
  // Non-creating gate: a storeless workspace has nothing to purge — must
  // never be materialized by --all just to discover that.
  const storePath = storeDir(workspace, { home });
  if (!fs.existsSync(storePath)) {
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: 'nothing to purge — no knowledge store yet',
    };
  }
  const { dir } = ensureStore(workspace, { home });
  try {
    absorbHandEdits({ workspace, home });
  } catch {
    // best effort — a hand-edit absorb failure must never block purge --all.
  }
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
  try {
    mirrorLearnings({ workspace, home });
  } catch {
    // best effort — a mirror failure must never block purge --all.
  }
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
export function rebuildStore({ workspace, home, yes, copilotHome }) {
  const { mode } = readStoreConfig(workspace, { home });
  if (!['on', 'suggest'].includes(mode)) {
    return {
      pass: false,
      exitCode: 2,
      archived: null,
      debt: null,
      blockedReason: `knowledge mode is ${mode} — run: harness knowledge on`,
      nextTools: ['harness knowledge on'],
    };
  }

  if (!yes) {
    // Non-creating read: a workspace/home with no store yet must never be
    // materialized by a blocked (no --yes) call — "no mutation" has to hold
    // even for the store's own existence, not just its contents. listLearnings
    // only runs on this (preview) path, once.
    const storePath = storeDir(workspace, { home });
    const archivedPreview = fs.existsSync(storePath) ? listLearnings(storePath).length : 0;
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
  // --yes is an explicit go-ahead, unlike the preview above. listLearnings
  // only runs on this (mutation) path, once.
  const { dir } = ensureStore(workspace, { home });
  try {
    absorbHandEdits({ workspace, home });
  } catch {
    // best effort — a hand-edit absorb failure must never block rebuild.
  }
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
  try {
    mirrorLearnings({ workspace, home });
  } catch {
    // best effort — a mirror failure must never block rebuild.
  }

  // copilotHome must be threaded through so the fresh debt count includes
  // global episodes (docs/solutions under the copilot home), not just
  // product-local ones — otherwise a rebuild under-reports debt.
  const { debt } = consolidateStatus({ workspace, home, copilotHome });
  return {
    pass: true,
    exitCode: 0,
    archived,
    debt,
    blockedReason: null,
    nextTools: ['harness consolidate --candidates'],
  };
}
