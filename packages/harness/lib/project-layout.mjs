import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from './paths.mjs';
import { repoId } from './knowledge/store.mjs';

/** Committed change-contract location (this library, teams that check plans in). */
export const WORKSPACE_PLANS_REL = 'docs/plans';
/** Session-local plans for app repos that gitignore harness artifacts. */
export const SESSION_PLANS_REL = '.harness/plans';
export const WORKSPACE_SOLUTIONS_REL = 'docs/solutions';
export const WORKSPACE_MAP_REL = 'docs/codebase-map.md';
export const SESSION_MAP_REL = '.harness/codebase-map.md';
export const WORKSPACE_AGENT_CTX_REL = 'docs/agent-context.md';
export const SESSION_AGENT_CTX_REL = '.harness/agent-context.md';

const PLAN_FILE = /^\d{4}-\d{2}-\d{2}-(?:feat|fix|docs|refactor|chore)-[a-z0-9]+(?:-[a-z0-9]+)*-plan\.md$/;

export function projectStoreDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'projects', repoId(workspace));
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
    return spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 10_000 });
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

/**
 * Where to write new plans: keep using committed docs/plans when git tracks
 * that directory; otherwise use gitignored .harness/plans. If git cannot be
 * probed, keep an existing docs/plans directory so we never switch write
 * root and then delete committed files.
 */
export function plansWriteRel(workspace) {
  const listed = gitLsFiles(workspace, WORKSPACE_PLANS_REL);
  if (!listed.ok) {
    return dirExists(workspace, WORKSPACE_PLANS_REL) ? WORKSPACE_PLANS_REL : SESSION_PLANS_REL;
  }
  return listed.files.length > 0 ? WORKSPACE_PLANS_REL : SESSION_PLANS_REL;
}

export function plansReadRels(workspace) {
  const rels = [];
  if (dirExists(workspace, WORKSPACE_PLANS_REL)) rels.push(WORKSPACE_PLANS_REL);
  if (dirExists(workspace, SESSION_PLANS_REL)) rels.push(SESSION_PLANS_REL);
  if (rels.length === 0) rels.push(plansWriteRel(workspace));
  return rels;
}

export function isPlanRel(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/');
  return (
    normalized.startsWith(`${WORKSPACE_PLANS_REL}/`) || normalized.startsWith(`${SESSION_PLANS_REL}/`)
  );
}

export function planBasename(rel) {
  return path.posix.basename(String(rel || '').replace(/\\/g, '/'));
}

export function isCanonicalPlanName(name) {
  return PLAN_FILE.test(String(name || ''));
}

/**
 * Resolve a --plan argument or session path to a workspace-relative plan path.
 * Accepts docs/plans/…, .harness/plans/…, or a basename.
 */
export function normalizePlanRel(workspace, planPath) {
  if (!planPath || typeof planPath !== 'string') return null;
  const root = path.resolve(workspace);
  const full = path.isAbsolute(planPath) ? path.resolve(planPath) : path.resolve(root, planPath);
  const rel = path.relative(root, full).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.endsWith('.md') && isPlanRel(rel)) return rel;
  const base = path.posix.basename(rel.endsWith('.md') ? rel : `${rel}.md`);
  if (!base.endsWith('.md')) return null;
  for (const dirRel of plansReadRels(workspace)) {
    const candidate = `${dirRel}/${base}`;
    if (fileExists(workspace, candidate)) return candidate;
  }
  return `${plansWriteRel(workspace)}/${base}`;
}

export function listPlanRels(workspace) {
  const seen = new Set();
  const out = [];
  for (const dirRel of plansReadRels(workspace)) {
    const dir = path.join(workspace, dirRel);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f.startsWith('_') || f === 'README.md') continue;
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(`${dirRel}/${f}`);
    }
  }
  return out;
}

export function agentContextRel(workspace) {
  if (fileExists(workspace, WORKSPACE_AGENT_CTX_REL)) return WORKSPACE_AGENT_CTX_REL;
  if (fileExists(workspace, SESSION_AGENT_CTX_REL)) return SESSION_AGENT_CTX_REL;
  return dirExists(workspace, 'docs') ? WORKSPACE_AGENT_CTX_REL : SESSION_AGENT_CTX_REL;
}

export function codebaseMapWriteRel(workspace) {
  if (fileExists(workspace, WORKSPACE_MAP_REL)) return WORKSPACE_MAP_REL;
  const listed = gitLsFiles(workspace, WORKSPACE_PLANS_REL);
  if (!listed.ok && dirExists(workspace, WORKSPACE_PLANS_REL)) return WORKSPACE_MAP_REL;
  if (listed.ok && listed.files.length > 0) return WORKSPACE_MAP_REL;
  return SESSION_MAP_REL;
}

/**
 * Episode write root. Existing docs/solutions stays the committed product
 * location. New app repos write under ~/.harness/projects/<repo-id>/ so the
 * working tree is not polluted.
 */
export function solutionsWriteTarget(workspace, { home } = {}) {
  if (dirExists(workspace, WORKSPACE_SOLUTIONS_REL)) {
    return { base: path.resolve(workspace), dirRel: WORKSPACE_SOLUTIONS_REL, kind: 'workspace' };
  }
  const overlay = projectStoreDir(workspace, { home });
  return { base: overlay, dirRel: WORKSPACE_SOLUTIONS_REL, kind: 'user' };
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
