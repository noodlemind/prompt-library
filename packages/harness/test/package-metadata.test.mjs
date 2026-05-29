import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package-lock.json'), 'utf8'));

test('npm package metadata builds and ships harness assets', () => {
  assert.equal(packageJson.name, '@dev-kit/harness');
  assert.equal(packageJson.bin.harness, './bin/harness.mjs');
  assert.ok(packageJson.files.includes('assets'));
  assert.equal(packageJson.scripts.prepare, 'npm run build:assets');
  assert.equal(packageJson.scripts.prepack, 'npm run build:assets');
  assert.equal(packageJson.scripts.prepublishOnly, 'npm run build:assets');
  assert.equal(packageJson.scripts['pack:local'], 'node ../../scripts/pack-harness-local.mjs');
});

test('package lock version stays aligned with package version', () => {
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
});
