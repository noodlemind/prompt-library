import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HARNESS_ASSET_DIRECTORIES,
  HARNESS_ASSET_FILES,
  HARNESS_ASSET_SOURCE_PATHS,
} from '../../../scripts/harness-asset-contract.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const evalRoot = path.join(repoRoot, 'evals');
const packageBoundaryTest = fileURLToPath(import.meta.url);
const npmPackArguments = ['pack', '--dry-run', '--json', '--ignore-scripts'];

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

test('the package builder has one complete, versioned asset input inventory', () => {
  assert.deepEqual(
    HARNESS_ASSET_SOURCE_PATHS,
    [...HARNESS_ASSET_DIRECTORIES, ...HARNESS_ASSET_FILES].map(({ from }) => from),
  );
  for (const source of HARNESS_ASSET_SOURCE_PATHS) {
    assert.equal(fs.existsSync(path.join(repoRoot, source)), true, `missing declared Harness asset input: ${source}`);
  }
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
