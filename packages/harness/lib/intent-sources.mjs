import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertNoSymlinkAncestors, readFileNoFollow, readPrefixNoFollow } from './fs-safe.mjs';

const PATH_CAP = 8;
const LINE_BUDGET = 512;
const LINE_SEPARATOR = ', ';

/**
 * @typedef {'frozen'|'selected'|'missing'|'none'} ObligationReason
 * @typedef {{ path: string, kind: string|null }} IntentSource
 * @typedef {{ reason: ObligationReason, paths: IntentSource[] }} IntentObligation
 */

function kindOf(rel) {
  const posix = String(rel || '').replace(/\\/g, '/');
  if (posix === '.specify/memory/constitution.md') return 'spec';
  const lower = posix.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (/(^|\/)(adr|adrs|decisions)(\/|$)/.test(lower) || /^adr[-.]/.test(base) || base.endsWith('.adr.md')) return 'adr';
  if (/(^|\/)(rfc|rfcs)(\/|$)/.test(lower) || base.endsWith('.rfc.md')) return 'rfc';
  if (/(^|\/)(intent|intents)(\/|$)/.test(lower) || base.endsWith('.intent.md')) return 'intent';
  if (/(^|\/)(spec|specs)(\/|$)/.test(lower) || base.endsWith('.spec.md')) return 'spec';
  if (/(^|\/)issues?(\/|$)/.test(lower)) return 'issue';
  return null;
}

function queryTokens(text) {
  const seen = new Set();
  const tokens = [];
  for (const token of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length <= 1 || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function prefixText(workspace, rel) {
  try {
    const full = assertNoSymlinkAncestors(workspace, rel);
    if (!full) return '';
    const buf = readPrefixNoFollow(full, { root: workspace });
    if (!buf || buf.length === 0) return '';
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function scoreSource(item, tokens, prefix) {
  const body = prefix.includes('\0') ? '' : prefix;
  const hay = `${item.path} ${item.kind} ${body}`.toLowerCase();
  return tokens.reduce((count, token) => count + (hay.includes(token) ? 1 : 0), 0);
}

function preferredBasename(item) {
  const base = item.path.slice(item.path.lastIndexOf('/') + 1);
  return base === 'spec.md' || base === 'constitution.md' ? 0 : 1;
}

function catalog(workspace) {
  if (!workspace) return [];
  const listed = spawnSync('git', ['-C', workspace, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'buffer',
    timeout: 10_000,
  });
  if (listed.status !== 0 || !listed.stdout) return [];
  const found = [];
  for (const rel of listed.stdout.toString('utf8').split('\0')) {
    if (!rel) continue;
    const posix = rel.replace(/\\/g, '/');
    const kind = kindOf(posix);
    if (!kind) continue;
    found.push({ path: posix, kind });
  }
  return found;
}

export function obligationLine(paths) {
  return (paths || []).map((item) => item.path).join(LINE_SEPARATOR);
}

function takeLine(ranked) {
  if (!ranked.length) return [];
  const kept = [ranked[0]];
  for (let i = 1; i < ranked.length; i += 1) {
    if (kept.length >= PATH_CAP) break;
    const next = kept.concat(ranked[i]);
    if (Buffer.byteLength(obligationLine(next), 'utf8') > LINE_BUDGET) break;
    kept.push(ranked[i]);
  }
  return kept.map(({ path, kind }) => ({ path, kind }));
}

export function selectIntent(workspace, text = '') {
  const tokens = queryTokens(text);
  const ranked = catalog(workspace);
  for (const item of ranked) {
    item.score = tokens.length === 0 ? 0 : scoreSource(item, tokens, prefixText(workspace, item.path));
  }
  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const prefer = preferredBasename(a) - preferredBasename(b);
    if (prefer) return prefer;
    return a.path.localeCompare(b.path);
  });
  return takeLine(ranked);
}

export function resolveObligation(workspace, plan, text = '') {
  const stored = listedIntentSources(plan);
  if (plan && stored && stored.length) {
    return {
      reason: 'frozen',
      paths: stored.map((path) => ({ path, kind: kindOf(path) })),
    };
  }
  const selected = selectIntent(workspace, plan ? (typeof plan.fm?.intent === 'string' ? plan.fm.intent : '') : text);
  if (!selected.length) return { reason: 'none', paths: [] };
  if (plan) return { reason: 'missing', paths: selected };
  return { reason: 'selected', paths: selected };
}

export function sourcePath(value) {
  if (typeof value === 'string') return value.replace(/\\/g, '/').trim();
  if (value && typeof value === 'object' && typeof value.path === 'string') {
    return value.path.replace(/\\/g, '/').trim();
  }
  return '';
}

export function sourceHash(value) {
  if (value && typeof value === 'object' && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)) {
    return value.sha256;
  }
  return null;
}

export function hashIntentFile(workspace, rel) {
  if (!workspace || !rel) return null;
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full) return null;
  let stat = null;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const bytes = readFileNoFollow(full, { root: workspace, encoding: null });
  if (bytes == null) return null;
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function lockIntentSources(workspace, entries, { rehash = true } = {}) {
  const seen = new Set();
  const out = [];
  for (const entry of entries || []) {
    const rel = sourcePath(entry);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const kept = rehash ? null : sourceHash(entry);
    const sha256 = kept || hashIntentFile(workspace, rel);
    if (!sha256) throw Object.assign(new Error(`intent source unreadable: ${rel}`), { code: 'E_INTENT_SOURCE' });
    out.push({ path: rel, sha256 });
  }
  return out;
}

export function bindLockedIntentSources(workspace, entries, { query = '' } = {}) {
  const explicit = entries || [];
  const seen = new Set(explicit.map(sourcePath).filter(Boolean));
  const rest = selectIntent(workspace, query).filter((item) => !seen.has(item.path));
  return lockIntentSources(workspace, [...explicit, ...rest], { rehash: true });
}

export function listedIntentSources(plan) {
  const raw = plan?.fm?.intent_sources;
  if (!Array.isArray(raw)) return null;
  return raw.map(sourcePath).filter(Boolean);
}

export function intentSourcesCheck(plan, workspace) {
  const obligation = resolveObligation(workspace, plan);
  if (obligation.reason === 'missing') {
    return {
      id: 'C-intent-sources',
      pass: false,
      message: `Read in-repo specs before implementing and record them on intent_sources. Missing: ${obligationLine(obligation.paths)}`,
      severity: 'fail',
    };
  }
  if (obligation.reason === 'none') {
    return { id: 'C-intent-sources', pass: true, message: 'no in-repo spec or intent sources', severity: 'ok' };
  }
  return {
    id: 'C-intent-sources',
    pass: true,
    message: `intent_sources covers ${obligation.paths.length} source(s)`,
    severity: 'ok',
  };
}
