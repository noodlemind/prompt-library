import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('npm pack tarball includes bundled assets for registry and local install', () => {
  const packDir = tempDir('harness-pack-');
  execSync('npm pack --pack-destination .', {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const version = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  ).version;
  const tgzName = `dev-kit-harness-${version}.tgz`;
  const produced = path.join(packageRoot, tgzName);
  const tgzPath = path.join(packDir, tgzName);
  fs.renameSync(produced, tgzPath);

  const listing = execSync(`tar -tzf "${tgzPath}"`, { encoding: 'utf8' });
  assert.match(listing, /package\/assets\/skills\/engineer\/SKILL\.md/);

  const prefix = path.join(packDir, 'install-prefix');
  execSync(`npm install --prefix "${prefix}" "${tgzPath}"`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bundledSkill = path.join(
    prefix,
    'node_modules',
    '@dev-kit',
    'harness',
    'assets',
    'skills',
    'engineer',
    'SKILL.md'
  );
  assert.equal(fs.existsSync(bundledSkill), true);

  const copilotHome = path.join(packDir, 'copilot-home');
  fs.mkdirSync(copilotHome, { recursive: true });
  const harnessBin = path.join(
    prefix,
    'node_modules',
    '@dev-kit',
    'harness',
    'bin',
    'harness.mjs'
  );
  const install = spawnSync(
    process.execPath,
    [harnessBin, 'install', '--configure-vscode', '--copilot-home', copilotHome, '--dry-run'],
    { encoding: 'utf8', env: { ...process.env, HOME: packDir } }
  );
  assert.equal(install.status, 0, install.stderr || install.stdout);
});
