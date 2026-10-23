import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { queryGraph, prepareGraph, GRAPH_OPERATIONS } from './graph.mjs';
import { inertLine } from './knowledge/store.mjs';
import { redactedJson } from './redact.mjs';
import { EXIT } from './style.mjs';

export function parseGraphArguments(argv) {
  const positionals = [];
  const values = {};
  const valueFlags = new Set(['--workspace', '--copilot-home', '--ae-home', '--harness-home', '--output', '--limit', '--depth', '--generation']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    const flag = arg.split('=')[0];
    if (valueFlags.has(flag)) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('--')) throw Object.assign(new Error(`${flag} requires a value`), { code: 'E_USAGE', exit: EXIT.usage, hint: 'ae help graph' });
      if (['--limit', '--depth'].includes(flag)) {
        if (!/^\d+$/.test(value)) throw Object.assign(new Error(`${flag} requires an integer`), { code: 'E_USAGE', exit: EXIT.usage, hint: 'ae help graph' });
        values[flag.slice(2)] = Number(value);
      }
      if (flag === '--generation') values.generation = value;
      continue;
    }
    if (['--json', '--verbose', '-v', '--dry-run', '--no-events', '--no-color'].includes(arg)) continue;
    if (arg.startsWith('-')) throw Object.assign(new Error(`unknown graph flag ${arg}`), { code: 'E_USAGE', exit: EXIT.usage, hint: 'ae help graph' });
    positionals.push(arg);
  }
  const flags = parseFlags(argv);
  const operation = positionals.shift();
  return { workspace: path.resolve(flags.workspace), home: flags.harnessHome || flags.home, operation, files: positionals, ...values, flags };
}

export function graphResultOf(argv, preparation = null) {
  const result = queryGraph(parseGraphArguments(argv));
  if (preparation?.refreshed) Object.assign(result.cache, { reused: preparation.reused, refreshed: preparation.reparsed, prepared: true });
  if (preparation?.dryRun) result.preparation = { dryRun: true, refreshed: false, degraded: result.coverage.lexicalFiles > 0, reason: 'Dry-run skips parser preparation; existing facts or labelled lexical evidence are read without publishing an index.' };
  return { ...result, summary: `${result.operation} ${result.roots.join(' -> ')}: ${result.outcome}${result.coverage.complete ? '' : ' with incomplete coverage'} [git-tracked-source; ${result.freshness.state}${result.source === 'snapshot' ? ` generation ${result.generation}; no live validation` : ''}; import declarations only${preparation?.dryRun ? '; dry-run, parser preparation skipped' : ''}]` };
}

export async function cmdGraph(argv) {
  const args = parseGraphArguments(argv);
  if (!GRAPH_OPERATIONS.includes(args.operation) || args.files.length !== (['path', 'explain'].includes(args.operation) ? 2 : 1)) return graphResultOf(argv);
  const preparation = await prepareGraph(args);
  const result = graphResultOf(argv, preparation);
  const flags = parseFlags(argv);
  if (flags.json) console.log(redactedJson(result, { pretty: flags.verbose }));
  else {
    console.log(inertLine(result.summary));
    if (result.path) console.log(inertLine(result.path.join(' -> ')));
    else for (const edge of result.edges) console.log(inertLine(`${edge.from} -> ${edge.to} (${edge.resolution}; ${edge.method || 'unknown'}; ${edge.resolutionStatus || 'candidate'})`));
    for (const edge of result.unresolved) console.log(inertLine(`${edge.from}: ${edge.import} (${edge.reason})`));
    if (result.omitted.edges || result.omitted.unresolved) console.log(`${result.omitted.edges} edges and ${result.omitted.unresolved} unresolved imports omitted; increase --limit.`);
    if (result.depthLimitReached) console.log(`Traversal stopped at --depth ${result.depth}; increase --depth to explore further.`);
  }
  return 0;
}

export { GRAPH_OPERATIONS };
