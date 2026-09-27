import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Same root the CLI uses. HARNESS_HOME wins over ~/.harness. */
export function harnessHome() {
  if (process.env.HARNESS_HOME) return path.resolve(process.env.HARNESS_HOME);
  return path.join(os.homedir(), '.harness');
}

function gitOut(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  return res.status === 0 ? res.stdout.trim() : null;
}

function localRepoId(workspace) {
  let real = workspace;
  try {
    real = fs.realpathSync(workspace);
  } catch {
    // keep the given path
  }
  return `local-${crypto.createHash('sha256').update(real).digest('hex').slice(0, 12)}`;
}

/** Keep this identical to packages/harness/lib/knowledge/store.mjs repoId. */
export function repoId(workspace) {
  const remote = gitOut(workspace, ['remote', 'get-url', 'origin']);
  if (remote) {
    const canonical = remote
      .trim()
      .replace(/\.git$/, '')
      .replace(/^[a-z+]+:\/\//i, '')
      .replace(/^[^@/]+@/, '')
      .replace(/:/g, '/')
      .toLowerCase();
    const slug = canonical.replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) {
      const suffix = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
      return `${slug}-${suffix}`;
    }
  }
  return localRepoId(workspace);
}

export function externalPlansDir(workspace) {
  return path.join(harnessHome(), 'projects', repoId(workspace), 'plans');
}

export function planRoots(workspace) {
  const roots = [];
  for (const rel of ['docs/plans', '.harness/plans']) {
    const full = path.join(workspace, rel);
    if (fs.existsSync(full)) roots.push(full);
  }
  const external = externalPlansDir(workspace);
  if (fs.existsSync(external)) roots.push(external);
  return roots;
}

/** Real path of a plan that lives in a legacy dir or the external project store. */
export function resolveAcceptedPlan(workspace, planPath) {
  let candidate;
  try {
    candidate = fs.realpathSync(path.resolve(workspace, planPath));
  } catch {
    return null;
  }
  for (const root of planRoots(workspace)) {
    let plansRoot;
    try {
      plansRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    const relative = path.relative(plansRoot, candidate);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    return candidate;
  }
  return null;
}
