function invalidFlag(name, value, hint) {
  throw new Error(`invalid ${name}: ${JSON.stringify(value)} — ${hint}`);
}

function parseMinScore(raw, flagName) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    invalidFlag(flagName, raw, 'must be a number between 0 and 1');
  }
  return n;
}

function parsePositiveInt(raw, flagName) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    invalidFlag(flagName, raw, 'must be an integer >= 1');
  }
  return n;
}

function parsePhase(raw) {
  if (!['implement', 'verify'].includes(raw)) {
    invalidFlag('--phase', raw, 'must be implement or verify');
  }
  return raw;
}

export function parseFlags(argv) {
  const flags = {
    dryRun: false,
    verbose: false,
    json: false,
    preserveKnowledge: true,
    forceProfile: false,
    configureVsCode: false,
    configurePath: false,
    autonomy: null,
    copilotHome: null,
    targets: new Set(['vscode', 'cli', 'intellij']),
    workspace: process.cwd(),
    query: null,
    phase: 'implement',
    limit: null,
    refresh: false,
    semantic: false,
    includePlans: false,
    strictIntent: false,
    noEvents: false,
    plan: null,
    base: null,
    enforcement: null,
    learnings: null,
    collection: null,
    minScore: 0.15,
    docid: null,
    path: null,
    lines: 40,
    maxBytes: 2048,
    host: null,
    session: null,
    summary: false,
    failures: false,
    sync: false,
    global: false,
    check: false,
    insight: false,
    title: null,
    category: null,
    tags: null,
    trigger: null,
    claim: null,
    body: null,
    bodyFile: null,
    ops: null,
    domain: null,
    reason: null,
    why: null,
    yes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--verbose' || a === '-v') flags.verbose = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--refresh') flags.refresh = true;
    else if (a === '--semantic') flags.semantic = true;
    else if (a === '--include-plans') flags.includePlans = true;
    else if (a === '--strict-intent') flags.strictIntent = true;
    else if (a === '--no-events') flags.noEvents = true;
    else if (a === '--summary') flags.summary = true;
    else if (a === '--failures') flags.failures = true;
    else if (a === '--sync') flags.sync = true;
    else if (a === '--global') flags.global = true;
    else if (a === '--check') flags.check = true;
    else if (a.startsWith('--query=')) flags.query = a.split('=').slice(1).join('=');
    else if (a === '--query') flags.query = argv[++i];
    else if (a.startsWith('--phase=')) flags.phase = parsePhase(a.split('=')[1]);
    else if (a === '--phase') flags.phase = parsePhase(argv[++i]);
    else if (a.startsWith('--limit=')) flags.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--limit') flags.limit = parseInt(argv[++i], 10);
    else if (a === '--preserve-knowledge') flags.preserveKnowledge = true;
    else if (a === '--force-knowledge-reset') flags.preserveKnowledge = false;
    else if (a === '--force-profile') flags.forceProfile = true;
    else if (a === '--configure-vscode') flags.configureVsCode = true;
    else if (a === '--configure-path') flags.configurePath = true;
    else if (a.startsWith('--autonomy=')) flags.autonomy = a.split('=')[1];
    else if (a === '--autonomy') flags.autonomy = argv[++i];
    else if (a.startsWith('--copilot-home=')) flags.copilotHome = a.split('=')[1];
    else if (a === '--copilot-home') flags.copilotHome = argv[++i];
    else if (a.startsWith('--target=')) {
      flags.targets = new Set(a.split('=')[1].split(',').map((t) => t.trim()));
    } else if (a === '--target') {
      flags.targets = new Set(argv[++i].split(',').map((t) => t.trim()));
    } else if (a.startsWith('--plan=')) flags.plan = a.split('=').slice(1).join('=');
    else if (a === '--plan') flags.plan = argv[++i];
    else if (a.startsWith('--base=')) flags.base = a.split('=').slice(1).join('=');
    else if (a === '--base') flags.base = argv[++i];
    else if (a.startsWith('--enforcement=')) flags.enforcement = a.split('=').slice(1).join('=');
    else if (a === '--enforcement') flags.enforcement = argv[++i];
    else if (a.startsWith('--learnings=')) flags.learnings = a.split('=').slice(1).join('=');
    else if (a === '--learnings') flags.learnings = argv[++i];
    else if (a.startsWith('--workspace=')) flags.workspace = a.split('=')[1];
    else if (a === '--workspace') flags.workspace = argv[++i];
    else if (a === '-c' || a === '--collection') flags.collection = argv[++i];
    else if (a.startsWith('--collection=')) flags.collection = a.split('=')[1];
    else if (a.startsWith('--min-score=')) flags.minScore = parseMinScore(a.split('=')[1], '--min-score');
    else if (a === '--min-score') flags.minScore = parseMinScore(argv[++i], '--min-score');
    else if (a.startsWith('--docid=')) flags.docid = a.split('=').slice(1).join('=');
    else if (a === '--docid') flags.docid = argv[++i];
    else if (a.startsWith('--path=')) flags.path = a.split('=').slice(1).join('=');
    else if (a === '--path') flags.path = argv[++i];
    else if (a.startsWith('--lines=')) flags.lines = parsePositiveInt(a.split('=')[1], '--lines');
    else if (a === '--lines') flags.lines = parsePositiveInt(argv[++i], '--lines');
    else if (a.startsWith('--max-bytes=')) flags.maxBytes = parsePositiveInt(a.split('=')[1], '--max-bytes');
    else if (a === '--max-bytes') flags.maxBytes = parsePositiveInt(argv[++i], '--max-bytes');
    else if (a.startsWith('--host=')) flags.host = a.split('=').slice(1).join('=');
    else if (a === '--host') flags.host = argv[++i];
    else if (a.startsWith('--session=')) flags.session = a.split('=').slice(1).join('=');
    else if (a === '--session') flags.session = argv[++i];
    else if (a === '--insight') flags.insight = true;
    else if (a.startsWith('--title=')) flags.title = a.split('=').slice(1).join('=');
    else if (a === '--title') flags.title = argv[++i];
    else if (a.startsWith('--category=')) flags.category = a.split('=').slice(1).join('=');
    else if (a === '--category') flags.category = argv[++i];
    else if (a.startsWith('--tags=')) flags.tags = a.split('=').slice(1).join('=');
    else if (a === '--tags') flags.tags = argv[++i];
    else if (a.startsWith('--trigger=')) flags.trigger = a.split('=').slice(1).join('=');
    else if (a === '--trigger') flags.trigger = argv[++i];
    else if (a.startsWith('--claim=')) flags.claim = a.split('=').slice(1).join('=');
    else if (a === '--claim') flags.claim = argv[++i];
    else if (a.startsWith('--body=')) flags.body = a.split('=').slice(1).join('=');
    else if (a === '--body') flags.body = argv[++i];
    else if (a.startsWith('--body-file=')) flags.bodyFile = a.split('=').slice(1).join('=');
    else if (a === '--body-file') flags.bodyFile = argv[++i];
    else if (a.startsWith('--ops=')) flags.ops = a.split('=').slice(1).join('=');
    else if (a === '--ops') flags.ops = argv[++i];
    else if (a.startsWith('--domain=')) flags.domain = a.split('=').slice(1).join('=');
    else if (a === '--domain') flags.domain = argv[++i];
    else if (a.startsWith('--reason=')) flags.reason = a.split('=').slice(1).join('=');
    else if (a === '--reason') flags.reason = argv[++i];
    else if (a.startsWith('--why=')) flags.why = a.split('=').slice(1).join('=');
    else if (a === '--why') flags.why = argv[++i];
    else if (a === '--yes') flags.yes = true;
  }

  return flags;
}
