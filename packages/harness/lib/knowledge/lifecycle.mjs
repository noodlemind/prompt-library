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

  const tx = withStoreTransaction(
    workspace,
    {
      home,
      label: `${action} ${id}`,
      // Mirror a COMMITTED snapshot under the still-held lock (P2), never after
      // the lock releases where a concurrent writer's dirty state could leak in.
      afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home });
      },
    },
    ({ dir, recordCheckpoint }) => {
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

    // Promoted is terminal for retire/dispute/confirm (design correction): a
    // learning's behavior already lives in a primitive (promoted_to set), so
    // a later confirm/retire/dispute here would append a NEWER governance
    // entry than the standing `promote` record — readGovernance's
    // latest-entry-per-id replay would then forget the promotion on the very
    // next `consolidate --rebuild --yes`, regenerating the learning WITHOUT
    // promoted_to even though the primitive it names is still the live
    // behavior. Rejected unconditionally, before any of the three actions'
    // own mutation logic runs, and before any governance entry is appended —
    // apply.mjs's ops path already can never reach a promoted target this way
    // (promotedTargetRejection fires before any write), so this is the one
    // remaining CLI-driven path that could otherwise sneak a later
    // retire/dispute/confirm record in over a promotion. `promote` itself is
    // deliberately exempt from this check (out of scope here; re-promoting
    // an already-promoted learning is unchanged behavior) — reversal, if
    // ever wanted, needs its own explicit `unpromote` action, not added here
    // (YAGNI): promoted simply has no way back through this command.
    if (action !== 'promote' && learning.fm.promoted_to) {
      return {
        kind: 'reject', pass: false, exitCode: 2, id, status: null,
        blockedReason: `${id} is promoted (behavior lives in ${learning.fm.promoted_to}) — lifecycle actions don't apply; edit the primitive or purge`,
      };
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
      // frontmatter write and the governance entry. `at` is a full ISO-8601
      // UTC timestamp (P1-9), not the day-only todayClamped() stamp used for
      // last_confirmed above — the model-lane recency gate
      // (overridesGovernanceRecency, apply.mjs) needs finer-than-a-day
      // resolution to tell a same-day override apart from a genuinely later
      // one; readGovernance's readers stay tolerant of a legacy plain-date
      // value too.
      appendGovernance(dir, { id, action: 'promote', reason: reason || null, to: promotedTo, at: new Date().toISOString() });
      return { kind: 'success', commitMessage: `promote ${id}: ${promotedTo}`, status: 'promoted' };
    }

    updateFrontmatterField(learning.file, 'status', TARGET_STATUS[action]);
    if (action === 'confirm') updateFrontmatterField(learning.file, 'last_confirmed', todayClamped());
    rebuildIndex(dir);
    // Governance record (Milestone 4): appended BEFORE the transaction's own
    // commit, same reasoning as the promote branch above — one commit
    // carries both. `at` is a full ISO-8601 UTC timestamp (P1-9) — see the
    // promote branch above for why.
    appendGovernance(dir, { id, action, reason: reason || null, to: null, at: new Date().toISOString() });
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

  // The workspace mirror already ran inside the transaction's afterCommit hook
  // (above), under the still-held lock on the committed tree — never here after
  // the lock released (P2).
  return {
    pass: true,
    exitCode: 0,
    id,
    status: inner.status,
    blockedReason: null,
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}
