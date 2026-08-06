import assert from 'node:assert/strict';
import { spawnSync as spawnChildSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

import {
  discoverRepositoryTestFiles,
  runRepositoryTests,
  scrubRepositoryTestEnvironment,
  selectRepositoryTestSuites,
} from '../../scripts/test-repository.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const fixtureRepository = path.resolve(repoRoot, '..', 'repository-fixture');

const entries = (...names) => names.map((name) => ({
  name,
  isFile: () => !name.startsWith('directory:'),
}));

function dependencies(overrides = {}) {
  const calls = [];
  const errors = [];
  const output = [];
  const value = {
    repository: fixtureRepository,
    environment: { PATH: '/bin' },
    readdirSync: () => entries('suite.test.mjs'),
    spawnSync(file, args, options) {
      calls.push({ file, args, options });
      return { status: 0, signal: null };
    },
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    ...overrides,
  };
  return { value, calls, errors, output };
}

test('repository suite selection supports all, core-only, and eval-only modes', () => {
  assert.deepEqual(
    selectRepositoryTestSuites([]).map(({ directory }) => directory),
    ['packages/harness/test', 'evals/test'],
  );
  assert.deepEqual(
    selectRepositoryTestSuites(['--core']).map(({ directory }) => directory),
    ['packages/harness/test'],
  );
  assert.deepEqual(
    selectRepositoryTestSuites(['--eval']).map(({ directory }) => directory),
    ['evals/test'],
  );
  assert.deepEqual(
    selectRepositoryTestSuites(['--eval', '--core']).map(({ directory }) => directory),
    ['packages/harness/test', 'evals/test'],
  );
});

test('repository test discovery retains only sorted top-level test files', () => {
  const observed = [];
  const files = discoverRepositoryTestFiles(fixtureRepository, 'evals/test', {
    readdirSync(directory, options) {
      observed.push({ directory, options });
      return [
        ...entries('z.test.mjs', 'helper.mjs', 'a.test.mjs'),
        { name: 'directory:nested.test.mjs', isFile: () => false },
      ];
    },
  });

  assert.deepEqual(files, [
    path.join('evals/test', 'a.test.mjs'),
    path.join('evals/test', 'z.test.mjs'),
  ]);
  assert.deepEqual(observed, [{
    directory: path.join(fixtureRepository, 'evals/test'),
    options: { withFileTypes: true },
  }]);
});

test('repository runner rejects unknown options without spawning a child', () => {
  const harness = dependencies();
  const status = runRepositoryTests({ argv: ['--bogus'], ...harness.value });

  assert.equal(status, 2);
  assert.equal(harness.calls.length, 0);
  assert.deepEqual(harness.errors, [
    'Usage: node scripts/test-repository.mjs [--core] [--eval]\nUnknown option: --bogus',
  ]);
});

test('repository runner direct invocation preserves the unknown-option exit contract', () => {
  const result = spawnChildSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/test-repository.mjs'), '--bogus'],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'Usage: node scripts/test-repository.mjs [--core] [--eval]\nUnknown option: --bogus\n',
  );
});

test('repository runner scrubs credential-like environment variables without mutating its input', () => {
  const environment = {
    PATH: '/bin',
    CI: 'true',
    OPENAI_API_KEY: 'secret-api-key',
    GH_TOKEN: 'secret-token',
    DB_PASSWORD: 'secret-password',
    DB_PASSWD: 'secret-passwd',
    LOGIN_PASS: 'secret-pass',
    GITHUB_PAT: 'secret-pat',
    AUTHORIZATION: 'secret-authorization',
    COMPASS: 'benign',
    KEYBOARD_LAYOUT: 'us',
    MONKEY: 'benign',
    TOKENIZER_MODE: 'local',
  };
  const harness = dependencies({ environment });

  const expected = {
    PATH: '/bin',
    CI: 'true',
    COMPASS: 'benign',
    KEYBOARD_LAYOUT: 'us',
    MONKEY: 'benign',
    TOKENIZER_MODE: 'local',
  };
  assert.deepEqual(scrubRepositoryTestEnvironment(environment), expected);
  assert.equal(runRepositoryTests({ argv: ['--core'], ...harness.value }), 0);
  assert.deepEqual(harness.calls[0].options.env, expected);
  assert.equal(environment.OPENAI_API_KEY, 'secret-api-key');
});

test('repository runner rejects an empty selected suite', () => {
  const harness = dependencies({ readdirSync: () => [] });
  assert.throws(
    () => runRepositoryTests({ argv: ['--eval'], ...harness.value }),
    /Repository eval tests test suite is empty: evals\/test/,
  );
  assert.equal(harness.calls.length, 0);
});

test('repository runner executes both suites in deterministic order when no flags are provided', () => {
  const harness = dependencies();

  assert.equal(runRepositoryTests({ argv: [], ...harness.value }), 0);
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(
    harness.calls.map(({ args }) => args.at(-1)),
    [
      path.join('packages/harness/test', 'suite.test.mjs'),
      path.join('evals/test', 'suite.test.mjs'),
    ],
  );
});

test('repository runner propagates a nonzero status and stops before the next suite', () => {
  const harness = dependencies({
    spawnSync(file, args, options) {
      harness.calls.push({ file, args, options });
      return { status: 7, signal: null };
    },
  });

  assert.equal(runRepositoryTests({ argv: [], ...harness.value }), 7);
  assert.equal(harness.calls.length, 1);
  assert.match(harness.output[0], /Harness core tests \(1 files\)/);
  assert.deepEqual(harness.calls[0].args, [
    '--test',
    '--test-concurrency=1',
    path.join('packages/harness/test', 'suite.test.mjs'),
  ]);
});

test('repository runner reports a child signal and fails closed', () => {
  const harness = dependencies({
    spawnSync(file, args, options) {
      harness.calls.push({ file, args, options });
      return { status: null, signal: 'SIGTERM' };
    },
  });

  assert.equal(runRepositoryTests({ argv: ['--eval'], ...harness.value }), 1);
  assert.deepEqual(harness.errors, ['Repository eval tests terminated by SIGTERM']);
});

test('repository checks retain the composite runner and private evidence verifier commands', () => {
  const checks = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/harness/checks.yaml'), 'utf8'));
  assert.deepEqual(checks.checks['harness-tests'].command, ['node', 'scripts/test-repository.mjs']);
  assert.deepEqual(checks.checks['zero-provider-daytona'].command, [
    'node',
    'evals/verify-zero-provider-daytona.mjs',
  ]);
});

test('the eval workspace remains private and routes repository-owned scripts locally', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals/package.json'), 'utf8'));
  assert.equal(packageJson.name, '@dev-kit/harness-evals');
  assert.equal(packageJson.private, true);
  assert.deepEqual(packageJson.scripts, {
    eval: 'node ./run.mjs',
    run: 'node ./run.mjs',
    release: 'node ./release.mjs',
    test: 'node ../scripts/test-repository.mjs --eval',
    'test:daytona-zero-provider': 'node ./zero-provider-daytona.mjs',
    'verify:daytona-zero-provider': 'node ./verify-zero-provider-daytona.mjs',
  });
});
