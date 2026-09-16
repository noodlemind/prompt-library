/**
 * Workspace + copilot-home fixture layout for harness tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp.mjs';
import { git } from './store.mjs';

/**
 * @param {{ prefix?: string, workspacePrefix?: string, homePrefix?: string }} [opts]
 * @returns {{ workspace: string, copilotHome: string, ws: string, home: string }}
 */
export function makeScopes(opts = {}) {
  const workspace = tempDir(opts.workspacePrefix || opts.prefix || 'harness-ws-');
  const copilotHome = tempDir(opts.homePrefix || 'harness-home-');
  return {
    workspace,
    copilotHome,
    /** short aliases used by many knowledge tests */
    ws: workspace,
    home: copilotHome,
  };
}

/**
 * Ensure common workspace subdirs exist (docs/plans, .harness).
 * @param {string} workspace
 * @param {{ plans?: boolean, harness?: boolean }} [opts]
 */
export function ensureWorkspaceLayout(workspace, opts = {}) {
  if (opts.plans !== false) {
    fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  }
  if (opts.harness !== false) {
    fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  }
  return workspace;
}

/**
 * Make `docs/solutions` a git-tracked write root. Also points origin/HEAD at
 * the current branch so knowledge writes stay on the golden layer instead of
 * a branch bucket (no origin/HEAD → resolveDefaultBranch is null).
 */
export function trackWorkspaceSolutions(ws) {
  const keep = path.join(ws, 'docs', 'solutions', '.gitkeep');
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  if (!fs.existsSync(path.join(ws, '.git'))) {
    git(ws, ['init', '-q', '-b', 'main']);
    git(ws, ['config', 'user.email', 't@t']);
    git(ws, ['config', 'user.name', 't']);
  }
  git(ws, ['add', 'docs/solutions/.gitkeep']);
  if (git(ws, ['diff', '--cached', '--quiet']).status !== 0) {
    git(ws, ['commit', '-qm', 'track solutions']);
  }
  const branch = (git(ws, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout || 'main').trim() || 'main';
  git(ws, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD']);
  git(ws, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]);
  return ws;
}
