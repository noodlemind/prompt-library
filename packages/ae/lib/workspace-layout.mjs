import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import { logicalDomainContract, normalizeDomainOrigin, readDomain } from './domain-contract.mjs';
import { harnessGlobalHome } from './paths.mjs';

const FILE_MARKERS = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'];
const MAX_MARKER_BYTES = 256 * 1024;
const MAX_FOLDERS = 64;
const MAX_REPORTED_ROOTS = 31;
const MAX_DOMAIN_FILES = 64;
const GIT_TIMEOUT = 4000;
const DOMAIN_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function emptyLayout() {
  return {
    boundRoot: null,
    kind: 'unknown',
    markers: [],
    workspaceType: 'none',
    workspaceFile: null,
    roots: [],
    domainSuggestion: null,
  };
}

function readText(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function packageWorkspaces(text) {
  try {
    const workspaces = JSON.parse(text).workspaces;
    if (Array.isArray(workspaces)) return workspaces.length > 0;
    return Array.isArray(workspaces?.packages) && workspaces.packages.length > 0;
  } catch {
    return false;
  }
}

function skipGradleString(text, index) {
  const quote = text[index];
  let i = index + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

function takeParen(text, open) {
  let depth = 0;
  let i = open;
  const start = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipGradleString(text, i); continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
    i += 1;
  }
  return text.slice(start);
}

export function gradleIncludeCount(text) {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') { i += 2; while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    if (ch === '"' || ch === "'") { i = skipGradleString(text, i); continue; }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i += 1;
      if (text.slice(start, i) !== 'include') continue;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      const body = text[i] === '(' ? takeParen(text, i) : text.slice(i, text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i));
      count += (body.match(/'[^'\n]*'|"[^"\n]*"|:[A-Za-z0-9_.-]+/g) || []).length;
      continue;
    }
    i += 1;
  }
  return count;
}

export function mavenModuleCount(text) {
  const stripped = String(text).replace(/<!--[\s\S]*?-->/g, '');
  let count = 0;
  for (const block of stripped.matchAll(/<modules\b[^>]*>([\s\S]*?)<\/modules>/gi)) {
    count += (block[1].match(/<module\b[^>]*>[\s\S]*?<\/module>/gi) || []).length;
  }
  return count;
}

export function classifyRepo(root) {
  const markers = [];
  if (!root) return { kind: 'product-repo', markers };
  for (const name of FILE_MARKERS) {
    if (readText(path.join(root, name)) !== null) markers.push(name);
  }
  if (packageWorkspaces(readText(path.join(root, 'package.json')) || '')) markers.push('package.json');
  for (const name of ['settings.gradle', 'settings.gradle.kts']) {
    const text = readText(path.join(root, name));
    if (text !== null && gradleIncludeCount(text) > 1) markers.push(name);
  }
  const pom = readText(path.join(root, 'pom.xml'));
  if (pom !== null && mavenModuleCount(pom) > 0) markers.push('pom.xml');
  return { kind: markers.length ? 'monorepo' : 'product-repo', markers };
}

function expandHome(value) {
  const profile = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const home = process.env.HOME || os.homedir();
  let expanded = String(value)
    .replace(/%USERPROFILE%/gi, profile)
    .replace(/\$\{USERPROFILE\}/g, profile)
    .replace(/\$USERPROFILE\b/g, profile)
    .replace(/%HOME%/gi, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME\b/g, home);
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = home + expanded.slice(1);
  return expanded;
}

export function resolveWorkspacePath(workspaceFile, raw) {
  const value = expandHome(String(raw ?? '').trim());
  if (!value) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\');
  if (windows) {
    const base = path.win32.dirname(String(workspaceFile).replace(/\//g, '\\'));
    const absolute = path.win32.isAbsolute(value) ? value : path.win32.resolve(base, value);
    return path.win32.normalize(absolute);
  }
  return path.resolve(path.dirname(String(workspaceFile)), value);
}

export function parseJsonc(text) {
  if (typeof text !== 'string') return null;
  let out = '';
  let i = 0;
  let string = false;
  let escape = false;
  const nextStructural = (from) => {
    let j = from;
    while (j < text.length) {
      if (/\s/.test(text[j])) { j += 1; continue; }
      if (text[j] === '/' && text[j + 1] === '/') { j += 2; while (j < text.length && text[j] !== '\n') j += 1; continue; }
      if (text[j] === '/' && text[j + 1] === '*') { j += 2; while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j += 1; j += 2; continue; }
      return j;
    }
    return j;
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (string) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') string = false;
      i += 1;
      continue;
    }
    if (ch === '"') { string = true; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') { i += 2; while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    if (ch === ',') {
      const structural = nextStructural(i + 1);
      if (text[structural] === '}' || text[structural] === ']') { i += 1; continue; }
    }
    out += ch;
    i += 1;
  }
  try { return JSON.parse(out); } catch { return null; }
}

function git(cwd, args) {
  try {
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024, env: gitMetadataEnvironment(), windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function canonical(file) {
  if (!file) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(file);
  const resolved = windows ? path.win32.normalize(file) : path.resolve(file);
  if (windows && process.platform !== 'win32') return resolved;
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

function samePath(left, right) {
  const a = canonical(left);
  const b = canonical(right);
  if (!a || !b) return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function gitToplevel(dir) {
  if (!dir) return null;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top ? canonical(top) : null;
}

function gitOrigin(dir) {
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  if (!remote) return null;
  try { return normalizeDomainOrigin(remote); } catch { return null; }
}

function describeRoot(root) {
  const classified = classifyRepo(root);
  return { root: canonical(root), kind: classified.kind, markers: classified.markers, origin: gitOrigin(root) };
}

function searchDirs(boundRoot) {
  const parent = path.dirname(boundRoot);
  return parent && parent !== boundRoot ? [boundRoot, parent] : [boundRoot];
}

function codeWorkspaceFiles(boundRoot) {
  const found = [];
  for (const dir of searchDirs(boundRoot)) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.code-workspace')) continue;
      found.push(path.join(dir, entry.name));
    }
  }
  return found.sort();
}

function expandProjectDir(projectDir, directory) {
  if (directory === '$PROJECT_DIR$') return projectDir;
  const prefix = '$PROJECT_DIR$';
  if (String(directory).startsWith(prefix)) {
    const rest = directory.slice(prefix.length).replace(/^[\\/]+/, '');
    if (/^[A-Za-z]:[\\/]/.test(rest)) return resolveWorkspacePath(path.join(projectDir, 'sentinel.code-workspace'), rest);
    return path.resolve(projectDir, ...rest.split(/[\\/]+/).filter(Boolean));
  }
  return resolveWorkspacePath(path.join(projectDir, 'sentinel.code-workspace'), directory);
}

function distinctOthers(paths, boundRoot) {
  const seen = new Set();
  const others = [];
  let includesBound = false;
  let truncated = false;
  for (const candidate of paths) {
    if (!candidate) continue;
    const top = gitToplevel(candidate);
    if (!top) continue;
    if (samePath(top, boundRoot)) { includesBound = true; continue; }
    if (seen.has(top)) continue;
    seen.add(top);
    if (others.length >= MAX_REPORTED_ROOTS) { truncated = true; continue; }
    others.push(describeRoot(top));
  }
  return { includesBound, others, truncated };
}

function readCodeWorkspace(boundRoot) {
  let selected = null;
  for (const file of codeWorkspaceFiles(boundRoot)) {
    const parsed = parseJsonc(readText(file) || '');
    const folders = Array.isArray(parsed?.folders) ? parsed.folders.slice(0, MAX_FOLDERS) : null;
    if (!folders) continue;
    const resolved = folders.map(folder => resolveWorkspacePath(file, folder?.path));
    const found = distinctOthers(resolved, boundRoot);
    if (!found.includesBound) continue;
    if (!selected || found.others.length > selected.others.length) selected = { file, ...found };
  }
  return selected;
}

function vcsFiles(boundRoot) {
  return searchDirs(boundRoot)
    .map(dir => path.join(dir, '.idea', 'vcs.xml'))
    .filter(file => {
      try { return fs.lstatSync(file).isFile(); } catch { return false; }
    });
}

function mappingDirectories(xml) {
  const dirs = [];
  for (const match of String(xml).matchAll(/<mapping\b[^>]*\bdirectory\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    dirs.push(match[1] ?? match[2]);
    if (dirs.length >= MAX_FOLDERS) break;
  }
  return dirs;
}

function readVcs(boundRoot) {
  let selected = null;
  for (const file of vcsFiles(boundRoot)) {
    const projectDir = path.dirname(path.dirname(file));
    const resolved = mappingDirectories(readText(file) || '').map(directory => expandProjectDir(projectDir, directory));
    const found = distinctOthers(resolved, boundRoot);
    if (!found.includesBound) continue;
    if (!selected || found.others.length > selected.others.length) selected = { file, ...found };
  }
  return selected;
}

function slug(value) {
  let text = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(text)) text = `r-${text}`.replace(/-+$/g, '');
  if (!/^[a-z]/.test(text)) text = 'repo';
  return text.slice(0, 64).replace(/-+$/g, '') || 'repo';
}

function memberId(root, used) {
  const base = slug(path.win32.basename(path.posix.basename(root)));
  let id = base;
  let n = 2;
  while (used.has(id) || !DOMAIN_NAME.test(id)) {
    const suffix = `-${n}`;
    id = `${base.slice(0, 64 - suffix.length)}${suffix}`.replace(/^-+/, '');
    n += 1;
    if (n > 100) id = `repo-${n}`;
  }
  used.add(id);
  return id;
}

function domainCovers(home, members) {
  let names;
  try { names = fs.readdirSync(path.join(home, 'domains')); } catch { return false; }
  for (const name of names.slice(0, MAX_DOMAIN_FILES)) {
    if (!name.endsWith('.yaml')) continue;
    const base = name.slice(0, -'.yaml'.length);
    let config;
    try { config = readDomain(base, { home }).config; } catch { continue; }
    const roots = config.domain_version === 2
      ? Object.values(config.bindings?.repos || {})
      : (config.repos || []).map(repo => repo.root);
    if (members.every(member => roots.some(root => samePath(root, member.root)))) return true;
  }
  return false;
}

function domainFileName(ids, home) {
  let name = ids.join('-').slice(0, 64).replace(/-+$/g, '');
  if (!DOMAIN_NAME.test(name)) name = 'workspace';
  const dir = path.join(home, 'domains');
  for (let n = 1; n < 100; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`.replace(/-+$/g, '');
    if (!DOMAIN_NAME.test(candidate)) continue;
    if (!fs.existsSync(path.join(dir, `${candidate}.yaml`))) return candidate;
  }
  return null;
}

function suggestDomain(home, members) {
  if (members.length < 2 || members.length > 32 || domainCovers(home, members)) return null;
  const used = new Set();
  const repos = members.map(member => {
    const id = memberId(member.root, used);
    const entry = member.origin ? { id, origin: member.origin } : { id, local_identity: { id, approved: true } };
    return { entry, root: member.root };
  });
  const name = domainFileName(repos.map(repo => repo.entry.id), home);
  if (!name) return null;
  const config = {
    domain_version: 2,
    name,
    repos: repos.map(repo => repo.entry),
    sources: [],
    bindings: {
      repos: Object.fromEntries(repos.map(repo => [repo.entry.id, repo.root])),
      sources: {},
    },
    shared_specs: [],
    shared_conventions: [],
  };
  try { logicalDomainContract(config); } catch { return null; }
  const yaml = YAML.stringify(config, { lineWidth: 0 });
  return { path: path.join(home, 'domains', `${name}.yaml`), yaml };
}

export function detectWorkspace(workspace, options = {}) {
  const home = options.home || harnessGlobalHome();
  try {
    const boundRoot = gitToplevel(workspace);
    if (!boundRoot) return emptyLayout();
    const bound = describeRoot(boundRoot);
    const vscode = readCodeWorkspace(boundRoot);
    const idea = vscode ? null : readVcs(boundRoot);
    const selected = vscode || idea;
    const others = selected?.others || [];
    const members = [bound, ...others];
    return {
      boundRoot: bound.root,
      kind: bound.kind,
      markers: bound.markers,
      workspaceType: vscode ? 'vscode' : idea ? 'intellij' : 'none',
      workspaceFile: selected?.file || null,
      roots: others.map(({ root, kind, markers }) => ({ root, kind, markers })),
      domainSuggestion: selected?.truncated ? null : suggestDomain(home, members),
    };
  } catch {
    return emptyLayout();
  }
}
