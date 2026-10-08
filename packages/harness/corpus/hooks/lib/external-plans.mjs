import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorityBin } from './authority-bin.mjs';

let layout = null;
for (const bin of new Set([authorityBin(), authorityBin({ includeOverride: false })].filter(Boolean))) {
  try {
    layout = await import(pathToFileURL(path.resolve(path.dirname(bin), '../lib/project-layout.mjs')).href);
    break;
  } catch { /* a diagnostic CLI override may have no runtime modules */ }
}

/** Same root the CLI uses. HARNESS_HOME wins over ~/.harness. */
export function harnessHome() {
  if (process.env.HARNESS_HOME) return path.resolve(process.env.HARNESS_HOME);
  return path.join(os.homedir(), '.harness');
}

export function externalPlansDir(workspace) {
  if (!layout) throw new Error('Harness project-layout authority is unavailable; upgrade Harness');
  return layout.externalPlansDir(workspace);
}

function isDirectory(full) {
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

export function planRoots(workspace) {
  const roots = [];
  for (const rel of ['docs/plans', '.harness/plans']) {
    const full = path.join(workspace, rel);
    if (isDirectory(full)) roots.push(full);
  }
  const external = externalPlansDir(workspace);
  if (isDirectory(external)) roots.push(external);
  return roots;
}

/** Workspace-relative posix path, or the absolute path when target is outside the workspace. */
export function planDisplayPath(workspace, target) {
  const relative = path.relative(workspace, target);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return target;
}

/** Real path of a plan that lives in a legacy dir or the external project store. */
export function resolveAcceptedPlan(workspace, planPath) {
  let candidate;
  try {
    candidate = fs.realpathSync.native(path.resolve(workspace, planPath));
  } catch {
    return null;
  }
  for (const root of planRoots(workspace)) {
    let plansRoot;
    try {
      plansRoot = fs.realpathSync.native(root);
    } catch {
      continue;
    }
    const relative = path.relative(plansRoot, candidate);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    return candidate;
  }
  return null;
}
