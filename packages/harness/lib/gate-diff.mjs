import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_LINES = 50;
const LARGE_FILE_LOC = 200;
const REWRITE_RATIO = 0.4;

function gitOk(workspace) {
  const gitDir = path.join(workspace, '.git');
  return fs.existsSync(gitDir);
}

function runGit(workspace, args) {
  return execSync(`git ${args}`, {
    cwd: workspace,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function parseImpactedFiles(text) {
  if (!text) return [];
  const paths = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*]\s+`?([^`\s]+)`?/);
    if (m) paths.push(normalizePath(m[1]));
  }
  return paths;
}

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseNumstat(workspace) {
  let out = '';
  try {
    out = runGit(workspace, 'diff --numstat HEAD');
    if (!out) out = runGit(workspace, 'diff --numstat');
  } catch {
    return [];
  }
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [add, del, file] = line.split('\t');
      return {
        file: normalizePath(file),
        add: parseInt(add, 10) || 0,
        del: parseInt(del, 10) || 0,
      };
    });
}

function fileLineCount(workspace, rel) {
  try {
    const fromGit = runGit(workspace, `show HEAD:${rel}`);
    return fromGit.split('\n').length;
  } catch {
    const full = path.join(workspace, rel);
    if (fs.existsSync(full)) {
      return fs.readFileSync(full, 'utf8').split('\n').length;
    }
    return 0;
  }
}

/**
 * E1–E3 diff advisories for implement phase. Requires git repo unless skipped.
 */
export function runDiffAdvisories({ workspace, plan, flags, autonomy }) {
  const checks = [];
  if (flags.noGit || !gitOk(workspace)) {
    checks.push({
      id: 'E0',
      pass: true,
      message: flags.noGit ? 'Diff checks skipped (--no-git)' : 'Diff checks skipped (not a git repo)',
      severity: 'ok',
    });
    return { checks, exitCode: 0 };
  }

  const stats = parseNumstat(workspace);
  if (!stats.length) {
    checks.push({
      id: 'E0',
      pass: true,
      message: 'No uncommitted diff — diff advisories skipped',
      severity: 'ok',
    });
    return { checks, exitCode: 0 };
  }

  const editStrategy = (plan?.fm?.edit_strategy || 'patch').toLowerCase();
  const maxLines = parseInt(plan?.fm?.max_lines_changed, 10) || DEFAULT_MAX_LINES;
  const impacted = parseImpactedFiles(plan?.sections?.impactedFilesText || '');
  const strict = autonomy === 'strict';

  const totalChanged = stats.reduce((n, s) => n + s.add + s.del, 0);

  // E1 — total lines vs max_lines_changed
  if (plan?.fm?.max_lines_changed != null && String(plan.fm.max_lines_changed).trim() !== '') {
    const ok = totalChanged <= maxLines;
    checks.push({
      id: 'E1',
      pass: ok,
      message: ok
        ? `Diff ${totalChanged} lines ≤ max_lines_changed ${maxLines}`
        : `Diff ${totalChanged} lines exceeds max_lines_changed ${maxLines}`,
      severity: ok ? 'ok' : strict ? 'fail' : 'warn',
    });
  } else {
    checks.push({
      id: 'E1',
      pass: true,
      message: 'max_lines_changed not set — E1 skipped',
      severity: 'ok',
    });
  }

  // E2 — files ⊆ Impacted Files
  if (impacted.length) {
    const outside = stats.map((s) => s.file).filter((f) => !impacted.some((i) => f === i || f.endsWith(i)));
    const ok = outside.length === 0;
    checks.push({
      id: 'E2',
      pass: ok,
      message: ok
        ? 'All changed files listed in ## Impacted Files'
        : `Changed files outside plan: ${outside.join(', ')}`,
      severity: ok ? 'ok' : strict ? 'fail' : 'warn',
    });
  } else {
    checks.push({
      id: 'E2',
      pass: true,
      message: '## Impacted Files empty — E2 skipped',
      severity: 'ok',
    });
  }

  // E3 — per-file rewrite ratio
  const rewriteFiles = [];
  for (const s of stats) {
    const lines = fileLineCount(workspace, s.file);
    if (lines < LARGE_FILE_LOC) continue;
    const ratio = (s.add + s.del) / Math.max(lines, 1);
    if (ratio > REWRITE_RATIO && editStrategy !== 'refactor') {
      rewriteFiles.push(`${s.file} (~${Math.round(ratio * 100)}%)`);
    }
  }
  const e3ok = rewriteFiles.length === 0;
  checks.push({
    id: 'E3',
    pass: e3ok,
    message: e3ok
      ? 'No large-file rewrite pattern detected'
      : `Large-file churn without edit_strategy refactor: ${rewriteFiles.join('; ')}`,
    severity: e3ok ? 'ok' : strict ? 'fail' : 'warn',
  });

  let exitCode = 0;
  for (const c of checks) {
    if (!c.pass && c.severity === 'warn') exitCode = Math.max(exitCode, 2);
    if (!c.pass && c.severity === 'fail') exitCode = 1;
  }
  return { checks, exitCode };
}
