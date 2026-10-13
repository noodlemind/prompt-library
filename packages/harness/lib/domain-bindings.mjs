import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readDomain, logicalDomainContract, normalizeDomainOrigin, observeDomainRepositoryIdentity } from './domain-contract.mjs';
import { hashIntentFile } from './intent-sources.mjs';
import { assertNoSymlinkAncestors, canonicalPath, readFileNoFollow } from './fs-safe.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MAX_BINDING_BYTES = 256 * 1024;
const FILESYSTEM_FIELDS = ['primaryRoot', 'executionRoot', 'commonDir', 'gitDir'];
const STAT_FIELDS = ['dev', 'ino', 'birthtimeNs'];
const MAX_STAT_VALUE = 18446744073709551615n;

function failure(message) {
  return Object.assign(new Error(`domain: ${message}`), { code: 'E_DOMAIN_BINDING', exit: 1 });
}

function mapping(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure(`${label} has an unsupported shape`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function validStatValue(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= MAX_STAT_VALUE;
}

function validateDirectoryIdentity(identity) {
  mapping(identity, STAT_FIELDS, 'accepted filesystem directory identity');
  if (STAT_FIELDS.some(key => !validStatValue(identity[key]))) throw failure('filesystem directory identity requires bounded nonzero device, inode and birth time');
}

function directoryIdentity(root) {
  let stat;
  try {
    stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || canonicalPath(root) !== root) throw failure('filesystem identity path must be a canonical directory');
  } catch { throw failure('stable filesystem directory identity is unavailable'); }
  const identity = Object.fromEntries(STAT_FIELDS.map(key => [key, typeof stat[key] === 'bigint' ? stat[key].toString() : null]));
  validateDirectoryIdentity(identity);
  return identity;
}

function validateFilesystemIdentity(identity) {
  mapping(identity, FILESYSTEM_FIELDS, 'accepted filesystem identity');
  for (const field of FILESYSTEM_FIELDS) validateDirectoryIdentity(identity[field]);
}

function distinctRepositoryBindings(entries) {
  const roots = new Set();
  const commonDirs = new Set();
  for (const entry of entries) {
    const rootIdentity = digest(entry.filesystemIdentity.executionRoot);
    const commonIdentity = digest(entry.filesystemIdentity.commonDir);
    if (roots.has(entry.root) || roots.has(rootIdentity) || commonDirs.has(entry.commonDir) || commonDirs.has(commonIdentity)) throw failure('repository members require distinct execution roots and physical common Git identities');
    roots.add(entry.root);
    roots.add(rootIdentity);
    commonDirs.add(entry.commonDir);
    commonDirs.add(commonIdentity);
  }
}

function observedIdentity(root, descriptor) {
  const result = observeDomainRepositoryIdentity(root, descriptor);
  const observed = result.observed;
  if (result.status !== 'available' || !observed.head || !observed.root || !observed.commonDir || !observed.gitDir) throw failure(`${descriptor.id} Git identity or HEAD is unavailable`);
  const origin = observed.origin === null ? null : normalizeDomainOrigin(observed.origin);
  if (descriptor.origin && origin !== descriptor.origin) throw failure(`${descriptor.id} observed origin differs from the accepted logical identity`);
  return { ...observed, origin };
}

function memberBindings(config, kind, overrides) {
  const members = config[kind];
  const allowed = members.map(member => member.id);
  mapping(config.bindings?.[kind], allowed, `${kind} root bindings`);
  mapping(overrides, allowed, `${kind} execution overrides`);
  return members.map(member => {
    const primary = observedIdentity(config.bindings[kind][member.id], member);
    const executionRoot = Object.hasOwn(overrides, member.id) ? overrides[member.id] : primary.root;
    const execution = executionRoot === primary.root ? primary : observedIdentity(executionRoot, member);
    if (execution.root !== primary.root) {
      const registration = path.relative(path.join(primary.commonDir, 'worktrees'), execution.gitDir);
      const backlink = readFileNoFollow(path.join(execution.gitDir, 'gitdir'), { root: execution.gitDir, maxBytes: 4096 });
      const backlinkPath = backlink ? path.resolve(execution.gitDir, backlink.trim()) : null;
      const safeBacklink = backlinkPath && assertNoSymlinkAncestors(path.parse(backlinkPath).root, path.relative(path.parse(backlinkPath).root, backlinkPath));
      if (!execution.isLinkedWorktree || execution.commonDir !== primary.commonDir || !registration || registration.startsWith('..') || registration.includes(path.sep)
        || !safeBacklink || canonicalPath(safeBacklink) !== canonicalPath(path.join(execution.root, '.git'))) throw failure(`${member.id} execution override must be a registered linked worktree with the same primary common Git identity`);
    }
    const filesystemIdentity = { primaryRoot: directoryIdentity(primary.root), executionRoot: directoryIdentity(execution.root), commonDir: directoryIdentity(execution.commonDir), gitDir: directoryIdentity(execution.gitDir) };
    return { id: member.id, primaryRoot: primary.root, root: execution.root, origin: execution.origin, commonDir: execution.commonDir, gitDir: execution.gitDir, filesystemIdentity };
  });
}

function authoritativeSources(logical) {
  return [...logical.shared_specs.map(ref => ({ ...ref, authority: 'spec' })), ...logical.shared_conventions.filter(ref => ref.authority === 'authoritative')]
    .sort((a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path) || a.authority.localeCompare(b.authority));
}

export function snapshotDomain(record, { executionRoots = {} } = {}) {
  const logical = logicalDomainContract(record?.config);
  mapping(record.config.bindings, ['repos', 'sources'], 'local root bindings');
  mapping(executionRoots, ['repos', 'sources'], 'execution overrides');
  const bindings = Object.fromEntries(['repos', 'sources'].map(kind => [kind, memberBindings({ ...logical, bindings: record.config.bindings }, kind, executionRoots[kind] ?? {})]));
  const sources = new Map(bindings.sources.map(source => [source.id, source]));
  const sharedSources = authoritativeSources(logical).map(ref => {
    const sha256 = hashIntentFile(sources.get(ref.source).root, ref.path);
    if (!sha256) throw failure(`shared source ${ref.source}/${ref.path} is unreadable, unsafe or not a regular file`);
    return { ...ref, sha256 };
  });
  return acceptedSnapshot({ version: 1, name: logical.name, logicalDigest: digest(logical), executionDigest: digest(bindings), logical, bindings, sharedSources });
}

function acceptedSnapshot(binding) {
  let encoded;
  try { encoded = JSON.stringify(binding); } catch { throw failure('accepted shared binding is not finite acyclic data'); }
  if (Buffer.byteLength(encoded || '') > MAX_BINDING_BYTES) throw failure('accepted shared binding exceeds its size bound');
  mapping(binding, ['version', 'name', 'logicalDigest', 'executionDigest', 'logical', 'bindings', 'sharedSources'], 'accepted shared binding');
  if (binding.version !== 1 || !HASH.test(binding.logicalDigest || '') || !HASH.test(binding.executionDigest || '')) throw failure('accepted shared binding requires supported version and content digests');
  mapping(binding.logical, ['domain_version', 'name', 'repos', 'sources', 'shared_specs', 'shared_conventions'], 'accepted logical contract');
  const logical = logicalDomainContract(binding.logical);
  if (binding.name !== logical.name || digest(logical) !== binding.logicalDigest || digest(binding.logical) !== binding.logicalDigest) throw failure('accepted logical domain contract digest is invalid');
  mapping(binding.bindings, ['repos', 'sources'], 'accepted execution bindings');
  for (const kind of ['repos', 'sources']) {
    const entries = binding.bindings[kind];
    if (!Array.isArray(entries) || entries.length !== logical[kind].length || new Set(entries.map(entry => entry?.id)).size !== entries.length) throw failure(`accepted ${kind} execution bindings do not match unique membership`);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      mapping(entry, ['id', 'primaryRoot', 'root', 'origin', 'commonDir', 'gitDir', 'filesystemIdentity'], 'accepted execution member');
      if (entry.id !== logical[kind][index].id || ['primaryRoot', 'root', 'commonDir', 'gitDir'].some(key => typeof entry[key] !== 'string' || !path.isAbsolute(entry[key]) || Buffer.byteLength(entry[key]) > 4096 || /[\x00-\x1f\x7f]/.test(entry[key]))) throw failure('accepted execution member must have canonical absolute identity paths');
      if (entry.origin !== null && normalizeDomainOrigin(entry.origin) !== entry.origin) throw failure('accepted execution origin is not normalized');
      validateFilesystemIdentity(entry.filesystemIdentity);
    }
  }
  distinctRepositoryBindings(binding.bindings.repos);
  if (digest(binding.bindings) !== binding.executionDigest) throw failure('accepted execution binding digest is invalid');
  const refs = authoritativeSources(logical);
  if (!Array.isArray(binding.sharedSources) || binding.sharedSources.length !== refs.length) throw failure('accepted shared source membership does not cover logical obligations');
  for (let index = 0; index < refs.length; index++) {
    const entry = binding.sharedSources[index];
    mapping(entry, ['source', 'path', 'authority', 'sha256'], 'accepted shared source');
    if (!HASH.test(entry.sha256 || '') || digest({ source: entry.source, path: entry.path, authority: entry.authority }) !== digest(refs[index])) throw failure('accepted shared source membership or content hash is invalid');
  }
  return binding;
}

function acceptedExecutionRoots(binding) {
  return Object.fromEntries(['repos', 'sources'].map(kind => [kind, Object.fromEntries(binding.bindings[kind].map(member => [member.id, member.root]))]));
}

export function domainAuthorityBinding(workspace, plan, { home } = {}) {
  const accepted = plan?.fm?.domain_binding ?? null;
  if (!accepted) {
    const required = Boolean(plan?.fm?.domain_child || plan?.fm?.domain_parent);
    return { accepted: null, current: null, pass: !required, diagnostics: required ? ['Domain execution requires an accepted shared binding.'] : [] };
  }
  const diagnostics = [];
  let current = null;
  try {
    acceptedSnapshot(accepted);
    const domainName = plan?.fm?.domain_child?.name ?? plan?.fm?.domain_parent?.name;
    if (domainName !== undefined && domainName !== accepted.name) throw failure('parent or child domain name differs from its accepted shared binding');
    const record = readDomain(accepted.name, { home });
    if (record.config.domain_version !== 2) throw failure('accepted executable domain requires version 2; version 1 is advisory');
    const logical = logicalDomainContract(record.config);
    if (digest(logical) !== accepted.logicalDigest) throw failure('logical domain contract membership or authority changed; accept an explicit amendment');
    current = snapshotDomain(record, { executionRoots: acceptedExecutionRoots(accepted) });
    if (current.executionDigest !== accepted.executionDigest) diagnostics.push('Domain execution root or Git identity changed; revalidate and accept refreshed execution authority.');
    if (digest(current.sharedSources) !== digest(accepted.sharedSources)) diagnostics.push('Shared intent source bytes changed or became unreadable; accept an explicit amendment.');
    const childId = plan?.fm?.domain_child?.repoId;
    if (childId !== undefined) {
      const member = accepted.bindings.repos.find(repo => repo.id === childId);
      if (!member) diagnostics.push('Domain child names a repository outside the accepted membership.');
      else {
        let realWorkspace = null;
        try {
          const requested = path.resolve(workspace);
          if (assertNoSymlinkAncestors(path.parse(requested).root, path.relative(path.parse(requested).root, requested))) realWorkspace = canonicalPath(requested);
        } catch {}
        if (realWorkspace !== member.root) diagnostics.push('Domain child workspace differs from its accepted execution root.');
      }
    }
  } catch (error) {
    diagnostics.push(error?.code?.startsWith('E_DOMAIN') ? error.message : 'Domain authority is unavailable or malformed.');
  }
  return { accepted, current, pass: diagnostics.length === 0, diagnostics };
}

export function sharedIntentCheck(workspace, plan, options = {}) {
  const binding = domainAuthorityBinding(workspace, plan, options);
  return { id: 'C-shared-intent-sources', pass: binding.pass, severity: binding.pass ? 'ok' : 'fail', message: binding.accepted ? (binding.pass ? 'Accepted domain membership, execution identity and shared source bytes are current' : binding.diagnostics.join(' ')) : (binding.pass ? 'No accepted shared domain obligations' : binding.diagnostics.join(' ')), binding };
}
