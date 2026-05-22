export function parseFlags(argv) {
  const flags = {
    dryRun: false,
    verbose: false,
    json: false,
    preserveKnowledge: true,
    forceProfile: false,
    configureVsCode: false,
    autonomy: null,
    copilotHome: null,
    targets: new Set(['vscode', 'cli', 'intellij']),
    workspace: process.cwd(),
    query: null,
    phase: 'implement',
    limit: 3,
    refresh: false,
    semantic: false,
    includePlans: false,
    strictIntent: false,
    noEvents: false,
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
    else if (a.startsWith('--query=')) flags.query = a.split('=').slice(1).join('=');
    else if (a === '--query') flags.query = argv[++i];
    else if (a.startsWith('--phase=')) flags.phase = a.split('=')[1];
    else if (a === '--phase') flags.phase = argv[++i];
    else if (a.startsWith('--limit=')) flags.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--limit') flags.limit = parseInt(argv[++i], 10);
    else if (a === '--preserve-knowledge') flags.preserveKnowledge = true;
    else if (a === '--force-knowledge-reset') flags.preserveKnowledge = false;
    else if (a === '--force-profile') flags.forceProfile = true;
    else if (a === '--configure-vscode') flags.configureVsCode = true;
    else if (a.startsWith('--autonomy=')) flags.autonomy = a.split('=')[1];
    else if (a === '--autonomy') flags.autonomy = argv[++i];
    else if (a.startsWith('--copilot-home=')) flags.copilotHome = a.split('=')[1];
    else if (a === '--copilot-home') flags.copilotHome = argv[++i];
    else if (a.startsWith('--target=')) {
      flags.targets = new Set(a.split('=')[1].split(',').map((t) => t.trim()));
    } else if (a === '--target') {
      flags.targets = new Set(argv[++i].split(',').map((t) => t.trim()));
    } else if (a.startsWith('--workspace=')) flags.workspace = a.split('=')[1];
    else if (a === '--workspace') flags.workspace = argv[++i];
  }

  return flags;
}
