import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  withStoreTransaction,
  StoreTransactionAbort,
  LEARNING_FILE_RE,
  parsePorcelainLine,
  storeDir,
  storeDirForId,
  repoId,
  localRepoId,
  acquireStoreLock,
  listLearnings,
  readLedger,
  appendLedger,
  commitStore,
  parseLearningFrontmatter,
  serializeLearning,
  readStoreConfig,
  appendGovernance,
  rewriteGovernance,
  inertLine,
} from './store.mjs';
import { rebuildIndex, todayClamped } from './apply.mjs';
import { consolidateStatus, LEARNING_BYTE_CAP, isActiveFm } from './consolidate.mjs';
import { scanSecrets } from '../secret-scan.mjs';
import { assertNoSymlinkAncestors, writeFileContained } from '../fs-safe.mjs';

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
 * propose-then-ratify phase. The sweep below removes a file whose
 * `<domain>/<slug>` matches ANY of three things: a CURRENT store learning
 * that is now inactive, an id the caller explicitly names via `retiredIds` —
 * full-reset callers (`purge --all`, `rebuild --yes`) capture the store's id
 * list BEFORE wiping it and pass it here, since after the wipe those ids no
 * longer exist anywhere for the "current store" half of the check to match —
 * or an id THIS pass just excluded as secret-shaped (`skippedIds`, below): an
 * ACTIVE learning that turns secret-shaped is excluded from the write and the
 * INDEX, and without also sweeping it here its previous clean mirror copy
 * would linger forever, out of sync with both. Anything else (an id none of
 * the three lists names — genuinely foreign, or simply never mirrored) is
 * left untouched.
 *
 * Every learning slated for the mirror (verbatim text or INDEX entry) is
 * secret-scanned first: a hit is excluded from BOTH the `.md` write and the
 * INDEX entry list entirely — a skipped learning is invisible in the mirror,
 * not just missing its file body — and counted in `skipped` with a logged
 * warning (best-effort screening per design §11).
 *
 * commit === 'none' is a no-op: an existing mirror (e.g. left over from a
 * prior 'repo' period) is left exactly as it is.
 */
export function mirrorLearnings({ workspace, home, log = () => {}, retiredIds = [] }) {
  const { commit } = readStoreConfig(workspace, { home });
  if (commit !== 'repo') return { mirrored: 0, skipped: 0 };

  const dir = storeDir(workspace, { home });
  const mirrorRootRel = path.join('docs', 'knowledge', 'learnings');
  const mirrorRoot = path.join(workspace, mirrorRootRel);
  const storeLearnings = fs.existsSync(dir) ? listLearnings(dir) : [];
  const byId = new Map(storeLearnings.map((l) => [l.id, l]));
  const active = storeLearnings.filter((l) => isActiveFm(l.fm)).sort((a, b) => a.id.localeCompare(b.id));
  const retiredIdSet = new Set(retiredIds);

  let mirrored = 0;
  let skipped = 0;
  const skippedIds = new Set();

  for (const learning of active) {
    const text = fs.readFileSync(learning.file, 'utf8');
    const secrets = scanSecrets(text);
    if (secrets.length) {
      skipped++;
      skippedIds.add(learning.id);
      log(`mirror: secret-shaped content (${secrets.map((s) => s.id).join(', ')}) — skipped ${learning.id}`);
      continue;
    }
    // Contained, atomic write (P1-3): refuses when any component of
    // docs/knowledge/learnings/<domain>/<slug>.md — including a symlinked
    // domain directory — already exists as a symlink, rather than the old
    // lexical mkdir+write, which would silently follow it and write outside
    // the workspace entirely.
    const rel = path.join(mirrorRootRel, learning.domain, `${learning.slug}.md`);
    const written = writeFileContained(workspace, rel, text);
    if (!written) {
      skipped++;
      skippedIds.add(learning.id);
      log(`mirror: symlinked destination under ${mirrorRootRel}/${learning.domain}/ — skipped ${learning.id}`);
      continue;
    }
    mirrored++;
  }

  // Sweep: remove mirror files for ids the CURRENT store still knows about
  // but that are no longer active, ids the caller names via retiredIds (see
  // the doc comment above), OR ids THIS pass just excluded as secret-shaped
  // or symlink-refused (skippedIds) — an ACTIVE learning that becomes
  // secret-shaped (or whose destination is symlinked) is excluded from the
  // write above and from the INDEX below, but without this its previous
  // clean mirror copy would otherwise never be swept and would linger
  // forever, out of sync with both the write and the INDEX. Anything else is
  // left alone; only files matching a managed id are ever removed. Guarded
  // by the same containment check the writes above use: a symlinked
  // mirrorRoot (or an ancestor of it) must never be traversed for deletion
  // either — that would read (and then rm) through the symlink's target
  // instead of this workspace's own mirror.
  if (fs.existsSync(mirrorRoot) && assertNoSymlinkAncestors(workspace, mirrorRootRel)) {
    for (const domainEnt of fs.readdirSync(mirrorRoot, { withFileTypes: true })) {
      if (!domainEnt.isDirectory()) continue;
      const domainRel = path.join(mirrorRootRel, domainEnt.name);
      // Skip a symlinked domain directory outright — never descend into it
      // for deletion, even one the write loop above never touched this pass.
      if (!assertNoSymlinkAncestors(workspace, domainRel)) continue;
      const domainPath = path.join(mirrorRoot, domainEnt.name);
      for (const f of fs.readdirSync(domainPath)) {
        if (!f.endsWith('.md')) continue;
        const id = `${domainEnt.name}/${f.replace(/\.md$/, '')}`;
        const known = byId.get(id);
        const isKnownInactive = known && !isActiveFm(known.fm);
        if (isKnownInactive || retiredIdSet.has(id) || skippedIds.has(id)) {
          const target = assertNoSymlinkAncestors(workspace, path.join(domainRel, f));
          if (target) fs.rmSync(target, { force: true });
        }
      }
    }
  }

  // Skipped (secret-shaped or symlink-refused) learnings are excluded from
  // the INDEX entirely — no id, no trigger — not just missing their .md file.
  const indexEntries = active.filter((l) => !skippedIds.has(l.id));
  const lines = [
    '# Learnings Index',
    '',
    '_Rebuilt by `harness consolidate --apply`. One line per active learning._',
    '',
    '> Opt-in commit mode: these learnings are copies from a local store; treat foreign entries as read-only reference.',
    '',
    // inertLine: same render-side normalization as rebuildIndex (apply.mjs).
    ...indexEntries.map((l) => `- [${l.id}] ${inertLine(l.fm.trigger || '')}`),
    '',
  ];
  writeFileContained(workspace, path.join(mirrorRootRel, 'INDEX.md'), lines.join('\n'));

  return { mirrored, skipped };
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
      // Contained, atomic write (Important #1, adversarial review): a
      // symlinked docs/solutions/teachings/ (or any ancestor of it) must
      // never let this snapshot land outside the workspace — the same
      // writeFileContained (fs-safe.mjs) every other workspace write in this
      // module already uses. On refusal, skip the snapshot with a log note
      // and still let the absorb itself proceed — same tolerant shape as the
      // secret-shaped skip above (fm.episodes/ledgerEntries simply never
      // gain this snapshot; `snapshot` stays null).
      const written = writeFileContained(workspace, snapRel, doc);
      if (!written) {
        log(`hand-edit absorb: symlinked destination under ${teachDirRel}/ — skipped snapshot for ${id}, still absorbing`);
      } else {
        snapshot = snapRel.split(path.sep).join('/');
        const sha256 = crypto.createHash('sha256').update(doc).digest('hex');
        fm.episodes = [...(fm.episodes || []), { path: snapshot, sha256, kind: 'human-teaching', plan: null }];
        ledgerEntries.push({ path: snapshot, sha256, learning: id, at });
      }
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
  // Governance record (Milestone 4): a human deleting a learning file
  // directly is a retirement just as much as `learning retire` — recorded
  // here so it survives a later `consolidate --rebuild`. Appended before the
  // single commit below so both land together. `at` is a full ISO-8601 UTC
  // timestamp (P1-9) — distinct from the day-only `at` above (used for the
  // snapshot filename, ledger entries, and the snapshot's own frontmatter
  // date) — the model-lane recency gate (overridesGovernanceRecency,
  // apply.mjs) needs finer-than-a-day resolution.
  const governanceAt = new Date().toISOString();
  for (const id of deleted) {
    appendGovernance(dir, { id, action: 'retire', reason: 'hand deletion (absorbed)', to: null, at: governanceAt });
  }
  rebuildIndex(dir);
  const ids = [...absorbed.map((a) => a.id), ...deleted].join(', ');
  const commitRes = commitStore(dir, `human edit: ${ids}`);
  if (!commitRes.ok) {
    // A REAL git failure (never "nothing to commit" — the writes above
    // always dirty the tree first, since absorbed.length || deleted.length
    // is what got us here): the absorbed content is sitting uncommitted in
    // the working tree right now. Surfaced via `ok`/`stderr` rather than
    // thrown here — absorbHandEdits itself stays a plain data-returning
    // function, called both standalone (advisory, unlocked) and inside a
    // withStoreTransaction. Every transaction caller runs it through
    // absorbOrAbort (below), which turns this into a StoreTransactionAbort
    // so a later rollback can never destroy it. Mirroring is skipped too —
    // the store-side change never actually landed.
    return { absorbed, deleted, committed: false, ok: false, stderr: commitRes.stderr };
  }
  try {
    // `deleted` names the ids a human removed directly (git status "D") —
    // human deletion must win in the mirror too, so those ids are named via
    // retiredIds even though the store itself has already forgotten them by
    // the time this runs (same reasoning as purgeAll/rebuildStore).
    mirrorLearnings({ workspace, home, log, retiredIds: deleted });
  } catch {
    // best effort — a mirror failure must never block absorb.
  }
  return { absorbed, deleted, committed: commitRes.committed };
}

/**
 * Run absorbHandEdits, then fail closed if its own sub-commit failed for a
 * REAL reason (not simply "nothing to absorb" — see absorbHandEdits' own
 * `ok` doc comment above): a real failure here means the absorb's writes are
 * sitting uncommitted in the working tree right now. Proceeding to the
 * caller's own mutation — or letting a LATER failure trigger the standard
 * rollback — would either compound onto unprotected state or destroy the
 * human's edit outright with no commit to fall back to. Every
 * withStoreTransaction adopter that calls absorbHandEdits calls this
 * instead, as the very first thing inside its transaction `fn`; the
 * StoreTransactionAbort it throws propagates through the adopter's own
 * try/catch (which must re-throw it, not swallow it — see the adopters
 * below) and out to withStoreTransaction's catch, which recognizes it and
 * skips the rollback.
 *
 * `recordCheckpoint` is `fn`'s withStoreTransaction context callback
 * (store.mjs) — called here on a SUCCESSFUL absorb commit so the
 * transaction's rollback floor advances past it: a later failure (this
 * function's own caller mutating further, or the transaction's own finalize
 * commit) then rolls back to the absorb commit rather than before it,
 * exactly the batch-A "lands on the absorb commit" invariant, now
 * checkpoint-based rather than dirty-content-guessed. Defaults to a no-op so
 * a direct (non-transactional) caller of absorbOrAbort — none exist today,
 * but the parameter is optional the same way `log` is — never has to pass one.
 */
export function absorbOrAbort({ workspace, home, log = () => {}, recordCheckpoint = () => {} }) {
  const result = absorbHandEdits({ workspace, home, log });
  if (result.ok === false) {
    throw new StoreTransactionAbort(
      `absorbing a hand edit failed to commit: ${result.stderr || 'git commit failed'}`,
      { stderr: result.stderr }
    );
  }
  if (result.committed) recordCheckpoint();
  return result;
}

/**
 * Cascade-delete one episode (design §3): the episode file itself, every
 * learning it was the sole evidence for, and its link inside learnings that
 * cite it alongside other evidence. Ledger entries for the path are dropped
 * and INDEX.md is rebuilt so nothing dangling survives the purge.
 */
export function purgeEpisode({ workspace, target, copilotHome, home, log = () => {} }) {
  if (!target) {
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: 'purge needs a target file path or --all',
    };
  }
  // Resolve the target against the SAME two roots `collectEpisodes`
  // (consolidate.mjs) scans — workspace first, then copilotHome/knowledge
  // (P2) — so a global episode's ledger-emitted path (relative to
  // copilotHome/knowledge) can be purged exactly as readily as a
  // product-repo-local one, instead of silently leaving its source file on
  // disk as permanent debt. Each root gets its OWN PHYSICAL containment
  // check (assertNoSymlinkAncestors, fs-safe.mjs) — a lexical resolve+
  // startsWith check alone (the prior implementation) passes when an
  // ancestor directory (e.g. a symlinked docs/solutions) is itself a
  // symlink pointing outside the root, letting the delete below land on an
  // arbitrary external file (P1-4). Learnings/ledger matching still uses the
  // repo-relative `target` string as-is, independent of which root it
  // resolves against on this machine.
  const candidateRoots = [{ label: 'workspace', dir: path.resolve(workspace) }];
  if (copilotHome) candidateRoots.push({ label: 'copilotHome/knowledge', dir: path.resolve(copilotHome, 'knowledge') });

  const resolved = [];
  for (const { label, dir } of candidateRoots) {
    const full = assertNoSymlinkAncestors(dir, target);
    if (!full) continue; // escapes this root lexically, or a symlink ancestor — never a candidate
    resolved.push({ label, dir, full, existsOnDisk: fs.existsSync(full) });
  }

  if (!resolved.length) {
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: `purge target escapes every configured root or resolves through a symlink: ${target}`,
    };
  }

  const existingIn = resolved.filter((r) => r.existsOnDisk);
  if (existingIn.length > 1) {
    // Ambiguous: the same relative path exists under more than one root —
    // never guess which one the human meant.
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: `${target} exists under both ${existingIn.map((r) => r.label).join(' and ')} — ambiguous; pass an explicit prefix or delete the unwanted copy directly`,
    };
  }

  // Prefer the root the file actually exists in; when it exists in neither
  // (already deleted, or this purge is purely a store-side cascade for a
  // ledger/learnings-only reference), default to the first configured root
  // (workspace) — same fall-through behavior as before this fix.
  const chosen = existingIn[0] || resolved[0];
  const episodeRoot = chosen.dir;
  const episodeExistsOnDisk = chosen.existsOnDisk;

  // Non-creating gate: a storeless workspace must never be materialized just
  // to discover there's nothing in it to purge. The episode FILE is a
  // separate concern from the store, though — deleting it (if present) is
  // the human's explicit intent even with no store at all, so that still
  // runs; every store-side stage below is skipped entirely.
  const storePath = storeDir(workspace, { home });
  if (!fs.existsSync(storePath)) {
    if (episodeExistsOnDisk) {
      // TOCTOU re-check (P1-4): re-validate physical containment
      // immediately before the actual delete, not just at the check above.
      const safe = assertNoSymlinkAncestors(episodeRoot, target);
      if (!safe) {
        return {
          pass: false,
          exitCode: 1,
          removed: null,
          blockedReason: `purge target no longer resolves safely (symlink introduced) — refusing to delete: ${target}`,
        };
      }
      fs.rmSync(safe, { force: true });
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

  // Store-side cascade (learnings, links, ledger, governance) runs inside the
  // single-writer transaction. The workspace episode FILE itself is
  // deliberately deleted OUTSIDE and AFTER this transaction, only once it has
  // committed successfully (P1-8): if the store-side cascade fails or rolls
  // back, the episode file is never touched, so a failed purge never loses
  // evidence with nothing left to point at it.
  const tx = withStoreTransaction(workspace, { home, label: `purge: ${target}` }, ({ dir, recordCheckpoint }) => {
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
      // A REAL absorb-commit failure must propagate as-is (never swallowed)
      // so withStoreTransaction can skip the rollback and protect the
      // uncommitted hand edit sitting in the tree — any OTHER absorb hiccup
      // stays best effort, exactly as before.
      if (err instanceof StoreTransactionAbort) throw err;
    }

    // Read-only discovery pass first: decide whether anything actually
    // references `target` before mutating anything, so a no-match purge can
    // bail with zero side effects (no commit) instead of reporting a false
    // "pass" for a target nothing ever cited. Read fresh, under the lock —
    // not before it — so this can never validate against a stale snapshot
    // another writer has since moved past.
    const matchingLearnings = listLearnings(dir).filter((l) => (l.fm.episodes || []).some((e) => e.path === target));
    const ledger = readLedger(dir);
    const ledgerHits = ledger.filter((e) => e.path === target).length;

    if (!episodeExistsOnDisk && matchingLearnings.length === 0 && ledgerHits === 0) {
      return {
        kind: 'reject',
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

    // Governance record (Milestone 4): a fully cascade-deleted learning's
    // history is dropped too — nothing left for those records to govern —
    // while a merely delinked (removedLinks) learning's governance history is
    // untouched, since the learning itself still exists.
    if (removedLearnings.length) {
      const removedIds = new Set(removedLearnings);
      rewriteGovernance(dir, (e) => !removedIds.has(e.id));
    }

    rebuildIndex(dir);

    return {
      kind: 'success',
      commitMessage: `purge: ${target}`,
      removedLearnings,
      removedLinks,
      ledgerRemoved: ledger.length - keptLedger.length,
    };
  });

  if (!tx.ok) {
    return {
      pass: false,
      exitCode: 1,
      removed: null,
      blockedReason: tx.locked
        ? 'E_LOCKED: another operation holds the store lock'
        : `purge failed: ${tx.error?.message || 'store transaction failed'}`,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  const inner = tx.result;
  if (inner.kind === 'reject') {
    return {
      pass: inner.pass,
      exitCode: inner.exitCode,
      removed: inner.removed,
      blockedReason: inner.blockedReason,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  // The workspace episode file is deleted LAST, only now that the store-side
  // cascade above has committed successfully (P1-8). If deletion itself
  // fails here (e.g. a permission error), the store-side purge already
  // committed — there is nothing left to roll back, so this reports a
  // partial outcome rather than a failure.
  let episodeRemoved = false;
  let partialReason = null;
  if (episodeExistsOnDisk) {
    // TOCTOU re-check (P1-4): the store-side transaction above took real
    // time (lock, absorb, commit) — re-validate physical containment right
    // before this delete rather than trusting the check from before it.
    const safe = assertNoSymlinkAncestors(episodeRoot, target);
    if (!safe) {
      partialReason = `store purge committed, but the episode target no longer resolves safely (symlink introduced) — not deleted: ${target}`;
      log(partialReason);
    } else {
      try {
        fs.rmSync(safe, { force: true });
        episodeRemoved = true;
      } catch (err) {
        partialReason = `store purge committed, but the episode file could not be deleted: ${err.message}`;
        log(partialReason);
      }
    }
  }

  try {
    // removedLearnings names only the learnings this cascade FULLY DELETED
    // (as opposed to removedLinks, which were merely delinked and still
    // exist) — human deletion must win in the mirror too, so those ids are
    // named via retiredIds even though the store has already forgotten them.
    mirrorLearnings({ workspace, home, retiredIds: inner.removedLearnings });
  } catch {
    // best effort — a mirror failure must never block purge.
  }

  return {
    pass: true,
    exitCode: 0,
    removed: {
      episode: episodeRemoved ? target : null,
      learnings: inner.removedLearnings,
      links: inner.removedLinks,
      ledger: inner.ledgerRemoved,
    },
    blockedReason: null,
    ...(partialReason ? { partialReason } : {}),
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}

/**
 * Reset T2 (the learnings store) to empty: consolidated learnings and the
 * ledger are wiped, config.json (the mode) is kept. Unlike a `--rebuild`
 * (see rebuildStore below), governance.jsonl is wiped too — purge --all is a
 * human erasing everything, so there is no id left for any governance record
 * to still govern. Episode files on disk are untouched — they simply
 * re-enter the consolidation debt count on the next `consolidate --status`.
 */
export function purgeAll({ workspace, home, log = () => {} }) {
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

  const tx = withStoreTransaction(workspace, { home, label: 'purge: --all (store reset)' }, ({ dir, recordCheckpoint }) => {
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
      // A REAL absorb-commit failure must propagate as-is (never swallowed)
      // so withStoreTransaction can skip the rollback and protect the
      // uncommitted hand edit sitting in the tree — any OTHER absorb hiccup
      // stays best effort, exactly as before.
      if (err instanceof StoreTransactionAbort) throw err;
    }
    // Captured BEFORE the wipe below: a full reset (design-controller ruling)
    // must still clear the mirror for exactly these ids, but by the time
    // mirrorLearnings runs the store no longer has any record of them — pass
    // them explicitly via retiredIds so its sweep can still match them.
    const idsBeforeReset = listLearnings(dir).map((l) => l.id);
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
    // Truncate rather than rewriteGovernance(dir, () => false): purge --all
    // erases the entire store, so there is no surviving id left for a
    // predicate to filter against — a full truncate is equivalent and simpler.
    fs.writeFileSync(path.join(dir, 'governance.jsonl'), '', 'utf8');
    rebuildIndex(dir);
    return { kind: 'success', commitMessage: 'purge: --all (store reset)', removedCount: n, idsBeforeReset };
  });

  if (!tx.ok) {
    return {
      pass: false,
      exitCode: 1,
      removed: null,
      blockedReason: tx.locked
        ? 'E_LOCKED: another operation holds the store lock'
        : `purge --all failed: ${tx.error?.message || 'store transaction failed'}`,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  const inner = tx.result;
  try {
    mirrorLearnings({ workspace, home, retiredIds: inner.idsBeforeReset });
  } catch {
    // best effort — a mirror failure must never block purge --all.
  }
  return {
    pass: true,
    exitCode: 0,
    removed: { learnings: inner.removedCount },
    blockedReason: null,
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}

/**
 * T2 reset for model-upgrade regeneration (design §2's re-derivability
 * invariant): every learning is discarded — git history in the store repo
 * still holds them, `--yes` is the only undo — and every episode, including
 * `kind: human-teaching` ones written by `remember`, re-enters consolidation
 * debt so `source: human` learnings regenerate with full authority. Unlike
 * `purgeAll`, rebuild also drops `stale.json`: a fresh model gets a clean
 * stale-anchor slate rather than exclusions computed against the old corpus.
 * config.json (the mode/commit) and governance.jsonl (Milestone 4's human
 * decision ledger) both survive untouched — the regenerated learnings must
 * still honor any standing retire/dispute/confirm/promote a human already
 * made, which Task 2 reapplies against the fresh corpus. Mode-gated like
 * every other knowledge write — human purge is the only always-on path.
 */
export function rebuildStore({ workspace, home, yes, copilotHome, log = () => {} }) {
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
  // only runs on this (mutation) path, once, inside the transaction (fresh,
  // under the lock, rather than before it existed).
  const tx = withStoreTransaction(workspace, { home, label: 'consolidate: rebuild reset' }, ({ dir, recordCheckpoint }) => {
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
      // A REAL absorb-commit failure must propagate as-is (never swallowed)
      // so withStoreTransaction can skip the rollback and protect the
      // uncommitted hand edit sitting in the tree — any OTHER absorb hiccup
      // stays best effort, exactly as before.
      if (err instanceof StoreTransactionAbort) throw err;
    }
    // Captured BEFORE the wipe below — same reasoning as purgeAll's
    // idsBeforeReset: mirrorLearnings needs these ids named explicitly via
    // retiredIds since the store itself forgets them the instant the wipe runs.
    const archivedLearnings = listLearnings(dir);
    const archived = archivedLearnings.length;

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
    return {
      kind: 'success',
      commitMessage: `consolidate: rebuild reset (${archived} learnings archived to git history)`,
      archived,
      archivedIds: archivedLearnings.map((l) => l.id),
    };
  });

  if (!tx.ok) {
    return {
      pass: false,
      exitCode: 1,
      archived: null,
      debt: null,
      blockedReason: tx.locked
        ? 'E_LOCKED: another operation holds the store lock'
        : `rebuild failed: ${tx.error?.message || 'store transaction failed'}`,
      nextTools: [],
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  const inner = tx.result;
  try {
    mirrorLearnings({ workspace, home, retiredIds: inner.archivedIds });
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
    archived: inner.archived,
    debt,
    blockedReason: null,
    nextTools: ['harness consolidate --candidates'],
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}

/** True when `dir` exists and has at least one entry — used by
 * migrateStrandedStore's collision check below (a bare empty directory,
 * e.g. left over from a prior aborted attempt, is not "a real store already
 * lives there"). */
function isNonEmptyDir(dir) {
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
}

/**
 * Explicit, collision-safe, transactional migration for a stranded store
 * (P2, design §2). `repoId` (store.mjs) switches from the path-keyed
 * `local-<hash>` id to a remote-keyed id the instant a workspace gains an
 * origin remote — every store mutator resolves `storeDir` fresh from the
 * CURRENT `repoId`, so a store built BEFORE that switch keeps existing on
 * disk under the old id but is never read or written again: nothing
 * surfaces that it still exists, and a fresh (empty) store silently starts
 * accumulating under the new id instead. This never runs automatically —
 * `harness doctor`'s K4 check only DETECTS and reports the stranded state
 * (see doctor.mjs); a human runs this explicitly to move it.
 *
 * Collision-safe: refuses when the destination already exists and is
 * non-empty (a real store already lives there — migrating over it would
 * silently merge or clobber two independent histories; the caller is left
 * to reconcile by hand). Transactional: the move is a single
 * `fs.renameSync` of the whole directory (including its own `.git`), which
 * is atomic on the same filesystem — there is no copy-then-delete window
 * where a crash could leave the content duplicated or half-moved. Both
 * directories live under the same `<home>/knowledge/` parent, so they are
 * always on the same filesystem in every normal install; the one fallback
 * (a cross-device rename, `EXDEV`) copies the tree, verifies the copy
 * landed, THEN removes the source — never the reverse order, so a failure
 * mid-copy leaves the original store untouched rather than lost.
 */
export function migrateStrandedStore({ workspace, home, log = () => {} }) {
  const currentId = repoId(workspace);
  if (currentId.startsWith('local-')) {
    return {
      pass: false,
      exitCode: 2,
      migrated: false,
      blockedReason: 'this workspace has no origin remote configured — repoId is already path-keyed, nothing to migrate',
    };
  }
  const legacyId = localRepoId(workspace);
  const legacyDir = storeDirForId(legacyId, { home });
  const targetDir = storeDirForId(currentId, { home });

  // Non-creating gate: a workspace with no legacy path-keyed store on disk
  // must never be materialized by this command just to discover that.
  if (!fs.existsSync(path.join(legacyDir, 'consolidated.jsonl'))) {
    return {
      pass: false,
      exitCode: 2,
      migrated: false,
      blockedReason: `no legacy path-keyed store found at ${legacyDir} — nothing to migrate`,
    };
  }

  if (isNonEmptyDir(targetDir)) {
    return {
      pass: false,
      exitCode: 1,
      migrated: false,
      blockedReason: `migration target already exists and is non-empty: ${targetDir} — refusing to overwrite; resolve manually`,
    };
  }

  // Lock the legacy store for the duration of the move via the SAME
  // stale-takeover-aware acquisition withStoreTransaction uses (store.mjs's
  // acquireStoreLock) — this is the one lock acquired OUTSIDE a normal store
  // transaction, against a dir withStoreTransaction itself will never touch
  // again once repoId has switched, so a lock left behind by a killed
  // PRE-SWITCH writer would otherwise have no takeover path at all and wedge
  // migration permanently.
  const lockPath = path.join(legacyDir, '.lock');
  const lock = acquireStoreLock(lockPath);
  if (!lock.acquired) {
    const ageNote = lock.ageMs ? ` (${Math.round(lock.ageMs / 60000)}m old)` : '';
    return {
      pass: false,
      exitCode: 1,
      migrated: false,
      blockedReason: `E_LOCKED: another operation holds the legacy store lock at ${lockPath}${ageNote} — if the owning process is confirmed dead, remove that directory manually and retry`,
    };
  }
  const staleLockNote = lock.staleLockNote;

  try {
    // TOCTOU re-check immediately before the move, under the lock — same
    // idiom as purgeEpisode's own re-check-under-lock above.
    if (isNonEmptyDir(targetDir)) {
      return {
        pass: false,
        exitCode: 1,
        migrated: false,
        blockedReason: `migration target already exists and is non-empty: ${targetDir} — refusing to overwrite; resolve manually`,
        ...(staleLockNote ? { staleLockRemoved: staleLockNote } : {}),
      };
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    // An empty pre-existing target directory (e.g. a leftover empty dir from
    // some earlier partial attempt) must be removed before the rename: on
    // Windows (the stated primary platform), renaming a directory onto an
    // existing one — even an empty one — fails with EPERM, unlike POSIX
    // rename(2), which can replace an empty target directory atomically.
    // rmdirSync only ever succeeds on a genuinely empty directory; if a
    // last-instant race made it non-empty, it throws and this function fails
    // closed instead of silently clobbering something.
    if (fs.existsSync(targetDir)) fs.rmdirSync(targetDir);
    try {
      fs.renameSync(legacyDir, targetDir);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      // Cross-device fallback (near-impossible in practice — both dirs share
      // <home>/knowledge/ — but handled cleanly): copy the whole tree, verify
      // it landed, THEN remove the source. Any failure in this block —
      // cpSync itself throwing (e.g. disk full mid-copy) or the post-copy
      // verification failing — removes whatever partial debris landed at
      // targetDir before rethrowing, so a retry after a failed copy is
      // idempotent instead of seeing a bogus "target already exists and is
      // non-empty" refusal caused by OUR OWN interrupted attempt.
      try {
        fs.cpSync(legacyDir, targetDir, { recursive: true });
        if (!fs.existsSync(path.join(targetDir, 'consolidated.jsonl'))) {
          throw new Error('cross-device copy did not verify — legacy store left untouched');
        }
      } catch (copyErr) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        throw copyErr;
      }
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
    // The lock directory moved WITH the tree (rename) or was copied then the
    // source removed (EXDEV fallback) — either way it is sitting at the new
    // location now; clear it so a normal withStoreTransaction against the
    // freshly migrated store is never blocked by a lock this function
    // itself created.
    fs.rmSync(path.join(targetDir, '.lock'), { recursive: true, force: true });
    log(`migrated stranded store: ${legacyDir} -> ${targetDir}`);
    return {
      pass: true,
      exitCode: 0,
      migrated: true,
      from: legacyDir,
      to: targetDir,
      blockedReason: null,
      ...(staleLockNote ? { staleLockRemoved: staleLockNote } : {}),
    };
  } catch (err) {
    // The lock may still be sitting in legacyDir if the move itself never
    // completed — clean it up so a retry isn't stuck E_LOCKED against this
    // failed attempt's own lock. Best effort: a cleanup failure here must
    // never mask the real error below.
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // ignored
    }
    return {
      pass: false,
      exitCode: 1,
      migrated: false,
      blockedReason: `migration failed: ${err.message}`,
      ...(staleLockNote ? { staleLockRemoved: staleLockNote } : {}),
    };
  }
}
