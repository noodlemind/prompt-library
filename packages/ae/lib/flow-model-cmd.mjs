import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { readFileNoFollow } from './fs-safe.mjs';
import { redactedJson } from './redact.mjs';
import { prepareFlowModel, publishFlowModel, flowModelStatus, showFlowModel } from './flow-model.mjs';

export const FLOW_VERBS = Object.freeze(['prepare', 'publish', 'status', 'show']);
const BOOLEAN = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
const VALUED = new Set(['--file', '--workspace', '--ae-home', '--harness-home', '--copilot-home']);
const usage = message => Object.assign(new Error(`flows: ${message}`), { code: 'E_USAGE', exit: 2, hint: 'ae help flows' });

export function parseFlowArguments(argv) {
  const verb = argv[0];
  if (!FLOW_VERBS.includes(verb)) throw usage(`expected ${FLOW_VERBS.join('|')}`);
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
  const file = values.get('--file');
  if (verb === 'publish' && !file) throw usage('publish requires --file');
  if (file && !['prepare', 'publish'].includes(verb)) throw usage('--file is only supported for prepare or publish');
  if (file && (path.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes('\\') || file.includes(':') || file.split('/').some(part => !part || part === '.' || part === '..'))) throw usage('--file must be a contained relative path');
  return { flags: parseFlags(argv), verb, file };
}

export function flowsResultOf(argv, ctx = {}) {
  const { flags, verb, file } = parseFlowArguments(argv);
  const workspace = path.resolve(flags.workspace), home = flags.harnessHome || ctx.harnessHome || harnessGlobalHome();
  let input;
  if (file) {
    const content = readFileNoFollow(path.join(workspace, file), { root: workspace, maxBytes: 1024 * 1024 });
    if (content === null) throw usage('--file must be a bounded, readable regular file without symlink ancestors');
    try { input = JSON.parse(content); } catch { throw usage('--file must contain JSON'); }
  }
  let result;
  if (verb === 'prepare') {
    if (input && (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'watchPaths') || !Array.isArray(input.watchPaths))) throw usage('prepare input must be {watchPaths:[repo-relative paths]}');
    if (file && !input) throw usage('prepare input must be an object');
    result = { preparation: prepareFlowModel({ workspace, home, watchPaths: input?.watchPaths }) };
  } else if (verb === 'publish') result = publishFlowModel({ workspace, home, input, dryRun: Boolean(flags.dryRun) });
  else if (verb === 'status') result = flowModelStatus({ workspace, home });
  else result = showFlowModel({ workspace, home });
  return { mode: 'flows', verb, status: 'ok', exitCode: 0, ...result };
}

export function cmdFlows(argv, ctx = {}) {
  const result = flowsResultOf(argv, ctx), { flags } = parseFlowArguments(argv);
  if (flags.json) console.log(redactedJson(result, { pretty: flags.verbose }));
  else if (result.preparation && result.verb === 'prepare') console.log(JSON.stringify(result.preparation, null, 2));
  else if (result.verb === 'show') console.log(JSON.stringify(result, null, 2));
  else console.log(`Application flows: ${result.state}${result.generationCommit ? ` (${result.generationCommit.slice(0, 12)})` : ''}${result.dryRun ? '; dry run' : ''}`);
  ctx.reportStatus?.(result.status);
  return result.exitCode;
}
