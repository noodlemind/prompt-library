import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from '../paths.mjs';
import { assertNoSymlinkAncestors, assertRealpathContained, readFileNoFollow } from '../fs-safe.mjs';
import {
  readLearningFile,
  readStoreFile,
  writeStoreFile,
  appendStoreFile,
  removeStoreFile,
  storeFileState,
  findSymlinkedStoreDirectories,
  reclaimSymlinkedStoreDirectory,
  QUARANTINE_DIR,
} from './store-io.mjs';

/**
 * The local knowledge store: a CLI-managed git repo OUTSIDE the working tree
 * at <harness home>/knowledge/<repo-id>/ — survives `git clean`, re-clones,
 * and is shared by every worktree/clone of the same remote. Never pushed.
 */

const INDEX_STUB = `# Learnings Index

_Rebuilt by \`harness consolidate --apply\`. One line per active learning._
`;

function gitOut(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * The path-keyed store id — a stable hash of the workspace's real path,
 * independent of whatever remote (if any) is currently configured. This is
 * exactly what `repoId` below falls back to when there's no origin remote.
 * Exported separately (P2) so a caller can compute what the store id WAS (or
 * would be) for this workspace WITHOUT a remote, regardless of whether one
 * is configured now — the doctor stranded-store check and
 * `harness knowledge migrate-store` (admin.mjs) both need this: once a
 * workspace gains an origin remote, `repoId` switches to the remote-keyed id
 * and a store built under the OLD path-keyed id silently stops being read or
 * written by anything, with nothing surfacing that it still exists on disk.
 */
export function localRepoId(workspace) {
  let real = workspace;
  try {
    real = fs.realpathSync(workspace);
  } catch {
    // keep the given path
  }
  return `local-${crypto.createHash('sha256').update(real).digest('hex').slice(0, 12)}`;
}

/**
 * Normalize any origin-remote form (ssh/https/scp) to one stable id. The
 * human-readable slug alone is lossy — `github.com/org-a/repo-b` and
 * `github.com/org-a-repo/b` both collapse to the same slug once `/` and `-`
 * are folded together — so a short hash of the pre-lossy canonical string is
 * appended to disambiguate. Equivalent ssh/https/scp forms of the same
 * remote still share one canonical string, so they still share one id.
 */
export function repoId(workspace) {
  const remote = gitOut(workspace, ['remote', 'get-url', 'origin']);
  if (remote) {
    const canonical = remote
      .trim()
      .replace(/\.git$/, '')
      .replace(/^[a-z+]+:\/\//i, '') // https://, ssh://, git://
      .replace(/^[^@/]+@/, '') // user@
      .replace(/:/g, '/') // scp form host:path
      .toLowerCase();
    const slug = canonical.replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) {
      const suffix = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
      return `${slug}-${suffix}`;
    }
  }
  // No remote: stable path-keyed fallback (documented limitation — memory is
  // per-path until a remote is added).
  return localRepoId(workspace);
}

/** `<home>/knowledge/<id>` for an ALREADY-COMPUTED store id — the shared
 * join `storeDir` below uses for the current `repoId(workspace)`, exported
 * separately so a caller that already has (or wants) a DIFFERENT id — the
 * doctor stranded-store check and `harness knowledge migrate-store`
 * (admin.mjs), both working with `localRepoId`'s path-keyed id alongside the
 * current `repoId` — can resolve either one to a directory without
 * duplicating this join. */
export function storeDirForId(id, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'knowledge', id);
}

export function storeDir(workspace, { home } = {}) {
  return storeDirForId(repoId(workspace), { home });
}

/**
 * Store schema version (blueprint §5a): stamped into `store.json` by
 * ensureStore, checked wherever the store is opened for use. Schema 2 = the
 * layered store (golden `learnings/` + `branches/<key>/` buckets). A store
 * whose recorded schema is NEWER than this CLI supports refuses with an
 * upgrade hint instead of operating layer-blind — an older CLI running
 * root-anchored maintenance against a layered store is a data-loss hazard,
 * not a degraded mode. An absent/corrupt store.json is treated as the
 * current schema (legacy stores predate the marker and are fully readable).
 */
export const STORE_SCHEMA = 2;

export function assertStoreSchemaSupported(dir) {
  let recorded = null;
  try {
    const parsed = JSON.parse(readStoreFile(path.join(dir, 'store.json')));
    if (parsed && Number.isInteger(parsed.schema)) recorded = parsed.schema;
  } catch {
    recorded = null; // absent, unreadable, symlinked, or corrupt — never a refusal
  }
  if (recorded !== null && recorded > STORE_SCHEMA) {
    const err = new Error(
      `knowledge store schema ${recorded} is newer than this CLI supports (${STORE_SCHEMA}) — upgrade @dev-kit/harness before touching this store`
    );
    err.code = 'E_STORE_SCHEMA';
    err.hint = 'npm install -g @dev-kit/harness@latest && harness install';
    throw err;
  }
  return recorded;
}

/**
 * The store's `.gitignore` (S2 — LOCK LOSS MUST BE STRUCTURALLY IMPOSSIBLE).
 *
 * `rollbackStore` runs `git clean -fd`, which sweeps every untracked directory
 * in the store — including the `.lock` the running transaction is holding. The
 * previous rounds patched that by re-asserting the lock with a bare
 * `fs.mkdirSync(lockPath)` afterwards and swallowing EEXIST as "still there":
 * if a second writer had grabbed the freed lock in that window, the first
 * writer carried on regardless, `git add -A`-ed the other writer's in-flight
 * files, and finally `rmSync`-ed THEIR lock.
 *
 * A `.gitignore` removes the window instead of racing inside it: `git clean`
 * without `-x` never touches an ignored path, and `git add -A` never stages
 * one. The lock (and its stale-takeover tombstones, and the symlink quarantine
 * bucket) therefore survive every rollback by construction. Ownership tokens
 * below are the second, independent layer — belt to this brace — because a
 * store whose `.gitignore` a human deleted must still never release a lock it
 * does not own.
 *
 * The transaction journal needs no entry: it lives at `.git/harness-txn.json`,
 * which git neither stages nor cleans.
 */
const STORE_IGNORE_ENTRIES = ['/.lock/', '/.lock.stale-*', `/${QUARANTINE_DIR}/`];

/**
 * Write or migrate the store `.gitignore`. Existing stores predate it, so this
 * runs on EVERY open (ensureStore) rather than only at creation: a store built
 * by an older CLI gains the entries the first time any command touches it,
 * which is the only migration point that does not require the user to know a
 * migration exists. Idempotent and additive — an entry a human already wrote
 * is not duplicated, and lines this CLI does not own are preserved verbatim.
 */
/**
 * Called from inside `withStoreTransaction` UNDER THE LOCK (P3), never from
 * `ensureStore`: it used to run before `acquireStoreLock`, which made it a
 * store MUTATION outside the lock — two writers could interleave a
 * read-modify-write of the same file, and the very file that keeps a rollback
 * from sweeping the lock was written by an unlocked path.
 *
 * NEVER CLOBBER WHAT YOU COULD NOT READ (P3). A `.gitignore` that exists but
 * fails `readStoreFile` for a reason OTHER than "it is a symlink" — over
 * DEFAULT_MAX_BYTES, unreadable permissions — used to read as `''` and was then
 * FULLY REPLACED rather than extended, destroying whatever a human had put
 * there. Such a file is now left exactly as found: the entries are merely a
 * belt to the ownership-token brace, so running without them is degraded, not
 * unsafe, while silently rewriting a file we cannot see is neither.
 */
function ensureStoreGitignore(dir) {
  const gitignore = path.join(dir, '.gitignore');
  const state = storeFileState(gitignore);
  // 'other'/'blocked': a directory at that name, or a symlinked ancestor —
  // nothing this function may safely touch. 'symlink' falls through: the
  // planted link is quarantined by writeStoreFile and a real file takes its
  // place, which is the whole point of making a plant inert.
  if (state === 'other' || state === 'blocked') return;
  let existing = '';
  if (state === 'file') {
    const text = readStoreFile(gitignore);
    if (text === null) return; // present and real, but unreadable — never rewrite it
    existing = text;
  }
  const lines = existing.split('\n').map((l) => l.trim());
  const missing = STORE_IGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (!missing.length) return;
  const header = existing ? (existing.endsWith('\n') ? '' : '\n') : '# harness knowledge store — never staged, never swept by `git clean -fd`\n';
  try {
    // Best effort: an unwritable `.gitignore` still lets the store run — it
    // just falls back to the ownership-token layer below for lock safety,
    // which is independent of this file.
    writeStoreFile(gitignore, existing + header + missing.join('\n') + '\n');
  } catch {
    // writeFileContained mkdirs the parent, which can throw on a hand-built store
  }
}

export function ensureStore(workspace, { home, dryRun = false } = {}) {
  const dir = storeDir(workspace, { home });
  assertStoreSchemaSupported(dir);
  const ledgerPath = path.join(dir, 'consolidated.jsonl');
  const created = storeFileState(ledgerPath) !== 'file';
  // `.git` is a DIRECTORY probe, not a store-owned file read — the store's git
  // repo is created and read by git itself, never by this module.
  if (dryRun) return { dir, created, git: fs.existsSync(path.join(dir, '.git')) };
  fs.mkdirSync(path.join(dir, 'learnings'), { recursive: true });
  let gitOk = fs.existsSync(path.join(dir, '.git'));
  if (!gitOk) {
    gitOk = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status === 0;
    if (gitOk) {
      // The store's on-disk format is LF (admin.mjs writes '\n'), but `git
      // init` inherits ambient config, and core.autocrlf=true is the
      // Git-for-Windows default. Left unpinned, every `git reset --hard`
      // (rollback) and `git checkout -- <path>` (residue discard) rewrites
      // these files as CRLF — silently corrupting learning frontmatter, since
      // the store is the one place git re-materializes files this module then
      // parses. Pin it at both layers git honors, so the byte format is a
      // property of the store rather than of whoever created it.
      // Config only, deliberately: a `.gitattributes` would need the
      // lock-protected `writeStoreFile` path (R1/R7 forbids raw fs here, and
      // R6 puts store metadata writes under the lock), which is more surface
      // than this needs. `parseLearningFrontmatter` is already CRLF-tolerant
      // on its own, so this pin is defense in depth rather than the fix.
      spawnSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir, encoding: 'utf8' });
      spawnSync('git', ['config', 'core.eol', 'lf'], { cwd: dir, encoding: 'utf8' });
    }
  }
  // `storeFileState` — never `fs.existsSync` — decides "is this file already
  // there?": existsSync FOLLOWS a symlink, so a planted link read as "already
  // fine" and was left live for the next writer to follow (the verified
  // INDEX.md exploit). A 'symlink'/'absent'/'other' state all mean "write the
  // real file", and writeStoreFile quarantines the link on the way.
  // A refused write throws (as the bare `fs.writeFileSync` these replaced did):
  // a store missing its index/ledger/schema marker is not a store this CLI may
  // pretend it opened.
  // Only 'absent' and 'symlink' are seeded: 'absent' is a fresh/legacy store,
  // and a 'symlink' is a plant that writeStoreFile quarantines on the way. A
  // real file is already correct, and 'other' (a directory, a device node) is
  // NOT ours to replace — whichever writer actually needs it will fail closed
  // inside the transaction, where a rollback exists.
  const seed = (file, content) => {
    const state = storeFileState(file);
    if (state !== 'absent' && state !== 'symlink') return;
    if (!writeStoreFile(file, content)) {
      throw new Error(`refused to create ${file} — the path does not resolve safely inside the knowledge store`);
    }
  };
  seed(path.join(dir, 'INDEX.md'), INDEX_STUB);
  seed(ledgerPath, '');
  seed(path.join(dir, 'store.json'), JSON.stringify({ schema: STORE_SCHEMA }) + '\n');
  return { dir, created, git: gitOk };
}

export const KNOWLEDGE_MODES = new Set(['on', 'suggest', 'off', 'freeze', 'capture-only']);

/**
 * Opt-in commit mode (Milestone 3 Task 6): 'none' (default — no mirroring)
 * or 'repo' (mirror ACTIVE learnings verbatim into
 * <workspace>/docs/knowledge/learnings/, see admin.mjs's mirrorLearnings).
 * Independent of KNOWLEDGE_MODES — the two fields persist side by side in
 * config.json, each read-modify-write preserving the other (writeStoreConfig
 * below): `knowledge freeze` must not reset commit, `knowledge commit repo`
 * must not reset mode.
 */
export const KNOWLEDGE_COMMIT_MODES = new Set(['none', 'repo']);

/**
 * Kill-switch mode (and opt-in commit mode) for the knowledge layer, read
 * from <store>/config.json. Read-only — never creates the store. Tolerant of
 * an absent or corrupt config (missing file, unreadable JSON, unrecognized
 * mode/commit): default mode is 'on' and default commit is 'none', so a
 * fresh or damaged store never silently blocks the whole layer nor silently
 * starts mirroring into the product repo.
 */
export function readStoreConfig(workspace, { home } = {}) {
  const dir = storeDir(workspace, { home });
  let mode = 'on';
  let commit = 'none';
  try {
    const parsed = JSON.parse(readStoreFile(path.join(dir, 'config.json')));
    if (parsed && KNOWLEDGE_MODES.has(parsed.mode)) mode = parsed.mode;
    if (parsed && KNOWLEDGE_COMMIT_MODES.has(parsed.commit)) commit = parsed.commit;
  } catch {
    // absent, unreadable, or corrupt — defaults above hold
  }
  return { mode, commit };
}

/**
 * Read-modify-write: only the field(s) actually passed (`mode` and/or
 * `commit`) change — whichever one this call omits is preserved from the
 * current config exactly as-is, so `knowledge freeze` and `knowledge commit
 * repo` can never stomp on each other. The commit message names whichever
 * field this call changed.
 */
export function writeStoreConfig(workspace, { home, mode, commit } = {}) {
  const tx = withStoreTransaction(workspace, { home }, ({ dir }) => {
    const current = readStoreConfig(workspace, { home });
    const nextMode = mode !== undefined ? mode : current.mode;
    const nextCommit = commit !== undefined ? commit : current.commit;
    // Preserve any OTHER fields the raw config carries (e.g. the
    // `defaultBranch` layer-routing override, git-context.mjs) — this
    // read-modify-write owns only mode/commit, never the whole file.
    let raw = {};
    try {
      const parsed = JSON.parse(readStoreFile(path.join(dir, 'config.json')));
      if (parsed && typeof parsed === 'object') raw = parsed;
    } catch {
      // absent/corrupt — nothing extra to preserve
    }
    // Through the choke point (R1), and CHECKED: a refused config write used to
    // be invisible, so `knowledge freeze` reported the new mode while the store
    // kept running in the old one. A refusal fails the transaction instead.
    if (!writeStoreFile(path.join(dir, 'config.json'), JSON.stringify({ ...raw, mode: nextMode, commit: nextCommit }) + '\n')) {
      throw new Error('refused to write config.json — the path does not resolve safely inside the knowledge store');
    }
    const message = mode !== undefined ? `knowledge: mode ${nextMode}` : `knowledge: commit ${nextCommit}`;
    return { nextMode, nextCommit, commitMessage: message };
  });
  if (!tx.ok) {
    return {
      mode: mode !== undefined ? mode : null,
      commit: commit !== undefined ? commit : null,
      committed: false,
      pass: false,
      code: tx.locked ? 'E_LOCKED' : 'E_STORE_TRANSACTION_FAILED',
      blockedReason: tx.locked ? 'E_LOCKED: another operation holds the store lock' : `store transaction failed: ${tx.error?.message || 'unknown error'}`,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }
  return {
    mode: tx.result.nextMode,
    commit: tx.result.nextCommit,
    committed: tx.committed,
    pass: true,
    blockedReason: null,
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}

function ledgerPathFor(root) {
  return path.join(root, 'consolidated.jsonl');
}

/** Append-only episode-consumption ledger. Torn tail lines are tolerated; a
 * ledger that cannot be read safely (symlinked, over the read cap, outside the
 * store) reads as empty — the same tolerant default an absent one gets. Every
 * REWRITE goes through `writeLedger` below, which refuses on exactly that
 * unreadable case rather than truncating what it could not see. */
export function readLedger(root) {
  const text = readStoreFile(ledgerPathFor(root));
  if (text === null) return [];
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // torn/corrupt line — skip, never fail reads on it
    }
  }
  return entries;
}

/**
 * Append through the choke point: a real O_NOFOLLOW/O_APPEND write, so a ledger
 * too large to read whole is still appendable (a read-modify-write "append"
 * would truncate it).
 *
 * THROWS ON REFUSAL, never silently drops the entries (same discipline as S4's
 * "a rollback whose result nobody checked"): the ledger is what counts episode
 * consumption and three-strikes quarantine, so an append nobody noticed failing
 * would leave the store's own bookkeeping quietly wrong. Every caller runs
 * inside a transaction, which turns the throw into a rollback.
 */
export function appendLedger(root, entries) {
  if (!entries || !entries.length) return;
  const ledgerPath = ledgerPathFor(root);
  if (!appendStoreFile(ledgerPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { newlineGuard: true })) {
    throw new Error(`refused to append to ${ledgerPath} — the path does not resolve safely inside the knowledge store`);
  }
}

/**
 * Full ledger REWRITE (the purge/cleanup filter shape: read → drop entries →
 * write back). Unlike an append or a deliberate truncate, this one is only
 * correct if the read that produced `keptEntries` actually saw the file — so
 * it FAILS CLOSED when the ledger is present but unreadable, rather than
 * writing a filtered version of nothing over it. Throws so the surrounding
 * transaction rolls back; callers doing a deliberate WIPE write '' directly
 * and never come through here.
 */
export function writeLedger(root, keptEntries) {
  const ledgerPath = ledgerPathFor(root);
  if (storeFileState(ledgerPath) === 'file' && readStoreFile(ledgerPath) === null) {
    throw new Error(`refused to rewrite ${ledgerPath} — it exists but could not be read safely`);
  }
  if (!writeStoreFile(ledgerPath, keptEntries.length ? keptEntries.map((e) => JSON.stringify(e)).join('\n') + '\n' : '')) {
    throw new Error(`refused to write ${ledgerPath} — the path does not resolve safely inside the knowledge store`);
  }
}

/**
 * Raw, in-order governance entries — every line, one per human lifecycle
 * decision, torn/corrupt lines skipped (same tolerance as readLedger). This
 * is the shared parse used by both readGovernance (replayed into a
 * latest-per-id Map) and rewriteGovernance (filtered and rewritten as-is,
 * still one line per historical decision) — so the two never drift apart on
 * what counts as a well-formed line.
 */
function readGovernanceEntries(dir) {
  const govPath = path.join(dir, 'governance.jsonl');
  if (storeFileState(govPath) === 'absent') return [];
  const text = readStoreFile(govPath);
  // Present but unreadable (symlinked, over the read cap, escaping the store).
  // Distinguished from absent — a tolerant READER treats it as empty, but a
  // REWRITE must never truncate a file it could not see.
  if (text === null) return null;
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // torn/corrupt line — skip, never fail reads on it
    }
  }
  return entries;
}

/**
 * Human governance ledger (Milestone 4): append-only record of retire/
 * dispute/confirm/promote decisions a person made on a learning — the half
 * of a learning's state a `consolidate --rebuild` wipe must never resurrect.
 * Replayed in file order, latest entry per id wins, so a dispute followed by
 * a confirm on the same id resolves to the confirm. Missing file → empty Map,
 * same as a fresh store with no decisions yet.
 *
 * EXCEPTION — promote is sticky (mirrors lifecycle.mjs's setLearningStatus,
 * which rejects retire/dispute/confirm outright against a promoted learning,
 * P2): once an id has a `promote` entry, a LATER entry for that same id
 * whose action is anything OTHER than `promote` is skipped here — it never
 * overrides the standing promote record in the replayed map. Without this, a
 * governance.jsonl written before that lifecycle guard existed (or hand-
 * edited directly — governance.jsonl is a plain file outside every CLI write
 * path's absorb/validation) could still carry a stray post-promote confirm/
 * retire/dispute record, and `readGovernance`'s plain latest-wins replay
 * would resolve to THAT instead of the promote — so a later
 * `consolidate --rebuild --yes` would regenerate the learning WITHOUT
 * `promoted_to`, silently erasing a promotion the ledger itself still
 * recorded. A LATER `promote` entry is still allowed to overwrite an earlier
 * one (e.g. correcting a recorded `--to` path) — only non-promote entries are
 * blocked from overriding a standing promote; there is no `unpromote`.
 */
/**
 * REPLAY RULE (blueprint §5, normative): only the human DECISION set can ever
 * become an id's latest standing decision. `absorb-branch` entries — the
 * audit record a branch→golden promotion appends — are deliberately NOT in
 * this set: they are recorded for audit but skipped by the replay, so a
 * promotion can never displace a standing retire/dispute (the required
 * regression: retire → absorb-branch → `consolidate --rebuild --yes` still
 * lands retired). Unknown/future actions are likewise audit-only until they
 * are explicitly added here.
 */
const REPLAY_DECISION_ACTIONS = new Set(['retire', 'dispute', 'confirm', 'promote']);

export function readGovernance(dir) {
  const map = new Map();
  for (const entry of readGovernanceEntries(dir) || []) {
    if (!entry || !entry.id) continue;
    if (!REPLAY_DECISION_ACTIONS.has(entry.action)) continue; // audit-only (absorb-branch, future actions)
    const existing = map.get(entry.id);
    if (existing && existing.action === 'promote' && entry.action !== 'promote') continue;
    map.set(entry.id, entry);
  }
  return map;
}

/** Append one governance decision. Same choke-point append as appendLedger, and
 * the same fail-closed rule: a standing human decision that silently failed to
 * land would be re-derived away by the next `consolidate --rebuild`. */
export function appendGovernance(dir, entry) {
  const govPath = path.join(dir, 'governance.jsonl');
  if (!appendStoreFile(govPath, JSON.stringify(entry) + '\n', { newlineGuard: true })) {
    throw new Error(`refused to append to ${govPath} — the path does not resolve safely inside the knowledge store`);
  }
}

/**
 * Rewrite governance.jsonl keeping only entries where `keepPredicate(entry)`
 * is true — used by purgeEpisode (admin.mjs) to drop every historical record
 * for an id whose learning was just fully cascade-deleted. No-op when the
 * file is absent: a purge on a store that never recorded a governance
 * decision must never materialize the file.
 */
export function rewriteGovernance(dir, keepPredicate) {
  const govPath = path.join(dir, 'governance.jsonl');
  if (storeFileState(govPath) === 'absent') return;
  const entries = readGovernanceEntries(dir);
  // Fail closed, exactly like writeLedger: a filter-rewrite is only correct if
  // the read saw the file. Truncating a governance ledger we could not read
  // would silently erase standing human decisions.
  if (entries === null) throw new Error(`refused to rewrite ${govPath} — it exists but could not be read safely`);
  const kept = entries.filter(keepPredicate);
  if (!writeStoreFile(govPath, kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '')) {
    throw new Error(`refused to write ${govPath} — the path does not resolve safely inside the knowledge store`);
  }
}

/**
 * Parse learning frontmatter including the structured episodes block and the
 * flat anchors list. Only one list can be "open" at a time — episodes and
 * anchors items look similar (both start `  - `) so we track which block
 * we're inside and only apply that block's item shape.
 */
export function parseLearningFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { fm: {}, body: text.trim() };
  const fm = { episodes: [], anchors: [] };
  let openList = null; // 'episodes' | 'anchors' | null
  let current = null;
  // Split on \r?\n, not '\n'. The opening match above already tolerates CRLF,
  // so a CRLF file gets past it and then loses EVERY scalar field here: each
  // line keeps a trailing \r, and the scalar matcher below (`(.*)$`) cannot
  // match it — `.` excludes \r and `$` without the m flag is end-of-input.
  // The failure is silent, and on Windows it fires after any store rollback
  // (`git reset --hard`) or residue discard (`git checkout -- <path>`) when
  // core.autocrlf is on, which is the Git-for-Windows default: a retired
  // learning reads back with no status at all, i.e. as active.
  for (const line of m[1].split(/\r?\n/)) {
    if (/^episodes:\s*$/.test(line)) {
      openList = 'episodes';
      current = null;
      continue;
    }
    if (/^anchors:\s*\[\]\s*$/.test(line)) {
      openList = null;
      current = null;
      fm.anchors = [];
      continue;
    }
    if (/^anchors:\s*$/.test(line)) {
      openList = 'anchors';
      current = null;
      continue;
    }
    if (openList === 'episodes') {
      const item = line.match(/^\s{2}- (\w+):\s*(.*)$/);
      const sub = line.match(/^\s{4}(\w+):\s*(.*)$/);
      if (item) {
        current = { [item[1]]: unquote(item[2]) };
        fm.episodes.push(current);
        continue;
      }
      if (sub && current) {
        current[sub[1]] = unquote(sub[2]);
        continue;
      }
    }
    if (openList === 'anchors') {
      const anchorItem = line.match(/^\s{2}- (.+)$/);
      if (anchorItem) {
        fm.anchors.push(unquote(anchorItem[1]));
        continue;
      }
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      openList = null;
      current = null;
      const value = unquote(kv[2]);
      fm[kv[1]] = value === 'null' || value === '' ? (value === '' ? '' : null) : value;
    }
  }
  const body = text.slice(m[0].length).trim();
  return { fm, body };
}

const ESCAPE_MAP = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Reverse what `yamlQuote` does at write time: wrap in double quotes, then
 * escape `\`, `"`, and control chars. Only a value surrounded by
 * double quotes on both ends went through that escaping, so only that shape
 * gets unescaped — a single-pass regex so a real backslash (encoded as
 * `\\`) is never re-interpreted as the start of a second escape sequence.
 * Anything else (bare scalars, single-quoted legacy values) is only
 * quote-stripped, exactly as before.
 */
function unquote(v) {
  const s = String(v ?? '').trim();
  const m = /^"([\s\S]*)"$/.exec(s);
  if (m) {
    return m[1].replace(/\\(.)/g, (_, ch) => ESCAPE_MAP[ch] ?? ch);
  }
  return s.replace(/^["']|["']$/g, '');
}

function yamlQuote(v) {
  return `"${String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * Render-side normalization (P1-5), shared by every surface that interpolates
 * a learning's trigger or claim/body-derived text into structured markdown —
 * the context pack (context-pack.mjs), `harness learnings` / `--why`
 * (listing.mjs), and INDEX.md (apply.mjs's rebuildIndex, and admin.mjs's
 * mirrorLearnings INDEX write). `yamlQuote` escapes a raw
 * control char (including `\n`) into a literal two-character sequence at
 * write time, but `unquote` (above) decodes that sequence back into the REAL
 * control character when a file is parsed back off disk — correct for
 * round-tripping arbitrary text, but it means a trigger or claim line can
 * carry an embedded newline in memory even though admission (applyOps)
 * rejects one in a FRESH trigger. A legacy learning file written before that
 * admission gate existed, or one hand-edited directly in the store, can
 * still carry an embedded control char — without this, interpolating it
 * into a single-line markdown bullet (`- [id] trigger → claim`) would inject
 * extra "lines" — fake headings, extra bullets, anything — into what is
 * otherwise a trusted context surface. Collapses every C0 control char
 * (0x00-0x1F) and DEL (0x7F) to a single space so the text always renders as
 * ONE line, wherever it's interpolated.
 */
export function inertLine(text) {
  return String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
}

/**
 * Render one learning's `episodes:` block lines. Shared by this module's own
 * `serializeLearning` (a parse → mutate → re-render round trip) AND
 * apply.mjs's `renderLearning` (a from-scratch ADD/SUPERSEDE/STRENGTHEN/MERGE
 * write) — the two sole writers of a learning file — so a malformed episode
 * entry (missing `path` or an unrecognized/missing `kind`, the shape a
 * hand-edited file or a stale on-disk record can carry) is normalized
 * IDENTICALLY by both instead of one of them drifting back to emitting a
 * literal `path: undefined` / `kind: undefined`. A pathless entry is dropped
 * outright — a link with nothing to link to is meaningless, not valid YAML
 * worth keeping. A missing/unrecognized kind defaults to 'fix'.
 */
export function episodeLines(episodes) {
  const lines = [];
  for (const e of episodes || []) {
    if (!e.path) continue;
    lines.push(`  - path: ${e.path}`);
    lines.push(`    sha256: ${yamlQuote(e.sha256)}`);
    lines.push(`    kind: ${e.kind === 'insight' ? 'insight' : e.kind === 'human-teaching' ? 'human-teaching' : 'fix'}`);
    lines.push(`    plan: ${e.plan || ''}`);
  }
  return lines;
}

/**
 * Git provenance frontmatter (harness evolution blueprint P1/P9): optional,
 * reader-tolerant `commit:` / `branch:` / `base:` fields on episodes and
 * learnings. ONE rendering shared by BOTH learning serializers —
 * `serializeLearning` below (parse → mutate → re-render round trips: absorb,
 * purge delink, lifecycle promote) and apply.mjs's `renderLearning` (fresh
 * ADD/SUPERSEDE/STRENGTHEN/MERGE writes) — because reader tolerance alone is
 * insufficient: a serializer with a fixed field list silently DROPS the
 * fields on any re-render. Shape-validated at render: commit/base must be
 * full 40-hex shas; branch is an attacker-influenced string on fork
 * checkouts, so it is yamlQuoted (round-tripped by `unquote`) and length-
 * capped here at the write boundary (render surfaces additionally pass it
 * through `inertLine`). Absent/invalid fields render nothing — a legacy
 * artifact without them never errors and never gains fabricated values.
 */
// Both git object formats: 40-hex (SHA-1) and 64-hex (SHA-256 repos).
const PROVENANCE_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROVENANCE_BRANCH_CAP = 200;

export function provenanceLines({ commit, branch, base } = {}) {
  const lines = [];
  if (typeof commit === 'string' && PROVENANCE_SHA_RE.test(commit)) lines.push(`commit: ${commit}`);
  if (typeof branch === 'string' && branch && branch.length <= PROVENANCE_BRANCH_CAP) {
    lines.push(`branch: ${yamlQuote(branch)}`);
  }
  if (typeof base === 'string' && PROVENANCE_SHA_RE.test(base)) lines.push(`base: ${base}`);
  return lines;
}

/**
 * Byte cost of the provenance lines as they land in a rendered learning
 * (each line plus its joining newline). The LEARNING_BYTE_CAP check in
 * apply.mjs subtracts exactly this, so a near-cap learning gaining
 * provenance can never trip E_BYTE_CAP (and never records a quarantine
 * strike) purely because of the stamp — the cap keeps measuring the CLAIM,
 * not the bookkeeping. Recorded as the Phase 1 byte-cap decision.
 */
export function provenanceBytes(fields) {
  return provenanceLines(fields).reduce((n, line) => n + Buffer.byteLength(line, 'utf8') + 1, 0);
}

/**
 * Render a parsed `{ fm, body }` pair (as `parseLearningFrontmatter` above
 * hands back) to the canonical on-disk learning text — same field order and
 * escaping the sole writer's `renderLearning` (apply.mjs) uses for a fresh
 * ADD/SUPERSEDE/STRENGTHEN write, so a parse → mutate fm → serializeLearning
 * round trip stays byte-shape-compatible with a from-scratch write. Every
 * scalar is written straight from `fm` as parsed, with no re-interpretation —
 * e.g. `fm.merged_from` is already the raw bracketed string this module's own
 * parser hands back, not an array, so it's written verbatim rather than
 * re-joined. `renderLearning` itself builds from discrete op arguments (an
 * array `mergedFrom`, a freshly-stamped `last_confirmed`) rather than a
 * parsed `fm`, so it is intentionally NOT rebased on this function — that
 * would require normalizing shapes it doesn't own; see apply.mjs.
 * Provenance fields parsed off disk are re-emitted via provenanceLines
 * (above), so no re-render ever drops them.
 */
export function serializeLearning(fm, body) {
  const lines = [
    '---',
    'schema: 1',
    `trigger: ${yamlQuote(fm.trigger || '')}`,
    `status: ${fm.status || 'active'}`,
    `source: ${fm.source || 'auto'}`,
    'episodes:',
    ...episodeLines(fm.episodes),
  ];
  const anchors = fm.anchors || [];
  if (anchors.length) {
    lines.push('anchors:');
    for (const a of anchors) lines.push(`  - ${a}`);
  } else {
    lines.push('anchors: []');
  }
  lines.push(`superseded_by: ${fm.superseded_by || 'null'}`);
  lines.push(`last_confirmed: ${fm.last_confirmed || 'null'}`);
  if (fm.merged_from) lines.push(`merged_from: ${fm.merged_from}`);
  if (fm.promoted_to) lines.push(`promoted_to: ${fm.promoted_to}`);
  if (fm.promoted_to_golden) lines.push(`promoted_to_golden: ${fm.promoted_to_golden}`);
  lines.push(`origin: ${fm.origin || 'unknown'}`);
  lines.push(...provenanceLines(fm));
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

export function listLearnings(dir) {
  const out = [];
  // A symlinked `learnings/` (or a symlinked store root) would make this scan
  // enumerate an arbitrary outside directory. Every individual read below is
  // already inert against it — readLearningFile's ancestor walk refuses the
  // whole subtree — but refusing the WALK up front means the scan never even
  // enumerates names outside the store.
  const root = assertNoSymlinkAncestors(dir, 'learnings');
  if (!root || !fs.existsSync(root)) return out;
  for (const domain of fs.readdirSync(root, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    const dPath = path.join(root, domain.name);
    for (const f of fs.readdirSync(dPath)) {
      if (!f.endsWith('.md')) continue;
      const file = path.join(dPath, f);
      // THE ONLY READ (S1): `readLearningFile` (store-io.mjs) is the store's
      // single learning-file reader. It returns null — and this entry is simply
      // not a learning — for a symlinked leaf or ancestor, a path resolving
      // outside the store, a file over the DEFAULT_MAX_BYTES read cap (the
      // hand-planted over-cap DoS this loop used to statSync for), or an absent
      // file. That null is what makes a planted symlink INERT here: it is never
      // presented as an active learning, so nothing downstream — retrieval,
      // ranking, STRENGTHEN target resolution, the mirror — can reach it.
      const text = readLearningFile(file);
      if (text === null) continue;
      const { fm, body } = parseLearningFrontmatter(text);
      const slug = f.replace(/\.md$/, '');
      out.push({
        id: `${domain.name}/${slug}`,
        domain: domain.name,
        slug,
        file,
        fm,
        body,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Stage and commit everything in the store. `committed` is the long-standing
 * boolean contract every caller destructures (true on a real commit, false on
 * a clean tree) — unchanged. `ok`/`stderr` are additive: a REAL git failure
 * (as opposed to "nothing to commit") now surfaces distinctly instead of
 * being silently folded into `committed: false` (P1-7 — a failed `git add`
 * or `git commit` used to be indistinguishable from a legitimate no-op, so
 * callers reported success on a git failure and left dirty CLI-authored
 * state a later absorb could misclassify as a human edit).
 *
 * The clean-tree signal is `git status --porcelain` emptiness, never a git
 * exit code or message string: `git commit` also exits nonzero for a clean
 * tree, and its "nothing to commit" text is locale-dependent — porcelain
 * output is neither.
 */
export function commitStore(dir, message) {
  // THE LAST LINE BEFORE `git add -A` (R7). A symlink at a store-owned
  // DIRECTORY is the one plant that reaches staging: it produces no absorb
  // entry (LEARNING_FILE_RE matches file leaves only), every read path silently
  // returns nothing through it, and `git add -A` records it as a `120000` blob
  // — after which it is SELF-REVIVING, since every rollback `git reset --hard`
  // re-materializes a tracked path and `git clean -fd` cannot sweep one.
  // Staging happens in exactly this one function, so the refusal belongs here:
  // no present or future caller can reach `git add -A` around it. Detect and
  // REFUSE only — quarantining is a mutation, and `withStoreTransaction`
  // (which owns the lock, the journal and the rollback) is where the store is
  // allowed to be repaired.
  const plantedDirs = findSymlinkedStoreDirectories(dir);
  if (plantedDirs.length) {
    return {
      committed: false,
      ok: false,
      stderr: `refusing to stage the store: a symlink stands at store-owned director${plantedDirs.length > 1 ? 'ies' : 'y'} ${plantedDirs.join(', ')} — staging it would commit the link into store history and hide every learning under it`,
    };
  }
  const addRes = spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' });
  if (addRes.status !== 0) {
    return { committed: false, ok: false, stderr: addRes.stderr || `git add exited ${addRes.status}` };
  }
  const statusRes = spawnSync('git', ['status', '--porcelain', '-z'], { cwd: dir, encoding: 'utf8' });
  if (statusRes.status !== 0) {
    return { committed: false, ok: false, stderr: statusRes.stderr || `git status exited ${statusRes.status}` };
  }
  if (!statusRes.stdout.trim()) {
    return { committed: false, ok: true };
  }
  const commitRes = spawnSync(
    'git',
    ['-c', 'user.name=harness', '-c', 'user.email=harness@local', 'commit', '-q', '-m', message],
    { cwd: dir, encoding: 'utf8', timeout: 15000 }
  );
  if (commitRes.status !== 0) {
    return { committed: false, ok: false, stderr: commitRes.stderr || `git commit exited ${commitRes.status}` };
  }
  return { committed: true, ok: true };
}

// A killed transaction holder leaves `.lock` behind forever — nothing ever
// removes it on a crash. Past this age, assume its owner is dead rather than
// wedging the store for every future writer.
const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Acquire a `.lock` directory at `lockPath` (mkdir), taking over a lock
 * that's been sitting for longer than STALE_LOCK_MS via a rename-to-a-
 * tombstone-then-reclaim dance. The ONE shared implementation — used by
 * `withStoreTransaction` below (every normal store mutation) AND by
 * `migrateStrandedStore` (admin.mjs), which acquires a lock OUTSIDE any
 * store transaction, against a LEGACY store dir `withStoreTransaction`
 * itself will never touch again once `repoId` has moved on (P2: without
 * this shared helper, a lock left behind by a killed pre-switch writer had
 * no takeover path at all and wedged migration permanently). Extracting one
 * function is what keeps the two callers from ever drifting on staleness/
 * takeover behavior.
 *
 * Returns `{ acquired: true, staleLockNote }` on success — `staleLockNote`
 * is a human-readable note ONLY when a genuinely stale lock was just taken
 * over, else `null` — or `{ acquired: false, ageMs, lockPath }` when a live
 * lock is genuinely held by someone else right now (`ageMs` is the lock
 * directory's current age, for a caller that wants to report it).
 */
/**
 * OWNER TOKENS (S2). The `.lock` directory alone says "someone holds this"; it
 * never said WHO, so every re-assert and every release was an unverified
 * guess. `fs.mkdirSync(lockPath)` after a `git clean -fd` swept the lock threw
 * EEXIST when a SECOND process had taken it in the meantime, and that EEXIST
 * was swallowed as "still there" — the first writer then continued inside a
 * lock it no longer held and finally `rmSync`-ed the other writer's.
 *
 * A token — pid plus a random nonce, written INSIDE the lock directory the
 * instant it is created — makes ownership checkable. `releaseStoreLock` and
 * `reassertStoreLock` below both verify it and NEVER remove or claim a lock
 * whose owner file names somebody else. The nonce (not just the pid) is what
 * makes it sound across pid reuse and across two transactions in one process.
 */
const LOCK_OWNER_FILE = 'owner.json';

function newLockToken() {
  return `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Stamp ownership into a lock directory we just created, and REPORT whether it
 * landed (P3). It used to be best-effort-and-ignored, which quietly wedged the
 * store for STALE_LOCK_MS: a failed stamp makes `lockOwnership` report our own
 * lock `foreign`, so `releaseStoreLock` refuses to remove it and the live,
 * unowned lock sits there blocking every writer — including us — for ten
 * minutes. `acquireStoreLock` now fails the acquisition (and removes the lock
 * it just created) instead of leaving one behind that nobody can release.
 *
 * The write goes through the choke point (store-io.mjs), matching the contained
 * read in `lockOwnership`: the lock directory is freshly mkdir'd, but the owner
 * file inside it is still a path another process could reach.
 */
function writeLockOwner(lockPath, token) {
  try {
    return writeStoreFile(
      path.join(lockPath, LOCK_OWNER_FILE),
      JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }) + '\n'
    );
  } catch {
    return false;
  }
}

/**
 * `'absent'` (no lock directory at all), `'owned'` (the owner file names
 * `token`), or `'foreign'` (it names something else, or cannot be read at all
 * — an unreadable/absent/symlinked owner file is never assumed to be ours).
 * The read goes through `readFileNoFollow` contained to the lock directory:
 * `.lock` sits in a directory a human can write to, so the owner file is as
 * attacker-influenced as anything else in the store.
 */
export function lockOwnership(lockPath, token) {
  if (!fs.existsSync(lockPath)) return 'absent';
  const text = readStoreFile(path.join(lockPath, LOCK_OWNER_FILE));
  if (text === null) return 'foreign';
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.token && parsed.token === token ? 'owned' : 'foreign';
  } catch {
    return 'foreign';
  }
}

/**
 * Re-establish the lock after an operation that COULD have removed it, without
 * ever stealing one. `.lock` is gitignored (STORE_IGNORE_ENTRIES) so
 * `git clean -fd` can no longer sweep it, but this is the independent second
 * layer: absent → recreate and re-stamp (it was ours, nobody else took it);
 * ours → nothing to do; SOMEBODY ELSE'S → return false, and the caller must
 * abort rather than proceed inside a lock it does not hold.
 */
export function reassertStoreLock(lockPath, token) {
  const state = lockOwnership(lockPath, token);
  if (state === 'owned') return true;
  if (state === 'foreign') return false;
  try {
    fs.mkdirSync(lockPath, { recursive: true });
  } catch {
    return false;
  }
  // Between the existence check and this mkdir another writer may have won the
  // race; re-verify rather than assume the mkdir means we hold it.
  writeLockOwner(lockPath, token);
  return lockOwnership(lockPath, token) === 'owned';
}

/**
 * Options for removing a lock directory.
 *
 * Windows refuses to delete a directory whose entries still have an open
 * handle, and returns EBUSY/EPERM/ENOTEMPTY transiently even after the last
 * writer has closed — antivirus and the indexer both hold handles briefly.
 * Without retries `releaseStoreLock` returns false, the `finally` swallows it,
 * and the lock is LEAKED: the store stays wedged for the whole STALE_LOCK_MS
 * window even though its owner exited cleanly. Observed on windows-latest,
 * where the leaked `.lock` still contained its own `owner.json`.
 *
 * `maxRetries`/`retryDelay` are the options Node provides for exactly this;
 * on POSIX they are inert because the first attempt always succeeds.
 */
const RM_LOCK_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 25 };

/**
 * Release ONLY a lock this holder owns. Returns true when the lock is gone (or
 * was already gone) because of us, false when it belongs to someone else and
 * was therefore LEFT ALONE — the single rule that keeps a confused writer from
 * unlocking a live transaction it never held.
 */
export function releaseStoreLock(lockPath, token) {
  const state = lockOwnership(lockPath, token);
  if (state === 'absent') return true;
  if (state === 'foreign') return false;
  try {
    fs.rmSync(lockPath, RM_LOCK_OPTS);
    return true;
  } catch (err) {
    // Record why. A swallowed error here is exactly what made a leaked lock on
    // Windows cost six CI round-trips to attribute: the caller only ever sees
    // `false`, which cannot distinguish "the lock is not mine" from "it is mine
    // and the removal failed". The two have completely different causes and
    // completely different fixes.
    lastLockReleaseError = err.code || err.message;
    return false;
  }
}

/**
 * Why the most recent `releaseStoreLock` returned false because removal failed
 * (as opposed to the lock not being ours). Diagnostic only — never part of a
 * control-flow decision, and cleared by nothing, so it reflects the last
 * failure of the process rather than a live state.
 */
let lastLockReleaseError = null;
export function lastStoreLockReleaseError() {
  return lastLockReleaseError;
}

/**
 * The IDENTITY of the lock currently sitting at `lockPath`, observed BEFORE any
 * takeover attempt, or null when there is nothing there / it is not stale yet.
 * `{ ageMs, key }` — `key` is the raw owner stamp when it can be read, and a
 * dev+ino+mtime fingerprint when it cannot, so two processes looking at the
 * SAME stale lock always derive the SAME key while a lock replaced in between
 * derives a different one.
 *
 * Exported with `takeOverStaleLock` so the compare-and-swap can be exercised
 * with both observations taken before either takeover runs — the exact
 * interleaving that used to let two writers both believe they held the lock.
 */
export function observeStaleLock(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return null;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs <= STALE_LOCK_MS) return { ageMs, key: null, stale: false };
  const owner = readStoreFile(path.join(lockPath, LOCK_OWNER_FILE));
  const key = owner === null ? `ino:${stat.dev}:${stat.ino}:${stat.mtimeMs}` : `owner:${owner}`;
  return { ageMs, key, stale: true };
}

/**
 * COMPARE-AND-SWAP TAKEOVER (P2). The old dance — stat, rename to a
 * pid/time-named tombstone, mkdir, stamp, verify — was narrowed by its final
 * ownership check but never atomic: A renames, mkdirs, stamps and verifies
 * owned; B's rename then succeeds against A's FRESH lock, and B mkdirs, stamps
 * and verifies owned too. Both return acquired.
 *
 * The tombstone name is now DERIVED FROM THE OBSERVED IDENTITY, which makes the
 * rename itself the compare-and-swap: the first writer to move identity `I`
 * aside leaves a non-empty directory at that exact name, so the second writer's
 * rename fails (POSIX rename refuses to replace a non-empty directory). And
 * because a winner removes its tombstone at the end, the swap is re-verified
 * after the fact: whatever we just moved must still carry the identity we
 * observed BEFORE the rename, or we moved somebody's LIVE lock — in which case
 * we put it straight back and refuse.
 */
export function takeOverStaleLock(lockPath, observed, token) {
  if (!observed || !observed.stale || !observed.key) return { acquired: false, ageMs: observed?.ageMs || 0, lockPath, token: null };
  const fingerprint = crypto.createHash('sha256').update(observed.key).digest('hex').slice(0, 16);
  const tombstone = `${lockPath}.stale-${fingerprint}`;
  try {
    fs.renameSync(lockPath, tombstone);
  } catch {
    // Another process already moved this exact identity aside (its tombstone
    // stands in the way), or the lock vanished — either way we did not win.
    return { acquired: false, ageMs: observed.ageMs, lockPath, token: null };
  }
  // Post-swap verify: is what we moved the object we observed? The tombstone is
  // a TRANSIENT rename target this call just created, not a store-owned path,
  // so it has no allow-listed shape in store-io.mjs — it is read through the
  // same fs-safe primitive, contained against the STORE root (the tombstone's
  // parent), which is the identical guarantee `readStoreFile` gives the live
  // `.lock/owner.json` above.
  const movedOwner = readFileNoFollow(path.join(tombstone, LOCK_OWNER_FILE), { root: path.dirname(tombstone) });
  const movedKey = movedOwner === null ? null : `owner:${movedOwner}`;
  if (observed.key.startsWith('owner:') ? movedKey !== observed.key : movedKey !== null) {
    // We moved a DIFFERENT lock — a fresh one a winner planted after we
    // observed. Put it back; it is not ours to hold or to destroy.
    try {
      fs.renameSync(tombstone, lockPath);
    } catch {
      // The winner already re-created its lock, so the rename-back is refused;
      // the tombstone is gitignored debris, and their live lock stands.
    }
    return { acquired: false, ageMs: observed.ageMs, lockPath, token: null };
  }
  // `createdDir` is tracked SEPARATELY from `recovered`: the cleanup below may
  // only ever remove a lock directory THIS call created. Folding the two
  // together would mean a failed exclusive mkdir — which happens precisely
  // because somebody ELSE now holds the lock — took their lock away.
  let createdDir = false;
  try {
    fs.mkdirSync(lockPath);
    createdDir = true;
  } catch {
    createdDir = false;
  }
  const recovered = createdDir && writeLockOwner(lockPath, token);
  if (createdDir && !recovered) {
    // Never leave a live lock nobody can prove they own (P3). Ours to remove:
    // the exclusive mkdir above is what created it.
    try {
      fs.rmSync(lockPath, RM_LOCK_OPTS);
    } catch {
      // best effort
    }
  }
  try {
    fs.rmSync(tombstone, { recursive: true, force: true });
  } catch {
    // ignored — an orphaned tombstone is harmless, gitignored disk debris
  }
  if (recovered && lockOwnership(lockPath, token) === 'owned') {
    return { acquired: true, staleLockNote: `stale lock (${Math.round(observed.ageMs / 60000)}m old) removed`, token };
  }
  return { acquired: false, ageMs: observed.ageMs, lockPath, token: null };
}

export function acquireStoreLock(lockPath) {
  const token = newLockToken();
  let created = false;
  try {
    fs.mkdirSync(lockPath);
    created = true;
  } catch {
    created = false; // occupied — fall through to the stale-takeover attempt
  }
  if (created) {
    // AN UNSTAMPABLE LOCK IS NOT ACQUIRED (P3). Leaving one live wedges the
    // store for STALE_LOCK_MS: nobody — including us — can prove ownership, so
    // `releaseStoreLock` refuses to remove it. We created this directory, so
    // removing it again is unambiguously ours to do.
    if (writeLockOwner(lockPath, token) && lockOwnership(lockPath, token) === 'owned') {
      return { acquired: true, staleLockNote: null, token };
    }
    try {
      fs.rmSync(lockPath, RM_LOCK_OPTS);
    } catch {
      // best effort — a lock we could not remove is taken over as stale later
    }
    return { acquired: false, ageMs: 0, lockPath, token: null };
  }
  const observed = observeStaleLock(lockPath);
  if (!observed) return { acquired: false, ageMs: 0, lockPath, token: null };
  if (!observed.stale) return { acquired: false, ageMs: observed.ageMs, lockPath, token: null };
  return takeOverStaleLock(lockPath, observed, token);
}

/**
 * Roll back the store's working tree: `git reset --hard [targetSha]` undoes
 * tracked changes back to `targetSha` (or plain current HEAD when omitted —
 * the store's ordinary "discard everything uncommitted" shape), `git clean
 * -fd` sweeps untracked files/dirs. One implementation, shared by every
 * adopter via withStoreTransaction, replacing what used to be duplicated
 * inline in apply.mjs. Exported so a `fn` body that itself makes an
 * intermediate sub-commit (e.g. apply.mjs's recordContentFailure) can
 * discard JUST that partial write on its own sub-commit failure (calling
 * this with no target, since it only ever needs to undo its OWN attempt),
 * keeping the tree clean before returning — otherwise withStoreTransaction's
 * own finalize step would inherit the dirt and risk masking the real
 * rejection behind a generic commit-failure error.
 *
 * VERIFIED, NEVER ASSUMED (S4). Both spawns used to be fire-and-forget and
 * this function returned nothing, so a `git reset --hard` that failed — a
 * stray `.git/index.lock`, a read-only store, a bad target sha — left the
 * materialized mutation sitting in the working tree while every caller
 * proceeded as though the store were clean, and the transaction's own
 * `commitStore` then PUBLISHED exactly what the rollback existed to discard.
 * It now reports `{ ok, stderr }`: both spawns are checked, and — because a
 * zero exit is not the same thing as a clean tree — the tree itself is
 * re-read afterwards and a still-dirty store is a FAILED rollback. Every
 * caller acts on it; none may ignore it.
 */
export function rollbackStore(dir, targetSha) {
  const reset = spawnSync('git', targetSha ? ['reset', '--hard', targetSha] : ['reset', '--hard'], { cwd: dir, encoding: 'utf8' });
  if (reset.error || reset.status !== 0) {
    return { ok: false, stderr: reset.error ? reset.error.message : reset.stderr || `git reset exited ${reset.status}` };
  }
  const clean = spawnSync('git', ['clean', '-fd'], { cwd: dir, encoding: 'utf8' });
  if (clean.error || clean.status !== 0) {
    return { ok: false, stderr: clean.error ? clean.error.message : clean.stderr || `git clean exited ${clean.status}` };
  }
  // Exit codes alone are not proof: `git reset --hard <unreachable sha>` and a
  // partially-applied clean can both leave content behind. Judge the POST
  // STATE — the same discipline purgeEpisode already applies to its own
  // completion check. `.lock`/`.quarantine` are gitignored (S2), so they never
  // show up here as false dirt.
  const remaining = dirtyPaths(dir);
  if (remaining === null) return { ok: false, stderr: 'git status unreadable after rollback — cannot confirm the store is clean' };
  if (remaining.length) return { ok: false, stderr: `store still dirty after rollback: ${remaining.slice(0, 5).join(', ')}` };
  return { ok: true, stderr: null };
}

/**
 * `learnings/<domain>/<slug>.md` — golden — OR
 * `branches/<key>/learnings/<domain>/<slug>.md` — a branch bucket (blueprint
 * §5a: hand edits under buckets are absorbed exactly like golden hand edits,
 * never left for transaction rollback to destroy) — the shapes
 * absorbHandEdits (admin.mjs) treats as an absorbable hand edit. Capture
 * groups: [1] = bucket key (undefined for golden), [2] = domain, [3] = slug.
 * Exported for admin.mjs's own `parsePorcelainZ` scan; no longer used by store.mjs
 * itself (an earlier version of the rollback guard here matched dirty paths
 * against it, which incorrectly protected a path a transaction's OWN
 * legitimate mutation re-dirtied after an earlier absorb commit already
 * captured it — see withStoreTransaction's checkpoint-based design below,
 * which replaced that approach entirely).
 */
export const LEARNING_FILE_RE = /^(?:branches\/([^/]+)\/)?learnings\/([^/]+)\/([^/]+)\.md$/;

/**
 * Statuses whose porcelain entry carries a SECOND, NUL-terminated field (the
 * original path). `git status --porcelain -z` emits `XY <new>\0<orig>\0` for a
 * rename or copy — new path FIRST, unlike the line-oriented format's
 * `XY <orig> -> <new>` — so the parser must consume that extra field or every
 * subsequent entry is misaligned by one.
 */
const PORCELAIN_PAIRED = new Set(['R', 'C']);

/**
 * THE ONE PORCELAIN PARSER (S3), NUL-DELIMITED.
 *
 * The line-oriented `git status --porcelain` format is lossy in two ways that
 * both produced silent, reported-as-success no-ops here:
 *
 *   1. C-QUOTING. A path with a non-ASCII byte, a quote, a backslash, or a
 *      control char is emitted quoted and octal-escaped:
 *      `?? "learnings/caf\303\251/x.md"`. The old parser stripped the quotes
 *      and ran `.replace(/\\(.)/g, '$1')`, which turns `\303\251` into
 *      `303251` — decoding `learnings/café/x.md` as `learnings/caf303251/x.md`.
 *      Residue discard then "discarded" a path that does not exist (reporting
 *      success), absorb missed the same file, and the next `commitStore`'s
 *      `git add -A` swept the REAL file into store history unvalidated and
 *      unscanned.
 *   2. THE ` -> ` SPLIT. The old parser split on any literal ` -> ` anywhere in
 *      the rest of the line, so an ordinary file named `learnings/a -> b/c.md`
 *      parsed as `b/c.md`.
 *
 * `-z` has neither problem: pathnames are emitted VERBATIM (no quoting, no
 * escaping — the terminator is NUL, which cannot occur in a pathname) and the
 * rename pair is two separate NUL-terminated fields instead of an in-band
 * separator. Parsing that is the only correct option, so it is the only one
 * available: `parsePorcelainLine` is gone, and both consumers (dirtyPaths
 * below, absorbHandEdits in admin.mjs) call THIS function on `-z` output.
 *
 * Returns `[{ status, path, origPath }]`. `origPath` is null except on a
 * rename/copy, where it names where the file came from.
 */
export function parsePorcelainZ(stdout) {
  const fields = String(stdout ?? '').split('\0');
  const out = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    // The final NUL leaves a trailing empty field; a path is never empty.
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const p = entry.slice(3);
    let origPath = null;
    if (PORCELAIN_PAIRED.has(status[0]) || PORCELAIN_PAIRED.has(status[1])) {
      i += 1;
      origPath = fields[i] ?? null;
    }
    out.push({ status, path: p, origPath });
  }
  return out;
}

/** The store's current HEAD commit sha, or null on a store with no commits
 * yet (`git rev-parse HEAD` fails closed rather than throwing). */
function currentHeadSha(dir) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * Every path `git status --porcelain -uall` currently reports as uncommitted.
 * `-uall` (not the default `-unormal`) because these paths drive a PER-PATH
 * decision: the default collapses a brand-new directory into one entry that
 * names no individual file, which is too coarse to tell "the dead writer
 * planted this learning" from "a human left an unrelated file here".
 *
 * Returns null — never an empty array — when git could not be read, so every
 * caller fails CLOSED (an unreadable tree is never mistaken for a clean one)
 * rather than the journal recording "nothing was dirty" for a tree it could
 * not actually inspect.
 */
function dirtyPaths(dir) {
  const res = spawnSync('git', ['status', '--porcelain', '-uall', '-z'], { cwd: dir, encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  return parsePorcelainZ(res.stdout).map((e) => e.path);
}

/**
 * IN-TRANSACTION INTENT JOURNAL (P1 — crash residue is not human authority).
 *
 * A writer that dies between its first mutation and its commit/rollback
 * leaves CLI-authored dirt in the store working tree. The stale-lock takeover
 * path cannot tell that dirt apart from a genuine hand edit, so the next
 * transaction's `absorbHandEdits` (admin.mjs) used to absorb it as
 * `kind: human-teaching` and stamp `source: human` — laundering a
 * model-authored partial write into the one authority tier the store reserves
 * for a person editing the file themselves.
 *
 * The journal makes the two distinguishable. It is written immediately after
 * the lock is acquired and BEFORE `fn` runs, refreshed whenever an
 * intra-transaction commit lands (recordCheckpoint — the tree is clean again
 * at that instant, so everything dirty from there on is this transaction's
 * own work), and removed once the transaction has committed or rolled back.
 * `dirtyAtStart` records whether anything was ALREADY uncommitted when the
 * journal was written: false means every uncommitted byte found later is
 * necessarily CLI residue; true means an unabsorbed human edit was already
 * sitting there, so recovery keeps its hands off and leaves it for absorb
 * exactly as before.
 *
 * `dirty` is the LIST of paths already uncommitted when the journal was
 * written, not a single tree-wide flag. The flag was too coarse: absorb
 * deliberately ignores non-learning files (config.json, INDEX.md, a human's
 * scratch note), so such a file can sit uncommitted indefinitely — and under a
 * tree-wide flag its mere presence disarmed residue rollback for the LEARNING
 * paths a later crash dirtied, handing the dead writer's own partial write to
 * the next absorb as `source: human`. Recovery therefore decides PER PATH:
 * anything dirty now that was NOT dirty then is this transaction's residue;
 * everything else is left exactly as it was found.
 *
 * It lives under `.git/` deliberately: that is the one path inside the store
 * `git add -A` can never stage and `git clean -fd` never sweeps, so the
 * journal can neither leak into store history nor be destroyed by the very
 * rollback it drives. A store with no git has neither commits nor rollbacks,
 * so it is never journaled.
 */
const TXN_JOURNAL_REL = path.join('.git', 'harness-txn.json');

/** Contained, atomic journal write (fs-safe.mjs — the same primitive every
 * other writer in the store uses). Returns true on success, false on ANY
 * refusal or failure, so the caller can fail CLOSED instead of running a
 * transaction whose residue nothing can later classify. The try/catch is not
 * decoration: `writeFileContained` mkdirs the parent, which THROWS (rather than
 * returning null) when `.git` is a gitfile instead of a directory — a store
 * `ensureStore` never produces, but one a hand-built store can. A throw here
 * would escape with the lock still held; false simply refuses the run. */
function writeTxnJournal(dir, data) {
  try {
    return writeStoreFile(path.join(dir, TXN_JOURNAL_REL), JSON.stringify(data) + '\n');
  } catch {
    return false;
  }
}

function readTxnJournal(dir) {
  const text = readStoreFile(path.join(dir, TXN_JOURNAL_REL));
  if (text === null) return null; // absent, symlinked, or outside the store
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // corrupt — treated as "no interrupted transaction"
  }
  return null;
}

/**
 * The set of paths a journal recorded as ALREADY uncommitted when it was
 * written, or null when the journal cannot say — in which case recovery keeps
 * its hands off the tree entirely. A journal written by an older CLI carries
 * only the tree-wide `dirtyAtStart` flag: `false` still means "nothing was
 * dirty" (an empty set) and anything else stays unactionable, exactly the
 * pre-per-path behavior.
 */
function journalDirtySet(journal) {
  if (Array.isArray(journal.dirty)) return new Set(journal.dirty);
  if (journal.dirtyAtStart === false) return new Set();
  return null;
}

/**
 * Discard ONE residue path back to `targetSha` (or HEAD): restore it from that
 * commit when it exists there, remove it outright when it does not (a file the
 * dead writer created). Per-path rather than the whole-tree `git reset --hard`
 * so a path that was already dirty when the journal was written — a human's
 * unabsorbed hand edit, or a non-learning file absorb ignores — is never
 * touched by another path's recovery. The delete half goes through
 * `assertRealpathContained` (fs-safe.mjs): `rel` comes from `git status` over
 * a directory a human hand-edits, so a symlinked component must never let the
 * removal land outside the store.
 */
function discardResiduePath(dir, rel, targetSha) {
  const ref = targetSha || 'HEAD';
  const opts = { cwd: dir, encoding: 'utf8' };
  spawnSync('git', ['reset', '-q', ref, '--', rel], opts);
  if (spawnSync('git', ['checkout', '-q', '--', rel], opts).status === 0) return;
  // Not present in `ref` at all — the dead writer planted it.
  const full = assertRealpathContained(dir, rel);
  if (!full) return;
  try {
    fs.rmSync(full, { recursive: true, force: true });
  } catch {
    // best effort — a path that resists removal is reported as unrecovered by
    // simply staying dirty, never by throwing out of lock acquisition
  }
}

/**
 * OWNER-CHECKED JOURNAL CLEARING (P2) — the journal-side twin of
 * `releaseStoreLock`. The journal is ONE SHARED FILE, and clearing it used to
 * be unconditional: a writer whose recovery rollback LOST the lock still ran
 * `rmSync` on its way out, deleting the journal the WINNING writer had just
 * written. That winner then ran unmarked — precisely the state the fail-closed
 * journal-write check exists to prevent, reached from the other direction.
 *
 * A journal now carries the same `owner` token its writer's lock does, and this
 * removes only a journal stamped with `token` (or an unstamped legacy one).
 * `force: true` is the ONE legitimate foreign clear: crash recovery, running
 * under a freshly acquired lock, is consuming a DEAD writer's journal, which by
 * definition names somebody else.
 */
function clearTxnJournal(dir, { token = null, force = false } = {}) {
  if (!force) {
    const journal = readTxnJournal(dir);
    // A journal whose owner is someone else's is not ours to remove. An
    // unreadable/absent one (null) falls through: nothing to protect.
    if (journal && typeof journal.owner === 'string' && journal.owner !== token) return;
  }
  try {
    removeStoreFile(path.join(dir, TXN_JOURNAL_REL));
  } catch {
    // ignored — a stranded journal only ever costs one extra recovery pass
  }
}

/**
 * SYMLINKED STORE DIRECTORIES: QUARANTINE, RESTORE, THEN REFUSE (R7).
 *
 * Run under the lock as the FIRST thing a transaction does — before crash
 * recovery, before `fn`, before anything reads the tree — because every step
 * after it is wrong in the presence of one:
 *   - `listLearnings` returns NOTHING through a symlinked `learnings/`
 *     (assertNoSymlinkAncestors correctly refuses the whole subtree), so absorb
 *     would see a store-wide "the human deleted everything" and record a
 *     governance `retire` per learning;
 *   - recovery's `git reset --hard` would try to check paths back out THROUGH
 *     the link;
 *   - `git add -A` would record the link itself as a `120000` blob, after which
 *     it is self-reviving.
 *
 * Three steps, in this order:
 *   1. QUARANTINE the link (`reclaimSymlinkedStoreDirectory`, store-io.mjs) —
 *      the link moves, its target is never touched — and put a real, empty
 *      directory back in its place.
 *   2. RESTORE what the last commit held under that directory (`git reset` to
 *      HEAD for the path, then `git checkout`), so the learnings the plant hid
 *      REAPPEAR instead of staying invisible. Nothing is destroyed by this: the
 *      plant already replaced the whole subtree, so there is no worktree state
 *      under it left to preserve.
 *   3. REFUSE the transaction anyway. The auto-heal makes the NEXT run clean;
 *      this run has already read a store that was lying to it, and "we found a
 *      symlink where your learnings live" is not something to fix silently.
 *
 * Returns `{ planted, note }` — `planted` empty means nothing was found and the
 * transaction proceeds normally.
 */
function healSymlinkedStoreDirectories(dir, git) {
  const planted = findSymlinkedStoreDirectories(dir);
  if (!planted.length) return { planted, note: null };
  const notes = [];
  for (const rel of planted) {
    const { quarantined, ok } = reclaimSymlinkedStoreDirectory(dir, rel);
    notes.push(
      ok
        ? `${rel} was a symlink — never followed; moved to ${quarantined}`
        : `${rel} is a symlink this CLI could not quarantine — move it aside by hand`
    );
    if (!ok || !git) continue;
    // Restore the subtree from the last commit. Both halves, exactly as
    // discardResiduePath does: `reset` first so a staged deletion cannot make
    // `checkout` a no-op, then `checkout` to materialize the files again.
    const opts = { cwd: dir, encoding: 'utf8' };
    spawnSync('git', ['reset', '-q', 'HEAD', '--', rel], opts);
    spawnSync('git', ['checkout', '-q', '--', rel], opts);
  }
  return { planted, note: notes.join('; ') };
}

/**
 * Crash recovery, run under the freshly-acquired lock: a journal still on
 * disk means the previous holder never reached its commit or rollback. Every
 * path dirty NOW that the journal did not record as dirty THEN is that dead
 * writer's residue — discarded back to its last recorded checkpoint (so any
 * intra-transaction commit it DID land, e.g. an absorbed hand edit, survives)
 * instead of being inherited by the next transaction's absorb as human
 * authority. Paths the journal DID record stay exactly as found: that dirt may
 * be a real hand edit the dead writer never got to absorb, and absorbing it is
 * exactly the behavior to preserve. Returns a human-readable note, or null
 * when nothing was recovered.
 */
function recoverInterruptedTransaction(dir, git, lockPath, token) {
  const journal = readTxnJournal(dir);
  if (!journal) return { note: null, lockLost: false, failed: false };
  // The one legitimate FOREIGN clear: this journal belongs to a writer that
  // died, and we hold the lock now.
  clearTxnJournal(dir, { force: true });
  if (!git) return { note: null, lockLost: false, failed: false };
  const before = journalDirtySet(journal);
  if (before === null) return { note: null, lockLost: false, failed: false }; // the journal cannot say — hands off
  const now = dirtyPaths(dir);
  if (now === null) return { note: null, lockLost: false, failed: false }; // unreadable status — fail closed, touch nothing
  const residue = now.filter((p) => !before.has(p));
  if (!residue.length) return { note: null, lockLost: false, failed: false };
  const checkpoint = typeof journal.checkpoint === 'string' && /^[0-9a-f]{40,64}$/.test(journal.checkpoint) ? journal.checkpoint : null;
  let lockLost = false;
  let failed = false;
  if (before.size === 0) {
    // Nothing was dirty at the start, so EVERY uncommitted byte is residue —
    // the store's own whole-tree rollback is both the cheapest and the most
    // thorough discard.
    //
    // A recorded checkpoint can be unreachable (a store rewritten under the
    // dead writer's feet) — `git reset --hard <sha>` then fails and leaves the
    // residue in place. rollbackStore now REPORTS that (S4), so the fallback to
    // the plain "discard everything uncommitted" reset keys off the honest
    // result rather than re-reading the tree by hand.
    //
    // BOTH RESULTS ARE CHECKED (P3). The fallback's result used to be thrown
    // away — `if (!rollbackStore(dir, checkpoint).ok) rollbackStore(dir);` — so
    // a recovery that could not discard the residue reported success anyway and
    // the next transaction inherited the dead writer's uncommitted bytes as a
    // hand edit, which is the exact laundering the journal exists to stop.
    if (!rollbackStore(dir, checkpoint).ok && !rollbackStore(dir).ok) failed = true;
    // `.lock` is gitignored (S2) so `git clean -fd` can no longer sweep it, but
    // re-assert through the OWNER-CHECKED path anyway: if this lock somehow
    // went away and another writer took it, we must abort, never mkdir over it.
    if (!reassertStoreLock(lockPath, token)) lockLost = true;
  } else {
    // Mixed tree: discard only what this dead writer added, one path at a
    // time, so the pre-existing dirt survives untouched.
    for (const rel of residue) discardResiduePath(dir, rel, checkpoint);
  }
  return { note: failed ? null : 'discarded interrupted write residue', lockLost, failed };
}

/**
 * Thrown by a withStoreTransaction `fn` to signal a failure that must NOT
 * trigger the standard rollback (git reset --hard + clean -fd). Reserved for
 * exactly one situation today: absorbHandEdits' own sub-commit failed for a
 * REAL reason (see admin.mjs's absorbOrAbort) — at that point the working
 * tree holds a legitimate, uncommitted human edit that absorbHandEdits
 * itself already wrote. The standard rollback would destroy it outright,
 * with nothing left recording the edit ever happened. withStoreTransaction's
 * catch recognizes this type and skips both the stage/commit attempt AND the
 * rollback: the lock is still released, the failure still reported with
 * `ok: false`, but the tree is left exactly as `fn` last touched it.
 */
export class StoreTransactionAbort extends Error {
  constructor(message, { stderr } = {}) {
    super(message);
    this.name = 'StoreTransactionAbort';
    this.stderr = stderr || null;
  }
}

/**
 * The single-writer transaction every store mutator (applyOps,
 * setLearningStatus, purgeEpisode, purgeAll, rebuildStore's --yes path,
 * writeStoreConfig — six primary adopters, each with exactly one call site)
 * runs inside. remember.mjs adds a 7th call site — its own best-effort
 * post-failure ledger-cleanup transaction — which is not a new mutating
 * capability of its own (remember's real write goes through applyOps like
 * every other caller) but still follows the SAME absorb-first invariant
 * (via absorbOrAbort, admin.mjs) as the six primary adopters, for exactly
 * the reason every adopter needs it: it can inherit a dirty, uncommitted
 * hand edit left behind by an EARLIER transaction's aborted absorb, and
 * must not silently ignore it.
 *
 * Closes three race windows a security review found in the pre-transaction
 * design: the lock started too late (state was read and validated before
 * the lock existed), ended too early (released before the final commit, so
 * a losing writer could interleave with an in-flight commit), and several
 * writers never took it at all.
 *
 * Deliberately OUTSIDE this transaction (by design, not oversight):
 *   - orient/consolidate --status/--candidates/learnings reads: pure reads
 *     never need the lock — a stale read is harmless (the caller doesn't act
 *     on it under an assumption of freshness the way a writer's validation
 *     does), and locking every read would serialize the CLI's most common,
 *     latency-sensitive path against every writer for no safety benefit.
 *   - index's stale.json write: recomputed CLI-local cache state, not
 *     store-of-record content — safe to race, self-heals on the next index run.
 *   - mirrorLearnings: writes into the WORKSPACE (docs/knowledge/learnings/),
 *     not the store, so it was never store state the lock needed to protect.
 *     EVERY store writer that mirrors (applyOps, setLearningStatus,
 *     purgeEpisode, purgeAll, rebuildStore) now runs it via the `afterCommit`
 *     hook BELOW — i.e. still under this transaction's lock, on the clean
 *     committed tree — so it can only ever mirror COMMITTED learnings, never a
 *     concurrent writer's dirty-then-rolled-back mutation (P2).
 *
 * Acquires `.lock` (mkdir + stale-takeover-via-rename — moved here from
 * apply.mjs so there is exactly one implementation), then runs crash recovery
 * against the intent journal and writes a fresh one (see
 * recoverInterruptedTransaction above — a dead writer's uncommitted residue is
 * discarded rather than absorbed as human authority by the next transaction),
 * all BEFORE calling
 * `fn({ dir, git, recordCheckpoint, rollbackToCheckpoint, rollbackUncommitted })`.
 * `rollbackUncommitted` is the same guarded rollback narrowed to "discard what
 * is uncommitted" rather than "reset to the checkpoint" — the only shape an
 * `fn` that made its own failed sub-commit attempt needs, and the reason no
 * `fn` has any business calling `rollbackStore` itself.
 * `rollbackToCheckpoint` is the same rollback the failure paths below use,
 * exposed so an `fn` that REJECTS after already mutating (apply.mjs's write-time
 * `E_HEAD_MOVED`, which can only be reached once a branch bucket has been
 * materialized) can make its own "nothing was written" promise literally true
 * instead of leaving stale mutations for the finalize commit to publish.
 * `fn` is expected to mutate the store
 * directly and return a plain result value describing what happened; it may
 * perform its OWN sub-commits when it needs more than one checkpoint inside
 * this same lock (e.g. absorbHandEdits's self-contained "human edit: <ids>"
 * commit, simply invoked from inside `fn` now instead of before the lock
 * existed).
 *
 * Rollback target — the checkpoint, not a dirty-content guess: a
 * `checkpointSha` is captured at entry (current HEAD, or null on a store
 * with no commits yet) and advances every time `fn` calls `recordCheckpoint`
 * after landing an intra-transaction commit of its own (absorbOrAbort calls
 * it after a successful absorb sub-commit; apply.mjs's recordContentFailure
 * calls it after a successful strike sub-commit — ANY intra-transaction
 * commit should). On failure, `git reset --hard <checkpointSha>` (or plain
 * `git reset --hard` when checkpointSha is null) discards everything AFTER
 * that point and nothing before it — this is what makes "lands on the
 * absorb commit, not before it" correct BY CONSTRUCTION rather than by
 * inspecting what's currently dirty: an EARLIER version of this guard tried
 * to protect dirty paths that "looked like" an absorbed hand edit, which
 * incorrectly protected a path a transaction's OWN legitimate mutation
 * re-dirtied AFTER an absorb commit already captured it (an in-place
 * human-teaching reteach rewriting the SAME file absorb had just committed),
 * leaving a failed mutation's content visible to readers with nothing
 * rolled back. Resetting to the actual last-known-good commit sha has no
 * such failure mode: the reteach's failed rewrite is simply everything after
 * `checkpointSha`, discarded regardless of which path it touched.
 *
 * On `fn` returning normally: stage + commit whatever `fn` left uncommitted,
 * using `(result && result.commitMessage) || label` as the message. A real
 * git failure at either step triggers rollback to `checkpointSha` and is
 * reported as `ok: false, rolledBack: true`. A store with no git
 * (`ensureStore` degraded) skips staging entirely and reports
 * `committed: false` — the same tolerant default the rest of the store's
 * degraded modes use.
 *
 * On `fn` throwing: rollback to `checkpointSha`, then report
 * `ok: false, rolledBack: true, error` — UNLESS the thrown value is a
 * StoreTransactionAbort, in which case rollback is skipped entirely and
 * `rolledBack: false` (see the class doc comment above) — that path exists
 * for exactly the one case a checkpoint can't help with: absorb ITSELF
 * couldn't commit, so there's no fresh checkpoint to fall back to and the
 * dirty, uncommitted edit must be left exactly where it is.
 *
 * The lock is released in `finally`, AFTER the commit or rollback above
 * completes — never before.
 *
 * Non-reentrant by design: `fn` must never call withStoreTransaction again
 * (it would simply E_LOCKED against its own held lock).
 */
export function withStoreTransaction(workspace, { home, label, afterCommit } = {}, fn) {
  const { dir, git } = ensureStore(workspace, { home });
  const lockPath = path.join(dir, '.lock');
  const lock = acquireStoreLock(lockPath);
  if (!lock.acquired) {
    return { ok: false, locked: true, rolledBack: false, error: null, committed: false, result: null, dir, git, staleLockNote: null };
  }
  const token = lock.token;
  // UNDER THE LOCK (P3). `.gitignore` is what keeps a rollback's `git clean -fd`
  // from sweeping the lock, and writing it is a store mutation — it used to run
  // inside `ensureStore`, i.e. BEFORE `acquireStoreLock`, which is the one place
  // a store mutation must never happen. It runs here, before recovery, because
  // recovery's own rollback is the first thing that depends on it.
  ensureStoreGitignore(dir);
  // BEFORE RECOVERY, BEFORE `fn`, BEFORE ANY GIT READ (R7). A symlink at a
  // store-owned directory makes every step below operate on a store that is
  // lying about its own contents — see healSymlinkedStoreDirectories. The
  // link is quarantined and the real directory restored (so the next run is
  // clean), and THIS run refuses: nothing has been mutated by the transaction
  // itself at this point, so refusing costs only the run.
  const dirGuard = healSymlinkedStoreDirectories(dir, git);
  if (dirGuard.planted.length) {
    releaseStoreLock(lockPath, token);
    return {
      ok: false,
      locked: false,
      rolledBack: false,
      error: new Error(
        `a symlink stands at store-owned director${dirGuard.planted.length > 1 ? 'ies' : 'y'} ${dirGuard.planted.join(', ')} — every learning under it was hidden from every read path; ${dirGuard.note}`
      ),
      committed: false,
      result: null,
      dir,
      git,
      staleLockNote: [lock.staleLockNote, dirGuard.note].filter(Boolean).join('; ') || null,
    };
  }
  // Crash recovery BEFORE anything reads the tree (see
  // recoverInterruptedTransaction): a dead writer's uncommitted residue is
  // discarded here rather than inherited by the absorb step below as human
  // authority. Both notes ride the one existing recovery channel callers
  // already surface as `staleLockRemoved`.
  const recovery = recoverInterruptedTransaction(dir, git, lockPath, token);
  const staleLockNote = [lock.staleLockNote, recovery.note].filter(Boolean).join('; ') || null;
  if (recovery.lockLost || recovery.failed) {
    // Either somebody else's lock is sitting where ours was, or the dead
    // writer's residue is still in the tree. Nothing has been mutated by THIS
    // transaction, and a foreign lock is not ours to remove — refuse loudly and
    // leave the store exactly as it is. The journal clear is owner-checked (P2):
    // if another writer took the lock, the journal on disk is THEIRS.
    clearTxnJournal(dir, { token });
    if (!recovery.lockLost) releaseStoreLock(lockPath, token);
    return {
      ok: false,
      locked: recovery.lockLost,
      rolledBack: false,
      error: new Error(
        recovery.lockLost
          ? 'store lock was taken over by another writer during crash recovery — refusing to run'
          : 'could not discard the interrupted write residue left by a previous transaction — refusing to run on a store this CLI cannot clean'
      ),
      committed: false,
      result: null,
      dir,
      git,
      staleLockNote,
    };
  }

  // The rollback floor: entry HEAD, advanced by recordCheckpoint() whenever
  // an intra-transaction commit lands. Re-queried from git (not a
  // hand-incremented counter) so a caller that forgets to call
  // recordCheckpoint after a commit it made only delays when checkpointSha
  // catches up — it can never make checkpointSha wrong the way a
  // hand-maintained value could.
  let checkpointSha = git ? currentHeadSha(dir) : null;
  // `owner` stamps the journal with the SAME token the lock carries, so
  // `clearTxnJournal` can refuse to delete a journal another writer owns (P2).
  const journalBase = { pid: process.pid, at: new Date().toISOString(), label: label || null, owner: token };
  // FAIL CLOSED ON A JOURNAL WRITE FAILURE (P1). The journal is the ONLY thing
  // that tells this transaction's crash residue apart from a human hand edit,
  // so a best-effort write that silently failed left the transaction running
  // UNMARKED — exactly the state whose residue the next transaction's absorb
  // launders into `source: human`. Nothing has been mutated at this point, so
  // refusing the run costs only the run. `dirtyPaths` returning null (git
  // unreadable) is likewise refused: a journal that cannot record what was
  // already dirty cannot drive a per-path recovery either.
  if (git) {
    const dirty = dirtyPaths(dir);
    if (dirty === null || !writeTxnJournal(dir, { ...journalBase, checkpoint: checkpointSha, dirty })) {
      clearTxnJournal(dir, { token });
      releaseStoreLock(lockPath, token);
      return {
        ok: false,
        locked: false,
        rolledBack: false,
        error: new Error('store transaction journal could not be written — refusing to run unmarked (crash residue would be indistinguishable from a hand edit)'),
        committed: false,
        result: null,
        dir,
        git,
        staleLockNote,
      };
    }
  }
  function recordCheckpoint() {
    if (!git) return;
    checkpointSha = currentHeadSha(dir);
    // The intra-transaction commit just cleaned the tree, so whatever is
    // dirty from here on is unambiguously this transaction's own work — even
    // if a hand edit WAS pending when the journal was first written.
    //
    // A FAILED REFRESH IS NOT "STRICTLY MORE CONSERVATIVE" — the comment that
    // used to stand here was simply wrong, and the wrongness was load-bearing.
    // Leaving the PREVIOUS journal in place leaves an OLDER checkpoint on
    // disk, and `recoverInterruptedTransaction` resets `--hard` to exactly
    // that sha: the sub-commit just landed — an absorbed HUMAN HAND EDIT, in
    // absorbOrAbort's case — is then destroyed by the next writer's recovery,
    // which is the one outcome the whole journal exists to prevent. The tree is
    // clean at this instant and the checkpoint IS the sub-commit, so aborting
    // here costs nothing already written and keeps every recorded checkpoint
    // truthful. StoreTransactionAbort (not a plain throw) because the standard
    // rollback would itself reset past the commit we just failed to record.
    if (!writeTxnJournal(dir, { ...journalBase, checkpoint: checkpointSha, dirty: [] })) {
      throw new StoreTransactionAbort(
        'store transaction journal could not record the checkpoint after an intra-transaction commit — aborting rather than leaving a stale checkpoint a later recovery would reset past'
      );
    }
  }

  // Set once a rollback finds the lock in somebody else's hands: the `finally`
  // must then leave that lock strictly alone.
  let lockLost = false;
  // Set by ANY failed guardedRollback. This is the structural half of S4: a
  // transaction that could not discard what it meant to discard must never
  // reach `commitStore`, no matter what `fn` does with the boolean it was
  // handed. A caller that ignores the return value can no longer publish the
  // residue the rollback failed to remove — the commit simply does not happen.
  let rollbackFailed = false;
  let rollbackError = null;

  /**
   * Roll back to the checkpoint and REPORT whether it worked (S4). Returns true
   * only when git actually reset+cleaned the tree AND this transaction still
   * holds its lock. A false return is not advisory — every caller must abort;
   * `fn` bodies use it via `rollbackToCheckpoint`, and the terminal paths below
   * carry it into `rolledBack`.
   */
  /**
   * `toHead: true` discards only what is UNCOMMITTED (a plain
   * `git reset --hard` + clean) instead of resetting to the checkpoint — the
   * shape apply.mjs's `recordContentFailure` needs to undo its own failed
   * strike sub-commit attempt without unwinding to the checkpoint. It used to
   * call `rollbackStore` directly, which set no `rollbackFailed` latch and
   * re-asserted no ownership: its `git clean -fd` was the last rollback in the
   * codebase that could free the lock with nobody checking (R4).
   */
  function guardedRollback({ toHead = false } = {}) {
    if (!git) return false;
    const res = toHead ? rollbackStore(dir) : rollbackStore(dir, checkpointSha);
    // `.lock` is gitignored (S2), so `git clean -fd` no longer sweeps it — but
    // verify ownership rather than assume it: a rollback taken MID-`fn`
    // (rollbackToCheckpoint) must never let this transaction keep writing after
    // the store has been handed to a concurrent writer.
    const held = reassertStoreLock(lockPath, token);
    if (!held) lockLost = true;
    const ok = res.ok && held;
    if (!ok) {
      rollbackFailed = true;
      rollbackError = res.ok
        ? 'store lock was taken over by another writer during rollback'
        : `store rollback failed: ${res.stderr || 'unknown git failure'}`;
    }
    return ok;
  }

  try {
    let result;
    try {
      result = fn({
        dir,
        git,
        recordCheckpoint,
        rollbackToCheckpoint: () => guardedRollback(),
        rollbackUncommitted: () => guardedRollback({ toHead: true }),
      });
    } catch (err) {
      const isAbort = err instanceof StoreTransactionAbort;
      const rolledBack = isAbort ? false : guardedRollback();
      // A rollback that itself failed is reported IN the error, not hidden
      // behind a bare `rolledBack: false` no caller reads (S4).
      const error = !isAbort && !rolledBack && rollbackError ? new Error(`${err.message} — AND ${rollbackError}`) : err;
      return { ok: false, locked: false, rolledBack, error, committed: false, result: null, dir, git, staleLockNote };
    }
    // A FAILED ROLLBACK CAN NEVER BE FOLLOWED BY A COMMIT (S4). `fn` may have
    // called `rollbackToCheckpoint` and returned normally — apply.mjs's
    // write-time E_HEAD_MOVED gate does exactly that — so if that rollback did
    // not actually clean the tree, committing here would publish the very
    // mutation the rejection claims was never written. Refuse instead, and say
    // why. Enforced HERE rather than trusting each `fn` to check, because a
    // caller forgetting to check is precisely how this defect shipped.
    if (rollbackFailed) {
      return {
        ok: false,
        locked: false,
        rolledBack: false,
        error: new Error(`${rollbackError} — refusing to commit a store this transaction could not roll back`),
        committed: false,
        result: null,
        dir,
        git,
        staleLockNote,
      };
    }
    let commitRes = { committed: false, ok: true };
    if (git) {
      commitRes = commitStore(dir, (result && result.commitMessage) || label || 'harness: update store');
    }
    if (!commitRes.ok) {
      const rolledBack = guardedRollback();
      const base = commitRes.stderr || 'git commit failed';
      return {
        ok: false,
        locked: false,
        rolledBack,
        error: new Error(!rolledBack && rollbackError ? `${base} — AND ${rollbackError}` : base),
        committed: false,
        result: null,
        dir,
        git,
        staleLockNote,
      };
    }
    // Post-commit hook run WHILE THE LOCK IS STILL HELD (released only by the
    // finally below), on the clean, just-committed working tree. This is where
    // a caller that mirrors committed store state into the workspace
    // (apply.mjs's mirrorLearnings) belongs: running it here — rather than
    // after the lock is released — means no concurrent writer can interleave a
    // dirty mutation the mirror would re-read and then have rolled back (P2).
    // Best effort: a hook failure must never turn an already-committed
    // transaction into a failure.
    if (afterCommit) {
      try {
        afterCommit({ dir, git, committed: commitRes.committed, result });
      } catch {
        // swallow — the commit already landed; a mirror/side-effect failure is not a transaction failure
      }
    }
    return { ok: true, locked: false, rolledBack: false, error: null, committed: commitRes.committed, result, dir, git, staleLockNote };
  } finally {
    // Cleared only once the commit or rollback above has finished: while it
    // exists, a crash at any point leaves the residue classifiable. OWNER-
    // CHECKED (P2): reached with `lockLost === true` this would otherwise
    // delete the WINNING writer's journal and leave them running unmarked.
    clearTxnJournal(dir, { token });
    // OWNER-CHECKED RELEASE (S2), on every exit path including this one. The
    // old unconditional `rmSync(lockPath)` was the release half of the lock-loss
    // class: if anything had taken the lock in the meantime, this deleted a LIVE
    // writer's lock. `releaseStoreLock` removes it only when the owner stamp is
    // ours, and `lockLost` records that a rollback already found it foreign.
    if (!lockLost) releaseStoreLock(lockPath, token);
  }
}

/** Lowercase, diacritic-stripped, [a-z0-9-] slugs — case-insensitive-FS safe. */
export function normalizeSlug(text) {
  return (
    String(text)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'learning'
  );
}

/**
 * Stale-anchor exclusions: CLI state recomputed by `harness index`, not a
 * learning write. Tolerant of an absent or corrupt file — a fresh or damaged
 * store never blocks retrieval.
 */
export function readStaleExclusions(dir) {
  try {
    const parsed = JSON.parse(readStoreFile(path.join(dir, 'stale.json')));
    if (parsed && parsed.excluded && typeof parsed.excluded === 'object') {
      return { excluded: parsed.excluded };
    }
  } catch {
    // absent, unreadable, or corrupt — tolerant default
  }
  return { excluded: {} };
}

export function writeStaleExclusions(dir, data) {
  return writeStoreFile(path.join(dir, 'stale.json'), JSON.stringify(data) + '\n');
}
