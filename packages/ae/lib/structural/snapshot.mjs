import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained, DEFAULT_MAX_BYTES } from '../fs-safe.mjs';

const TABLES = ['meta.json', 'files.json', 'symbols.json', 'graph.json'];
const GENERATION = /^[a-f0-9]{32}$/;
const hash = body => createHash('sha256').update(body).digest('hex');

function safeRoot(root) {
  const home = path.resolve(root, '..', '..', '..', '..');
  return assertNoSymlinkAncestors(home, path.relative(home, root));
}

function table(dir, name, digest = null) {
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) return { value: null, error: digest || TABLES.includes(name) && name !== 'meta.json' ? `${name} is missing` : null };
  const body = readFileNoFollow(full, { root: dir, maxBytes: ['current.json', 'manifest.json', 'owner.json'].includes(name) ? 16_384 : DEFAULT_MAX_BYTES });
  if (body === null) return { value: null, error: `${name} is unreadable (oversized, symlink, or open failure)` };
  if (digest && hash(body) !== digest) return { value: null, error: `${name} integrity mismatch` };
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value, error: null } : { value: null, error: `${name} is not a JSON object` };
  } catch {
    return { value: null, error: `${name} is not valid JSON` };
  }
}

function manifest(root) {
  const full = path.join(root, 'current.json');
  if (!fs.existsSync(full)) return { value: null, error: null };
  const parsed = table(root, 'current.json');
  if (parsed.error) return parsed;
  const value = parsed.value;
  if (value?.version !== 1 || !GENERATION.test(value.generation) || TABLES.some(name => !/^[a-f0-9]{64}$/.test(value.tables?.[name]))) {
    return { value: null, error: 'invalid current.json generation or table hashes' };
  }
  return parsed;
}

export function currentSnapshotDir(root) {
  const current = manifest(root);
  return current.value ? path.join(root, 'generations', current.value.generation) : root;
}

function withSnapshotLock(root, fn) {
  if (!safeRoot(root)) throw new Error('unsafe structural cache directory');
  const lockPath = assertNoSymlinkAncestors(root, '.snapshot-lock');
  if (!lockPath) throw new Error('unsafe structural snapshot lock');
  const recovery = assertNoSymlinkAncestors(root, '.snapshot-recovery');
  if (!recovery || fs.existsSync(recovery)) throw new Error('structural snapshot busy; retry');
  const owner = { token: randomUUID(), pid: process.pid };
  const readOwner = dir => table(dir, 'owner.json').value;
  const create = () => {
    fs.mkdirSync(lockPath);
    if (!writeFileContained(lockPath, 'owner.json', JSON.stringify(owner) + '\n')) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      throw new Error('cannot stamp structural snapshot lock');
    }
  };
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = readOwner(lockPath);
    if (!prior?.token || !Number.isSafeInteger(prior.pid) || prior.pid <= 0) throw new Error('structural snapshot lock has no readable owner; inspect before removing it');
    try { process.kill(prior.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') prior.dead = true; }
    if (!prior.dead) throw new Error('structural snapshot busy; retry');
    try { fs.mkdirSync(recovery); }
    catch { throw new Error('structural snapshot recovery busy; retry'); }
    try {
      if (readOwner(lockPath)?.token !== prior.token) throw new Error('structural snapshot owner changed; retry');
      const retired = path.join(recovery, 'retired');
      fs.renameSync(lockPath, retired);
      if (readOwner(retired)?.token !== prior.token) throw new Error('structural snapshot recovery owner mismatch');
      fs.rmSync(retired, { recursive: true, force: true });
      create();
    } finally {
      fs.rmSync(recovery, { recursive: true, force: true });
    }
  }
  try {
    return fn();
  } finally {
    if (readOwner(lockPath)?.token !== owner.token) throw new Error('structural snapshot lock ownership lost');
    fs.rmSync(lockPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

export function readSnapshot(root, { expectedSha = null, generation: selectedGeneration = null } = {}) {
  if (!fs.existsSync(root)) return null;
  const broken = (error) => ({ root, dir: root, meta: null, files: {}, symbols: {}, graph: {}, unreadable: [error], generation: null, legacy: false });
  try {
    return withSnapshotLock(root, () => {
      if (selectedGeneration !== null && !GENERATION.test(selectedGeneration)) return broken('invalid selected structural generation');
      const current = selectedGeneration === null ? manifest(root) : { value: null, error: null };
      if (current.error) return broken(current.error);
      const generation = selectedGeneration || current.value?.generation || null;
      const dir = generation ? path.join(root, 'generations', generation) : root;
      if (!assertNoSymlinkAncestors(root, path.relative(root, dir))) return broken('unsafe structural generation directory');
      let hashes = current.value?.tables;
      if (selectedGeneration) {
        const retained = table(dir, 'manifest.json');
        if (retained.error || retained.value?.version !== 1 || retained.value.generation !== generation
          || TABLES.some(name => !/^[a-f0-9]{64}$/.test(retained.value.tables?.[name]))) return broken(retained.error || 'selected structural generation has no valid integrity manifest');
        hashes = retained.value.tables;
      }
      const meta = table(dir, 'meta.json', hashes?.['meta.json']);
      if (!meta.value && !meta.error) return null;
      if (meta.error) return broken(meta.error);
      if (generation && meta.value.generation !== generation) return broken('meta.json generation mismatch');
      if (expectedSha && meta.value.sha !== expectedSha) return null;
      const values = TABLES.slice(1).map(name => table(dir, name, hashes?.[name]));
      const unreadable = values.map(value => value.error).filter(Boolean);
      if (!generation) {
        const after = table(dir, 'meta.json');
        if (after.error || JSON.stringify(after.value) !== JSON.stringify(meta.value)) return broken('legacy structural generation changed while reading');
      }
      return { root, dir, meta: meta.value, files: values[0].value || {}, symbols: values[1].value || {}, graph: values[2].value || {}, unreadable, generation, legacy: !generation };
    });
  } catch (error) {
    return broken(error.message);
  }
}

function discard(root, rel) {
  const full = assertNoSymlinkAncestors(root, rel);
  if (!full) return;
  try { fs.rmSync(full, { recursive: true, force: true }); }
  catch { /* Derived cache cleanup can be retried by a later publication. */ }
}

export function publishSnapshot(root, writes) {
  const generation = randomUUID().replaceAll('-', '');
  const stagingRel = `.staging-${process.pid}-${generation}`;
  const staging = path.join(root, stagingRel);
  try {
    if (!safeRoot(root)) return { ok: false, failed: 'unsafe structural cache directory' };
    fs.mkdirSync(staging, { recursive: true });
    const tables = {};
    for (const [name, value] of writes) {
      if (!TABLES.includes(name)) throw new Error('unknown structural table');
      const payload = name === 'meta.json' ? { ...value, generation } : value;
      const body = JSON.stringify(payload) + '\n';
      if (Buffer.byteLength(body) > DEFAULT_MAX_BYTES || !writeFileContained(staging, name, body)) throw new Error(`cannot write bounded ${name}`);
      tables[name] = hash(body);
    }
    if (TABLES.some(name => !tables[name])) throw new Error('incomplete structural snapshot');
    if (!writeFileContained(staging, 'manifest.json', JSON.stringify({ version: 1, generation, tables }) + '\n')) throw new Error('cannot write structural generation manifest');
    return withSnapshotLock(root, () => {
      const previous = manifest(root).value?.generation || null;
      const generations = assertNoSymlinkAncestors(root, 'generations');
      if (!generations) throw new Error('unsafe generation store');
      fs.mkdirSync(generations, { recursive: true });
      const dir = path.join(generations, generation);
      fs.renameSync(staging, dir);
      if (!writeFileContained(root, 'current.json', JSON.stringify({ version: 1, generation, tables }) + '\n')) {
        discard(root, path.relative(root, dir));
        throw new Error('current generation publication refused');
      }
      for (const name of fs.readdirSync(generations)) {
        if (GENERATION.test(name) && name !== generation && name !== previous) discard(root, path.join('generations', name));
      }
      for (const name of fs.readdirSync(root)) {
        const match = /^\.staging-(\d+)-[a-f0-9]{32}$/.exec(name);
        if (!match) continue;
        try { process.kill(Number(match[1]), 0); }
        catch (error) { if (error.code === 'ESRCH') discard(root, name); }
      }
      return { ok: true, dir, generation, failed: null };
    });
  } catch (error) {
    return { ok: false, failed: error.message };
  } finally {
    discard(root, stagingRel);
  }
}
