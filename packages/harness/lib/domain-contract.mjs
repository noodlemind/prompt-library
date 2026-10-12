import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { harnessGlobalHome } from './paths.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';
import { readGitArgs } from '../corpus/hooks/lib/product-diff.mjs';

const DOMAIN_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REPOS = 32;
const MAX_REFERENCES = 64;
const GIT_TIMEOUT = 4000;
const GIT_MAX_BYTES = 64 * 1024;

function failure(message) {
  return Object.assign(new Error(`domain: ${message}`), { code: 'E_DOMAIN', exit: 1 });
}

function boundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function validName(name) {
  return typeof name === 'string' && name.length <= 64 && DOMAIN_NAME.test(name);
}

function objectWithKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(`${label} must be a mapping`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw failure(`${label} contains an unsupported field: ${key}`);
  }
}

function safeAbsolute(full, label) {
  if (!boundedText(full, 4096) || !path.isAbsolute(full)) throw failure(`${label} must be a bounded absolute path`);
  const resolved = path.resolve(full);
  const anchor = path.parse(resolved).root;
  if (!assertNoSymlinkAncestors(anchor, path.relative(anchor, resolved))) throw failure(`${label} is unsafe or symlinked`);
  return resolved;
}

function validateReferences(refs, repoIds, label) {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.length > MAX_REFERENCES) throw failure(`${label} must contain at most ${MAX_REFERENCES} references`);
  const seen = new Set();
  return refs.map(ref => {
    objectWithKeys(ref, ['repo', 'path'], `${label} reference`);
    if (!repoIds.has(ref.repo)) throw failure(`${label} reference names an unknown repo`);
    if (!boundedText(ref.path, 1024) || path.isAbsolute(ref.path) || ref.path.includes('\\') || ref.path.includes(':') || ref.path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw failure(`${label} reference must use a safe relative path`);
    }
    const key = `${ref.repo}\0${ref.path}`;
    if (seen.has(key)) throw failure(`${label} contains a duplicate reference`);
    seen.add(key);
    return { repo: ref.repo, path: ref.path };
  });
}

function validateV1(config, name) {
  objectWithKeys(config, ['domain_version', 'name', 'repos', 'shared_specs', 'shared_conventions'], 'domain config');
  if (config.domain_version !== 1) throw failure('unsupported domain_version; this reader supports version 1 display only');
  if (config.name !== name) throw failure('config name does not match the selected domain name');
  if (!Array.isArray(config.repos) || config.repos.length < 1 || config.repos.length > MAX_REPOS) throw failure(`repos must contain 1-${MAX_REPOS} members`);
  const ids = new Set();
  const repos = config.repos.map(repo => {
    objectWithKeys(repo, ['id', 'origin', 'root'], 'domain repo');
    if (!validName(repo.id) || ids.has(repo.id)) throw failure('repo IDs must be unique lowercase names');
    if (!boundedText(repo.origin, 2048)) throw failure('repo origin must be a bounded nonempty expected origin');
    ids.add(repo.id);
    return { id: repo.id, origin: repo.origin, root: safeAbsolute(repo.root, `repo ${repo.id} root`) };
  });
  return {
    domain_version: 1,
    name,
    repos,
    shared_specs: validateReferences(config.shared_specs, ids, 'shared_specs'),
    shared_conventions: validateReferences(config.shared_conventions, ids, 'shared_conventions'),
  };
}

export function readDomain(name, { home = harnessGlobalHome() } = {}) {
  if (!validName(name)) throw failure('name must be a lowercase hyphenated name of at most 64 characters');
  const selectedHome = safeAbsolute(path.resolve(home), 'Harness home');
  const configPath = safeAbsolute(path.join(selectedHome, 'domains', `${name}.yaml`), 'domain config path');
  const source = readFileNoFollow(configPath, { root: selectedHome, maxBytes: MAX_CONFIG_BYTES });
  if (source === null) throw failure('config is missing, unreadable, oversized or not a regular file');
  let config;
  try {
    const doc = YAML.parseDocument(source, { uniqueKeys: true, merge: false, strict: true });
    if (doc.errors.length || doc.warnings.length) throw failure('config contains invalid or unsupported YAML');
    YAML.visit(doc, { Alias() { throw failure('YAML aliases are unsupported in domain config'); } });
    config = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error?.code === 'E_DOMAIN') throw error;
    throw failure('config contains malformed YAML');
  }
  return { config: validateV1(config, name), configPath, home: selectedHome };
}

function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' };
}

function gitObservation(root, prefix, args) {
  const result = spawnSync('git', ['--no-pager', ...prefix, ...args], {
    cwd: root, env: gitEnvironment(), encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: GIT_MAX_BYTES,
  });
  if (result.error || result.signal || !Number.isInteger(result.status)) return null;
  return { status: result.status, output: String(result.stdout || '') };
}

function emptyObserved() {
  return { root: null, gitDir: null, commonDir: null, head: null, origin: null, branch: null, isLinkedWorktree: null, dirty: null, statusEntries: null };
}

function checksObservation(root) {
  const rel = '.github/harness/checks.yaml';
  const full = assertNoSymlinkAncestors(root, rel);
  if (!full) return { path: path.join(root, rel), present: false, status: 'unsafe' };
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  return { path: full, present: Boolean(stat?.isFile()), status: stat ? (stat.isFile() ? 'present' : 'nonregular') : 'missing' };
}

function inspectRepo(repo) {
  const warnings = [];
  const observed = emptyObserved();
  const result = { id: repo.id, status: 'unavailable', expected: { origin: repo.origin, root: repo.root }, observed, checks: { path: path.join(repo.root, '.github/harness/checks.yaml'), present: false, status: 'unavailable' }, warnings };
  const stat = fs.lstatSync(repo.root, { throwIfNoEntry: false });
  if (!stat) { warnings.push('Local root is missing; repository observation is unavailable.'); return result; }
  if (!stat.isDirectory()) throw failure(`repo ${repo.id} root is not a directory`);
  result.checks = checksObservation(repo.root);
  if (!result.checks.present) warnings.push(`Named checks file is ${result.checks.status}.`);
  if (!assertNoSymlinkAncestors(repo.root, '.git')) throw failure(`repo ${repo.id} Git identity path is unsafe or symlinked`);
  const prefix = readGitArgs(repo.root, { timeout: GIT_TIMEOUT, env: gitEnvironment() });
  if (!prefix) { warnings.push('Git configuration metadata is unavailable or malformed.'); return result; }
  const identity = gitObservation(repo.root, prefix, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  if (!identity || identity.status !== 0) { warnings.push('Git checkout metadata is unavailable.'); return result; }
  const lines = identity.output.trimEnd().split('\n');
  if (lines.length !== 3 || lines.some(value => !boundedText(value, 4096))) { warnings.push('Git checkout metadata is malformed.'); return result; }
  try {
    observed.root = fs.realpathSync(lines[0]);
    observed.gitDir = fs.realpathSync(path.resolve(repo.root, lines[1]));
    observed.commonDir = fs.realpathSync(path.resolve(repo.root, lines[2]));
  } catch { warnings.push('Git checkout identity paths are unavailable.'); return result; }
  if (observed.root !== fs.realpathSync(repo.root)) { warnings.push('Configured local root differs from the actual checkout root.'); return result; }
  observed.isLinkedWorktree = observed.gitDir !== observed.commonDir;
  const head = gitObservation(repo.root, prefix, ['rev-parse', '--verify', 'HEAD']);
  if (head?.status === 0 && /^[a-f0-9]{40}(?:[a-f0-9]{24})?\n?$/.test(head.output)) observed.head = head.output.trim();
  else warnings.push('HEAD is unavailable; the repository may have no commits.');
  const branch = gitObservation(repo.root, prefix, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch?.status === 0 && boundedText(branch.output.trimEnd(), 1024)) observed.branch = branch.output.trimEnd();
  else if (branch?.status !== 1) warnings.push('Branch metadata is unavailable.');
  const origin = gitObservation(repo.root, prefix, ['config', '--null', '--get-all', 'remote.origin.url']);
  if (origin?.status === 0 && origin.output.endsWith('\0')) {
    const urls = origin.output.slice(0, -1).split('\0');
    if (urls.length === 1 && boundedText(urls[0], 2048)) observed.origin = urls[0];
  }
  if (observed.origin === null) warnings.push('A single observed origin is unavailable.');
  else if (observed.origin !== repo.origin) warnings.push('Observed origin differs from expected origin.');
  const status = gitObservation(repo.root, prefix, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (status?.status === 0 && (!status.output || status.output.endsWith('\0'))) {
    observed.dirty = status.output.length > 0;
    observed.statusEntries = status.output ? status.output.split('\0').length - 1 : 0;
  } else warnings.push('Working tree status is unavailable or exceeds the metadata bound.');
  result.status = 'available';
  return result;
}

export function inspectDomain(record) {
  const { config, configPath, home } = record;
  const repos = config.repos.map(inspectRepo);
  return {
    schema: 1, mode: 'domain', verb: 'show', status: 'ok', exitCode: 0,
    name: config.name, domainVersion: config.domain_version, configPath, home,
    executionSupported: false,
    repos,
    sharedSpecs: config.shared_specs.map(ref => ({ ...ref, authority: 'advisory' })),
    sharedConventions: config.shared_conventions.map(ref => ({ ...ref, authority: 'advisory' })),
    warnings: ['Version 1 membership and shared references are advisory; executable domain delivery is unavailable.'],
  };
}
