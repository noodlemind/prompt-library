import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RECEIPT = '.ae-home-migration.json';

function fail(message) {
  return Object.assign(new Error(message), { code: 'E_MIGRATE_HOME', exit: 1 });
}

function fileDigest(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    if (!before.isFile()) throw fail(`not a regular file: ${file}`);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail('source changed during migration; stop writers and retry');
    return { bytes: before.size, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}

function inventory(root) {
  const files = [], directories = [];
  function walk(rel) {
    const full = path.join(root, rel), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw fail(`symlinks are not migrated: ${rel || root}`);
    if (stat.isDirectory()) {
      const name = path.basename(rel);
      if (/^\..*\.lock$/.test(name) || name === '.lock' || name === '.snapshot-lock' || name === 'locks' && fs.readdirSync(full).length) throw fail(`possible active writer at ${rel}; stop writers and release locks first`);
      directories.push(rel);
      for (const name of fs.readdirSync(full).sort()) walk(path.join(rel, name));
    } else if (stat.isFile()) files.push({ path: rel, ...fileDigest(full) });
    else throw fail(`special files are not migrated: ${rel}`);
  }
  walk('');
  return { files, directories };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function migrateHome({ from, to, dryRun = false }) {
  const sourcePath = path.resolve(from), targetPath = path.resolve(to);
  if (fs.lstatSync(sourcePath).isSymbolicLink()) throw fail('source home must be a real directory');
  const source = fs.realpathSync(sourcePath);
  const parent = fs.realpathSync(path.dirname(targetPath));
  const target = path.join(parent, path.basename(targetPath));
  if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep)) throw fail('source and destination homes must not overlap');
  if (!fs.statSync(source).isDirectory()) throw fail('source home must be a directory');
  const snapshot = inventory(source), sourceDigest = digest(snapshot);
  if (snapshot.files.some(entry => entry.path === RECEIPT)) throw fail('source is already a migrated home; select its original backup');
  const base = {
    source, target, backup: source, files: snapshot.files.length,
    bytes: snapshot.files.reduce((sum, entry) => sum + entry.bytes, 0),
    sourceDigest,
    next: [`Set AE_HOME=${target} and remove a conflicting HARNESS_HOME setting.`, 'Reload editor windows and run ae orient for each active checkout.', 'Run ae index and ae index --structural for each checkout; rerun review and verify for active work.'],
  };
  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStat) {
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw fail('destination must be an absent or empty real directory');
    let prior;
    try {
      const receiptPath = path.join(target, RECEIPT);
      if (fs.lstatSync(receiptPath).isFile() && !fs.lstatSync(receiptPath).isSymbolicLink()) prior = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    } catch { /* an unrecognized destination is never merged */ }
    if (prior?.schema === 1 && prior.source === source && prior.target === target && prior.sourceDigest === sourceDigest) {
      return { ...base, dryRun, unchanged: true, receipt: path.join(target, RECEIPT) };
    }
    if (fs.readdirSync(target).length) throw fail('destination is populated or the source changed since migration; refusing to merge or overwrite');
  }
  if (dryRun) return { ...base, dryRun: true, unchanged: false };
  const staging = fs.mkdtempSync(path.join(parent, '.ae-migrate-'));
  try {
    for (const rel of snapshot.directories) if (rel) fs.mkdirSync(path.join(staging, rel), { recursive: true, mode: 0o700 });
    for (const entry of snapshot.files) {
      const input = path.join(source, entry.path), output = path.join(staging, entry.path);
      fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(output, fs.statSync(input).mode & 0o777);
    }
    if (digest(inventory(source)) !== sourceDigest || digest(inventory(staging)) !== sourceDigest) throw fail('source or copy changed; nothing published, stop writers and retry');
    const receipt = { schema: 1, ...base, completedAt: new Date().toISOString(), inventory: snapshot };
    fs.writeFileSync(path.join(staging, RECEIPT), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (targetStat) fs.rmdirSync(target);
    fs.renameSync(staging, target);
    return { ...base, dryRun: false, unchanged: false, receipt: path.join(target, RECEIPT) };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
