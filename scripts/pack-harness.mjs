#!/usr/bin/env node
/**
 * Build bundled assets and create an npm tarball for local distribution or Nexus publish.
 *
 * Output: packages/harness/dist/dev-kit-harness-<version>.tgz
 *
 * Testers:
 *   npm install -g ./packages/harness/dist/dev-kit-harness-0.4.0.tgz
 *   harness install --configure-vscode --autonomy balanced
 *   harness doctor
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pkgDir = path.join(repoRoot, 'packages', 'harness');
const distDir = path.join(pkgDir, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const version = pkg.version;
const tarballName = `dev-kit-harness-${version}.tgz`;

fs.mkdirSync(distDir, { recursive: true });

console.log('[pack-harness] building assets…');
execSync('npm run build:assets', { cwd: pkgDir, stdio: 'inherit' });

console.log(`[pack-harness] packing ${pkg.name}@${version}…`);
execSync(`npm pack --pack-destination "${distDir}"`, { cwd: pkgDir, stdio: 'inherit' });

const tarballPath = path.join(distDir, tarballName);
if (!fs.existsSync(tarballPath)) {
  console.error(`[pack-harness] expected tarball missing: ${tarballPath}`);
  process.exit(1);
}

const listing = execSync(`tar -tzf "${tarballPath}"`, { encoding: 'utf8' });
const required = [
  'package/assets/skills/engineer/SKILL.md',
  'package/assets/agents/engineer.agent.md',
  'package/bin/harness.mjs',
];
for (const entry of required) {
  if (!listing.split('\n').includes(entry)) {
    console.error(`[pack-harness] tarball missing ${entry}`);
    process.exit(1);
  }
}

const sizeKb = Math.round(fs.statSync(tarballPath).size / 1024);
console.log('');
console.log(`[pack-harness] ready: ${tarballPath} (${sizeKb} KB)`);
console.log('');
console.log('Share with testers:');
console.log(`  npm install -g "${tarballPath}"`);
console.log('  harness install --configure-vscode --autonomy balanced');
console.log('  harness doctor');
console.log('');
console.log('Publish to Nexus (after .npmrc is configured):');
console.log(`  cd packages/harness && npm publish`);
