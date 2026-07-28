import fs from 'node:fs';
import { storeDir, listLearnings, commitStore } from './store.mjs';
import { updateFrontmatterField, todayClamped } from './apply.mjs';

/**
 * One-command human authority over a single learning: retire, dispute, or
 * confirm. The only writer here besides applyOps — one or two targeted
 * frontmatter field writes (confirm also stamps last_confirmed) plus one
 * store commit, never a rewrite of the learning body.
 */

const ACTIONS = new Set(['retire', 'dispute', 'confirm']);
const TARGET_STATUS = { retire: 'retired', dispute: 'disputed', confirm: 'active' };

export function setLearningStatus({ workspace, id, action, reason, home }) {
  if (!ACTIONS.has(action) || !id) {
    return { pass: false, exitCode: 2, id: id || null, status: null,
      blockedReason: 'usage: harness learning <retire|dispute|confirm> <id> --reason "<r>"' };
  }
  if (action !== 'confirm' && !reason) {
    return { pass: false, exitCode: 2, id, status: null, blockedReason: `${action} requires --reason` };
  }
  const dir = storeDir(workspace, { home });
  // Read-only until the target is confirmed to exist — a storeless workspace
  // (or a missing id in an existing store) must never be materialized by a
  // targeted lifecycle command; only a real hit proceeds to the write below.
  const learning = fs.existsSync(dir) ? listLearnings(dir).find((l) => l.id === id) : null;
  if (!learning) {
    return { pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: no learning ${id}` };
  }
  updateFrontmatterField(learning.file, 'status', TARGET_STATUS[action]);
  if (action === 'confirm') updateFrontmatterField(learning.file, 'last_confirmed', todayClamped());
  commitStore(dir, `${action} ${id}: ${reason || 'human confirm'}`);
  return { pass: true, exitCode: 0, id, status: TARGET_STATUS[action], blockedReason: null };
}
