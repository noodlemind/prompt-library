/**
 * Workspace + copilot-home fixture layout for harness tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp.mjs';

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
