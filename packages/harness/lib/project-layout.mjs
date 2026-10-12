import fs from 'node:fs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from './paths.mjs';
import { workspaceStorageId } from './knowledge/store.mjs';
import { createHash } from 'node:crypto';
import { readFileNoFollow } from './fs-safe.mjs';

const objectHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash = value => createHash('sha256').update(value).digest('hex');
export const conversionPointerRel = full => `.harness/operations/plans/conversions/${objectHash(path.resolve(full))}.json`;

function planConversionRecord(workspace, full, { home } = {}) {
  try {
    const root = projectStoreDir(workspace, { home });
    const old = fs.existsSync(full) ? fs.realpathSync(full) : path.resolve(full);
    const pointerPath = path.join(root, conversionPointerRel(old));
    if (!fs.lstatSync(pointerPath, { throwIfNoEntry: false })) return null;
    const pointer = JSON.parse(readFileNoFollow(pointerPath, { root, maxBytes: 4096 }) || 'null');
    if (!pointer || pointer.version !== 1 || !/^[a-f0-9]{64}$/.test(pointer.inputDigest || '') || !/^\.harness\/operations\/plans\/[a-f0-9]{64}\.json$/.test(pointer.record || '')) return { state: 'invalid' };
    const record = JSON.parse(readFileNoFollow(path.join(root, pointer.record), { root, maxBytes: 1024 * 1024 }) || 'null');
    if (record?.kind !== 'conversion' || record.inputDigest !== pointer.inputDigest || !['pending', 'completed'].includes(record.state) || record.id !== objectHash(record.value) || record.value.oldPath !== old || record.value.newPath !== old.replace(/\.md$/, '.hplan') || typeof record.value.original !== 'string' || textHash(record.value.original) !== record.value.oldRevision || typeof record.value.text !== 'string' || textHash(record.value.text) !== record.value.newRevision) return { state: 'invalid' };
    return record;
  } catch { return { state: 'invalid' }; }
}

export function planConversionPublished(workspace, full, options = {}) {
  return Boolean(planConversionRecord(workspace, full, options));
}

export function planConversionPending(workspace, full, options = {}) {
  if (!full.endsWith('.hplan')) return false;
  const record = planConversionRecord(workspace, full.replace(/\.hplan$/, '.md'), options);
  return Boolean(record && record.state !== 'completed');
}

/** Committed change-contract location (this library, teams that check plans in). */
export const WORKSPACE_PLANS_REL = 'docs/plans';
/** Session-local plans for app repos that gitignore harness artifacts. */
export const SESSION_PLANS_REL = '.harness/plans';
export const WORKSPACE_SOLUTIONS_REL = 'docs/solutions';
export const WORKSPACE_MAP_REL = 'docs/codebase-map.md';
export const SESSION_MAP_REL = '.harness/codebase-map.md';
export const WORKSPACE_AGENT_CTX_REL = 'docs/agent-context.md';
export const SESSION_AGENT_CTX_REL = '.harness/agent-context.md';

const PLAN_FILE = /^\d{4}-\d{2}-\d{2}-(?:feat|fix|docs|refactor|chore)-[a-z0-9]+(?:-[a-z0-9]+)*-plan\.(?:md|hplan)$/;

export function projectStoreDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'projects', workspaceStorageId(workspace, { home }));
}

export function dirExists(root, rel) {
  try {
    return fs.statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

export function fileExists(root, rel) {
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

function workspaceHasGitDir(workspace) {
  try {
    const st = fs.lstatSync(path.join(workspace, '.git'));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

function gitSpawn(workspace, args) {
  try {
    return spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 10_000, env: gitMetadataEnvironment() });
  } catch (err) {
    return { status: 1, stdout: '', stderr: String(err?.message || err || ''), error: err };
  }
}

/** 'inside' | 'outside' | 'unknown' — unknown is fail-closed (do not migrate). */
export function gitWorktreeState(workspace) {
  const res = gitSpawn(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (res.error) return 'unknown';
  if (res.status === 0 && String(res.stdout).trim() === 'true') return 'inside';
  const err = String(res.stderr || '');
  if (/not a git repository/i.test(err) || String(res.stdout).trim() === 'false') {
    return workspaceHasGitDir(workspace) ? 'unknown' : 'outside';
  }
  return 'unknown';
}

export function gitLsFiles(workspace, rel) {
  const state = gitWorktreeState(workspace);
  if (state === 'unknown') return { ok: false, files: [] };
  if (state === 'outside') return { ok: true, files: [] };
  const res = gitSpawn(workspace, ['ls-files', '-z', '--', rel]);
  if (res.error || res.status !== 0) return { ok: false, files: [] };
  const files = String(res.stdout || '')
    .split('\0')
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter(Boolean);
  return { ok: true, files };
}

export function gitHasTrackedFiles(workspace, rel) {
  const listed = gitLsFiles(workspace, rel);
  return listed.ok && listed.files.length > 0;
}

/** New plans live outside the repo so a reset or another commit cannot drop them. */
export const EXTERNAL_PLANS_REL = 'plans';

export function plansWriteTarget(workspace, { home } = {}) {
  return {
    base: projectStoreDir(workspace, { home }),
    dirRel: EXTERNAL_PLANS_REL,
    kind: 'user',
  };
}

export function externalPlansDir(workspace, { home } = {}) {
  const target = plansWriteTarget(workspace, { home });
  return path.join(target.base, target.dirRel);
}

/** @deprecated Writers use plansWriteTarget. Kept so older callers still name the in-repo session folder. */
export function plansWriteRel() {
  return EXTERNAL_PLANS_REL;
}

export function plansReadRels(workspace) {
  const rels = [];
  if (dirExists(workspace, WORKSPACE_PLANS_REL)) rels.push(WORKSPACE_PLANS_REL);
  if (dirExists(workspace, SESSION_PLANS_REL)) rels.push(SESSION_PLANS_REL);
  return rels;
}

/** Absolute plan directories. Includes the external project store when it exists. */
export function planReadDirs(workspace, { home } = {}) {
  const dirs = [];
  for (const rel of plansReadRels(workspace)) {
    const full = path.join(workspace, rel);
    try {
      if (!fs.lstatSync(full).isSymbolicLink()) dirs.push({ dir: full, label: rel });
    } catch {
      // disappeared between the existence check and the stat
    }
  }
  const external = externalPlansDir(workspace, { home });
  try {
    const st = fs.lstatSync(external);
    if (st.isDirectory() && !st.isSymbolicLink()) dirs.push({ dir: external, label: external });
  } catch {
    // no external plans yet
  }
  return dirs;
}

export function isPlanRel(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return true;
  return (
    normalized.startsWith(`${WORKSPACE_PLANS_REL}/`) ||
    normalized.startsWith(`${SESSION_PLANS_REL}/`) ||
    normalized.startsWith(`${EXTERNAL_PLANS_REL}/`)
  );
}

export function planBasename(rel) {
  return path.posix.basename(String(rel || '').replace(/\\/g, '/'));
}

export function isCanonicalPlanName(name) {
  return PLAN_FILE.test(String(name || ''));
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a --plan argument. Legacy docs/plans and .harness/plans stay readable.
 * A basename with no legacy file resolves to the external project store.
 */
export function normalizePlanRel(workspace, planPath, { home } = {}) {
  if (!planPath || typeof planPath !== 'string') return null;
  const external = externalPlansDir(workspace, { home });
  if (path.isAbsolute(planPath)) {
    const resolved = path.resolve(planPath);
    try {
      const full = fs.realpathSync(resolved);
      const root = fs.existsSync(external) ? fs.realpathSync(external) : path.resolve(external);
      if (contained(root, full) && /\.(?:md|hplan)$/.test(full)) return full;
    } catch {
      if (contained(path.resolve(external), resolved) && /\.(?:md|hplan)$/.test(resolved)) return resolved;
    }
  }
  const root = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
  const full = path.resolve(root, planPath);
  const rel = path.relative(root, full).replace(/\\/g, '/');
  if (!rel.startsWith('..') && !path.isAbsolute(rel) && /\.(?:md|hplan)$/.test(rel) && isPlanRel(rel) && !rel.startsWith(`${EXTERNAL_PLANS_REL}/`)) {
    if (fileExists(workspace, rel)) return rel;
  }
  if (path.isAbsolute(planPath)) return null;
  const base = path.posix.basename((/\.(?:md|hplan)$/.test(rel) ? rel : `${path.posix.basename(planPath)}.md`).replace(/\\/g, '/'));
  if (!/\.(?:md|hplan)$/.test(base)) return null;
  for (const dirRel of plansReadRels(workspace)) {
    const candidate = `${dirRel}/${base}`;
    if (fileExists(workspace, candidate)) return candidate;
  }
  const outside = path.join(external, base);
  if (fs.existsSync(outside)) return outside;
  return outside;
}

export function listPlanRels(workspace, { home } = {}) {
  const seen = new Set();
  const out = [];
  const take = (dir, nameFor) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(?:md|hplan)$/.test(f) || f.startsWith('_') || f === 'README.md') continue;
      if (f.endsWith('.md') && planConversionPublished(workspace, path.join(dir, f), { home })) continue;
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(nameFor(f));
    }
  };
  for (const dirRel of plansReadRels(workspace)) {
    take(path.join(workspace, dirRel), (f) => `${dirRel}/${f}`);
  }
  take(externalPlansDir(workspace, { home }), (f) => path.join(externalPlansDir(workspace, { home }), f));
  return out;
}

export function agentContextRel(workspace, { home } = {}) {
  if (fileExists(workspace, WORKSPACE_AGENT_CTX_REL)) return WORKSPACE_AGENT_CTX_REL;
  if (fileExists(workspace, SESSION_AGENT_CTX_REL)) return SESSION_AGENT_CTX_REL;
  const external = path.join(projectStoreDir(workspace, { home }), 'agent-context.md');
  if (fs.existsSync(external)) return external;
  return external;
}

export function codebaseMapWriteRel(workspace) {
  if (fileExists(workspace, WORKSPACE_MAP_REL)) return WORKSPACE_MAP_REL;
  const listed = gitLsFiles(workspace, WORKSPACE_PLANS_REL);
  if (!listed.ok && dirExists(workspace, WORKSPACE_PLANS_REL)) return WORKSPACE_MAP_REL;
  if (listed.ok && listed.files.length > 0) return WORKSPACE_MAP_REL;
  return SESSION_MAP_REL;
}

/** New episodes always go to the external project store. Tracked docs/solutions stay readable. */
export function solutionsWriteTarget(workspace, { home } = {}) {
  return {
    base: projectStoreDir(workspace, { home }),
    dirRel: WORKSPACE_SOLUTIONS_REL,
    kind: 'user',
  };
}

export function solutionsScanRoots(workspace, { home } = {}) {
  const roots = [];
  const ws = path.join(workspace, WORKSPACE_SOLUTIONS_REL);
  if (fs.existsSync(ws)) roots.push({ dir: ws, base: path.resolve(workspace), kind: 'workspace' });
  const overlay = projectStoreDir(workspace, { home });
  const user = path.join(overlay, WORKSPACE_SOLUTIONS_REL);
  if (fs.existsSync(user)) roots.push({ dir: user, base: overlay, kind: 'user' });
  return roots;
}

/**
 * Roots that may contain an episode relative path such as
 * `docs/solutions/<category>/<file>.md` or a global `solutions/...` path.
 * Workspace first, then copilotHome/knowledge, then the user project store.
 */
export function episodeResolveRoots(workspace, { home, copilotHome } = {}) {
  const roots = [path.resolve(workspace)];
  if (copilotHome) {
    const globalRoot = path.resolve(copilotHome, 'knowledge');
    if (!roots.includes(globalRoot)) roots.push(globalRoot);
  }
  const overlay = path.resolve(projectStoreDir(workspace, { home }));
  if (!roots.includes(overlay)) roots.push(overlay);
  return roots;
}

export function episodeAbsPath(workspace, rel, { home } = {}) {
  return path.join(solutionsWriteTarget(workspace, { home }).base, rel);
}

export function artifactSearchRoots(workspace, { home, copilotHome } = {}) {
  const roots = [];
  if (copilotHome) roots.push(path.join(copilotHome, 'knowledge'));
  roots.push(path.resolve(workspace));
  roots.push(path.join(workspace, 'knowledge'));
  roots.push(projectStoreDir(workspace, { home }));
  return [...new Set(roots)];
}
