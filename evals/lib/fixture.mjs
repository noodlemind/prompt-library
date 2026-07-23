/**
 * Materialize a persistent sample repo (evals/fixtures/<name>) into an isolated
 * temp git workspace so a run's mutations are real and diffable against a clean
 * baseline. With HARNESS_EVAL_KEEP set, the workspace is preserved after the run
 * and its `git diff` is printed, so edits can be validated by eye.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function materializeFixture(name) {
  const src = path.join(fixturesRoot, name);
  if (!fs.existsSync(src)) throw new Error(`fixture not found: ${name}`);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `harness-fx-${name}-`));
  fs.cpSync(src, ws, { recursive: true });
  const git = (args) =>
    spawnSync('git', args, {
      cwd: ws,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  git(['add', '.']);
  git(['commit', '-qm', 'fixture baseline']);
  return ws;
}

/** Delete the workspace, unless HARNESS_EVAL_KEEP — then keep it and print the diff. */
export function finalizeWorkspace(ws, label = 'run') {
  if (!process.env.HARNESS_EVAL_KEEP) {
    fs.rmSync(ws, { recursive: true, force: true });
    return null;
  }
  const diff = spawnSync('git', ['-C', ws, 'diff'], { encoding: 'utf8' }).stdout || '';
  const status = spawnSync('git', ['-C', ws, 'status', '--short'], { encoding: 'utf8' }).stdout || '';
  console.log(`\n[keep] ${label} workspace: ${ws}`);
  console.log(`[keep] git status:\n${status || '  (clean)'}`);
  console.log(`[keep] git diff (validated mutation):\n${diff || '  (no tracked-file changes)'}`);
  return ws;
}
