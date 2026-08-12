import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  withStoreTransaction,
  StoreTransactionAbort,
  LEARNING_FILE_RE,
  parsePorcelainZ,
  storeDir,
  storeDirForId,
  repoId,
  localRepoId,
  acquireStoreLock,
  releaseStoreLock,
  listLearnings,
  readLedger,
  appendLedger,
  writeLedger,
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
import { assertNoSymlinkAncestors, assertRealpathContained, writeFileContained, readFileNoFollow } from '../fs-safe.mjs';
import {
  readLearningFile,
  writeLearningFile,
  removeLearningFile,
  quarantineSymlinkedLearning,
  writeStoreFile,
  removeStoreFile,
  storeFileState,
} from './store-io.mjs';
import { runIndexKnowledge } from '../index-knowledge.mjs';
import { loadManifest } from '../recall-rank.mjs';

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
  // Through the choke point (S1) — both halves. Returns null when the path is
  // not a safely-resolvable learning file inside the store (symlinked leaf or
  // ancestor, escaped path, over-cap, vanished); the purge cascade treats that
  // as a hard failure rather than silently reporting a delink that never
  // happened.
  const text = readLearningFile(file);
  if (text === null) return null;
  const { fm, body } = parseLearningFrontmatter(text);
  // Preserve every other field, including last_confirmed as parsed — a purge
  // is a negative event on this learning's remaining evidence, not a fresh
  // human confirmation, so it must never refresh the last_confirmed trust
  // signal.
  fm.episodes = (fm.episodes || []).filter((e) => e.path !== targetPath);
  if (!writeLearningFile(file, serializeLearning(fm, body))) return null;
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
    // Through the choke point (S1). `listLearnings` already refuses a symlinked
    // learning, so this is the second, independent refusal on the same path —
    // deliberately, because mirrorLearnings copies verbatim bytes into a
    // COMMITTED workspace path under `knowledge commit repo`: following a
    // planted link here published an arbitrary outside file into the product
    // repo's PR flow. A null read is swept like any other skip.
    const text = readLearningFile(learning.file);
    if (text === null) {
      skipped++;
      skippedIds.add(learning.id);
      log(`mirror: ${learning.id} could not be read safely from the store — skipped`);
      continue;
    }
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
 *
 * UNTRACKED LEARNING FILES ARE HAND EDITS TOO (P1). A learning file planted
 * directly in the store — `?? learnings/<domain>/<slug>.md`, or the bucket
 * equivalent — is ACTIVE, retrievable content the moment it lands
 * (listLearnings reads the tree, not the git index), yet it was skipped here
 * as "untracked/other" and then swept wholesale into store history by the
 * next transaction's `git add -A` — INCLUDING a transaction whose own op set
 * was rejected. Never validated, never secret-scanned, never rendered by the
 * sole writer, and recorded with whatever provenance its author typed.
 * Untracked learning paths are therefore absorbed through this exact same
 * path as a modified one: snapshot-evidenced, secret-scanned, byte-cap
 * logged, re-serialized by `serializeLearning`, and stamped `source: human`
 * — the honest provenance for a file a person put in the store by hand.
 * `-uall` is required for that: the default `-unormal` collapses a brand-new
 * `learnings/<domain>/` into a single directory entry that matches no
 * learning path shape.
 *
 * A SYMLINK AT A LEARNING PATH IS NEVER ABSORBED. Every read and write in this
 * loop goes through fs-safe.mjs (`assertNoSymlinkAncestors` + `readFileNoFollow`
 * on the way in, `writeFileContained` on the way out), because a planted
 * symlink is otherwise followed in BOTH directions — reading an arbitrary
 * outside file into store history and a workspace teaching snapshot, then
 * overwriting that outside file with a canonically serialized learning. Such a
 * path is refused with a logged note, never followed.
 *
 * THAT COVERS A SYMLINK AT A LEARNING FILE, AND ONLY THAT. A symlink at a
 * store-owned DIRECTORY (`learnings/`, a domain directory, `branches/`, a
 * bucket, a bucket's learnings tree) never reaches this loop at all:
 * LEARNING_FILE_RE matches `…/<domain>/<slug>.md`, so a directory plant yields
 * no entry to quarantine, and every learning it hides looks to absorb like it
 * was simply never there. Worse, absorb would then read the resulting `D`
 * entries as a human deleting every learning at once and record a governance
 * `retire` for each. That whole class is handled UPSTREAM instead, before this
 * function is ever called: `withStoreTransaction` (store.mjs) sweeps the owned
 * directory shapes under the lock — quarantine, restore from the last commit,
 * then refuse the run — and `commitStore` refuses to stage while one stands.
 */
/** Truncate a store-owned file through the choke point, failing closed: a wipe
 * that was refused must never be reported as a completed purge/rebuild. */
function wipe(file) {
  if (!writeStoreFile(file, '')) {
    throw new Error(`refused to truncate ${file} — the path does not resolve safely inside the knowledge store`);
  }
}

/** Per-character allow-list of porcelain status codes an absorb acts on, plus
 * the unmerged codes carved out of it. See the comment at the filter below. */
const ABSORBABLE_CODES = new Set(['M', 'A', 'T']);
const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export function absorbHandEdits({ workspace, home, log = () => {} }) {
  const empty = { absorbed: [], deleted: [], committed: false };
  const dir = storeDir(workspace, { home });
  if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, '.git'))) return empty;

  const status = spawnSync('git', ['status', '--porcelain', '-uall', '-z'], { cwd: dir, encoding: 'utf8' });
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
  // NUL-delimited, verbatim paths (S3): the line-oriented format C-quotes any
  // path with a non-ASCII byte, a quote, a backslash, or a control char, and
  // the old hand-rolled unquoting mis-decoded exactly those — so a hand edit to
  // `learnings/café/x.md` was silently invisible to absorb and then swept into
  // store history unvalidated by the next `git add -A`.
  const entries = parsePorcelainZ(status.stdout);
  if (!entries.length) return empty;

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

  for (const { status: code, path: rel } of entries) {
    const m = LEARNING_FILE_RE.exec(rel);
    if (!m) continue; // non-learning file — left for the normal commit
    // Bucket capture (blueprint §5a): a hand edit under
    // branches/<key>/learnings/** absorbs exactly like a golden one; the
    // bucket key is recorded in the snapshot frontmatter below so the
    // provenance names which layer the human touched.
    const [, bucketKey, domain, slug] = m;
    const id = `${domain}/${slug}`;
    const layerRoot = bucketKey ? bucketDirFor(dir, bucketKey) : dir;

    // A SYMLINK AT A LEARNING PATH IS NEVER A LEARNING (P1), AND THE CHECK RUNS
    // BEFORE ANY STATUS-CODE FILTER (R2). `rel` comes straight from `git status`
    // over a directory a human hand-edits, and this block both READS the path
    // and later REWRITES it canonically — so a planted symlink was followed
    // BOTH ways: the read pulled an arbitrary outside file's content into the
    // absorb pipeline (snapshotted into the workspace, committed into store
    // history) and the rewrite overwrote that outside file with a serialized
    // learning.
    //
    // THE ORDER IS THE FIX. The absorbable-code filter used to run FIRST, and
    // the likeliest plant of all — replacing a TRACKED learning file with a
    // symlink — makes git emit ` T` (typechange; git-status(1): "[ MTARC] T
    // type changed in the work tree since the index"), which is neither `??`
    // nor contains `M`. It `continue`d here: never quarantined, never logged,
    // and the next `commitStore`'s `git add -A` committed the symlink into
    // store history while `listLearnings` silently dropped the learning. A
    // deny-list filter excluded the case that mattered, so the symlink check
    // now precedes every filter that could exclude it.
    const file = assertNoSymlinkAncestors(dir, rel);
    if (!file) {
      // REFUSING IS NOT ENOUGH — THE LINK MUST BECOME INERT (S1). The previous
      // round refused to follow it here and LEFT IT IN PLACE, so it stayed on
      // disk at a live learning path for every other reader and writer to trip
      // over. It is now moved (link itself, never its target) into
      // `<store>/.quarantine/`, which is gitignored: out of `learnings/`, out
      // of store history, preserved for inspection, and reported.
      const quarantined = quarantineSymlinkedLearning(path.resolve(dir, rel));
      log(
        quarantined
          ? `hand-edit absorb: ${rel} is a symlink — never followed; moved to ${quarantined}`
          : `hand-edit absorb: ${rel} is a symlink or sits under one — refused, never followed`
      );
      continue;
    }

    // THE UNMERGED CARVE-OUT RUNS FIRST, BEFORE ANY CODE IS INTERPRETED (R7).
    // A store repo never merges, and absorbing half a conflict would be worse
    // than leaving it — but the carve-out used to sit BELOW the deletion branch,
    // and every unmerged code that names a deletion (`DD` both deleted, `UD`
    // deleted by them, `DU` deleted by us) contains a literal `D`. Those states
    // were therefore recorded as HAND DELETIONS: a governance `retire` that
    // binds both layers and survives `consolidate --rebuild`, written for a
    // conflict nobody has resolved yet. The carve-out never ran, exactly
    // contrary to the comment that claimed it did. Order is the fix.
    if (UNMERGED_CODES.has(code)) continue;
    if (code.includes('D')) {
      // Human deletion always wins — nothing left to parse or re-render.
      deleted.push(id);
      if (bucketKey) touchedBucketRoots.add(layerRoot);
      continue;
    }
    // ALLOW-LIST, NOT DENY-LIST (rule 3). These are the codes whose worktree
    // state means "this learning file's content is not what the last commit
    // recorded", so it must be absorbed rather than swept into store history by
    // the next `git add -A`:
    //   `??` planted and never tracked   `M` modified in the worktree/index
    //   `A`  staged but never committed  `T` type changed back to a real file
    // Everything else (rename-into, copy) stays out of absorb scope as before.
    if (code !== '??' && ![...code].some((ch) => ABSORBABLE_CODES.has(ch))) continue;

    const text = readLearningFile(file);
    if (text === null) {
      // Vanished between status and read, swapped for a symlink since the walk
      // above, over the read cap, or resolving outside the store — nothing
      // safe to absorb either way.
      log(`hand-edit absorb: ${rel} could not be read safely — skipped`);
      continue;
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
    // Staged, not yet recorded: the ledger entry only becomes real once the
    // learning file itself has been rewritten successfully below. Pushing it
    // eagerly would leave the ledger crediting a snapshot for an absorb that
    // was then refused.
    let ledgerEntry = null;
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
        ledgerEntry = { path: snapshot, sha256, learning: id, at };
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
    // The write half of the symlink guard above (fs-safe.mjs): contained and
    // atomic, so an ancestor swapped for a symlink AFTER the pre-read walk
    // still cannot steer this rewrite onto a file outside the store — the temp
    // is created empty, containment-verified in place, filled through the
    // verified descriptor, then renamed over the leaf (a rename replaces a
    // symlink, it never follows one).
    if (!writeLearningFile(file, content)) {
      log(`hand-edit absorb: refused to rewrite ${rel} — the path no longer resolves inside the knowledge store`);
      // NO ORPHAN TEACHING SNAPSHOT. The snapshot is written BEFORE this
      // refusal can happen, and until now the refusal just `continue`d — so
      // `docs/solutions/teachings/<date>-hand-edit-<slug>.md` stayed behind in
      // the workspace with nothing citing it. That file is a valid
      // `kind: human-teaching` candidate episode, so a later ADD could cite it
      // and be admitted with `source: human` authority for an absorb that was
      // REFUSED. Snapshot and rewrite are therefore all-or-nothing: on refusal
      // the snapshot is removed again, and only if it cannot be removed is the
      // orphan reported rather than left silent.
      if (snapshot) {
        const snapFull = assertRealpathContained(workspace, snapshot);
        let cleared = false;
        if (snapFull) {
          try {
            fs.rmSync(snapFull, { force: true });
            cleared = true;
          } catch {
            cleared = false;
          }
        }
        if (!cleared) {
          log(`hand-edit absorb: could not remove the orphaned teaching snapshot ${snapshot} — delete it by hand before it is cited as evidence`);
        }
      }
      continue;
    }
    if (ledgerEntry) {
      if (!ledgerByRoot.has(layerRoot)) ledgerByRoot.set(layerRoot, []);
      ledgerByRoot.get(layerRoot).push(ledgerEntry);
    }
    absorbed.push({ id, snapshot });
    if (bucketKey) touchedBucketRoots.add(layerRoot);
  }

  if (!absorbed.length && !deleted.length) return empty;

  // THE EVIDENCE IS PART OF THE ABSORB, NOT A SIDE EFFECT (review finding).
  // `appendLedger`/`appendGovernance` already fail closed by THROWING on a
  // refused write — but a plain Error thrown from here lands in every
  // transaction adopter's `catch (err) { if (err instanceof
    const recordEvidence = (write) => {
    try {
      write();
    } catch (err) {
      throw new StoreTransactionAbort(`hand-edit absorb could not record its evidence: ${err.message}`);
    }
  };
  for (const [root, entries] of ledgerByRoot) recordEvidence(() => appendLedger(root, entries));
    const governanceAt = new Date().toISOString();
    const goldenIds = new Set(listLearnings(dir).map((l) => l.id));
  const activeIds = (root) => listLearnings(root).filter((l) => isActiveFm(l.fm)).map((l) => l.id);
  const survivingIds = new Set([
    ...activeIds(dir),
    ...listBuckets(dir).flatMap((b) => {
      try {
        return activeIds(b.dir);
      } catch {
        return [];
      }
    }),
  ]);
  for (const id of deleted) {
    if (survivingIds.has(id)) {
      log(`hand-edit absorb: ${id} removed from one layer but still held by another — no store-wide retire recorded`);
      continue;
    }
    recordEvidence(() =>
      appendGovernance(dir, { id, action: 'retire', reason: 'hand deletion (absorbed)', to: null, at: governanceAt })
    );
  }
  rebuildIndex(dir);
    for (const root of touchedBucketRoots) {
    if (fs.existsSync(root)) rebuildIndex(root);
  }
  const ids = [...absorbed.map((a) => a.id), ...deleted].join(', ');
  const commitRes = commitStore(dir, `human edit: ${ids}`);
  if (!commitRes.ok) {
        return { absorbed, deleted, committed: false, ok: false, stderr: commitRes.stderr };
  }
  try {
        mirrorLearnings({ workspace, home, log, retiredIds: deleted.filter((id) => !goldenIds.has(id)) });
  } catch {
    // best effort — a mirror failure must never block absorb.
  }
  return { absorbed, deleted, committed: commitRes.committed };
}

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

function refreshRecallAfterPurge({ workspace, copilotHome, target, log = () => {} }) {
  const posixTarget = String(target).split(/[\\/]+/).join('/');
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

    let served;
  try {
    served = loadManifest(copilotHome || '', workspace);
  } catch {
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

function purgeTempSiblings(safe) {
  const d = path.dirname(safe);
  const base = path.basename(safe);
  let names;
  try {
    names = fs.readdirSync(d);
  } catch {
    return [];
  }
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const debrisRe = new RegExp(`^${escaped}\\.purge-\\d+-\\d+$`);
  return names.filter((n) => debrisRe.test(n)).map((n) => path.join(d, n));
}

export function purgeEpisode({ workspace, target, copilotHome, home, log = () => {} }) {
  if (!target) {
    return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: 'purge needs a target file path or --all',
    };
  }
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
        return {
      pass: false,
      exitCode: 2,
      removed: null,
      blockedReason: `${target} exists under both ${existingIn.map((r) => r.label).join(' and ')} — ambiguous; pass an explicit prefix or delete the unwanted copy directly`,
    };
  }

    const chosen = existingIn[0] || resolved[0];
  const episodeRoot = chosen.dir;
  const episodeExistsOnDisk = chosen.existsOnDisk;

    const storePath = storeDir(workspace, { home });
  if (!fs.existsSync(storePath)) {
    if (episodeExistsOnDisk) {
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

    const safePaths = resolved.map((r) => r.full).filter(Boolean);
    const debrisBefore = safePaths.flatMap(purgeTempSiblings);

  let stagedFrom = null;
  let stagedTemp = null;
  if (episodeExistsOnDisk) {
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
            afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home, log, retiredIds: result.removedLearnings || [] });
      },
    },
    ({ dir, recordCheckpoint }) => {
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
            if (err instanceof StoreTransactionAbort) throw err;
    }

        const roots = [dir, ...listBuckets(dir).map((b) => b.dir)];
    const matchingByRoot = roots.map((root) => ({
      root,
      learnings: listLearnings(root).filter((l) => (l.fm.episodes || []).some((e) => e.path === target)),
      ledger: readLedger(root),
    }));
    const matchingLearnings = matchingByRoot.flatMap((m) => m.learnings);
    const ledgerHits = matchingByRoot.reduce((n, m) => n + m.ledger.filter((e) => e.path === target).length, 0);

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
                const remaining = episodes.filter((e) => e.path !== target);
        if (remaining.length === 0) {
                    if (!removeLearningFile(l.file)) {
            throw new Error(`refused to delete ${l.id}: the learning path does not resolve safely inside the knowledge store`);
          }
          removedLearnings.push(l.id);
        } else {
          if (removeEpisodeLink(l.file, target) === null) {
            throw new Error(`refused to delink ${l.id}: the learning path does not resolve safely inside the knowledge store`);
          }
          removedLinks.push(l.id);
        }
      }
      const keptLedger = m.ledger.filter((e) => e.path !== target);
      if (keptLedger.length !== m.ledger.length) {
                writeLedger(m.root, keptLedger);
        ledgerRemoved += m.ledger.length - keptLedger.length;
      }
      if (m.learnings.length) rebuildIndex(m.root);
    }
    rebuildIndex(dir);

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
        const restoreNote = restoreStaged();
    return {
      pass: inner.pass,
      exitCode: inner.exitCode,
      removed: inner.removed,
      blockedReason: (inner.blockedReason || '') + (restoreNote || ''),
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

    for (const sibling of safePaths.flatMap(purgeTempSiblings)) {
    try {
      fs.rmSync(sibling, { force: true });
    } catch {
          }
  }
  stagedTemp = null; // swept above (or attempted); no separate finalize owns it now

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

export function purgeAll({ workspace, home, log = () => {} }) {
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
            afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home, retiredIds: result.idsBeforeReset || [] });
      },
    },
    ({ dir, recordCheckpoint }) => {
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
            if (err instanceof StoreTransactionAbort) throw err;
    }
        const idsBeforeReset = listLearnings(dir).map((l) => l.id);
    const learningsDir = path.join(dir, 'learnings');
    let n = 0;
    if (fs.existsSync(learningsDir)) {
      for (const domain of fs.readdirSync(learningsDir, { withFileTypes: true })) {
        if (!domain.isDirectory()) continue;
        const dPath = path.join(learningsDir, domain.name);
        n += fs.readdirSync(dPath).filter((f) => f.endsWith('.md')).length;
                const contained = assertRealpathContained(dir, path.join('learnings', domain.name));
        if (contained) fs.rmSync(contained, { recursive: true, force: true });
      }
    }
        for (const bucket of listBuckets(dir)) {
      n += listLearnings(bucket.dir).length;
    }
    const containedBranches = assertRealpathContained(dir, 'branches');
    if (containedBranches) fs.rmSync(containedBranches, { recursive: true, force: true });
        wipe(path.join(dir, 'consolidated.jsonl'));
        wipe(path.join(dir, 'governance.jsonl'));
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
    return {
    pass: true,
    exitCode: 0,
    removed: { learnings: inner.removedCount },
    blockedReason: null,
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}

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
        const storePath = storeDir(workspace, { home });
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

    const tx = withStoreTransaction(
    workspace,
    {
      home,
      label: 'consolidate: rebuild reset',
            afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home, retiredIds: result.archivedIds || [] });
      },
    },
    ({ dir, recordCheckpoint }) => {
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
            if (err instanceof StoreTransactionAbort) throw err;
    }
        const archivedLearnings = listLearnings(dir);

    const learningsDir = path.join(dir, 'learnings');
    if (fs.existsSync(learningsDir)) {
      for (const domain of fs.readdirSync(learningsDir, { withFileTypes: true })) {
        if (!domain.isDirectory()) continue;
        // Same containment guard as purgeAll's sweep above.
        const contained = assertRealpathContained(dir, path.join('learnings', domain.name));
        if (contained) fs.rmSync(contained, { recursive: true, force: true });
      }
    }
    wipe(path.join(dir, 'consolidated.jsonl'));
        let archivedBranch = 0;
    for (const bucket of listBuckets(dir)) {
      archivedBranch += listLearnings(bucket.dir).length;
      const containedBucketLearnings = assertRealpathContained(dir, path.join('branches', bucket.key, 'learnings'));
      if (containedBucketLearnings) fs.rmSync(containedBucketLearnings, { recursive: true, force: true });
      fs.mkdirSync(path.join(bucket.dir, 'learnings'), { recursive: true });
      wipe(path.join(bucket.dir, 'consolidated.jsonl'));
      rebuildIndex(bucket.dir);
    }
    const archived = archivedLearnings.length + archivedBranch;
    rebuildIndex(dir);
    removeStoreFile(path.join(dir, 'stale.json'));
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

function isNonEmptyDir(dir) {
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
}

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

    if (storeFileState(path.join(legacyDir, 'consolidated.jsonl')) !== 'file') {
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
        if (fs.existsSync(targetDir)) fs.rmdirSync(targetDir);
    try {
      fs.renameSync(legacyDir, targetDir);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
            try {
        fs.cpSync(legacyDir, targetDir, { recursive: true });
        if (storeFileState(path.join(targetDir, 'consolidated.jsonl')) !== 'file') {
          throw new Error('cross-device copy did not verify — legacy store left untouched');
        }
      } catch (copyErr) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        throw copyErr;
      }
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
        releaseStoreLock(path.join(targetDir, '.lock'), lock.token);
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
        try {
            releaseStoreLock(lockPath, lock.token);
    } catch {
      // ignored — a leftover lock is taken over as stale on the next attempt
    }
  }
}
