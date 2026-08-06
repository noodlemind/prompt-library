#!/usr/bin/env node
/**
 * Copy prompt-library primitives into packages/harness/assets for npm publish.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  HARNESS_ASSET_DIRECTORIES,
  HARNESS_ASSET_FILES,
  validateHarnessAssetMappings,
} from './harness-asset-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

function isSameOrWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function portablePathKey(value) {
  return path.resolve(value).normalize('NFC').toLowerCase();
}

function pathsOverlap(left, right) {
  const leftKey = portablePathKey(left);
  const rightKey = portablePathKey(right);
  return isSameOrWithin(leftKey, rightKey) || isSameOrWithin(rightKey, leftKey);
}

function assertPlainDirectory(target, label) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} must be an existing directory: ${target}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory: ${target}`);
  }
}

function resolveBuildLayout(repoRoot, mappings) {
  if (typeof repoRoot !== 'string'
      || !path.isAbsolute(repoRoot)
      || path.resolve(repoRoot) !== repoRoot) {
    throw new Error(`Harness repository root must be an absolute normalized path: ${String(repoRoot)}`);
  }

  assertPlainDirectory(repoRoot, 'Harness repository root');
  const packagesRoot = path.join(repoRoot, 'packages');
  const packageRoot = path.join(packagesRoot, 'harness');
  const outRoot = path.join(packageRoot, 'assets');
  assertPlainDirectory(packagesRoot, 'Harness packages root');
  assertPlainDirectory(packageRoot, 'Harness package root');

  if (!isSameOrWithin(repoRoot, outRoot) || repoRoot === outRoot) {
    throw new Error(`unsafe Harness asset output path: ${outRoot}`);
  }

  if (fs.existsSync(outRoot)) {
    assertPlainDirectory(outRoot, 'Harness asset output');
  }

  const realRepoRoot = fs.realpathSync.native(repoRoot);
  const realPackageRoot = fs.realpathSync.native(packageRoot);
  if (!isSameOrWithin(realRepoRoot, realPackageRoot) || realRepoRoot === realPackageRoot) {
    throw new Error(`Harness package root resolves outside the repository: ${packageRoot}`);
  }
  const realOutRoot = fs.existsSync(outRoot)
    ? fs.realpathSync.native(outRoot)
    : path.join(realPackageRoot, 'assets');

  const resolvedMappings = mappings.map((mapping) => {
    const source = path.resolve(repoRoot, ...mapping.from.split('/'));
    const destination = path.resolve(outRoot, ...mapping.to.split('/'));
    if (!isSameOrWithin(portablePathKey(repoRoot), portablePathKey(source))
        || pathsOverlap(source, outRoot)) {
      throw new Error(`Harness asset source overlaps the output boundary: ${mapping.from}`);
    }
    if (!isSameOrWithin(portablePathKey(outRoot), portablePathKey(destination))
        || portablePathKey(outRoot) === portablePathKey(destination)) {
      throw new Error(`unsafe Harness asset destination: ${mapping.to}`);
    }

    if (fs.existsSync(source)) {
      const realSource = fs.realpathSync.native(source);
      if (!isSameOrWithin(realRepoRoot, realSource)) {
        throw new Error(`Harness asset source resolves outside the repository: ${mapping.from}`);
      }
      if (pathsOverlap(realSource, realOutRoot)) {
        throw new Error(`Harness asset source overlaps the output boundary: ${mapping.from}`);
      }
    }

    return { ...mapping, source, destination };
  });

  return { outRoot, packageRoot, resolvedMappings };
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function cpRecursive(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

export function buildHarnessAssets({
  repoRoot = defaultRepoRoot,
  directories = HARNESS_ASSET_DIRECTORIES,
  files = HARNESS_ASSET_FILES,
  log = (message) => console.log(message),
} = {}) {
  validateHarnessAssetMappings({ directories, files });
  const { outRoot, packageRoot, resolvedMappings } = resolveBuildLayout(
    repoRoot,
    [...directories, ...files],
  );
  const resolvedDirectories = resolvedMappings.slice(0, directories.length);
  const resolvedFiles = resolvedMappings.slice(directories.length);

  rmrf(outRoot);
  fs.mkdirSync(outRoot, { recursive: true });

  for (const { from, to, source: src, destination: dst } of resolvedDirectories) {
    if (!fs.existsSync(src)) {
      throw new Error(`missing declared Harness asset directory: ${from}`);
    }
    cpRecursive(src, dst);
    log(`copied ${from} → assets/${to}`);
  }

  for (const { from, to, source: src, destination: dst } of resolvedFiles) {
    if (!fs.existsSync(src)) {
      throw new Error(`missing declared Harness asset file: ${from}`);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    log(`copied ${from} → assets/${to}`);
  }

  const version = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  ).version;

  fs.writeFileSync(
    path.join(outRoot, 'harness-version.txt'),
    `${version}\n`,
    'utf8'
  );

  log(`assets ready at ${outRoot}`);
  return { outRoot, version };
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(fs.realpathSync.native(process.argv[1])).href) {
  buildHarnessAssets();
}
