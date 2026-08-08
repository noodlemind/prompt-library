const FLAGS_WITH_VALUES = new Set([
  '--autonomy',
  '--copilot-home',
  '--limit',
  '--phase',
  '--query',
  '--target',
  '--workspace',
  '-c',
  '--collection',
  '--min-score',
  '--docid',
  '--path',
  '--lines',
  '--max-bytes',
  // search's value flags. Absent from this set, their VALUES are read as query
  // words: `search foo --match regex` would search for "foo regex" and quietly
  // run in ranked mode — a wrong answer with no error anywhere.
  '--match',
  '--source',
  '--cursor',
  '--depth',
]);

export function parseQueryFromArgv(argv, flags) {
  if (flags.query) return flags.query;
  const parts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      parts.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (!arg.includes('=') && FLAGS_WITH_VALUES.has(flagName)) i++;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (!arg.includes('=') && FLAGS_WITH_VALUES.has(flagName)) i++;
      continue;
    }
    if (arg === '-v') continue;
    parts.push(arg);
  }

  return parts.join(' ').trim();
}
