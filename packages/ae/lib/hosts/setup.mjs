import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertNoSymlinkAncestors, readFileNoFollow } from '../fs-safe.mjs';
import { harnessGlobalHome } from '../paths.mjs';
import { projectHostCorpus } from './projection.mjs';
import { nativeHookConfig } from './native-hook.mjs';

const MANIFEST = '.ae-host.json';
const SKILLS_OWNER = '.ae-host-skills.json';
const HOSTS = ['claude-code', 'codex', 'cursor', 'terminal'];
const own = (object, key) => Object.hasOwn(object, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const equal = (left, right) => left === null ? right === null : right !== null && left.equals(right);
const equivalent = isDeepStrictEqual;
const slash = value => value.replaceAll('\\', '/');

function resolveRoots(options) {
  const home = path.resolve(options.home || harnessGlobalHome());
  const defaultConfig = options.host === 'terminal' ? path.join(home, 'terminal') : path.join(os.homedir(), options.host === 'claude-code' ? '.claude' : `.${options.host}`);
  const configHome = path.resolve(options.configHome || defaultConfig);
  const skillsHome = path.resolve(options.skillsHome || (options.host === 'codex' ? path.join(os.homedir(), '.agents', 'skills') : path.join(configHome, 'skills')));
  if (configHome === skillsHome || configHome.startsWith(skillsHome + path.sep)) throw new Error('Host config home must not equal or be inside its skills home');
  for (const root of [home, configHome, skillsHome]) {
    if (/[\u0000-\u001f\u007f]/.test(root)) throw new Error('Host paths cannot contain control characters');
    const base = path.parse(root).root;
    if (!assertNoSymlinkAncestors(base, path.relative(base, root))) throw new Error(`Refusing redirected host root: ${root}`);
  }
  return { home, configHome, skillsHome };
}

function filename(roots, root, relative) {
  if (!['config', 'skills'].includes(root) || typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid host-owned path');
  const directory = roots[root === 'config' ? 'configHome' : 'skillsHome'];
  const full = assertNoSymlinkAncestors(directory, relative);
  if (!full) throw new Error(`Refusing redirected host asset: ${relative}`);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`Host asset is not a regular file: ${full}`);
  return full;
}

function bytes(full) {
  if (!fs.existsSync(full)) return null;
  const value = readFileNoFollow(full, { maxBytes: 10 * 1024 * 1024, encoding: null });
  if (value === null) throw new Error(`Cannot safely read host asset: ${full}`);
  return value;
}

function parseObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(value.toString('utf8')); }
  catch { throw new Error(`Invalid JSON in ${label}`); }
  if (!object(parsed)) throw new Error(`Expected an object in ${label}`);
  return parsed;
}

function readManifest(roots, host) {
  const full = filename(roots, 'config', MANIFEST), raw = bytes(full);
  if (raw === null) return null;
  const manifest = parseObject(raw, full);
  if (manifest.schema !== 1 || manifest.host !== host || manifest.configHome !== roots.configHome || manifest.skillsHome !== roots.skillsHome || !Array.isArray(manifest.files) || !object(manifest.hooks) || !Array.isArray(manifest.hooks.groups)) throw new Error(`Invalid or mismatched host ownership record: ${full}`);
  const seen = new Set();
  for (const file of manifest.files) {
    if (!object(file) || typeof file.owned !== 'boolean' || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw new Error(`Invalid owned file in ${full}`);
    const key = filename(roots, file.root, file.path);
    if (seen.has(key) || [MANIFEST, SKILLS_OWNER].includes(file.path)) throw new Error(`Duplicate or reserved owned file in ${full}`);
    seen.add(key);
  }
  if (typeof manifest.hooks.created !== 'boolean' || ![null, host === 'claude-code' ? 'settings.json' : 'hooks.json'].includes(manifest.hooks.path)) throw new Error(`Invalid native hook ownership in ${full}`);
  if (manifest.hooks.path !== null) filename(roots, 'config', manifest.hooks.path);
  for (const entry of manifest.hooks.groups) if (!object(entry) || typeof entry.event !== 'string' || !object(entry.group)) throw new Error(`Invalid owned hook in ${full}`);
  return manifest;
}

function readOwner(roots) {
  const full = filename(roots, 'skills', SKILLS_OWNER), raw = bytes(full);
  if (raw === null) return null;
  const owner = parseObject(raw, full);
  if (owner.schema !== 1 || typeof owner.host !== 'string' || typeof owner.configHome !== 'string' || typeof owner.skillsHome !== 'string') throw new Error(`Invalid skills ownership record: ${full}`);
  return owner;
}

function hookDocument(roots, relative) {
  const full = filename(roots, 'config', relative), raw = bytes(full);
  const document = raw === null ? {} : parseObject(raw, full);
  if (document.hooks !== undefined && !object(document.hooks)) throw new Error(`Invalid hooks object in ${full}`);
  for (const [event, groups] of Object.entries(document.hooks || {})) {
    if (!Array.isArray(groups) || groups.some(group => !object(group))) throw new Error(`Invalid hook groups for ${event} in ${full}`);
  }
  return { full, raw, document };
}

function stripOwnedGroups(document, groups) {
  const missing = [];
  for (const { event, group } of groups) {
    const list = document.hooks?.[event] || [];
    const index = list.findIndex(item => equivalent(item, group));
    if (index < 0) missing.push(event);
    else list.splice(index, 1);
    if (!list.length && document.hooks) delete document.hooks[event];
  }
  return missing;
}

function addChange(changes, full, next) {
  const previous = bytes(full);
  if (!equal(previous, next)) changes.push({ full, previous, next });
}

function atomicWrite(full, value) {
  const temporary = path.join(path.dirname(full), `.${path.basename(full)}.ae-${randomUUID()}`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  try { fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, full); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function applyChanges(roots, changes) {
  if (!changes.length) return;
  const locks = [path.join(roots.configHome, '.ae-host.lock'), path.join(roots.skillsHome, '.ae-host-skills.lock')].sort();
  const acquired = [];
  const completed = [];
  const checkSnapshot = item => {
    const root = item.full === roots.skillsHome || item.full.startsWith(roots.skillsHome + path.sep) ? roots.skillsHome : roots.configHome;
    if (!assertNoSymlinkAncestors(root, path.relative(root, item.full)) || !equal(bytes(item.full), item.previous)) throw new Error(`Host asset changed during setup: ${item.full}`);
  };
  try {
    for (const lock of locks) {
      const root = lock.startsWith(roots.skillsHome + path.sep) ? roots.skillsHome : roots.configHome;
      if (!assertNoSymlinkAncestors(root, path.relative(root, lock))) throw new Error('Refusing redirected host setup lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      try { fs.mkdirSync(lock); }
      catch (error) { if (error.code === 'EEXIST') throw new Error(`Host setup is already locked: ${lock}`); throw error; }
      acquired.push(lock);
    }
    // Both ownership boundaries are locked. Recheck before any publication and
    // again at each destination so an editor update during a large install survives.
    for (const item of changes) checkSnapshot(item);
    for (const item of changes) {
      checkSnapshot(item);
      if (item.next === null) fs.unlinkSync(item.full);
      else atomicWrite(item.full, item.next);
      completed.push(item);
    }
  } catch (error) {
    const failures = [];
    for (const item of completed.reverse()) {
      try {
        if (!equal(bytes(item.full), item.next)) throw new Error('changed after publication');
        if (item.previous === null) fs.unlinkSync(item.full);
        else atomicWrite(item.full, item.previous);
      } catch { failures.push(item.full); }
    }
    if (failures.length) error.message += `; rollback preserved changed paths: ${failures.join(', ')}`;
    throw error;
  } finally { for (const lock of acquired.reverse()) fs.rmdirSync(lock); }
}

function statusOf(roots, manifest, expectedVersion) {
  if (!manifest) return { configured: false, assetState: 'absent', changed: [] };
  const changed = [];
  for (const file of manifest.files) {
    const full = filename(roots, file.root, file.path), current = bytes(full);
    if (current === null || hash(current) !== file.sha256) changed.push(full);
  }
  if (manifest.hooks.path) {
    const { document, full } = hookDocument(roots, manifest.hooks.path);
    for (const { event, group } of manifest.hooks.groups) if (!(document.hooks?.[event] || []).some(item => equivalent(item, group))) changed.push(full);
  }
  return { configured: true, assetState: changed.length ? 'changed' : manifest.packageVersion !== expectedVersion ? 'outdated' : 'current', changed: [...new Set(changed)] };
}

/** Install only the selected integration. Configuration is never native proof or trust. */
export function runHostSetup(options = {}) {
  const result = { schema: 1, mode: 'host', verb: options.verb || 'list', host: options.host || null, status: 'ok', exitCode: 0, configured: false, nativeQualification: 'unverified', actions: [], conflicts: [], preserved: [], capabilities: {}, limitations: [] };
  try {
    if (result.verb === 'list') return { ...result, hosts: HOSTS.map(host => ({ host, nativeQualification: 'unverified', setup: `ae host setup --host ${host}` })) };
    if (!['setup', 'status', 'remove'].includes(result.verb)) throw new Error('Host verb must be list, setup, status or remove');
    if (!HOSTS.includes(result.host)) throw new Error(`Unsupported host: ${result.host}`);
    const roots = resolveRoots(options);
    result.roots = roots;
    const packageRoot = path.resolve(options.packageRoot || fileURLToPath(new URL('../..', import.meta.url)));
    const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
    const manifest = readManifest(roots, result.host);
    const owner = readOwner(roots);
    const ownerMatches = !owner || owner.host === result.host && owner.configHome === roots.configHome && owner.skillsHome === roots.skillsHome;
    if (!ownerMatches) {
      result.conflicts.push(filename(roots, 'skills', SKILLS_OWNER));
      return { ...result, status: 'conflict', exitCode: 1, reason: 'The skills home belongs to another AE integration' };
    }
    if (result.verb === 'status') return { ...result, ...statusOf(roots, manifest, packageVersion), capabilities: manifest?.capabilities || {}, limitations: manifest?.limitations || [] };
    if (result.verb === 'remove' && !manifest) return { ...result, assetState: 'absent' };
    const changes = [];
    if (result.verb === 'setup') {
      const projection = projectHostCorpus({ packageRoot, host: result.host, ...roots });
      result.capabilities = projection.capabilities;
      result.limitations = projection.limitations;
      const previous = new Map((manifest?.files || []).map(file => [`${file.root}/${file.path}`, file]));
      const nextFiles = [];
      const seen = new Set();
      for (const file of projection.files) {
        const full = filename(roots, file.root, file.path), current = bytes(full), desired = Buffer.from(file.content);
        if (seen.has(full) || [MANIFEST, SKILLS_OWNER].includes(file.path)) throw new Error(`Duplicate or reserved projection path: ${full}`);
        seen.add(full);
        const old = previous.get(`${file.root}/${file.path}`);
        previous.delete(`${file.root}/${file.path}`);
        const owned = Boolean(old?.owned || current === null);
        if (current !== null && (!old?.owned || hash(current) !== old.sha256) && !current.equals(desired)) result.conflicts.push(full);
        else addChange(changes, full, desired);
        nextFiles.push({ root: file.root, path: file.path, sha256: hash(desired), owned });
      }
      for (const old of previous.values()) {
        const full = filename(roots, old.root, old.path), current = bytes(full);
        if (old.owned && current !== null && hash(current) === old.sha256) addChange(changes, full, null);
        else if (current !== null) result.preserved.push(full);
      }
      let hookRecord = { path: null, groups: [], created: false };
      const native = result.host === 'terminal' ? null : nativeHookConfig({ host: result.host, packageRoot, ...roots });
      if (native?.path) {
        const { document, full, raw } = hookDocument(roots, native.path);
        if (manifest?.hooks.path && manifest.hooks.path !== native.path) throw new Error('Native hook configuration path changed; remove the previous integration first');
        if (stripOwnedGroups(document, manifest?.hooks.groups || []).length) result.conflicts.push(full);
        if (native.value.version !== undefined && document.version !== undefined && document.version !== native.value.version) throw new Error(`Unsupported native hooks version: ${full}`);
        if (native.value.version !== undefined) document.version = native.value.version;
        document.hooks ||= {};
        const ownedGroups = [];
        for (const [event, groups] of Object.entries(native.value.hooks || {})) {
          document.hooks[event] ||= [];
          for (const group of groups) {
            if (!document.hooks[event].some(item => equivalent(item, group))) {
              document.hooks[event].push(group);
              ownedGroups.push({ event, group });
            }
          }
        }
        hookRecord = { path: native.path, groups: ownedGroups, created: manifest?.hooks.created ?? raw === null };
        addChange(changes, full, json(document));
      }
      if (result.conflicts.length) return { ...result, status: 'conflict', exitCode: 1, reason: 'Unowned or modified host assets were preserved', actions: [] };
      addChange(changes, filename(roots, 'skills', SKILLS_OWNER), json({ schema: 1, host: result.host, configHome: roots.configHome, skillsHome: roots.skillsHome }));
      const next = { schema: 1, host: result.host, ...roots, packageRoot, packageVersion, capabilities: projection.capabilities, limitations: projection.limitations, files: nextFiles, hooks: hookRecord };
      addChange(changes, filename(roots, 'config', MANIFEST), json(next));
      result.configured = true;
      result.assetState = 'current';
    } else {
      for (const file of manifest.files) {
        const full = filename(roots, file.root, file.path), current = bytes(full);
        if (file.owned && current !== null && hash(current) === file.sha256) addChange(changes, full, null);
        else if (current !== null) result.preserved.push(full);
      }
      if (manifest.hooks.path) {
        const { document, full, raw } = hookDocument(roots, manifest.hooks.path);
        if (raw !== null) {
          if (stripOwnedGroups(document, manifest.hooks.groups).length) result.preserved.push(full);
          const empty = !Object.keys(document.hooks || {}).length && Object.keys(document).every(key => ['version', 'hooks'].includes(key));
          addChange(changes, full, manifest.hooks.created && empty ? null : json(document));
        }
      }
      if (owner) addChange(changes, filename(roots, 'skills', SKILLS_OWNER), null);
      addChange(changes, filename(roots, 'config', MANIFEST), null);
      result.assetState = 'absent';
    }
    result.actions = changes.map(change => ({ kind: change.next === null ? 'remove' : change.previous === null ? 'create' : 'update', path: change.full }));
    result.dryRun = Boolean(options.dryRun);
    if (!options.dryRun) applyChanges(roots, changes);
    return result;
  } catch (error) {
    return { ...result, status: 'failed', exitCode: 2, configured: false, reason: error.message, actions: [] };
  }
}
