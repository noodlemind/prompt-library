import { parseFlags } from './flags.mjs';
import { positionalsOf } from './positionals.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { redactedJson, createRedactor } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { readDomain, inspectDomain } from './domain-contract.mjs';

export const DOMAIN_VERBS = Object.freeze(['show']);

function usage(message) {
  return Object.assign(new Error(`domain: ${message}`), { code: 'E_USAGE', exit: 2, hint: 'harness domain show --name <name> --json' });
}

function selectedName(argv) {
  let value = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') break;
    if (arg !== '--name' && !arg.startsWith('--name=')) continue;
    if (value !== null) throw usage('--name was given more than once');
    value = arg === '--name' ? argv[++index] : arg.slice('--name='.length);
    if (!value || value.startsWith('--')) throw usage('--name needs a value');
  }
  if (value === null) throw usage('show requires --name <name>');
  return value;
}

export function domainResultOf(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const pos = positionalsOf(argv, { extra: ['--name'] });
  if (pos.length !== 1 || pos[0] !== 'show') throw usage('only the show verb is supported; unexpected argument');
  const name = selectedName(argv);
  const home = flags.harnessHome || ctx.harnessHome || harnessGlobalHome();
  return inspectDomain(readDomain(name, { home }));
}

export async function cmdDomain(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const result = domainResultOf(argv, ctx);
  const redactor = createRedactor();
  if (flags.json) console.log(redactedJson(result, { pretty: flags.verbose, redactor }));
  else {
    const { redactText } = redactor;
    console.log(`domain ${inertLine(result.name)} (version ${result.domainVersion}, advisory)`);
    for (const repo of result.repos) {
      console.log(`  ${inertLine(repo.id)}: ${repo.status}; ${inertLine(redactText(repo.expected.root))}`);
      console.log(`    origin expected: ${inertLine(redactText(repo.expected.origin))}`);
      console.log(`    origin observed: ${inertLine(redactText(repo.observed.origin || 'unknown'))}`);
      console.log(`    HEAD: ${repo.observed.head || 'unknown'}; checks: ${repo.checks.status}`);
      for (const warning of repo.warnings) console.log(`    ${inertLine(warning)}`);
    }
    for (const warning of result.warnings) console.log(`  ${inertLine(warning)}`);
  }
  ctx.reportStatus?.(result.status);
  return result.exitCode;
}
