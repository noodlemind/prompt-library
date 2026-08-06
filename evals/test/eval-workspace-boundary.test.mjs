import assert from 'node:assert/strict';
import { spawnSync as spawnChildSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

import {
  createRepositoryTestRoot,
  discoverRepositoryTestFiles,
  removeRepositoryTestRoot,
  runRepositoryTests,
  scrubRepositoryTestEnvironment,
  selectRepositoryTestSuites,
  validatedLocalDockerHost,
} from '../../scripts/test-repository.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const fixtureRepository = path.resolve(repoRoot, '..', 'repository-fixture');
const fixtureIsolatedRoot = path.join(fixtureRepository, 'isolated-test-state');

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
    createIsolatedRoot: () => fixtureIsolatedRoot,
    removeIsolatedRoot: () => {},
    resolveLocalDockerHost: () => null,
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
    HOME: '/attacker/home',
    XDG_CONFIG_HOME: '/attacker/config',
    DAYTONA_CONFIG: '/attacker/daytona',
    DOCKER_HOST: 'tcp://remote.example:2376',
    DOCKER_CERT_PATH: '/attacker/docker-certs',
    DOCKER_CONFIG: '/attacker/docker-config',
    SSH_AUTH_SOCK: '/attacker/agent.sock',
    KUBECONFIG: '/attacker/kubeconfig',
    AWS_PROFILE: 'production',
    HTTPS_PROXY: 'https://user:secret@proxy.example',
    NODE_OPTIONS: '--import=/attacker/preload.mjs',
    npm_config_userconfig: '/attacker/npmrc',
    GIT_CONFIG_GLOBAL: '/attacker/gitconfig',
    COMPASS: 'benign',
    KEYBOARD_LAYOUT: 'us',
    MONKEY: 'benign',
    TOKENIZER_MODE: 'local',
  };
  const harness = dependencies({ environment });

  const expected = {
    PATH: '/bin',
    CI: 'true',
    HOME: path.join(fixtureIsolatedRoot, 'home'),
    XDG_CONFIG_HOME: path.join(fixtureIsolatedRoot, 'xdg-config'),
    XDG_CACHE_HOME: path.join(fixtureIsolatedRoot, 'xdg-cache'),
    XDG_DATA_HOME: path.join(fixtureIsolatedRoot, 'xdg-data'),
    XDG_STATE_HOME: path.join(fixtureIsolatedRoot, 'xdg-state'),
    TMPDIR: path.join(fixtureIsolatedRoot, 'tmp'),
    TMP: path.join(fixtureIsolatedRoot, 'tmp'),
    TEMP: path.join(fixtureIsolatedRoot, 'tmp'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    npm_config_userconfig: '/dev/null',
    npm_config_cache: path.join(fixtureIsolatedRoot, 'npm-cache'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    PYTHONNOUSERSITE: '1',
  };
  assert.deepEqual(scrubRepositoryTestEnvironment(environment, { isolatedRoot: fixtureIsolatedRoot }), expected);
  assert.equal(runRepositoryTests({ argv: ['--core'], ...harness.value }), 0);
  assert.deepEqual(harness.calls[0].options.env, expected);
  assert.equal(environment.OPENAI_API_KEY, 'secret-api-key');
  assert.equal(environment.DOCKER_HOST, 'tcp://remote.example:2376');
});

test('only a validated local Docker socket can enter the isolated test environment', () => {
  const socketStat = { isSocket: () => true, uid: 501, mode: 0o140660 };
  const host = validatedLocalDockerHost({
    platform: 'darwin',
    realpathSync: () => '/private/local/docker.sock',
    lstatSync: () => socketStat,
    getuid: () => 501,
  });
  assert.equal(host, 'unix:///private/local/docker.sock');
  assert.equal(
    scrubRepositoryTestEnvironment(
      { PATH: '/bin', DOCKER_HOST: 'tcp://remote.example:2376' },
      { isolatedRoot: fixtureIsolatedRoot, dockerHost: host },
    ).DOCKER_HOST,
    host,
  );
  assert.equal(validatedLocalDockerHost({
    platform: 'linux',
    realpathSync: () => '/run/unsafe.sock',
    lstatSync: () => ({ ...socketStat, mode: 0o140666 }),
    getuid: () => 501,
  }), null);
  assert.equal(validatedLocalDockerHost({
    platform: 'linux',
    realpathSync: () => '/run/not-a-socket',
    lstatSync: () => ({ ...socketStat, isSocket: () => false }),
    getuid: () => 501,
  }), null);
});

test('the private repository-test root stays short enough for nested Unix sockets', () => {
  const calls = [];
  const root = createRepositoryTestRoot({
    platform: 'darwin',
    mkdtempSync(prefix) {
      calls.push(['mkdtemp', prefix]);
      return '/tmp/hr-fixture';
    },
    chmodSync(target, mode) {
      calls.push(['chmod', target, mode]);
    },
    chownSync(target, uid, gid) {
      calls.push(['chown', target, uid, gid]);
    },
    getuid: () => 501,
    getgid: () => 20,
    mkdirSync(target, options) {
      calls.push(['mkdir', target, options]);
    },
  });

  assert.equal(root, '/tmp/hr-fixture');
  assert.deepEqual(calls[0], ['mkdtemp', '/tmp/hr-']);
  assert.deepEqual(calls[1], ['chown', '/tmp/hr-fixture', 501, 20]);
  assert.deepEqual(calls[2], ['chmod', '/tmp/hr-fixture', 0o700]);
  assert.equal(calls.filter(([operation]) => operation === 'chown').length, 8);
  assert.equal(calls.filter(([operation]) => operation === 'mkdir').length, 7);
});

test('repository cleanup removes sealed owner-private eval fixture directories', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX directory modes are unavailable');
  const root = fs.mkdtempSync('/tmp/hr-');
  const sealed = path.join(root, 'tmp', 'sealed', 'nested');
  fs.mkdirSync(sealed, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sealed, 'artifact.json'), '{}\n', { mode: 0o400 });
  fs.chmodSync(sealed, 0o500);
  fs.chmodSync(path.dirname(sealed), 0o500);

  removeRepositoryTestRoot(root);

  assert.equal(fs.existsSync(root), false);
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

test('the maintainer release sequence runs both isolated suites before build and publish', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'packages/harness/README.md'), 'utf8');
  const block = readme.match(/## Maintainers \(prompt-library repo\)\s+```bash\n([\s\S]*?)\n```/);
  assert.ok(block, 'README must retain one explicit prompt-library maintainer command block');
  assert.deepEqual(block[1].split('\n'), [
    'npm ci --prefix packages/harness',
    'npm ci --prefix evals',
    'node scripts/test-repository.mjs --core',
    'node scripts/test-repository.mjs --eval',
    'npm --prefix packages/harness run build:assets',
    'npm --prefix packages/harness version patch',
    'npm --prefix packages/harness publish',
  ]);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/harness/package.json'), 'utf8'));
  assert.equal(packageJson.scripts['build:assets'], 'node ../../scripts/build-harness-assets.mjs');
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/test-repository.mjs')), true);
});
