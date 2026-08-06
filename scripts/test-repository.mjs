#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync as spawnChildSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const allowed = new Set(['--core', '--eval']);
const credentialLikeName = /(?:^|_)(?:API_?KEY|AUTHORIZATION|CREDENTIALS?|KEY|PASS(?:WORD|WD)?|PAT|SECRET|TOKEN)(?:_|$)/i;
const repositoryTestSuites = Object.freeze([
  Object.freeze({ flag: '--core', label: 'Harness core tests', directory: 'packages/harness/test' }),
  Object.freeze({ flag: '--eval', label: 'Repository eval tests', directory: 'evals/test' }),
]);

class RepositoryTestUsageError extends Error {
  constructor(argument) {
    super(`Usage: node scripts/test-repository.mjs [--core] [--eval]\nUnknown option: ${argument}`);
    this.name = 'RepositoryTestUsageError';
  }
}

export function selectRepositoryTestSuites(argv) {
  const unknown = argv.find((argument) => !allowed.has(argument));
  if (unknown !== undefined) throw new RepositoryTestUsageError(unknown);
  const requested = new Set(argv);
  return repositoryTestSuites.filter(({ flag }) => requested.size === 0 || requested.has(flag));
}

export function scrubRepositoryTestEnvironment(environment) {
  const scrubbed = { ...environment };
  for (const name of Object.keys(scrubbed)) {
    if (credentialLikeName.test(name)) delete scrubbed[name];
  }
  return scrubbed;
}

export function discoverRepositoryTestFiles(repository, directory, {
  readdirSync = fs.readdirSync,
} = {}) {
  return readdirSync(path.join(repository, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

export function runRepositoryTests({
  argv = process.argv.slice(2),
  repository = repoRoot,
  environment = process.env,
  executable = process.execPath,
  readdirSync = fs.readdirSync,
  spawnSync = spawnChildSync,
  stdout = (line) => console.log(line),
  stderr = (line) => console.error(line),
} = {}) {
  let suites;
  try {
    suites = selectRepositoryTestSuites(argv);
  } catch (error) {
    if (!(error instanceof RepositoryTestUsageError)) throw error;
    stderr(error.message);
    return 2;
  }

  const scrubbedEnvironment = scrubRepositoryTestEnvironment(environment);
  for (const { label, directory } of suites) {
    const files = discoverRepositoryTestFiles(repository, directory, { readdirSync });
    if (files.length === 0) throw new Error(`${label} test suite is empty: ${directory}`);

    stdout(`\n==> ${label} (${files.length} files)`);
    const result = spawnSync(
      executable,
      ['--test', '--test-concurrency=1', ...files],
      {
        cwd: repository,
        env: scrubbedEnvironment,
        stdio: 'inherit',
      },
    );

    if (result.error) throw result.error;
    if (result.signal) {
      stderr(`${label} terminated by ${result.signal}`);
      return 1;
    }
    const status = result.status ?? 1;
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runRepositoryTests();
}
