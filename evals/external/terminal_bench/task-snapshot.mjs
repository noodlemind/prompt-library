import fs from 'node:fs';
import path from 'node:path';

import { tasksOf, verifyTaskAgainstLock } from './harbor-adapter.mjs';

function realDirectory(value, label) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)
      || path.normalize(value) !== value) {
    throw new TypeError(`${label} must be an absolute normalized path`);
  }
  const named = fs.lstatSync(value);
  const real = fs.realpathSync.native(value);
  if (!named.isDirectory() || named.isSymbolicLink() || !fs.lstatSync(real).isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return real;
}

function materializeLockedSandbox(taskRoot, entry) {
  if (!entry?.sandbox) throw new Error(`task ${entry?.task ?? 'unknown'} has no sandbox lock`);
  const taskConfig = path.join(taskRoot, 'task.toml');
  const configStat = fs.lstatSync(taskConfig);
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.nlink !== 1) {
    throw new Error(`task ${entry.task} configuration is not a singly linked regular file`);
  }
  const source = fs.readFileSync(taskConfig, 'utf8');
  const imageLines = [...source.matchAll(/^docker_image\s*=\s*"([^"\r\n]+)"\s*$/gm)];
  if (imageLines.length !== 1 || imageLines[0][1] !== entry.sandbox.sourceImage) {
    throw new Error(`task ${entry.task} does not contain its locked source image`);
  }
  const expectedMemory = `${entry.sandbox.memoryMb / 1024}G`;
  const expectedStorage = `${entry.sandbox.storageMb / 1024}G`;
  const assignments = (field, pattern) => [...source.matchAll(
    new RegExp(`^${field}\\s*=\\s*${pattern}\\s*$`, 'gm'),
  )];
  const cpuAssignments = assignments('cpus', '(\\d+)');
  const memoryAssignments = assignments('memory', '"([^"\\r\\n]+)"');
  const storageAssignments = assignments('storage', '"([^"\\r\\n]+)"');
  if (!Number.isInteger(entry.sandbox.memoryMb / 1024)
      || !Number.isInteger(entry.sandbox.storageMb / 1024)
      || cpuAssignments.length !== 1
      || Number(cpuAssignments[0][1]) !== entry.sandbox.cpus
      || memoryAssignments.length !== 1
      || memoryAssignments[0][1] !== expectedMemory
      || storageAssignments.length !== 1
      || storageAssignments[0][1] !== expectedStorage) {
    throw new Error(`task ${entry.task} resource limits do not match its sandbox lock`);
  }
  const pinned = source.replace(
    imageLines[0][0],
    `docker_image = "${entry.sandbox.immutableImage}"`,
  );
  if (pinned === source) throw new Error(`task ${entry.task} image pin was not materialized`);
  const sealedMode = configStat.mode & 0o555;
  fs.chmodSync(taskConfig, sealedMode | 0o200);
  try {
    fs.writeFileSync(taskConfig, pinned);
  } finally {
    // The source artifact can be 0444. Grant write only to this private copy,
    // then restore its final read/execute shape even when the write fails.
    fs.chmodSync(taskConfig, sealedMode);
  }
}

/** Copy one lock-attested source task and materialize its digest-pinned execution image. */
export function materializeLockedTaskSnapshot({ sourceTask, destinationTask, lock, taskName } = {}) {
  const entry = tasksOf(lock).find((candidate) => candidate?.task === taskName);
  if (!entry) throw new Error(`task ${String(taskName)} is not present in its sandbox lock`);
  const source = realDirectory(sourceTask, 'source task');
  if (path.basename(source) !== taskName) throw new Error('source task identity drifted from its lock');
  const sourceVerdict = verifyTaskAgainstLock(source, lock, taskName);
  if (!sourceVerdict.ok) throw new Error(`source task failed checksum verification: ${sourceVerdict.reason}`);

  if (typeof destinationTask !== 'string' || destinationTask.includes('\0')
      || !path.isAbsolute(destinationTask) || path.normalize(destinationTask) !== destinationTask
      || path.basename(destinationTask) !== taskName) {
    throw new TypeError('destination task must be an absolute normalized locked-task path');
  }
  const namedDestinationParent = path.dirname(destinationTask);
  if (path.join(namedDestinationParent, taskName) !== destinationTask) {
    throw new Error('destination task must be a new direct dataset child');
  }
  const destinationParent = realDirectory(namedDestinationParent, 'destination dataset');
  const destination = path.join(destinationParent, taskName);
  if (fs.existsSync(destination)) {
    throw new Error('destination task must be a new direct dataset child');
  }

  const sourceMode = fs.lstatSync(source).mode;
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  // Some supported Node versions create a recursive-copy root with the
  // process default mode rather than the source root's read/execute bits.
  fs.chmodSync(destination, sourceMode & 0o777);
  const copied = verifyTaskAgainstLock(destination, lock, taskName);
  if (!copied.ok || copied.checksum !== sourceVerdict.checksum) {
    throw new Error(`copied task failed checksum verification: ${copied.reason}`);
  }
  materializeLockedSandbox(destination, entry);
  return fs.realpathSync.native(destination);
}

/** Seal a verified execution snapshot without following links or special nodes. */
export function sealVerifiedDatasetSnapshot(root) {
  const verifiedRoot = realDirectory(root, 'verified dataset snapshot');
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`verified dataset snapshot cannot contain symlinks: ${path.relative(verifiedRoot, current)}`);
    }
    if (!stat.isDirectory()) {
      if (!stat.isFile()) {
        throw new Error(`verified dataset snapshot contains an unsupported node: ${path.relative(verifiedRoot, current)}`);
      }
      fs.chmodSync(current, stat.mode & 0o555);
      return;
    }
    for (const name of fs.readdirSync(current)) visit(path.join(current, name));
    fs.chmodSync(current, stat.mode & 0o555);
  };
  visit(verifiedRoot);
  return verifiedRoot;
}
