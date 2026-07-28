import fs from 'node:fs';
import path from 'node:path';
import { storeDir, listLearnings, commitStore, serializeLearning } from './store.mjs';
import { updateFrontmatterField, todayClamped, rebuildIndex } from './apply.mjs';
import { absorbHandEdits, mirrorLearnings } from './admin.mjs';

/**
 * One-command human authority over a single learning: retire, dispute,
 * confirm, or promote. The only writer here besides applyOps — one or two
 * targeted frontmatter field writes (confirm also stamps last_confirmed,
 * promote stamps promoted_to via a full parse→mutate→serializeLearning
 * re-render since the field may be entirely absent on disk) plus one store
 * commit, never a rewrite of the learning body.
 */

const ACTIONS = new Set(['retire', 'dispute', 'confirm', 'promote']);
const TARGET_STATUS = { retire: 'retired', dispute: 'disputed', confirm: 'active' };

export function setLearningStatus({ workspace, id, action, reason, to, home }) {
  if (!ACTIONS.has(action) || !id) {
    return { pass: false, exitCode: 2, id: id || null, status: null,
      blockedReason: 'usage: harness learning <retire|dispute|confirm> <id> --reason "<r>"' };
  }
  if (action !== 'confirm' && action !== 'promote' && !reason) {
    return { pass: false, exitCode: 2, id, status: null, blockedReason: `${action} requires --reason` };
  }
  if (action === 'promote' && !to) {
    return { pass: false, exitCode: 2, id, status: null, blockedReason: 'promote requires --to' };
  }
  // Absorb any hand edit before this mutation reads the target — so a
  // retire/dispute/confirm/promote always acts on the absorbed
  // (human-authored) state, not a stale in-tree edit. Advisory: never blocks
  // the command.
  try {
    absorbHandEdits({ workspace, home });
  } catch {
    // best effort
  }
  const dir = storeDir(workspace, { home });
  // Read-only until the target is confirmed to exist — a storeless workspace
  // (or a missing id in an existing store) must never be materialized by a
  // targeted lifecycle command; only a real hit proceeds to the write below.
  const learning = fs.existsSync(dir) ? listLearnings(dir).find((l) => l.id === id) : null;
  if (!learning) {
    return { pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: no learning ${id}` };
  }

  if (action === 'promote') {
    // Promotion records where the behavior now lives — it never creates the
    // primitive itself (a human PR does that); the recorded path must
    // already exist on disk by the time the CLI is run.
    const primitiveFull = path.resolve(workspace, to);
    if (!fs.existsSync(primitiveFull)) {
      return { pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: ${to} does not exist` };
    }
    // Insight-only learnings never promote (design §10) — promotion asserts
    // the claim was proven by a real fix or a verified human teaching, never
    // just an unconfirmed observation.
    const hasQualifyingEpisode = (learning.fm.episodes || []).some(
      (e) => e.kind === 'fix' || e.kind === 'human-teaching'
    );
    if (!hasQualifyingEpisode) {
      return {
        pass: false, exitCode: 2, id, status: null,
        blockedReason: 'insight-only learnings never promote (design §10)',
      };
    }
    // Re-render via serializeLearning rather than updateFrontmatterField's
    // regex-insert: promoted_to may be entirely absent from the on-disk
    // file, and a parse → mutate fm → serializeLearning round trip is the
    // safe route to add it in its canonical position. status is left
    // untouched — promotion never overwrites the learning's own status.
    const nextFm = { ...learning.fm, promoted_to: to };
    fs.writeFileSync(learning.file, serializeLearning(nextFm, learning.body), 'utf8');
    // Same as every other store writer (applyOps, absorbHandEdits, purge):
    // rebuild INDEX.md in the same commit as the mutation, so a promoted
    // learning drops out of the index immediately rather than waiting for
    // the next consolidate --apply.
    rebuildIndex(dir);
    commitStore(dir, `promote ${id}: ${to}`);
    try {
      mirrorLearnings({ workspace, home });
    } catch {
      // best effort — a mirror failure must never block promote.
    }
    return { pass: true, exitCode: 0, id, status: 'promoted', blockedReason: null };
  }

  updateFrontmatterField(learning.file, 'status', TARGET_STATUS[action]);
  if (action === 'confirm') updateFrontmatterField(learning.file, 'last_confirmed', todayClamped());
  rebuildIndex(dir);
  commitStore(dir, `${action} ${id}: ${reason || 'human confirm'}`);
  try {
    mirrorLearnings({ workspace, home });
  } catch {
    // best effort — a mirror failure must never block a lifecycle action.
  }
  return { pass: true, exitCode: 0, id, status: TARGET_STATUS[action], blockedReason: null };
}
