import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT } from './style.mjs';
import { deriveGitContext, resolveDefaultBranch } from './git-context.mjs';

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
  try {
    return fs.lstatSync(path.join(workspace, '.git')).isFile();
  } catch {
    return false;
  }
}

function primaryRoot(workspace) {
  const raw = gitOut(workspace, ['rev-parse', '--git-common-dir']);
  if (!raw) return workspace;
  return path.dirname(path.resolve(workspace, raw));
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
  const gitignore = path.join(root, '.gitignore');
  const line = '.worktrees';
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, `${line}\n`);
    return;
  }
  const text = fs.readFileSync(gitignore, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.some((entry) => entry === '.worktrees' || entry === '.worktrees/')) return;
  const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gitignore, `${sep}${line}\n`);
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
