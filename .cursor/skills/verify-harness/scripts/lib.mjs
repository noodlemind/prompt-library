import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approveProject } from '../../../../packages/harness/lib/trust.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const skillRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(skillRoot, '../../..');
export const packageRoot = path.join(repoRoot, 'packages/harness');
export const binPath = path.join(packageRoot, 'bin/harness.mjs');

const requireYaml = createRequire(path.join(packageRoot, 'package.json'));
export const YAML = requireYaml('yaml');

export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'harness-verify',
  GIT_AUTHOR_EMAIL: 'harness-verify@example.test',
  GIT_COMMITTER_NAME: 'harness-verify',
  GIT_COMMITTER_EMAIL: 'harness-verify@example.test',
};

export function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error('plan has no frontmatter');
  return YAML.parse(match[1]);
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function writeTracked(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  git(ws, ['add', '--', rel]);
  git(ws, ['commit', '-qm', `add ${rel}`]);
}

export function initWorkspace() {
  const ws = tempDir('verify-harness-ws-');
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'harness-verify@example.test']);
  git(ws, ['config', 'user.name', 'Harness Verify']);
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src/example.js'), 'export const value = 1;\n');
  fs.mkdirSync(path.join(ws, '.github/harness'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.github/harness/checks.yaml'),
    `version: 1\nchecks:\n  unit-tests:\n    command: ${JSON.stringify([process.execPath, '-e', 'process.exit(0)'])}\n`
  );
  git(ws, ['add', '.']);
  git(ws, ['commit', '-qm', 'baseline']);
  const home = tempDir('verify-harness-home-');
  const copilotHome = tempDir('verify-harness-copilot-');
  approveProject({ workspace: ws, copilotHome, home });
  return { ws, home, copilotHome };
}

export function runHarness(args, { ws, home, copilotHome, env = {} }) {
  const full = [...args, '--workspace', ws, '--copilot-home', copilotHome, '--json'];
  return spawnSync(process.execPath, [binPath, ...full], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...GIT_ENV,
      CI: '',
      HARNESS_ALLOW_INPLACE: '',
      HARNESS_HOME: home,
      ...env,
    },
  });
}

export function writeEvidence(feature, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(skillRoot, 'evidence', feature);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${stamp}.json`);
  fs.writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`);
  const artifactsRoot = '/opt/cursor/artifacts';
  let copied = null;
  if (fs.existsSync(artifactsRoot)) {
    copied = path.join(artifactsRoot, `verify-harness-${feature}-${stamp}.json`);
    fs.copyFileSync(dest, copied);
  }
  return { dest, copied };
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertMatch(actual, re, label) {
  if (!re.test(String(actual || ''))) {
    throw new Error(`${label}: ${JSON.stringify(actual)} did not match ${re}`);
  }
}

export function cleanup(dirs) {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
