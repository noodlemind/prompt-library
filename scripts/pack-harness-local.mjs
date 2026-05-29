#!/usr/bin/env node
/**
 * Build a local npm tarball for @dev-kit/harness.
 *
 * The npm tarball is a gzip-compressed tar archive (.tgz). Share the generated
 * file with testers, who can install it with: npm install -g ./file.tgz
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const packageRoot = path.join(repoRoot, 'packages', 'harness');
const distRoot = path.join(packageRoot, 'dist');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(distRoot, { recursive: true });

const result = spawnSync(npmBin, ['pack', '--pack-destination', distRoot], {
  cwd: packageRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const tarballs = fs
  .readdirSync(distRoot)
  .filter((name) => name.endsWith('.tgz'))
  .sort();

if (tarballs.length === 0) {
  console.error(`No npm tarball was created in ${distRoot}`);
  process.exit(1);
}

const tarballPath = path.join(distRoot, tarballs[tarballs.length - 1]);
console.log('');
console.log(`Local harness package ready: ${tarballPath}`);
console.log(`Install test: npm install -g "${tarballPath}"`);
