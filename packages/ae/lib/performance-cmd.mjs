import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { redactedJson } from './redact.mjs';
import { analyzePerformance } from './performance.mjs';
import { renderPerformanceHtml } from './performance-report.mjs';

export const PERFORMANCE_VERBS = Object.freeze(['analyze']);
const DEFAULT_PROFILE = '.github/harness/performance.json';
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const BOOLEAN = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
const VALUED = new Set(['--file', '--domain', '--workspace', '--ae-home', '--harness-home', '--copilot-home']);
const usage = message => Object.assign(new Error(`performance: ${message}`), { code: 'E_USAGE', exit: 2, hint: 'ae help performance' });

export function parsePerformanceArguments(argv) {
  if (argv[0] !== 'analyze') throw usage('expected analyze');
  const seen = new Set(), values = new Map();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i], split = token.indexOf('=');
    const name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
    if (seen.has(key)) throw usage(`duplicate option ${key}`);
    seen.add(key);
    if (BOOLEAN.has(name) && split < 0) continue;
    if (!VALUED.has(name)) throw usage(`unsupported option ${name}`);
    const value = split < 0 ? argv[++i] : token.slice(split + 1);
    if (!value || value.startsWith('-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw usage(`${name} requires a bounded value`);
    values.set(name, value);
  }
  const domain = values.get('--domain');
  if (domain && (domain.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(domain))) throw usage('invalid domain name');
  const profilePath = values.get('--file') || DEFAULT_PROFILE;
  if (path.isAbsolute(profilePath) || path.win32.isAbsolute(profilePath) || profilePath.includes('\\') || profilePath.split('/').some(part => !part || part === '.' || part === '..')) throw usage('--file must be a contained relative path');
  return { flags: parseFlags(argv), profilePath, domain };
}

function publish(workspace, rel, content) {
  const existing = readFileNoFollow(path.join(workspace, rel), { root: workspace, maxBytes: MAX_REPORT_BYTES });
  if (existing === content) return rel;
  if (existing !== null || !writeFileContained(workspace, rel, content, { exclusive: true })) {
    if (readFileNoFollow(path.join(workspace, rel), { root: workspace, maxBytes: MAX_REPORT_BYTES }) !== content) throw usage('report destination is unsafe or contains conflicting bytes');
  }
  return rel;
}

export function performanceResultOf(argv, ctx = {}) {
  const { flags, profilePath, domain } = parsePerformanceArguments(argv);
  const workspace = path.resolve(flags.workspace), home = flags.harnessHome || ctx.harnessHome || harnessGlobalHome();
  const report = analyzePerformance({ workspace, home, profilePath, domain });
  if (!/^[a-f0-9]{64}$/.test(report.id)) throw usage('invalid report identity');
  const artifacts = { json: `.harness/performance/${report.id}/report.json`, html: `.harness/performance/${report.id}/report.html` };
  const json = `${JSON.stringify(report, null, 2)}\n`, html = renderPerformanceHtml(report);
  if ([json, html].some(content => Buffer.byteLength(content) > MAX_REPORT_BYTES)) throw usage('generated report exceeds 16 MiB per artifact; select fewer source files');
  if (!flags.dryRun) {
    publish(workspace, artifacts.json, json);
    publish(workspace, artifacts.html, html);
  }
  return { mode: 'performance', verb: 'analyze', status: 'ok', exitCode: 0, report, artifacts: flags.dryRun ? null : artifacts, dryRun: Boolean(flags.dryRun) };
}

export function cmdPerformance(argv, ctx = {}) {
  const result = performanceResultOf(argv, ctx), { flags } = parsePerformanceArguments(argv);
  if (flags.json) console.log(redactedJson(result, { pretty: flags.verbose }));
  else {
    console.log(`Performance snapshot ${result.report.id.slice(0, 12)}: ${result.report.journeys.length} journeys, ${result.report.coverage.read}/${result.report.coverage.selected} sources`);
    for (const journey of result.report.journeys) console.log(`  ${journey.id}: ${journey.goals.map(goal => `${goal.metric} ${goal.status}`).join('; ')}`);
    if (result.artifacts) console.log(`  Open ${result.artifacts.html}`);
    else console.log('  Dry run; no reports written.');
  }
  ctx.reportStatus?.(result.status);
  return result.exitCode;
}
