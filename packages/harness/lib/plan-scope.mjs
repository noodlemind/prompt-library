import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function runGit(workspace, args) {
  return spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
}

function lines(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

export function parseImpactedFiles(plan) {
  return (plan.sections?.impactedFiles || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+`?([^`#]+?)`?\s*(?:#.*)?$/)?.[1]?.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, '').replace(/\\/g, '/'));
}

export function matchesScope(file, allowed) {
  return allowed.some((entry) => {
    if (entry.endsWith('/**')) return file === entry.slice(0, -3) || file.startsWith(entry.slice(0, -2));
    if (entry.endsWith('/')) return file.startsWith(entry);
    return file === entry;
  });
}

export function collectChangedFiles(workspace, base = null) {
  const inside = runGit(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { files: [], error: 'Workspace is not a git worktree; scope cannot be verified' };
  }

  const diffArgs = ['diff', '--name-only', '--diff-filter=ACMRDTUXB'];
  if (base) diffArgs.push(base);
  else if (fs.existsSync(path.join(workspace, '.git'))) diffArgs.push('HEAD');
  const diff = runGit(workspace, diffArgs);
  if (diff.status !== 0) return { files: [], error: diff.stderr.trim() || 'git diff failed' };

  const untracked = runGit(workspace, ['ls-files', '--others', '--exclude-standard']);
  if (untracked.status !== 0) return { files: [], error: untracked.stderr.trim() || 'git ls-files failed' };

  const files = [...new Set([...lines(diff.stdout), ...lines(untracked.stdout)])]
    .filter((file) => !file.startsWith('.harness/'))
    .sort();
  return { files, error: null };
}

export function validatePlanScope({ workspace, plan, base = null }) {
  const allowed = parseImpactedFiles(plan);
  const changed = collectChangedFiles(workspace, base);
  if (changed.error) return { status: 'inconclusive', allowed, changedFiles: [], violations: [], message: changed.error };
  if (allowed.length === 0) {
    return { status: 'failed', allowed, changedFiles: changed.files, violations: changed.files, message: 'No Impacted Files allowlist' };
  }
  const violations = changed.files.filter((file) => !matchesScope(file, allowed));
  return {
    status: violations.length ? 'failed' : 'passed',
    allowed,
    changedFiles: changed.files,
    violations,
    message: violations.length ? `${violations.length} changed files outside plan scope` : 'Changed files match plan scope',
  };
}
