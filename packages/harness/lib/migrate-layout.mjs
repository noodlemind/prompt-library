import fs from 'node:fs';
import path from 'node:path';
import { copyFileContainedExclusive, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { ensureHarnessDir, readSession, writeSession } from './session.mjs';
import {
  WORKSPACE_PLANS_REL,
  SESSION_PLANS_REL,
  WORKSPACE_SOLUTIONS_REL,
  WORKSPACE_MAP_REL,
  SESSION_MAP_REL,
  WORKSPACE_AGENT_CTX_REL,
  SESSION_AGENT_CTX_REL,
  projectStoreDir,
  gitLsFiles,
  gitHasTrackedFiles,
} from './project-layout.mjs';

export { gitHasTrackedFiles };

function posixRel(rel) {
  return String(rel || '').replace(/\\/g, '/');
}

function listRelFiles(base, rel) {
  const normalized = posixRel(rel);
  const full = path.join(base, normalized);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [normalized];
  if (!stat.isDirectory()) return [];
  const out = [];
  const walk = (entryRel) => {
    const entryFull = path.join(base, entryRel);
    let entryStat;
    try {
      entryStat = fs.lstatSync(entryFull);
    } catch {
      return;
    }
    if (entryStat.isSymbolicLink()) return;
    if (entryStat.isDirectory()) {
      for (const name of fs.readdirSync(entryFull)) walk(`${entryRel}/${name}`);
      return;
    }
    if (entryStat.isFile()) out.push(entryRel);
  };
  walk(normalized);
  return out;
}

function pruneEmptyAncestors(workspace, rel) {
  const root = path.resolve(workspace);
  let cur = path.resolve(workspace, rel);
  try {
    const st = fs.lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) cur = path.dirname(cur);
  } catch {
    cur = path.dirname(cur);
  }
  while (cur.startsWith(root + path.sep)) {
    const relFromRoot = path.relative(root, cur);
    if (!relFromRoot || path.isAbsolute(relFromRoot) || relFromRoot.startsWith('..')) break;
    if (!assertNoSymlinkAncestors(root, relFromRoot)) break;
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) break;
    try {
      if (fs.readdirSync(cur).length) break;
      fs.rmdirSync(cur);
    } catch {
      break;
    }
    cur = path.dirname(cur);
  }
}

function copyPresent({ workspace, fromRel, destRoot, destRel, dryRun }) {
  const files = [];
  for (const srcRel of listRelFiles(workspace, fromRel)) {
    const destPathRel = destFileRel(srcRel, fromRel, destRel);
    const destFull = path.join(destRoot, destPathRel);
    if (fs.existsSync(destFull)) continue;
    if (dryRun) {
      files.push({ from: srcRel, to: destPathRel });
      continue;
    }
    const written = copyFileContainedExclusive(workspace, srcRel, destRoot, destPathRel);
    if (written) files.push({ from: srcRel, to: destPathRel });
  }
  return files;
}

function destFileRel(fromRel, fromRootRel, destRootRel) {
  const suffix = posixRel(fromRel).slice(posixRel(fromRootRel).length).replace(/^\//, '');
  return suffix ? `${posixRel(destRootRel)}/${suffix}` : posixRel(destRootRel);
}

function migrateItem({ workspace, kind, fromRel, destRoot, destRel, dryRun }) {
  const from = posixRel(fromRel);
  const to = posixRel(destRel);
  if (!fs.existsSync(path.join(workspace, from))) {
    return { kind, from, to, action: 'absent', files: [], conflicts: [], kept: [] };
  }
  if (!assertNoSymlinkAncestors(workspace, from)) {
    return { kind, from, to, action: 'blocked-symlink', files: [], conflicts: [], kept: [] };
  }
  const listed = gitLsFiles(workspace, from);
  if (!listed.ok) {
    return { kind, from, to, action: 'keep-unknown', files: [], conflicts: [], kept: [] };
  }
  const tracked = new Set(listed.files);
  const sources = listRelFiles(workspace, from);
  const files = [];
  const conflicts = [];
  const kept = [];
  for (const srcRel of sources) {
    if (tracked.has(srcRel)) {
      kept.push({ from: srcRel, reason: 'tracked' });
      continue;
    }
    const destPathRel = destFileRel(srcRel, from, to);
    const destFull = path.join(destRoot, destPathRel);
    if (fs.existsSync(destFull)) {
      conflicts.push({ from: srcRel, to: destPathRel, reason: 'exists' });
      continue;
    }
    if (dryRun) {
      files.push({ from: srcRel, to: destPathRel });
      continue;
    }
    const written = copyFileContainedExclusive(workspace, srcRel, destRoot, destPathRel);
    if (!written) {
      conflicts.push({
        from: srcRel,
        to: destPathRel,
        reason: fs.existsSync(destFull) ? 'exists' : 'write-refused',
      });
      continue;
    }
    const srcPath = path.join(workspace, srcRel);
    try {
      const st = fs.lstatSync(srcPath);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('source-changed');
      fs.unlinkSync(srcPath);
    } catch {
      try {
        fs.unlinkSync(written);
      } catch {
        /* dest may remain as a duplicate the next run will conflict on */
      }
      conflicts.push({ from: srcRel, to: destPathRel, reason: 'source-delete-failed' });
      continue;
    }
    pruneEmptyAncestors(workspace, srcRel);
    files.push({ from: srcRel, to: destPathRel });
  }
  if (!dryRun) pruneEmptyAncestors(workspace, from);
  let action = 'absent';
  if (files.length || conflicts.length) action = 'migrate';
  else if (kept.length) action = 'keep-tracked';
  return { kind, from, to, action, files, conflicts, kept };
}

function rewriteSessionPlanPaths(workspace, moved, dryRun, home) {
  const session = readSession(workspace);
  if (!session) return false;
  const movedFrom = new Set(
    (moved || []).filter((item) => item.kind === 'plans').map((item) => posixRel(item.from))
  );
  if (!movedFrom.size) return false;
  let changed = false;
  const next = { ...session };
  for (const key of ['activePlan', 'gatedPlan']) {
    const raw = next[key];
    if (typeof raw !== 'string') continue;
    const n = posixRel(raw);
    if (!movedFrom.has(n)) continue;
    next[key] = path.join(projectStoreDir(workspace, { home }), 'plans', path.posix.basename(n));
    changed = true;
  }
  if (changed && !dryRun) writeSession(workspace, next, false);
  return changed;
}

export function inspectLayout(workspace, { home } = {}) {
  const overlay = projectStoreDir(workspace, { home });
  return [
    {
      kind: 'plans',
      from: WORKSPACE_PLANS_REL,
      to: 'plans',
      destRoot: projectStoreDir(workspace, { home }),
    },
    {
      kind: 'session-plans',
      from: SESSION_PLANS_REL,
      to: 'plans',
      destRoot: projectStoreDir(workspace, { home }),
    },
    {
      kind: 'solutions',
      from: WORKSPACE_SOLUTIONS_REL,
      to: WORKSPACE_SOLUTIONS_REL,
      destRoot: overlay,
    },
    {
      kind: 'knowledge',
      from: 'knowledge/solutions',
      to: 'knowledge/solutions',
      destRoot: overlay,
    },
    {
      kind: 'agent-context',
      from: WORKSPACE_AGENT_CTX_REL,
      to: 'agent-context.md',
      destRoot: projectStoreDir(workspace, { home }),
    },
    {
      kind: 'codebase-map',
      from: WORKSPACE_MAP_REL,
      to: 'codebase-map.md',
      destRoot: projectStoreDir(workspace, { home }),
    },
  ].map((spec) => {
    const exists = fs.existsSync(path.join(workspace, spec.from));
    if (!exists) return { ...spec, action: 'absent', files: [] };
    if (!assertNoSymlinkAncestors(workspace, spec.from)) return { ...spec, action: 'blocked-symlink', files: [] };
    const listed = gitLsFiles(workspace, spec.from);
    if (!listed.ok) return { ...spec, action: 'keep-unknown', files: [] };
    const tracked = new Set(listed.files);
    const untracked = listRelFiles(workspace, spec.from).filter((rel) => !tracked.has(rel));
    if (untracked.length) return { ...spec, action: 'migrate', files: untracked };
    if (tracked.size) return { ...spec, action: 'keep-tracked', files: [] };
    return { ...spec, action: 'migrate', files: [] };
  });
}

export function leftoverWorkspaceArtifacts(workspace, { home } = {}) {
  return inspectLayout(workspace, { home }).filter((item) => item.action === 'migrate');
}

export function runMigrateLayout({ workspace, dryRun = false, log = () => {}, home } = {}) {
  ensureHarnessDir(workspace, dryRun);
  const inspected = inspectLayout(workspace, { home });
  const moved = [];
  const kept = [];
  const conflicts = [];
  const blocked = [];
  for (const spec of inspected) {
    if (spec.action === 'absent') continue;
    if (spec.action === 'keep-tracked') {
      const copied = copyPresent({
        workspace,
        fromRel: spec.from,
        destRoot: spec.destRoot,
        destRel: spec.to,
        dryRun,
      });
      for (const file of copied) {
        moved.push({ kind: spec.kind, from: file.from, to: file.to, copied: true });
        log(`${dryRun ? 'would copy' : 'copied'} ${file.from} → ${file.to}`);
      }
      kept.push({ kind: spec.kind, from: spec.from, reason: 'tracked' });
      log(`keep ${spec.from} (git-tracked)`);
      continue;
    }
    if (spec.action === 'keep-unknown') {
      kept.push({ kind: spec.kind, from: spec.from, reason: 'git-unknown' });
      log(`keep ${spec.from} (git probe failed — refusing to migrate)`);
      continue;
    }
    if (spec.action === 'blocked-symlink') {
      blocked.push({ kind: spec.kind, from: spec.from, reason: 'symlink' });
      log(`skip ${spec.from} (symlink)`);
      continue;
    }
    const result = migrateItem({
      workspace,
      kind: spec.kind,
      fromRel: spec.from,
      destRoot: spec.destRoot,
      destRel: spec.to,
      dryRun,
    });
    for (const file of result.files) {
      moved.push({ kind: spec.kind, from: file.from, to: file.to });
      log(`${dryRun ? 'would move' : 'moved'} ${file.from} → ${file.to}`);
    }
    for (const file of result.kept || []) {
      kept.push({ kind: spec.kind, from: file.from, reason: file.reason });
      log(`keep ${file.from} (git-tracked)`);
    }
    for (const conflict of result.conflicts) {
      conflicts.push({ kind: spec.kind, ...conflict });
      log(`conflict ${conflict.from} → ${conflict.to} (${conflict.reason})`);
    }
  }
  const sessionRewritten = rewriteSessionPlanPaths(workspace, moved, dryRun, home);
  if (sessionRewritten) log(`${dryRun ? 'would rewrite' : 'rewrote'} session plan paths`);
  return {
    moved,
    kept,
    conflicts,
    blocked,
    sessionRewritten,
    leftover: leftoverWorkspaceArtifacts(workspace, { home }).length > 0,
  };
}
