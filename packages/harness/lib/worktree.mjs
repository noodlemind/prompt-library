import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT } from './style.mjs';
import { deriveGitContext, resolveDefaultBranch } from './git-context.mjs';
import { appendFileContained, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { externalPlansDir, SESSION_PLANS_REL, WORKSPACE_PLANS_REL } from './project-layout.mjs';
import { linkedPrimaryCheckout } from './knowledge/store.mjs';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CI_TRUE = new Set(['1', 'true', 'TRUE', 'yes', 'YES']);

function gitOut(cwd, args) {
  try {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 });
    return res.status === 0 ? String(res.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

function usage(message) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint: 'harness help worktree' });
}

function isLinkedWorktree(workspace) {
  return linkedPrimaryCheckout(workspace) != null;
}

function primaryRoot(workspace) {
  return linkedPrimaryCheckout(workspace) || workspace;
}

function currentBranch(workspace) {
  return gitOut(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

function originDefaultName(workspace) {
  const originHead = gitOut(workspace, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (!originHead || !originHead.startsWith('refs/remotes/origin/')) return null;
  return originHead.slice('refs/remotes/origin/'.length);
}

function ensureWorktreeIgnore(root) {
  const rel = '.gitignore';
  const gitignore = path.join(root, rel);
  const line = '.worktrees\n';
  let stat = null;
  try {
    stat = fs.lstatSync(gitignore);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) return;
  if (!stat) {
    writeFileContained(root, rel, line);
    return;
  }
  if (!stat.isFile()) return;
  const text = readFileNoFollow(gitignore, { root });
  if (text == null) return;
  const lines = text.split(/\r?\n/);
  if (lines.some((entry) => entry === '.worktrees' || entry === '.worktrees/')) return;
  appendFileContained(root, rel, line, { newlineGuard: true });
}

function carryCheckoutPlans(primary, dest) {
  const storeRoot = path.dirname(externalPlansDir(primary));
  for (const rel of [WORKSPACE_PLANS_REL, SESSION_PLANS_REL]) {
    const dir = path.join(primary, rel);
    let names = [];
    try {
      const dirStat = fs.lstatSync(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md') || name.startsWith('_') || name === 'README.md') continue;
      const src = path.join(dir, name);
      let srcStat = null;
      try {
        srcStat = fs.lstatSync(src);
      } catch {
        continue;
      }
      if (!srcStat.isFile()) continue;
      const destFile = path.join(dest, rel, name);
      try {
        if (fs.lstatSync(destFile).isFile()) continue;
      } catch {
        // The new checkout does not have this plan.
      }
      const target = path.join(storeRoot, 'plans', name);
      const text = readFileNoFollow(src, { root: primary });
      if (text == null) continue;
      let storeStat = null;
      try {
        storeStat = fs.lstatSync(target);
      } catch {
        storeStat = null;
      }
      if (storeStat) {
        if (!storeStat.isFile()) continue;
        const existing = readFileNoFollow(target, { root: storeRoot });
        if (existing == null || existing === text || !(srcStat.mtimeMs > storeStat.mtimeMs)) continue;
      }
      writeFileContained(storeRoot, path.join('plans', name), text);
    }
  }
}

function resolveStartPoint(workspace, from) {
  if (from) return from;
  const def = resolveDefaultBranch(workspace);
  if (def?.name) {
    if (gitOut(workspace, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${def.name}^{commit}`])) {
      return `origin/${def.name}`;
    }
    if (gitOut(workspace, ['rev-parse', '--verify', '--quiet', `refs/heads/${def.name}^{commit}`])) {
      return def.name;
    }
  }
  return 'HEAD';
}

export function planSlugFromPath(planPath) {
  const base = path.posix.basename(String(planPath || '').replace(/\\/g, '/'));
  const match = base.match(/^\d{4}-\d{2}-\d{2}-(?:feat|fix|docs|refactor|chore)-(.+)-plan\.md$/);
  return match ? match[1] : 'issue';
}

export function inspectIsolation({ workspace, home, env = process.env, allowInplace = false } = {}) {
  const ctx = deriveGitContext({ workspace, home });
  if (!ctx.worktree) {
    return {
      blocked: false,
      linked: false,
      onDefault: false,
      isolated: false,
      branch: null,
      defaultBranch: null,
      skipReason: 'not-git',
    };
  }
  const linked = isLinkedWorktree(workspace);
  // A knowledge-store defaultBranch is not origin/HEAD. No remote means the checkout stays editable.
  const originDefault = originDefaultName(workspace);
  const onDefault = Boolean(originDefault && ctx.branch && ctx.branch === originDefault);
  const ci = CI_TRUE.has(String(env.CI || ''));
  const inplace = allowInplace || env.HARNESS_ALLOW_INPLACE === '1';
  let skipReason = null;
  if (ci) skipReason = 'ci';
  else if (inplace) skipReason = 'allow-inplace';
  else if (!originDefault) skipReason = 'no-default-branch';
  else if (!onDefault) skipReason = 'feature-branch';
  else if (linked) skipReason = 'linked-worktree';
  const blocked = skipReason === null;
  return {
    blocked,
    linked,
    onDefault,
    isolated: linked && !onDefault,
    branch: ctx.branch,
    defaultBranch: originDefault,
    skipReason: blocked ? null : skipReason,
  };
}

export function addIsolatedWorktree({ workspace, slug, from, dryRun = false } = {}) {
  if (!slug || !SLUG_RE.test(slug)) {
    throw usage('worktree: --slug is required and must be lowercase-hyphen (a-z0-9-)');
  }
  const ctx = deriveGitContext({ workspace });
  if (!ctx.worktree) throw usage('worktree: workspace is not a git checkout');
  const root = primaryRoot(workspace);
  const dest = path.join(root, '.worktrees', slug);
  const branch = `harness/${slug}`;
  const start = resolveStartPoint(workspace, from);
  if (dryRun) {
    return { path: dest, branch, created: false, isolated: true, dryRun: true };
  }
  ensureWorktreeIgnore(root);
  if (fs.existsSync(dest)) {
    let destReal = dest;
    try {
      destReal = fs.realpathSync(dest);
    } catch {
      destReal = path.resolve(dest);
    }
    const listed = gitOut(root, ['worktree', 'list', '--porcelain']) || '';
    const listedHit = listed.split('\n').some((line) => {
      if (!line.startsWith('worktree ')) return false;
      const entry = line.slice('worktree '.length);
      try {
        return fs.realpathSync(entry) === destReal;
      } catch {
        return path.resolve(entry) === destReal;
      }
    });
    if (listedHit || isLinkedWorktree(dest)) {
      carryCheckoutPlans(root, dest);
      return { path: dest, branch: currentBranch(dest) || branch, created: false, isolated: true };
    }
    throw usage(`worktree: ${dest} exists and is not a worktree`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const branchExists = Boolean(gitOut(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]));
  const args = branchExists
    ? ['worktree', 'add', dest, branch]
    : ['worktree', 'add', '-b', branch, dest, start];
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15_000 });
  if (res.status !== 0) {
    throw Object.assign(new Error(`worktree: git worktree add failed: ${(res.stderr || res.stdout || '').trim()}`), {
      exit: 1,
    });
  }
  carryCheckoutPlans(root, dest);
  return { path: dest, branch, created: true, isolated: true };
}

export function worktreeGateMessage(isolation) {
  if (isolation.blocked) {
    return 'Do not edit the current branch in place. Run `harness worktree --slug <issue-slug>` and continue with --workspace <path>. Pass --allow-inplace to override.';
  }
  if (isolation.isolated) return 'issue worktree isolated';
  if (isolation.skipReason === 'ci') return 'worktree isolation skipped (CI)';
  if (isolation.skipReason === 'allow-inplace') return 'worktree isolation skipped (--allow-inplace)';
  if (isolation.skipReason === 'feature-branch') return 'worktree isolation skipped (non-default branch)';
  if (isolation.skipReason === 'linked-worktree') return 'worktree isolation skipped (linked worktree)';
  if (isolation.skipReason === 'no-default-branch') return 'worktree isolation skipped (no default branch)';
  return 'worktree isolation skipped';
}
