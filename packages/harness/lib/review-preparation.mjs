import fs from 'node:fs';
import { planContractText } from './work-contract.mjs';
import { domainContextOf, domainPlanPath, planHome, planRecordRoot } from './domain-context.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getCorpusRoot } from './assets.mjs';
import { externalPlansDir } from './project-layout.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { performanceContext, performanceContextIsCurrent } from './performance.mjs';
import { parsePlanFrontmatter } from './plan-parse.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors, canonicalPath } from './fs-safe.mjs';
import { readProductDiff, gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';

export const CODE_REVIEWERS = Object.freeze(['architecture-strategist', 'security-sentinel', 'performance-oracle', 'code-simplicity-reviewer', 'pattern-recognition-specialist']);
export const DOCUMENT_REVIEWERS = Object.freeze(['design', 'scope', 'coherence', 'feasibility']);
export const reviewHash = value => createHash('sha256').update(stableJson(value)).digest('hex');
export function stableJson(value) {
  return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function expandPatterns(value) {
  const patterns = [], tokens = [];
  let depth = 0, token = '';
  for (const char of value) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth < 0) throw new Error('Unbalanced check glob');
    if (char === ',' && depth === 0) { tokens.push(token); token = ''; } else token += char;
  }
  if (depth !== 0) throw new Error('Unbalanced check glob');
  tokens.push(token);
  for (const part of tokens) {
    const brace = part.match(/\{([^{}]+)\}/);
    if (brace) for (const option of brace[1].split(',')) patterns.push(...expandPatterns(part.replace(brace[0], option)));
    else if (part.trim()) patterns.push(part.trim());
    if (patterns.length > 100) throw new Error('Check glob expansion exceeds 100 patterns');
  }
  return patterns;
}
function globRegex(glob) {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; pattern += '(?:.*/)?'; } else pattern += '.*';
    } else if (c === '*') pattern += '[^/]*';
    else if (c === '?') pattern += '[^/]';
    else pattern += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(pattern + '$');
}
function source(root, rel, origin) {
  const full = path.join(root, rel);
  const bytes = readFileNoFollow(full, { root, encoding: null });
  let missing = false;
  try { fs.lstatSync(full); } catch (error) { missing = error.code === 'ENOENT' && Boolean(assertNoSymlinkAncestors(root, rel)); }
  return { origin, path: rel.replace(/\\/g, '/'), state: bytes === null ? (missing ? 'missing' : 'unreadable') : 'regular', sha256: bytes === null ? null : createHash('sha256').update(origin === 'domain-plan' ? planContractText(bytes.toString('utf8')) : bytes).digest('hex'), ...(origin === 'domain-plan' ? { hashPolicy: 'work-contract-v3' } : {}) };
}

function projectPlanLocation(workspace, file, { plan } = {}) {
  const context = domainContextOf(plan);
  if (context && typeof file === 'string') {
    try {
      const full = domainPlanPath(context, file);
      if (full === plan.fullPath) {
        const root = planRecordRoot(workspace, plan);
        return { root, rel: path.relative(root, full), full, origin: 'domain-plan' };
      }
    } catch { /* other selected files still require project-store authority below */ }
  }
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.(?:md|hplan)$/.test(file) || /[\0\r\n]/.test(file)) return null;
  const home = plan ? planHome(workspace, plan) : harnessGlobalHome();
  const raw = path.resolve(file);
  let full;
  try {
    const rawHome = [home, harnessGlobalHome()].find(candidate => {
      const relative = path.relative(candidate, raw);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && canonicalPath(candidate) === canonicalPath(home);
    });
    if (!rawHome || !assertNoSymlinkAncestors(rawHome, path.relative(rawHome, raw))) return null;
    full = canonicalPath(raw);
  } catch { return null; }
  let root;
  try { root = canonicalPath(externalPlansDir(workspace, { home })); } catch { return null; }
  const rel = path.relative(root, full);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const canonicalHome = canonicalPath(home);
  return { root: canonicalHome, rel: path.relative(canonicalHome, full), full };
}

/** Rederive the selected project's store rather than trusting a root in a packet. */
export function readReviewFile(workspace, ref, options = {}) {
  if (['project-plan', 'domain-plan'].includes(ref?.origin)) {
    const location = projectPlanLocation(workspace, ref.path, options);
    return location ? readFileNoFollow(location.full, { ...options, root: location.root }) : null;
  }
  if (!['product', 'corpus'].includes(ref?.origin) || typeof ref.path !== 'string' || path.isAbsolute(ref.path) || path.win32.isAbsolute(ref.path)) return null;
  const root = ref.origin === 'corpus' ? getCorpusRoot() : workspace;
  return readFileNoFollow(path.join(root, ref.path), { ...options, root });
}

function currentSource(workspace, ref, options = {}) {
  if (['project-plan', 'domain-plan'].includes(ref.origin)) {
    const location = projectPlanLocation(workspace, ref.path, options);
    return location ? { ...source(location.root, location.rel, ref.origin), path: ref.path } : { ...ref, state: 'unreadable', sha256: null };
  }
  return source(ref.origin === 'corpus' ? getCorpusRoot() : workspace, ref.path, ref.origin);
}

function selectedSource(workspace, file, kind, plan) {
  const full = path.resolve(workspace, file), rel = path.relative(workspace, full).replace(/\\/g, '/');
  if (rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel)) return source(workspace, rel, 'product');
  if (kind === 'document' || domainContextOf(plan)) {
    const location = projectPlanLocation(workspace, full, { plan });
    if (location) {
      const ref = { ...source(location.root, location.rel, location.origin || 'project-plan'), path: full.replace(/\\/g, '/') };
      if (ref.sha256) return ref;
    }
  }
  throw new Error('Review files must be inside the workspace or readable plans in the current project store for document reviews');
}

export function discoverReviewChecks(workspace, files) {
  const corpus = getCorpusRoot(), checks = [], failures = [];
  for (const [root, dir, origin] of [[corpus, 'skills/code-review/references/checks', 'corpus'], [workspace, '.github/checks', 'product']]) {
    if (!assertNoSymlinkAncestors(root, dir)) { failures.push(`${origin} check directory is unsafe`); continue; }
    let entries;
    try { entries = fs.readdirSync(path.join(root, dir)); } catch (error) { if (error.code !== 'ENOENT') failures.push(`${origin} checks unreadable`); continue; }
    for (const file of entries.filter(f => f.endsWith('.md')).sort(compareText)) {
      const ref = source(root, `${dir}/${file}`, origin);
      const text = readFileNoFollow(path.join(root, ref.path), { root, maxBytes: 1024 * 1024 });
      try {
        if (text === null) throw new Error('Missing, unsafe or oversized check');
        if (file.toLowerCase() === 'readme.md' && !/^---\r?\n/.test(text)) continue;
        const fm = parsePlanFrontmatter(text);
        if (typeof fm.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name)) throw new Error('Check needs a valid name');
        if (fm.globs !== undefined && typeof fm.globs !== 'string' && !(Array.isArray(fm.globs) && fm.globs.every(g => typeof g === 'string'))) throw new Error('Check globs must be strings');
        const patterns = fm.globs === undefined ? [] : (Array.isArray(fm.globs) ? fm.globs : [fm.globs]).flatMap(expandPatterns).map(globRegex);
        const mapped = files.map(f => f.replace(/^packages\/harness\/corpus\/(agents|skills|instructions)\//, '.github/$1/'));
        const matched = patterns.length === 0 || mapped.some(f => patterns.some(pattern => pattern.test(f)));
        checks.push({ name: fm.name, ref, globs: fm.globs ?? null, matched, severityDefault: fm['severity-default'] || 'P2' });
      } catch (error) { failures.push(`${origin}:${ref.path}: ${error.message}`); checks.push({ name: null, ref, matched: false, invalid: true }); }
    }
  }
  const ids = checks.filter(c => c.matched).map(c => c.name);
  if (ids.length !== new Set(ids).size) failures.push('Duplicate applicable review check names');
  return { checks, failures };
}

export function reviewPreparation({ workspace, scope, plan, kind, reviewers, files, maxBytes = 16384, home }) {
  const corpus = getCorpusRoot();
  const selectedRefs = new Map((files?.length ? files : scope.changedFiles).map(file => {
    const ref = selectedSource(workspace, file, kind, plan);
    return [ref.path, ref];
  }));
  const selected = [...selectedRefs.keys()].sort(compareText);
  const covered = [...new Set([...scope.changedFiles, ...selected])].sort(compareText);
  const discovery = kind === 'code' ? discoverReviewChecks(workspace, covered) : { checks: [], failures: [] };
  const declaredRequired = [...new Set(plan?.fm.reviews?.required || [])].sort(compareText);
  const required = [...new Set([...(kind === 'document' ? DOCUMENT_REVIEWERS : CODE_REVIEWERS), ...declaredRequired.filter(r => r !== 'code-review'), ...reviewers, ...discovery.checks.filter(c => c.matched).map(c => c.name)])].sort(compareText);
  if (required.some(id => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error('Invalid required review IDs');
  const perspectives = kind === 'document' ? DOCUMENT_REVIEWERS : [...new Set([...CODE_REVIEWERS, ...reviewers, ...declaredRequired.filter(id => id !== 'code-review')])];
  const collisions = discovery.checks.filter(c => c.matched && perspectives.includes(c.name)).map(c => `Review check name collides with a required perspective: ${c.name}`);
  const sources = kind === 'document' ? [source(corpus, 'skills/document-review/references/review-criteria.md', 'corpus')] : perspectives.map(id => source(corpus, `agents/${id}.agent.md`, 'corpus'));
  sources.push(source(corpus, 'skills/code-review/references/findings-schema.md', 'corpus'));
  const failures = [...discovery.failures, ...collisions, ...sources.filter(s => !s.sha256).map(s => `Review definition unavailable: ${s.path}`)];
  const performance = kind === 'code' ? performanceContext({ workspace, home: plan ? planHome(workspace, plan) : home || harnessGlobalHome(), files: covered }) : null;
  if (performance?.state === 'invalid') failures.push('Performance profile is invalid; inspect the current profile before completing review');
  const refs = covered.map(file => selectedRefs.get(file) || source(workspace, file, 'product'));
  const diff = readProductDiff(workspace, { base: scope.base || 'HEAD', planPath: plan?.path });
  const branchResult = spawnSync('git', ['branch', '--show-current'], { cwd: workspace, encoding: 'utf8', timeout: 4000, env: gitMetadataEnvironment() });
  const budget = Math.max(1024, Math.min(maxBytes, 131072));
  const included = [], omitted = [];
  let bytes = 0;
  for (const ref of refs) {
    if (!selected.includes(ref.path)) { omitted.push({ ...ref, reason: 'not selected for excerpts; remains in the review scope' }); continue; }
    const text = readReviewFile(workspace, ref, { maxBytes: 1024 * 1024, plan });
    const remaining = budget - bytes;
    if (text === null || remaining < 256) { omitted.push({ ...ref, reason: text === null ? 'deleted, unsafe, binary or over read limit' : 'packet byte budget' }); continue; }
    const excerpt = Buffer.from(text).subarray(0, Math.min(remaining, 4096)).toString('utf8');
    bytes += Buffer.byteLength(excerpt);
    included.push({ ...ref, excerpt, truncated: Buffer.byteLength(text) > Buffer.byteLength(excerpt) });
  }
  return { declaredRequired, required, preparation: { kind, ...(performance ? { performance } : {}), branch: branchResult.status === 0 ? branchResult.stdout.trim() : null, checks: discovery.checks, sources, refs, files: included, omitted, diff: diff === null ? null : Buffer.from(diff).subarray(0, budget).toString('utf8'), diffTruncated: diff === null || Buffer.byteLength(diff) > budget, coverage: { totalFiles: covered.length, includedFiles: included.length, omittedFiles: omitted.length, byteBudget: budget, excerptBytes: bytes }, failures, provenance: 'Host invocation identity unknown; declarations and same-context perspectives are not independent evidence' } };
}

export function preparationIsCurrent(workspace, preparation, options = {}) {
  if (preparation.kind === 'code') {
    const home = options.plan ? planHome(workspace, options.plan) : options.home || harnessGlobalHome();
    if (preparation.performance) {
      if (!performanceContextIsCurrent({ workspace, home, context: preparation.performance })) return false;
    } else if (performanceContext({ workspace, home, files: preparation.refs.map(ref => ref.path) }) !== null) return false;
  }
  if (preparation.kind !== 'document' && preparation.refs.some(ref => ref.origin === 'project-plan')) return false;
  if (preparation.kind === 'code') {
    const discovery = discoverReviewChecks(workspace, preparation.refs.map(ref => ref.path));
    if (stableJson(discovery.checks) !== stableJson(preparation.checks)) return false;
  }
  return [...preparation.sources, ...preparation.checks.map(c => c.ref), ...preparation.refs].every(ref => {
    const current = currentSource(workspace, ref, options);
    return current.hashPolicy === ref.hashPolicy && current.sha256 === ref.sha256 && (ref.sha256 !== null || (ref.state === 'missing' && current.state === 'missing'));
  });
}
