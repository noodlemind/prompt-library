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
import { listBuckets, branchesRoot, bucketDirFor } from './overlay.mjs';
import { scanSecrets } from '../secret-scan.mjs';
import { assertNoSymlinkAncestors, assertRealpathContained, writeFileContained } from '../fs-safe.mjs';
import { runIndexKnowledge } from '../index-knowledge.mjs';
import { loadManifest } from '../recall-rank.mjs';

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
  // Fail CLOSED (P2): a spawn error or a non-zero `git status` exit used to be
  // coerced to an empty string — read as "tree is clean" — so a later
  // transaction rollback (git reset --hard + clean -fd) could silently destroy
  // an unabsorbed hand edit this function never got to see. Surface it as a
  // failure-shaped result (`ok: false`) so absorbOrAbort turns it into a
  // StoreTransactionAbort and the transaction aborts WITHOUT rolling back over
  // the unprotected edit, exactly like a failed absorb sub-commit.
  if (status.error || status.status !== 0) {
    const detail = status.error ? status.error.message : status.stderr || `git status exited ${status.status}`;
    return { absorbed: [], deleted: [], committed: false, ok: false, stderr: `git status failed: ${detail}` };
  }
  const lines = status.stdout.split('\n').filter(Boolean);
  if (!lines.length) return empty;

  const at = todayClamped();
  const absorbed = [];
  const deleted = [];
  // Per-layer bookkeeping (blueprint §5a): a bucket hand edit's ledger
  // evidence belongs in ITS root's consolidated.jsonl, and its bucket
  // INDEX.md needs rebuilding too — same per-layer routing purgeEpisode and
  // rebuildStore already do. Governance stays store-rooted: the single
  // ledger binds both layers (§4).
  const ledgerByRoot = new Map();
  const touchedBucketRoots = new Set();

  for (const line of lines) {
    const { status: code, path: rel } = parsePorcelainLine(line);
    const m = LEARNING_FILE_RE.exec(rel);
    if (!m) continue; // non-learning file — left for the normal commit
    // Bucket capture (blueprint §5a): a hand edit under
    // branches/<key>/learnings/** absorbs exactly like a golden one; the
    // bucket key is recorded in the snapshot frontmatter below so the
    // provenance names which layer the human touched.
    const [, bucketKey, domain, slug] = m;
    const id = `${domain}/${slug}`;
    const layerRoot = bucketKey ? bucketDirFor(dir, bucketKey) : dir;

    if (code.includes('D')) {
      // Human deletion always wins — nothing left to parse or re-render.
      deleted.push(id);
      if (bucketKey) touchedBucketRoots.add(layerRoot);
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
    // Layer provenance (blueprint §5a): a bucket hand edit's snapshot names
    // its bucket so a later rebuild routes the human authority back to the
    // branch layer it was taught in, never silently into golden.
    if (bucketKey) fmLines.push(`bucket: ${yamlQuote(bucketKey)}`);
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
        if (!ledgerByRoot.has(layerRoot)) ledgerByRoot.set(layerRoot, []);
        ledgerByRoot.get(layerRoot).push({ path: snapshot, sha256, learning: id, at });
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
    if (bucketKey) touchedBucketRoots.add(layerRoot);
  }

  if (!absorbed.length && !deleted.length) return empty;

  for (const [root, entries] of ledgerByRoot) appendLedger(root, entries);
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
  // existsSync guard: a human may have deleted the whole bucket directory,
  // not just a learning file inside it — nothing left to rebuild there.
  for (const root of touchedBucketRoots) {
    if (fs.existsSync(root)) rebuildIndex(root);
  }
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
 * Recall-state cascade for purge: deleting an episode's T1 file and its T2
 * store links is not enough — the team recall manifest
 * (knowledge/manifest.yaml) and the postings index are separate retrieval
 * state, rebuilt from the same solution trees by `harness index`, and until
 * they are rebuilt rankRecall keeps serving the purged episode's title/
 * summary/snippet from the manifest alone, resurrecting content a human
 * explicitly deleted. Rebuilds both via runIndexKnowledge (the exact
 * rebuild `harness index` runs, covering every configured root), then
 * enforces the post-condition directly against DISK — the manifest recall
 * actually serves (loadManifest) must no longer list the purged path —
 * rather than trusting the rebuild call's own success. Skipped entirely
 * when no manifest exists yet:
 * nothing can be served from retrieval state that was never built, and a
 * purge must not materialize manifest/postings files as a side effect.
 * Returns { ok, reason }: ok false means the purged entry may still be
 * recallable, and the caller must NOT report the purge as fully passed.
 */
function refreshRecallAfterPurge({ workspace, copilotHome, target, log = () => {} }) {
  const posixTarget = String(target).split(/[\\/]+/).join('/');
  // Same roots resolveKnowledgePaths (recall-config.mjs) serves recall from,
  // built explicitly so a falsy copilotHome never degrades into a
  // cwd-relative 'knowledge' lookup.
  const roots = [];
  if (copilotHome) roots.push(path.join(copilotHome, 'knowledge'));
  roots.push(path.join(workspace, 'knowledge'));
  const manifestsOnDisk = () => roots.map((r) => path.join(r, 'manifest.yaml')).filter((p) => fs.existsSync(p));
  if (!manifestsOnDisk().length) return { ok: true, refreshed: false, reason: null };

  let rebuildError = null;
  try {
    const knowledgeRoot =
      copilotHome && fs.existsSync(path.join(copilotHome, 'knowledge')) ? path.join(copilotHome, 'knowledge') : null;
    runIndexKnowledge({ knowledgeRoot, workspace, copilotHome: copilotHome || '', flags: {}, log });
  } catch (err) {
    rebuildError = err?.message || 'index rebuild failed';
  }

  // Post-condition, checked through loadManifest — the EXACT read path
  // rankRecall serves from (first parseable manifest, copilotHome root
  // first), not a re-derived approximation of it — so "no longer listed"
  // here is precisely "no longer servable" there. Checked against disk
  // AFTER the rebuild rather than trusting the rebuild call's own success.
  let served;
  try {
    served = loadManifest(copilotHome || '', workspace);
  } catch {
    // A manifest read/parse crash means nothing provably serves the entry —
    // rankRecall's own read would fail the same way.
    return { ok: true, refreshed: !rebuildError, reason: null };
  }
  if ((served.entries || []).some((e) => e && e.path === posixTarget)) {
    return {
      ok: false,
      refreshed: !rebuildError,
      reason: `${served.path} still lists ${posixTarget}${rebuildError ? ` (index rebuild failed: ${rebuildError})` : ''} — run: harness index`,
    };
  }
  return { ok: true, refreshed: !rebuildError, reason: null };
}

/**
 * Every `<basename>.purge-<pid>-<ts>` staging sibling of `safe` in its own
 * directory. Purge stages the T1 episode via a rename to such a temp before
 * committing T2 (see below); if the process dies between the rename and the
 * commit, that temp is stranded with the still-live episode content in it and
 * nothing else would ever sweep it. Enumerating the siblings lets a later
 * purge (or the same one's finalize) COMPLETE the interrupted deletion — a
 * re-run that finds only debris must genuinely remove the content, never
 * report a clean/no-op success while the content persists on disk.
 */
function purgeTempSiblings(safe) {
  const d = path.dirname(safe);
  const base = path.basename(safe);
  let names;
  try {
    names = fs.readdirSync(d);
  } catch {
    return [];
  }
  // Match ONLY the exact shape this module stages — `<base>.purge-<pid>-<ts>`
  // with a numeric pid and timestamp — so a coincidentally-named unrelated
  // sibling (e.g. `report.md.purge-notes.md`) is never swept.
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const debrisRe = new RegExp(`^${escaped}\\.purge-\\d+-\\d+$`);
  return names.filter((n) => debrisRe.test(n)).map((n) => path.join(d, n));
}

/**
 * Cascade-delete one episode (design §3): the episode file itself, every
 * learning it was the sole evidence for, its link inside learnings that
 * cite it alongside other evidence, AND the recall retrieval state (team
 * manifest + postings index) that would otherwise keep serving the deleted
 * content (see refreshRecallAfterPurge). Ledger entries for the path are
 * dropped and INDEX.md is rebuilt so nothing dangling survives the purge.
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
      // TOCTOU re-check (P1-4): re-validate physical containment immediately
      // before the actual delete, not just at the check above. realpath-based
      // (assertRealpathContained) so a symlinked ANCESTOR swapped in after the
      // earlier walk — which resolves the delete target outside the root — is
      // caught here, not just a symlinked leaf.
      const safe = assertRealpathContained(episodeRoot, target);
      if (!safe) {
        return {
          pass: false,
          exitCode: 1,
          removed: null,
          blockedReason: `purge target no longer resolves safely (symlink introduced) — refusing to delete: ${target}`,
        };
      }
      fs.rmSync(safe, { force: true });
      // Even with no store, the recall manifest may list this episode —
      // deleting the file without updating retrieval state would leave it
      // recallable (title/summary/snippet) from the manifest alone.
      const recall = refreshRecallAfterPurge({ workspace, copilotHome, target, log });
      if (!recall.ok) {
        return {
          pass: false,
          exitCode: 1,
          removed: { episode: target, learnings: [], links: [], ledger: 0 },
          blockedReason: `episode file deleted, but recall retrieval state still serves it: ${recall.reason}`,
        };
      }
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

  // Atomicity (P2, tightening P1-8): stage the T1 workspace episode via a
  // reversible, same-filesystem RENAME to a temp path BEFORE the store cascade
  // (T2) commits, so the two are as close to atomic as a git store plus a
  // plain workspace file allow. On ANY failure through the commit, the episode
  // is renamed back — never lost, preserving P1-8's "a failed purge never
  // loses evidence". The temp is deleted only once the cascade has committed.
  // A TOCTOU containment re-check runs immediately before the rename; because
  // the file is renamed away before the transaction even starts, no
  // post-commit symlink race can redirect the finalizing delete.
  //
  // Recall reindex (refreshRecallAfterPurge, below) stays POST-COMMIT by
  // necessity: it rewrites WORKSPACE files (knowledge/manifest.yaml + postings),
  // not store files, so it cannot live inside the store's git transaction. Its
  // partial is loud and recoverable/idempotent — a still-served target yields
  // pass:false with "run: harness index", and re-running purge on the
  // already-deleted episode (or `harness index`) converges.
  // Resolved (containment-checked) target path under every candidate root —
  // used to stage the live episode AND to sweep `.purge-*` staging debris a
  // crashed prior purge may have stranded across either root.
  const safePaths = resolved.map((r) => r.full).filter(Boolean);
  // Debris a PRIOR interrupted purge left behind (rename landed, T2 commit
  // never did): its content is exactly the still-to-be-purged episode, so it
  // must count as "something to purge" and be swept on finalize — otherwise a
  // re-run silently reports "nothing to purge" while the content persists.
  const debrisBefore = safePaths.flatMap(purgeTempSiblings);

  let stagedFrom = null;
  let stagedTemp = null;
  if (episodeExistsOnDisk) {
    // realpath-based re-check (assertRealpathContained): the rename source must
    // resolve — through every ancestor — inside the root, so an ancestor
    // swapped for an outside symlink after the earlier walk cannot redirect the
    // staging rename onto an external file.
    const safe = assertRealpathContained(episodeRoot, target);
    if (!safe) {
      return {
        pass: false,
        exitCode: 1,
        removed: null,
        blockedReason: `purge target no longer resolves safely (symlink introduced) — refusing to delete: ${target}`,
      };
    }
    const temp = `${safe}.purge-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(safe, temp);
      stagedFrom = safe;
      stagedTemp = temp;
    } catch (err) {
      return {
        pass: false,
        exitCode: 1,
        removed: null,
        blockedReason: `could not stage the episode file for deletion: ${err.message}`,
      };
    }
  }
  // Restore the staged episode to its real path. Returns a human-recoverable
  // note (naming the temp path) when the restore rename itself fails, so a
  // caller can surface WHERE the content is instead of losing it silently.
  const restoreStaged = () => {
    if (!stagedTemp || !stagedFrom) return null;
    const temp = stagedTemp;
    stagedTemp = null;
    try {
      fs.renameSync(temp, stagedFrom);
      return null;
    } catch (err) {
      return ` — the episode could not be restored to ${stagedFrom} and is preserved at ${temp} (move it back manually): ${err.message}`;
    }
  };

  const tx = withStoreTransaction(
    workspace,
    {
      home,
      label: `purge: ${target}`,
      // Mirror the committed cascade under the still-held lock (P2); the
      // fully-deleted ids are named via retiredIds so their mirror copies are
      // swept even though the store has already forgotten them.
      afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home, log, retiredIds: result.removedLearnings || [] });
      },
    },
    ({ dir, recordCheckpoint }) => {
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
    // another writer has since moved past. The cascade is LAYER-AWARE
    // (blueprint §5a): every layer root — golden plus every branch bucket —
    // is scanned; human deletion always wins in every layer.
    const roots = [dir, ...listBuckets(dir).map((b) => b.dir)];
    const matchingByRoot = roots.map((root) => ({
      root,
      learnings: listLearnings(root).filter((l) => (l.fm.episodes || []).some((e) => e.path === target)),
      ledger: readLedger(root),
    }));
    const matchingLearnings = matchingByRoot.flatMap((m) => m.learnings);
    const ledgerHits = matchingByRoot.reduce((n, m) => n + m.ledger.filter((e) => e.path === target).length, 0);

    // Debris (a prior crash's stranded staging temp) also counts as "something
    // to purge": bailing here would leave that content on disk while reporting
    // "nothing to purge". With debris present we fall through so the post-commit
    // finalize sweeps it and the purge genuinely removes the content.
    if (!episodeExistsOnDisk && matchingLearnings.length === 0 && ledgerHits === 0 && debrisBefore.length === 0) {
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
    let ledgerRemoved = 0;
    for (const m of matchingByRoot) {
      for (const l of m.learnings) {
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
      const keptLedger = m.ledger.filter((e) => e.path !== target);
      if (keptLedger.length !== m.ledger.length) {
        fs.writeFileSync(
          path.join(m.root, 'consolidated.jsonl'),
          keptLedger.length ? keptLedger.map((e) => JSON.stringify(e)).join('\n') + '\n' : '',
          'utf8'
        );
        ledgerRemoved += m.ledger.length - keptLedger.length;
      }
      if (m.learnings.length) rebuildIndex(m.root);
    }
    rebuildIndex(dir);

    // Governance record (Milestone 4): a fully cascade-deleted learning's
    // history is dropped too — but ONLY once the id survives in NO layer
    // (blueprint §5a): a bucket copy removed while a golden twin (or another
    // bucket's copy) still exists must keep its governance history, since the
    // surviving learning is still governed by it.
    if (removedLearnings.length) {
      const survivingIds = new Set(roots.flatMap((root) => listLearnings(root).map((l) => l.id)));
      const fullyGone = new Set(removedLearnings.filter((id) => !survivingIds.has(id)));
      if (fullyGone.size) rewriteGovernance(dir, (e) => !fullyGone.has(e.id));
    }

    return {
      kind: 'success',
      commitMessage: `purge: ${target}`,
      removedLearnings,
      removedLinks,
      ledgerRemoved,
    };
  });

  if (!tx.ok) {
    // Cascade failed or was contended — restore the staged episode so a failed
    // purge never loses evidence (P1-8), exactly as if it had never been touched.
    const restoreNote = restoreStaged();
    return {
      pass: false,
      exitCode: 1,
      removed: null,
      blockedReason:
        (tx.locked
          ? 'E_LOCKED: another operation holds the store lock'
          : `purge failed: ${tx.error?.message || 'store transaction failed'}`) + (restoreNote || ''),
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  const inner = tx.result;
  if (inner.kind === 'reject') {
    // Nothing was purged (a no-match discovery bail) — restore the staged
    // episode. In practice staging only happens when the episode existed, and
    // an existing episode can never hit this reject branch, but restoring here
    // keeps the invariant unconditional.
    const restoreNote = restoreStaged();
    return {
      pass: inner.pass,
      exitCode: inner.exitCode,
      removed: inner.removed,
      blockedReason: (inner.blockedReason || '') + (restoreNote || ''),
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  // The cascade committed — finalize by sweeping EVERY `.purge-*` staging
  // sibling: this run's own staged temp AND any debris a crashed prior purge
  // stranded (that completes the interrupted deletion so the content is
  // genuinely gone, never left behind while we report success). The episodes
  // are already gone from their real paths, so a sweep failure only leaves
  // identifiable, same-directory debris — never resurrected content — and is
  // reported as a partial, not a failure.
  for (const sibling of safePaths.flatMap(purgeTempSiblings)) {
    try {
      fs.rmSync(sibling, { force: true });
    } catch {
      // Re-scanned below — a throw here just means this sibling still remains,
      // which the post-state check turns into an outright failure.
    }
  }
  stagedTemp = null; // swept above (or attempted); no separate finalize owns it now

  // Completion is judged from the ACTUAL POST-STATE, never the pre-state (P2):
  // the real episode path must be ABSENT and ZERO `.purge-*` staging siblings
  // may remain. A surviving temp still holds the live episode content, so its
  // presence is a FAILED purge — the content the human asked to delete is
  // still on disk — not a cosmetic partial the CLI can hide. The prior code
  // derived `episodeRemoved` from pre-state and only set a soft `partialReason`
  // (which the CLI renderer never surfaced) while returning pass:true.
  const debrisAfter = safePaths.flatMap(purgeTempSiblings);
  const realPathPresent = safePaths.some((p) => fs.existsSync(p));
  if (debrisAfter.length > 0 || realPathPresent) {
    const blockedReason = realPathPresent
      ? `store purge committed but the episode is still present on disk: ${target} — re-run purge`
      : `store purge committed but staging debris still holds the episode content and could not be removed: ${debrisAfter.join(', ')} — re-run purge or delete these files manually`;
    log(blockedReason);
    return {
      pass: false,
      exitCode: 1,
      removed: {
        // The content is NOT gone (a staging copy or the file itself remains).
        episode: null,
        learnings: inner.removedLearnings,
        links: inner.removedLinks,
        ledger: inner.ledgerRemoved,
      },
      blockedReason,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  // Post-state confirms the episode content is genuinely gone.
  const episodeRemoved = episodeExistsOnDisk || debrisBefore.length > 0;

  // The mirror already ran inside afterCommit (above), under the held lock on
  // the committed cascade — never here after the lock released (P2).

  // Recall-state cascade (refreshRecallAfterPurge): rebuild the manifest and
  // postings index so rankRecall stops serving the purged episode. NOT best
  // effort — a purge whose target can still be recalled must never report
  // pass: true.
  const recall = refreshRecallAfterPurge({ workspace, copilotHome, target, log });
  if (!recall.ok) {
    return {
      pass: false,
      exitCode: 1,
      removed: {
        episode: episodeRemoved ? target : null,
        learnings: inner.removedLearnings,
        links: inner.removedLinks,
        ledger: inner.ledgerRemoved,
      },
      blockedReason: `store purge committed, but recall retrieval state still serves the purged episode: ${recall.reason}`,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
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

  const tx = withStoreTransaction(
    workspace,
    {
      home,
      label: 'purge: --all (store reset)',
      // Mirror the committed reset under the still-held lock (P2), with the
      // pre-wipe ids plumbed through so the sweep can still match them.
      afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home, retiredIds: result.idsBeforeReset || [] });
      },
    },
    ({ dir, recordCheckpoint }) => {
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
    // Layer cascade (blueprint §5a): purge --all wipes `branches/` whole —
    // human deletion always wins in every layer; bucket learnings count
    // toward the removal total too.
    for (const bucket of listBuckets(dir)) {
      n += listLearnings(bucket.dir).length;
    }
    fs.rmSync(branchesRoot(dir), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'consolidated.jsonl'), '', 'utf8');
    // Truncate rather than rewriteGovernance(dir, () => false): purge --all
    // erases the entire store, so there is no surviving id left for a
    // predicate to filter against — a full truncate is equivalent and simpler.
    fs.writeFileSync(path.join(dir, 'governance.jsonl'), '', 'utf8');
    rebuildIndex(dir);
    return { kind: 'success', commitMessage: 'purge: --all (store reset)', removedCount: n, idsBeforeReset };
    }
  );

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
  // The mirror already ran inside afterCommit (above), under the held lock on
  // the committed reset — never here after the lock released (P2).
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
    // Preview counts what the wipe below actually archives: golden learnings
    // PLUS every bucket's (blueprint §5a) — golden alone under-counts.
    const archivedPreview = fs.existsSync(storePath)
      ? listLearnings(storePath).length + listBuckets(storePath).reduce((n, b) => n + listLearnings(b.dir).length, 0)
      : 0;
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
  const tx = withStoreTransaction(
    workspace,
    {
      home,
      label: 'consolidate: rebuild reset',
      // Mirror the committed rebuild under the still-held lock (P2), with the
      // archived ids plumbed through so the sweep clears their mirror copies.
      afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home, retiredIds: result.archivedIds || [] });
      },
    },
    ({ dir, recordCheckpoint }) => {
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

    const learningsDir = path.join(dir, 'learnings');
    if (fs.existsSync(learningsDir)) {
      for (const domain of fs.readdirSync(learningsDir, { withFileTypes: true })) {
        if (!domain.isDirectory()) continue;
        fs.rmSync(path.join(learningsDir, domain.name), { recursive: true, force: true });
      }
    }
    fs.writeFileSync(path.join(dir, 'consolidated.jsonl'), '', 'utf8');
    // Per-layer rebuild (blueprint §5a): every bucket's learnings and ledger
    // are wiped too — bucket meta.json survives as the layer's identity — so
    // each lane re-derives from raw episodes routed by their `branch:`
    // provenance (episodeEligibleForLayer): golden consolidation on the
    // default branch takes only default-branch episodes, each branch lane
    // takes its own plus provenance-less ones. Nothing is laundered into
    // golden by the wipe itself.
    let archivedBranch = 0;
    for (const bucket of listBuckets(dir)) {
      archivedBranch += listLearnings(bucket.dir).length;
      fs.rmSync(path.join(bucket.dir, 'learnings'), { recursive: true, force: true });
      fs.mkdirSync(path.join(bucket.dir, 'learnings'), { recursive: true });
      fs.writeFileSync(path.join(bucket.dir, 'consolidated.jsonl'), '', 'utf8');
      rebuildIndex(bucket.dir);
    }
    const archived = archivedLearnings.length + archivedBranch;
    rebuildIndex(dir);
    fs.rmSync(path.join(dir, 'stale.json'), { force: true });
    return {
      kind: 'success',
      commitMessage: `consolidate: rebuild reset (${archived} learnings archived to git history)`,
      archived,
      archivedIds: archivedLearnings.map((l) => l.id),
    };
    }
  );

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
  // The mirror already ran inside afterCommit (above), under the held lock on
  // the committed rebuild — never here after the lock released (P2).

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
    return {
      pass: false,
      exitCode: 1,
      migrated: false,
      blockedReason: `migration failed: ${err.message}`,
      ...(staleLockNote ? { staleLockRemoved: staleLockNote } : {}),
    };
  } finally {
    // Release the legacy-store lock on EVERY exit path — including the
    // collision recheck's early `return` from inside the try above, which
    // previously bypassed the catch-only cleanup and leaked the `.lock` until
    // stale takeover. On the success path legacyDir has been renamed away, so
    // this is a harmless no-op (ENOENT swallowed by force) — the MOVED lock at
    // targetDir/.lock is cleared separately above. Best effort: a cleanup
    // failure must never mask the real result.
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // ignored — a leftover lock is taken over as stale on the next attempt
    }
  }
}
