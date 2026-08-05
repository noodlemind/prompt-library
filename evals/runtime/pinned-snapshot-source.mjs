import fs from 'node:fs';
import path from 'node:path';

import { downloadPinnedSnapshotSourceWithFetch } from './runtime-snapshot-artifacts.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const ATTEMPT_TOKEN = /^[a-f0-9]{32}$/;
const ATTEMPT_DIRECTORY_PREFIX = '.engineer-pinned-source-';
const ATTEMPT_PARTIAL_NAME = 'source.partial';
const SUCCESS = 'ENGINEER-PINNED-SOURCE/1';
const ABSENT = 'ENGINEER-PINNED-SOURCE-ABSENT/1\n';
const FAILURE = 'ENGINEER-PINNED-SOURCE-FAILURE/1\n';

function safeDestination(value) {
  if (typeof value !== 'string' || value.length < 2 || Buffer.byteLength(value) > 4096 ||
      value.includes('\0') || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error('invalid destination');
  }
  return value;
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length || argv.indexOf(flag, index + 1) >= 0) {
    throw new Error('invalid invocation');
  }
  return argv[index + 1];
}

function proveAbsent(destination) {
  try {
    fs.lstatSync(destination);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('destination remains present');
}

function ownerPrivateDirectory(directory, label) {
  const canonical = fs.realpathSync.native(directory);
  const stat = fs.lstatSync(canonical);
  const effectiveUid = process.geteuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      !Number.isInteger(effectiveUid) || stat.uid !== effectiveUid ||
      (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700) {
    throw new Error(`${label} custody is not owned`);
  }
  return canonical;
}

function attemptPaths(destination, token) {
  if (!ATTEMPT_TOKEN.test(token)) throw new Error('invalid attempt token');
  const parent = ownerPrivateDirectory(path.dirname(destination), 'destination parent');
  const canonicalDestination = path.join(parent, path.basename(destination));
  const attemptDirectory = path.join(parent, `${ATTEMPT_DIRECTORY_PREFIX}${token}`);
  return {
    destination: canonicalDestination,
    attemptDirectory,
    partial: path.join(attemptDirectory, ATTEMPT_PARTIAL_NAME),
  };
}

function validateAttemptDirectory(attemptDirectory) {
  const canonical = fs.realpathSync.native(attemptDirectory);
  const stat = fs.lstatSync(canonical);
  const effectiveUid = process.geteuid?.();
  if (canonical !== attemptDirectory || !stat.isDirectory() || stat.isSymbolicLink() ||
      !Number.isInteger(effectiveUid) || stat.uid !== effectiveUid ||
      (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700) {
    throw new Error('attempt directory custody is not owned');
  }
}

function cleanupOwnedAttempt(destination, token) {
  const paths = attemptPaths(destination, token);
  try {
    validateAttemptDirectory(paths.attemptDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const entries = fs.readdirSync(paths.attemptDirectory);
  if (entries.some((entry) => entry !== ATTEMPT_PARTIAL_NAME) || entries.length > 1) {
    throw new Error('attempt directory contains an unexpected entry');
  }
  if (entries.length === 0) {
    fs.rmdirSync(paths.attemptDirectory);
    proveAbsent(paths.attemptDirectory);
    return;
  }
  let stat;
  try {
    stat = fs.lstatSync(paths.partial);
  } catch (error) {
    throw error;
  }
  const effectiveUid = process.geteuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink) ||
      !Number.isInteger(effectiveUid) || stat.uid !== effectiveUid ||
      (stat.mode & 0o077) !== 0 || stat.size < 0 || stat.size > MAX_DOWNLOAD_BYTES) {
    throw new Error('attempt partial custody is not owned');
  }
  if (stat.nlink === 2) {
    const published = fs.lstatSync(paths.destination);
    if (!published.isFile() || published.isSymbolicLink() || published.dev !== stat.dev ||
        published.ino !== stat.ino || published.uid !== stat.uid || published.size !== stat.size) {
      throw new Error('published destination does not match the attempt partial');
    }
  }
  fs.unlinkSync(paths.partial);
  proveAbsent(paths.partial);
  fs.rmdirSync(paths.attemptDirectory);
  proveAbsent(paths.attemptDirectory);
}

async function main(argv) {
  if (argv[0] === '--cleanup') {
    if (argv.length !== 5) throw new Error('invalid invocation');
    const destination = safeDestination(valueAfter(argv, '--destination'));
    const attemptToken = valueAfter(argv, '--attempt-token');
    cleanupOwnedAttempt(destination, attemptToken);
    process.stdout.write(ABSENT);
    return;
  }
  if (argv[0] !== '--download' || argv.length !== 9) throw new Error('invalid invocation');
  const url = valueAfter(argv, '--url');
  const expectedSha256 = valueAfter(argv, '--expected-sha256');
  const destination = safeDestination(valueAfter(argv, '--destination'));
  const attemptToken = valueAfter(argv, '--attempt-token');
  if (!HASH.test(expectedSha256)) throw new Error('invalid digest');
  const paths = attemptPaths(destination, attemptToken);
  validateAttemptDirectory(paths.attemptDirectory);
  if (fs.readdirSync(paths.attemptDirectory).length !== 0) {
    throw new Error('attempt directory must begin empty');
  }
  proveAbsent(paths.destination);
  await downloadPinnedSnapshotSourceWithFetch({
    url,
    expectedSha256,
    destination: paths.partial,
  });
  process.stdout.write(`${SUCCESS} ${expectedSha256}\n`);
}

try {
  await main(process.argv.slice(2));
} catch {
  process.stdout.write(FAILURE);
  process.exitCode = 70;
}
