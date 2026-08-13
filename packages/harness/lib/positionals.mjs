export const VALUE_FLAGS = Object.freeze(new Set([
  '--agent', '--allow-env', '--autonomy', '--base', '--body', '--body-file', '--branch',
  '--category', '--changes', '--claim', '--collection', '--command', '--content', '--copilot-home', '--criteria',
  '--cursor', '--cwd', '--date', '--depth', '--docid', '--domain', '--enforcement',
  '--expect', '--gap', '--host', '--id', '--ids', '--impacted', '--intent', '--layer', '--learnings',
  '--limit', '--lines', '--match', '--max-bytes', '--max-seconds', '--max-turns',
  '--min-score', '--model', '--new', '--offset', '--old', '--ops', '--output', '--path', '--phase', '--plan',
  '--profile', '--provider', '--query', '--reason', '--risk', '--scope', '--session', '--since',
  '--slug', '--source', '--spec', '--stale', '--status', '--tags', '--target', '--text', '--timeout', '--verification-check',
  '--title', '--to', '--tool-timeout', '--trigger', '--type', '--until', '--verify-cmd', '--why',
  '--workspace',
  '-c',
]));

export function isValueFlag(token, extra = null) {
  if (typeof token !== 'string' || !token.startsWith('-')) return false;
  if (token.includes('=')) return false; // `--limit=5` carries its own value
  return VALUE_FLAGS.has(token) || (extra ? extra.has(token) : false);
}

export function positionalsOf(argv, { limit = Infinity, extra = null } = {}) {
  const out = [];
  const widen = extra ? new Set(extra) : null;
  for (let i = 0; i < argv.length && out.length < limit; i += 1) {
    const token = argv[i];
    if (token === '--') break;
    if (typeof token !== 'string') continue;
    if (token.startsWith('-') && token !== '-') {
            if (isValueFlag(token, widen) && argv[i + 1] !== undefined && argv[i + 1] !== '--') i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

export function verbOf(argv, known, { fallback = null, extra = null } = {}) {
    const positionals = positionalsOf(argv, { extra });
  return positionals.length ? positionals[0] : fallback;
}
