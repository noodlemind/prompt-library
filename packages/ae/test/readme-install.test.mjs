import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function firstInstallCommand(rel) {
  const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const section = text.split(/^## /m).slice(1).find((part) => part.startsWith('Install') || part.startsWith('Adaptive Engineering') === false && part.includes('npm install'));
  const install = rel.endsWith('README.md')
    ? text.split(/^## Install\s*$/m)[1].split(/^## /m)[0]
    : text.split(/^```bash$/m)[1];
  const body = rel.endsWith('README.md')
    ? install.match(/```bash\n([\s\S]*?)```/)[1]
    : install.split('```')[0];
  const command = body.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
  assert.ok(command, `${rel} has no install command`);
  return command;
}

test('the documented install command installs this checkout and is not the unpublished registry package', { timeout: 180_000 }, () => {
  const readme = firstInstallCommand('packages/ae/README.md');
  const concept = firstInstallCommand('docs/adaptive-engineering.md');
  assert.equal(readme, 'npm install -g ./packages/ae');
  assert.equal(concept, 'npm install -g ./packages/ae');
  assert.doesNotMatch(readme, /ae-harness@/);

  const prefix = tempDir('readme-install-');
  const home = tempDir('readme-install-home-');
  const cache = tempDir('readme-install-cache-');
  execFileSync('npm', ['install', '-g', './packages/ae'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      npm_config_prefix: prefix,
      npm_config_cache: cache,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    },
    stdio: 'pipe',
  });
  const bin = path.join(prefix, 'bin', 'ae');
  assert.equal(fs.existsSync(bin), true, `install did not create ${bin}`);
  const version = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim();
  const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/ae/package.json'), 'utf8')).version;
  assert.equal(version, expected);
});
