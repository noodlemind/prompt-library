import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HARNESS_ASSET_DIRECTORIES,
  HARNESS_ASSET_FILES,
  HARNESS_ASSET_SOURCE_PATHS,
  validateHarnessAssetMappings,
} from '../../../scripts/harness-asset-contract.mjs';
import { buildHarnessAssets } from '../../../scripts/build-harness-assets.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const evalRoot = path.join(repoRoot, 'evals');
const packageBoundaryTest = fileURLToPath(import.meta.url);
const npmPackArguments = ['pack', '--dry-run', '--json', '--ignore-scripts'];
const APPROVED_HARNESS_ASSET_DIRECTORIES = Object.freeze([
  Object.freeze({ from: '.github/skills', to: 'skills' }),
  Object.freeze({ from: '.github/agents', to: 'agents' }),
  Object.freeze({ from: '.github/instructions', to: 'instructions' }),
  Object.freeze({ from: '.github/hooks', to: 'hooks' }),
  Object.freeze({ from: 'knowledge', to: 'knowledge' }),
  Object.freeze({ from: 'enterprise', to: 'enterprise' }),
]);
const APPROVED_HARNESS_ASSET_FILES = Object.freeze([
  Object.freeze({ from: '.github/copilot-instructions.md', to: 'copilot-instructions.md' }),
]);

function walk(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function importSpecifiers(source) {
  const imports = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      imports.push({ index: match.index, specifier: match[1] });
    }
  }
  return imports.sort((left, right) => left.index - right.index).map(({ specifier }) => specifier);
}

export function npmPackInvocation({
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (platform === 'win32') {
    const commandProcessor = environment.ComSpec ?? environment.COMSPEC;
    if (typeof commandProcessor !== 'string'
        || !path.win32.isAbsolute(commandProcessor)
        || path.win32.basename(commandProcessor).toLowerCase() !== 'cmd.exe') {
      throw new Error('Windows npm pack requires an absolute ComSpec path to cmd.exe');
    }
    return {
      command: commandProcessor,
      arguments: ['/d', '/s', '/c', `npm.cmd ${npmPackArguments.join(' ')}`],
    };
  }
  return {
    command: 'npm',
    arguments: [...npmPackArguments],
  };
}

test('import scanner covers each JavaScript module-loading form', () => {
  const source = [
    "import primary from './static.js';",
    "import './side-effect.js';",
    "export { named } from './named.js';",
    "export * from './all.js';",
    "const dynamic = import('./dynamic.js');",
    "const required = require('./required.cjs');",
    'const metadata = import.meta.url;',
  ].join('\n');

  assert.deepEqual(importSpecifiers(source), [
    './static.js',
    './side-effect.js',
    './named.js',
    './all.js',
    './dynamic.js',
    './required.cjs',
  ]);
});

test('the package builder matches the independently approved source-to-destination inventory', () => {
  assert.deepEqual(HARNESS_ASSET_DIRECTORIES, APPROVED_HARNESS_ASSET_DIRECTORIES);
  assert.deepEqual(HARNESS_ASSET_FILES, APPROVED_HARNESS_ASSET_FILES);
  assert.deepEqual(HARNESS_ASSET_SOURCE_PATHS, [
    ...APPROVED_HARNESS_ASSET_DIRECTORIES.map(({ from }) => from),
    ...APPROVED_HARNESS_ASSET_FILES.map(({ from }) => from),
  ]);
  for (const source of HARNESS_ASSET_SOURCE_PATHS) {
    assert.equal(fs.existsSync(path.join(repoRoot, source)), true, `missing declared Harness asset input: ${source}`);
  }
});

test('the asset contract rejects duplicate destinations across mapping types', () => {
  assert.throws(
    () => validateHarnessAssetMappings({
      directories: [{ from: 'source-directory', to: 'shared' }],
      files: [{ from: 'source-file', to: 'shared' }],
    }),
    /duplicate Harness asset destination: shared/,
  );
});

test('the asset contract rejects unsafe destinations', () => {
  for (const destination of ['', '.', '..', '../escape', 'nested/../escape', '/absolute', 'C:\\absolute', 'nested\\escape']) {
    assert.throws(
      () => validateHarnessAssetMappings({
        directories: [{ from: 'source-directory', to: destination }],
        files: [],
      }),
      /unsafe Harness asset destination/,
      destination || '<empty>',
    );
  }
});

test('the asset contract rejects unsafe sources', () => {
  for (const source of ['', '.', '..', '../escape', 'nested/../escape', '/absolute', 'C:\\absolute', 'nested\\escape']) {
    assert.throws(
      () => validateHarnessAssetMappings({
        directories: [{ from: source, to: 'safe-destination' }],
        files: [],
      }),
      /unsafe Harness asset source/,
      source || '<empty>',
    );
  }
});

test('the asset contract rejects case-colliding destinations', () => {
  assert.throws(
    () => validateHarnessAssetMappings({
      directories: [{ from: 'source-directory', to: 'Shared/Asset' }],
      files: [{ from: 'source-file', to: 'shared/asset' }],
    }),
    /duplicate Harness asset destination: shared\/asset/,
  );
});

test('the asset contract rejects overlapping destination trees', () => {
  assert.throws(
    () => validateHarnessAssetMappings({
      directories: [{ from: 'source-directory', to: 'shared' }],
      files: [{ from: 'source-file', to: 'shared/asset.md' }],
    }),
    /overlapping Harness asset destinations: shared and shared\/asset\.md/,
  );
});

test('the asset contract rejects repository-private eval and test destinations', () => {
  for (const destination of ['eval', 'evals/runtime', 'test', 'nested/tests/fixture']) {
    assert.throws(
      () => validateHarnessAssetMappings({
        directories: [{ from: 'source-directory', to: destination }],
        files: [],
      }),
      /forbidden Harness asset destination/,
      destination,
    );
  }
});

function builderFixture(t, { missing }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'packages', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'harness', 'package.json'), '{"version":"9.8.7"}\n');
  if (missing !== 'directory') {
    fs.mkdirSync(path.join(root, 'source-directory'));
    fs.writeFileSync(path.join(root, 'source-directory', 'entry.md'), 'directory asset\n');
  }
  if (missing !== 'file') fs.writeFileSync(path.join(root, 'source-file.md'), 'file asset\n');

  const outRoot = path.join(root, 'packages', 'harness', 'assets');
  fs.mkdirSync(outRoot);
  fs.writeFileSync(path.join(outRoot, 'harness-version.txt'), 'stale-success-marker\n');
  const messages = [];
  return {
    root,
    outRoot,
    messages,
    build() {
      return buildHarnessAssets({
        repoRoot: root,
        directories: [{ from: 'source-directory', to: 'directory-asset' }],
        files: [{ from: 'source-file.md', to: 'file-asset.md' }],
        log: (message) => messages.push(message),
      });
    },
  };
}

test('the builder derives the canonical package asset directory from the repository root', (t) => {
  const fixture = builderFixture(t, {});

  const result = fixture.build();

  assert.equal(result.outRoot, path.join(fixture.root, 'packages', 'harness', 'assets'));
  assert.equal(fs.readFileSync(path.join(result.outRoot, 'harness-version.txt'), 'utf8'), '9.8.7\n');
});

test('the builder rejects non-normalized repository roots before deletion', (t) => {
  const fixture = builderFixture(t, {});

  for (const untrustedRoot of [
    'relative-repository-root',
    `${fixture.root}${path.sep}`,
    `${fixture.root}${path.sep}packages${path.sep}..`,
  ]) {
    assert.throws(
      () => buildHarnessAssets({
        repoRoot: untrustedRoot,
        directories: [],
        files: [],
        log: () => {},
      }),
      /Harness repository root must be an absolute normalized path/,
      untrustedRoot,
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.outRoot, 'harness-version.txt'), 'utf8'),
      'stale-success-marker\n',
    );
  }
});

test('the builder rejects a symlinked repository root before deletion', {
  skip: process.platform === 'win32' ? 'directory symlinks require elevated privileges on Windows' : false,
}, (t) => {
  const fixture = builderFixture(t, {});
  const linkedRoot = `${fixture.root}-link`;
  fs.symlinkSync(fixture.root, linkedRoot, 'dir');
  t.after(() => fs.rmSync(linkedRoot, { force: true }));

  assert.throws(
    () => buildHarnessAssets({ repoRoot: linkedRoot, directories: [], files: [], log: () => {} }),
    /Harness repository root must be a non-symlink directory/,
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.outRoot, 'harness-version.txt'), 'utf8'),
    'stale-success-marker\n',
  );
});

test('the builder rejects sources on either side of the output boundary before deletion', (t) => {
  const fixture = builderFixture(t, {});
  fs.mkdirSync(path.join(fixture.outRoot, 'nested-source'));

  for (const source of ['packages/harness', 'packages/harness/assets/nested-source', 'PACKAGES/HARNESS/ASSETS']) {
    assert.throws(
      () => buildHarnessAssets({
        repoRoot: fixture.root,
        directories: [{ from: source, to: 'copied-source' }],
        files: [],
        log: () => {},
      }),
      /Harness asset source overlaps the output boundary/,
      source,
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.outRoot, 'harness-version.txt'), 'utf8'),
      'stale-success-marker\n',
      `${source} must be rejected before output deletion`,
    );
  }
});

test('the builder reports a missing declared directory without a success or version marker', (t) => {
  const fixture = builderFixture(t, { missing: 'directory' });

  assert.throws(fixture.build, /missing declared Harness asset directory: source-directory/);
  assert.equal(fs.existsSync(path.join(fixture.outRoot, 'harness-version.txt')), false);
  assert.equal(fixture.messages.some((message) => message.startsWith('assets ready at ')), false);
});

test('the builder reports a missing declared file without a success or version marker', (t) => {
  const fixture = builderFixture(t, { missing: 'file' });

  assert.throws(fixture.build, /missing declared Harness asset file: source-file\.md/);
  assert.equal(fs.existsSync(path.join(fixture.outRoot, 'harness-version.txt')), false);
  assert.equal(fixture.messages.some((message) => message.startsWith('assets ready at ')), false);
});

test('the builder CLI still runs through a symlinked entrypoint', {
  skip: process.platform === 'win32' ? 'file symlinks require elevated privileges on Windows' : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-assets-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const script of ['build-harness-assets.mjs', 'harness-asset-contract.mjs']) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', script), path.join(root, 'scripts', script));
  }
  for (const { from } of APPROVED_HARNESS_ASSET_DIRECTORIES) {
    fs.mkdirSync(path.join(root, from), { recursive: true });
  }
  for (const { from } of APPROVED_HARNESS_ASSET_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, from)), { recursive: true });
    fs.writeFileSync(path.join(root, from), 'file asset\n');
  }
  fs.mkdirSync(path.join(root, 'packages', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'harness', 'package.json'), '{"version":"9.8.7"}\n');
  const entrypoint = path.join(root, 'build-assets.mjs');
  fs.symlinkSync(path.join(root, 'scripts', 'build-harness-assets.mjs'), entrypoint);

  const result = spawnSync(process.execPath, [entrypoint], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /assets ready at /);
  assert.equal(fs.readFileSync(path.join(root, 'packages', 'harness', 'assets', 'harness-version.txt'), 'utf8'), '9.8.7\n');
});

test('core test sources do not depend on the private eval workspace', () => {
  const privateEvalReference = /(?:@dev-kit\/harness-evals|\bevals\b)/;
  const coreTests = walk(path.join(packageRoot, 'test'))
    .filter((file) => file.endsWith('.mjs') && file !== packageBoundaryTest);

  for (const file of coreTests) {
    assert.doesNotMatch(
      fs.readFileSync(file, 'utf8'),
      privateEvalReference,
      `${path.relative(repoRoot, file)} references the private eval workspace`,
    );
  }
});

test('npm pack uses the command processor rather than spawning a cmd shim directly on Windows', () => {
  const commandProcessor = path.win32.resolve('C:\\Windows', 'System32', 'cmd.exe');
  assert.deepEqual(
    npmPackInvocation({ platform: 'win32', environment: { ComSpec: commandProcessor } }),
    {
      command: commandProcessor,
      arguments: ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json --ignore-scripts'],
    },
  );
  assert.deepEqual(npmPackInvocation({ platform: 'linux', environment: {} }), {
    command: 'npm',
    arguments: npmPackArguments,
  });
});

test('published Harness production files do not import repository eval tooling', () => {
  assert.equal(packageJson.private, undefined, 'the Harness package remains publishable');
  assert.ok(Array.isArray(packageJson.files) && packageJson.files.length > 0, 'package files allowlist is required');

  for (const script of Object.values(packageJson.scripts ?? {})) {
    assert.doesNotMatch(script, /(?:^|[\\/])evals(?:[\\/]|$)/, 'published package scripts must not reach into repo-only evals');
  }

  const productionFiles = packageJson.files.flatMap((entry) => {
    const target = path.join(packageRoot, entry);
    return fs.statSync(target).isDirectory() ? walk(target) : [target];
  });

  for (const file of productionFiles.filter((candidate) => /\.(?:[cm]?js)$/.test(candidate))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const resolved = path.resolve(path.dirname(file), specifier);
        assert.equal(
          resolved === evalRoot || isWithin(evalRoot, resolved),
          false,
          `${path.relative(repoRoot, file)} imports repo-only eval tooling via ${specifier}`,
        );
      } else {
        assert.doesNotMatch(
          specifier,
          /^(?:@dev-kit\/harness-evals|evals)(?:\/|$)/,
          `${path.relative(repoRoot, file)} imports the private eval workspace`,
        );
      }
    }
  }
});

test('npm package dry run excludes repository tests and eval tooling', () => {
  const invocation = npmPackInvocation();
  const result = spawnSync(invocation.command, invocation.arguments, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout);
  const paths = packed[0].files.map((entry) => entry.path.replaceAll('\\', '/'));
  assert.ok(paths.length > 0, 'dry-run package manifest must contain files');
  assert.equal(paths.some((entry) => entry === 'test' || entry.startsWith('test/')), false);
  assert.equal(paths.some((entry) => entry === 'evals' || entry.startsWith('evals/')), false);
});
