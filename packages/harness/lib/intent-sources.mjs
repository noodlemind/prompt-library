import { spawnSync } from 'node:child_process';

const CAP = 12;

function kindOf(rel) {
  const lower = String(rel || '').replace(/\\/g, '/').toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (/(^|\/)(adr|adrs|decisions)(\/|$)/.test(lower) || /^adr[-.]/.test(base) || base.endsWith('.adr.md')) return 'adr';
  if (/(^|\/)(rfc|rfcs)(\/|$)/.test(lower) || base.endsWith('.rfc.md')) return 'rfc';
  if (/(^|\/)(intent|intents)(\/|$)/.test(lower) || base.endsWith('.intent.md')) return 'intent';
  if (/(^|\/)(spec|specs)(\/|$)/.test(lower) || base.endsWith('.spec.md')) return 'spec';
  if (/(^|\/)issues?(\/|$)/.test(lower)) return 'issue';
  return null;
}

function score(item, tokens) {
  const hay = `${item.path} ${item.kind}`.toLowerCase();
  return tokens.reduce((n, token) => n + (hay.includes(token) ? 1 : 0), 0);
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
    found.push({ path: posix, kind });
  }
  const tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  found.sort((a, b) => {
    if (tokens.length) {
      const delta = score(b, tokens) - score(a, tokens);
      if (delta) return delta;
    }
    return a.path.localeCompare(b.path);
  });
  return found.slice(0, limit);
}

export function listedIntentSources(plan) {
  const raw = plan?.fm?.intent_sources;
  if (!Array.isArray(raw)) return null;
  return raw.map((value) => String(value).replace(/\\/g, '/').trim()).filter(Boolean);
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
