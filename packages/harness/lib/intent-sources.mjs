import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';

const CAP = 12;
const BODY_PREFIX_BYTES = 8192;

function kindOf(rel) {
  const lower = String(rel || '').replace(/\\/g, '/').toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (/(^|\/)(adr|adrs|decisions)(\/|$)/.test(lower) || /^adr[-.]/.test(base) || base.endsWith('.adr.md')) return 'adr';
  if (/(^|\/)(rfc|rfcs)(\/|$)/.test(lower) || base.endsWith('.rfc.md')) return 'rfc';
  if (/(^|\/)(intent|intents)(\/|$)/.test(lower) || base.endsWith('.intent.md')) return 'intent';
  if (/(^|\/)\.specify\/memory\/constitution\.md$/.test(lower)) return 'spec';
  if (/(^|\/)(spec|specs)(\/|$)/.test(lower) || base.endsWith('.spec.md')) return 'spec';
  if (/(^|\/)issues?(\/|$)/.test(lower)) return 'issue';
  return null;
}

function bodyHay(workspace, rel) {
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full) return '';
  const text = readFileNoFollow(full, {
    root: workspace,
    encoding: 'utf8',
    prefix: true,
    maxBytes: BODY_PREFIX_BYTES,
  });
  if (!text || text.includes('\0')) return '';
  return text.toLowerCase();
}

function score(item, tokens) {
  const hay = `${item.path} ${item.kind} ${item.body || ''}`.toLowerCase();
  return tokens.reduce((n, token) => n + (hay.includes(token) ? 1 : 0), 0);
}

export function rankIntentSources(workspace, intent) {
  return discoverIntentSources(workspace, { query: typeof intent === 'string' ? intent : '' });
}

export function discoverIntentSources(workspace, { query = '', limit = CAP } = {}) {
  if (!workspace) return [];
  const listed = spawnSync('git', ['-C', workspace, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'buffer',
    timeout: 10_000,
  });
  if (listed.status !== 0) return [];
  const found = [];
  for (const rel of listed.stdout.toString('utf8').split('\0')) {
    if (!rel) continue;
    const posix = rel.replace(/\\/g, '/');
    const kind = kindOf(posix);
    if (!kind) continue;
    found.push({ path: posix, kind, body: '' });
  }
  const tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  if (tokens.length) {
    for (const item of found) item.body = bodyHay(workspace, item.path);
  }
  found.sort((a, b) => {
    if (tokens.length) {
      const delta = score(b, tokens) - score(a, tokens);
      if (delta) return delta;
    }
    return a.path.localeCompare(b.path);
  });
  return found.slice(0, limit).map(({ path: sourcePath, kind }) => ({ path: sourcePath, kind }));
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
  return lockIntentSources(workspace, [...(entries || []), ...discoverIntentSources(workspace, { query })], { rehash: true });
}

export function listedIntentSources(plan) {
  const raw = plan?.fm?.intent_sources;
  if (!Array.isArray(raw)) return null;
  return raw.map(sourcePath).filter(Boolean);
}

export function intentSourcesCheck(plan, discovered) {
  if (!discovered.length) {
    return { id: 'C-intent-sources', pass: true, message: 'no in-repo spec or intent sources', severity: 'ok' };
  }
  const listed = listedIntentSources(plan);
  const missing = discovered.filter((item) => !listed || !listed.includes(item.path));
  if (missing.length) {
    return {
      id: 'C-intent-sources',
      pass: false,
      message: `Read in-repo specs before implementing and record them on intent_sources. Missing: ${missing.map((item) => item.path).join(', ')}`,
      severity: 'fail',
    };
  }
  return {
    id: 'C-intent-sources',
    pass: true,
    message: `intent_sources covers ${discovered.length} source(s)`,
    severity: 'ok',
  };
}
