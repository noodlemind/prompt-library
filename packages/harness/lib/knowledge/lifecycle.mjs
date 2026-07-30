import fs from 'node:fs';
import path from 'node:path';
import { storeDir, withStoreTransaction, StoreTransactionAbort, listLearnings, serializeLearning, appendGovernance } from './store.mjs';
import { updateFrontmatterField, todayClamped, rebuildIndex } from './apply.mjs';
import { absorbOrAbort, mirrorLearnings } from './admin.mjs';

/**
 * One-command human authority over a single learning: retire, dispute,
 * confirm, or promote. The only writer here besides applyOps — one or two
 * targeted frontmatter field writes (confirm also stamps last_confirmed,
 * promote stamps promoted_to via a full parse→mutate→serializeLearning
 * re-render since the field may be entirely absent on disk) plus one store
 * commit, never a rewrite of the learning body. Runs inside the same
 * single-writer transaction (withStoreTransaction, store.mjs) every other
 * store mutator uses.
 */

const ACTIONS = new Set(['retire', 'dispute', 'confirm', 'promote']);
const TARGET_STATUS = { retire: 'retired', dispute: 'disputed', confirm: 'active' };

export function setLearningStatus({ workspace, id, action, reason, to, home, log = () => {} }) {
  if (!ACTIONS.has(action) || !id) {
    return { pass: false, exitCode: 2, id: id || null, status: null,
      blockedReason: 'usage: harness learning <retire|dispute|confirm|promote> <id> --reason "<r>" | --to <path>' };
  }
  if (action !== 'confirm' && action !== 'promote' && !reason) {
    return { pass: false, exitCode: 2, id, status: null, blockedReason: `${action} requires --reason` };
  }
  if (action === 'promote' && !to) {
    return { pass: false, exitCode: 2, id, status: null, blockedReason: 'promote requires --to' };
  }

  // Non-creating gate: a storeless workspace must never be materialized just
  // to discover a missing target — withStoreTransaction below always calls
  // ensureStore, so this cheap existence check has to happen BEFORE it.
  // Once a store DOES exist, the actual target lookup — and everything
  // after it — happens fresh, under the lock, inside the transaction: a
  // stale pre-lock read here would be exactly the P1-6 race (another writer
  // could delete/rewrite the target between this check and lock
  // acquisition).
  const storePath = storeDir(workspace, { home });
  if (!fs.existsSync(storePath)) {
    return { pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: no learning ${id}` };
  }

  const tx = withStoreTransaction(workspace, { home, label: `${action} ${id}` }, ({ dir, recordCheckpoint }) => {
    // Absorb any hand edit before this mutation reads the target — so a
    // retire/dispute/confirm/promote always acts on the absorbed
    // (human-authored) state, not a stale in-tree edit. Advisory: never
    // blocks the command.
    try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
      // A REAL absorb-commit failure must propagate as-is (never swallowed)
      // so withStoreTransaction can skip the rollback and protect the
      // uncommitted hand edit sitting in the tree — any OTHER absorb hiccup
      // stays best effort, exactly as before.
      if (err instanceof StoreTransactionAbort) throw err;
    }
    const learning = listLearnings(dir).find((l) => l.id === id);
    if (!learning) {
      return { kind: 'reject', pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: no learning ${id}` };
    }

    if (action === 'promote') {
      // Containment guard: same root/startsWith idiom purge uses (admin.mjs's
      // purgeEpisode) — a --to path that escapes the workspace (`../`) or
      // resolves to an absolute path outside it must never be recorded, let
      // alone read from disk.
      const root = path.resolve(workspace);
      const primitiveFull = path.resolve(root, to);
      if (primitiveFull !== root && !primitiveFull.startsWith(root + path.sep)) {
        return { kind: 'reject', pass: false, exitCode: 2, id, status: null, blockedReason: `promote --to escapes the workspace: ${to}` };
      }
      // Promotion records where the behavior now lives — it never creates the
      // primitive itself (a human PR does that); the recorded path must
      // already exist on disk by the time the CLI is run.
      if (!fs.existsSync(primitiveFull)) {
        return { kind: 'reject', pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: ${to} does not exist` };
      }
      // Insight-only learnings never promote (design §10) — promotion asserts
      // the claim was proven by a real fix or a verified human teaching, never
      // just an unconfirmed observation. A qualifying episode needs a path AS
      // WELL AS a qualifying kind: a pathless `kind: fix` entry (a malformed
      // record — a hand edit or stale on-disk data) is dropped by every
      // serializer (episodeLines, store.mjs/apply.mjs) on the very next
      // re-render, so counting it here would let a learning promote on
      // evidence that vanishes the moment the file is touched again, leaving a
      // promoted learning with ZERO recorded evidence.
      const hasQualifyingEpisode = (learning.fm.episodes || []).some(
        (e) => e.path && (e.kind === 'fix' || e.kind === 'human-teaching')
      );
      if (!hasQualifyingEpisode) {
        return {
          kind: 'reject', pass: false, exitCode: 2, id, status: null,
          blockedReason: 'insight-only learnings never promote (design §10)',
        };
      }
      // Stored as a normalized, workspace-relative POSIX path — never the raw
      // `to` string a caller passed (which may carry OS separators or `./`
      // noise) — so promoted_to stays portable and directly comparable across
      // platforms.
      const promotedTo = path.relative(root, primitiveFull).split(path.sep).join('/');
      // Re-render via serializeLearning rather than updateFrontmatterField's
      // regex-insert: promoted_to may be entirely absent from the on-disk
      // file, and a parse → mutate fm → serializeLearning round trip is the
      // safe route to add it in its canonical position. status is left
      // untouched — promotion never overwrites the learning's own status.
      const nextFm = { ...learning.fm, promoted_to: promotedTo };
      fs.writeFileSync(learning.file, serializeLearning(nextFm, learning.body), 'utf8');
      // Same as every other store writer (applyOps, absorbHandEdits, purge):
      // rebuild INDEX.md in the same commit as the mutation, so a promoted
      // learning drops out of the index immediately rather than waiting for
      // the next consolidate --apply.
      rebuildIndex(dir);
      // Governance record (Milestone 4): appended BEFORE the transaction's
      // own commit, same idea as before — one commit carries both the
      // frontmatter write and the governance entry.
      appendGovernance(dir, { id, action: 'promote', reason: reason || null, to: promotedTo, at: todayClamped() });
      return { kind: 'success', commitMessage: `promote ${id}: ${promotedTo}`, status: 'promoted' };
    }

    updateFrontmatterField(learning.file, 'status', TARGET_STATUS[action]);
    if (action === 'confirm') updateFrontmatterField(learning.file, 'last_confirmed', todayClamped());
    rebuildIndex(dir);
    // Governance record (Milestone 4): appended BEFORE the transaction's own
    // commit, same reasoning as the promote branch above — one commit
    // carries both.
    appendGovernance(dir, { id, action, reason: reason || null, to: null, at: todayClamped() });
    return { kind: 'success', commitMessage: `${action} ${id}: ${reason || 'human confirm'}`, status: TARGET_STATUS[action] };
  });

  if (!tx.ok) {
    return {
      pass: false,
      exitCode: 1,
      id,
      status: null,
      blockedReason: tx.locked
        ? 'E_LOCKED: another operation holds the store lock'
        : `${action} failed: ${tx.error?.message || 'store transaction failed'}`,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  const inner = tx.result;
  if (inner.kind === 'reject') {
    return {
      pass: inner.pass,
      exitCode: inner.exitCode,
      id: inner.id,
      status: inner.status,
      blockedReason: inner.blockedReason,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  try {
    mirrorLearnings({ workspace, home });
  } catch {
    // best effort — a mirror failure must never block a lifecycle action.
  }
  return {
    pass: true,
    exitCode: 0,
    id,
    status: inner.status,
    blockedReason: null,
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}
