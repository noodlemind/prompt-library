#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync as spawnChildSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const allowed = new Set(['--core', '--eval']);
const REPOSITORY_TEST_ROOT_PREFIX = 'hr-';
const SAFE_AMBIENT_ENVIRONMENT = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ',
  'CI', 'NO_COLOR', 'FORCE_COLOR',
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
]);
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

export function validatedLocalDockerHost({
  platform = process.platform,
  realpathSync = fs.realpathSync.native,
  lstatSync = fs.lstatSync,
  getuid = typeof process.getuid === 'function' ? () => process.getuid() : null,
} = {}) {
  if (platform === 'win32') return 'npipe:////./pipe/docker_engine';
  try {
    const socket = realpathSync('/var/run/docker.sock');
    if (!path.isAbsolute(socket) || path.normalize(socket) !== socket) return null;
    const stat = lstatSync(socket);
    if (!stat.isSocket() || (stat.mode & 0o002) !== 0) return null;
    const uid = typeof getuid === 'function' ? getuid() : null;
    if (stat.uid !== 0 && uid != null && stat.uid !== uid) return null;
    return `unix://${socket}`;
  } catch {
    return null;
  }
}

export function scrubRepositoryTestEnvironment(environment, {
  isolatedRoot,
  dockerHost = null,
  platform = process.platform,
} = {}) {
  if (typeof isolatedRoot !== 'string' || !path.isAbsolute(isolatedRoot)
      || path.normalize(isolatedRoot) !== isolatedRoot) {
    throw new Error('repository tests require an absolute normalized isolated state root');
  }
  const scrubbed = {};
  for (const name of SAFE_AMBIENT_ENVIRONMENT) {
    if (typeof environment?.[name] === 'string') scrubbed[name] = environment[name];
  }
  const home = path.join(isolatedRoot, 'home');
  const temporary = path.join(isolatedRoot, 'tmp');
  const nullDevice = platform === 'win32' ? 'NUL' : '/dev/null';
  Object.assign(scrubbed, {
    HOME: home,
    ...(platform === 'win32' ? { USERPROFILE: home } : {}),
    XDG_CONFIG_HOME: path.join(isolatedRoot, 'xdg-config'),
    XDG_CACHE_HOME: path.join(isolatedRoot, 'xdg-cache'),
    XDG_DATA_HOME: path.join(isolatedRoot, 'xdg-data'),
    XDG_STATE_HOME: path.join(isolatedRoot, 'xdg-state'),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_OPTIONAL_LOCKS: '0',
    npm_config_userconfig: nullDevice,
    npm_config_cache: path.join(isolatedRoot, 'npm-cache'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    PYTHONNOUSERSITE: '1',
    ...(dockerHost == null ? {} : { DOCKER_HOST: dockerHost }),
  });
  return scrubbed;
}

export function createRepositoryTestRoot({
  platform = process.platform,
  tempDirectory = platform === 'win32' ? os.tmpdir() : '/tmp',
  mkdtempSync = fs.mkdtempSync,
  chmodSync = fs.chmodSync,
  chownSync = fs.chownSync,
  mkdirSync = fs.mkdirSync,
  getuid = typeof process.getuid === 'function' ? () => process.getuid() : null,
  getgid = typeof process.getgid === 'function' ? () => process.getgid() : null,
} = {}) {
  if (!path.isAbsolute(tempDirectory) || path.normalize(tempDirectory) !== tempDirectory) {
    throw new Error('repository test temporary directory must be absolute and normalized');
  }
  // Keep this prefix deliberately short: nested broker/proxy tests create
  // Unix-domain sockets whose platform path limits are much lower than PATH_MAX.
  const root = mkdtempSync(path.join(tempDirectory, REPOSITORY_TEST_ROOT_PREFIX));
  const uid = platform !== 'win32' && typeof getuid === 'function' ? getuid() : null;
  const gid = platform !== 'win32' && typeof getgid === 'function' ? getgid() : null;
  if (Number.isInteger(uid) && Number.isInteger(gid)) chownSync(root, uid, gid);
  chmodSync(root, 0o700);
  for (const directory of [
    'home', 'tmp', 'xdg-config', 'xdg-cache', 'xdg-data', 'xdg-state', 'npm-cache',
  ]) {
    const target = path.join(root, directory);
    mkdirSync(target, { mode: 0o700 });
    if (Number.isInteger(uid) && Number.isInteger(gid)) chownSync(target, uid, gid);
  }
  return root;
}

export function removeRepositoryTestRoot(root, {
  platform = process.platform,
  tempDirectory = platform === 'win32' ? os.tmpdir() : '/tmp',
  lstatSync = fs.lstatSync,
  readdirSync = fs.readdirSync,
  chmodSync = fs.chmodSync,
  rmSync = fs.rmSync,
  getuid = typeof process.getuid === 'function' ? () => process.getuid() : null,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root
      || !path.isAbsolute(tempDirectory) || path.normalize(tempDirectory) !== tempDirectory
      || path.dirname(root) !== tempDirectory
      || !path.basename(root).startsWith(REPOSITORY_TEST_ROOT_PREFIX)
      || path.basename(root).length === REPOSITORY_TEST_ROOT_PREFIX.length) {
    throw new Error('repository test cleanup requires an exact temporary hr-* root');
  }

  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('repository test cleanup root must be a real directory');
  }
  const uid = platform !== 'win32' && typeof getuid === 'function' ? getuid() : null;
  if (platform !== 'win32'
      && (!Number.isInteger(uid) || rootStat.uid !== uid || (rootStat.mode & 0o077) !== 0)) {
    throw new Error('repository test cleanup root must be owned by the current user and owner-private');
  }

  const makeDirectoriesWritable = (current) => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    if (stat.dev !== rootStat.dev) {
      throw new Error('repository test cleanup refuses to cross filesystem boundaries');
    }
    chmodSync(current, 0o700);
    for (const name of readdirSync(current)) {
      makeDirectoriesWritable(path.join(current, name));
    }
  };
  makeDirectoriesWritable(root);

  const finalRootStat = lstatSync(root);
  if (!finalRootStat.isDirectory() || finalRootStat.isSymbolicLink()
      || finalRootStat.dev !== rootStat.dev || finalRootStat.ino !== rootStat.ino) {
    throw new Error('repository test cleanup root identity changed');
  }
  rmSync(root, {
    recursive: true,
    force: false,
    // macOS can transiently report ENOTEMPTY while retiring the hundreds of
    // short-lived eval fixture trees. Keep cleanup bounded but long enough to
    // prove the private state root is actually gone before returning green.
    maxRetries: 20,
    retryDelay: 100,
  });
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
  createIsolatedRoot = createRepositoryTestRoot,
  removeIsolatedRoot = removeRepositoryTestRoot,
  resolveLocalDockerHost = validatedLocalDockerHost,
} = {}) {
  let suites;
  try {
    suites = selectRepositoryTestSuites(argv);
  } catch (error) {
    if (!(error instanceof RepositoryTestUsageError)) throw error;
    stderr(error.message);
    return 2;
  }

  const dockerHost = resolveLocalDockerHost();
  for (const { label, directory } of suites) {
    const files = discoverRepositoryTestFiles(repository, directory, { readdirSync });
    if (files.length === 0) throw new Error(`${label} test suite is empty: ${directory}`);

    const isolatedRoot = createIsolatedRoot();
    try {
      const scrubbedEnvironment = scrubRepositoryTestEnvironment(environment, {
        isolatedRoot,
        dockerHost,
      });
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
    } finally {
      removeIsolatedRoot(isolatedRoot);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runRepositoryTests();
}
