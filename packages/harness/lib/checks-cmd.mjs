import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { positionalsOf } from './positionals.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { CHECKS_REL, loadNamedChecks, validateCommand, runNamedCheck, CHECK_TIMEOUT_DEFAULT_SECONDS } from './checks.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const CHECKS_VERBS = Object.freeze(['list', 'show', 'run']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

function readChecks(workspace) {
  const { checks, error } = loadNamedChecks(workspace);
  if (error) {
        throw notFoundError(error, `define checks in ${CHECKS_REL} with version: 1`);
  }
  return checks;
}

function describeCheck(name, config) {
  const invalid = validateCommand(name, config);
  return {
    name,
        command: Array.isArray(config?.command) ? [...config.command] : null,
    timeoutSeconds: config?.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS,
    valid: invalid === null,
    invalidReason: invalid,
  };
}

function context(argv) {
  const flags = parseFlags(argv);
    const positionals = positionalsOf(argv, { limit: 2 });
  return {
    flags,
    verb: positionals[0] ?? null,
    name: positionals[1] ?? null,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export async function checksResultOf(argv, ctx = {}) {
  const { verb, name, workspace, copilotHome } = context(argv);
  if (!verb) throw usageError('checks requires a verb', `harness checks <${CHECKS_VERBS.join('|')}>`);
  if (!CHECKS_VERBS.includes(verb)) {
    throw usageError(`unknown checks verb: ${verb}`, `one of ${CHECKS_VERBS.join(', ')}`);
  }
  const checks = readChecks(workspace);
  const names = Object.keys(checks).sort();

  if (verb === 'list') {
    return {
      schema: 1,
      verb,
      config: CHECKS_REL,
      checks: names.map((n) => describeCheck(n, checks[n])),
    };
  }

  if (!name) throw usageError(`checks ${verb} requires a check name`, `harness checks ${verb} <name>`);
  if (!(name in checks)) {
    throw notFoundError(`no check named ${JSON.stringify(name)} in ${CHECKS_REL}`, names.length ? `defined here: ${names.join(', ')}` : 'no checks are defined');
  }

  if (verb === 'show') {
    return { schema: 1, verb, config: CHECKS_REL, check: describeCheck(name, checks[name]) };
  }

    if (!isProjectTrusted({ workspace, copilotHome })) {
    throw Object.assign(new Error(`refusing to run ${JSON.stringify(name)}: this project is not trusted`), {
      code: 'E_DENIED',
      exit: EXIT.needsApproval,
      hint: `a named check runs commands this repository authored — read them with \`harness checks show ${name}\`, then \`harness trust approve\``,
    });
  }
    const outcome = await runNamedCheck(workspace, name, checks[name], { signal: ctx.signal, copilotHome, events: ctx.events });
    return { schema: 1, verb, config: CHECKS_REL, status: statusForOutcome(outcome), check: describeCheck(name, checks[name]), outcome };
}

/** The unified status vocabulary for a check's legacy outcome status. */
function statusForOutcome(outcome) {
  if (outcome?.status === 'passed') return 'ok';
  if (outcome?.status === 'timeout') return 'timed-out';
  return 'failed';
}

export function checksExitFor(result) {
  if (result?.verb !== 'run') return EXIT.ok;
  if (result.outcome?.status === 'passed') return EXIT.ok;
  if (result.outcome?.status === 'timeout') return EXIT.timedOut;
  return 1;
}

const OUTCOME_STATE = { passed: 'ok', failed: 'error', timeout: 'error', unavailable: 'warn' };

export async function cmdChecks(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await checksResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (result.verb === 'list') {
    const keyWidth = keyWidthFor(['checks', ...result.checks.map((c) => c.name)]);
    console.log(ui.line({ key: 'checks', value: `${result.checks.length} defined`, note: result.config, keyWidth }));
    for (const c of result.checks) {
      console.log(ui.line({
        state: c.valid ? 'ok' : 'error',
        key: c.name,
        value: c.command ? c.command.join(' ') : '(no command)',
        note: c.valid ? `${c.timeoutSeconds}s` : c.invalidReason,
        keyWidth,
      }));
    }
  } else {
    const c = result.check;
    const keyWidth = keyWidthFor(['command', 'timeout', 'outcome', 'stdout']);
    console.log(ui.line({ state: c.valid ? 'ok' : 'error', key: 'check', value: c.name, note: c.valid ? undefined : c.invalidReason, keyWidth }));
    console.log(ui.line({ key: 'command', value: (c.command || []).join(' '), keyWidth }));
    console.log(ui.line({ key: 'timeout', value: `${c.timeoutSeconds}s`, keyWidth }));
    if (result.outcome) {
      console.log(ui.line({
        state: OUTCOME_STATE[result.outcome.status] || 'warn',
        key: 'outcome',
        value: result.outcome.status,
        note: result.outcome.message,
        keyWidth,
      }));
            for (const stream of ['stdout', 'stderr']) {
        const text = result.outcome[stream];
        if (text) console.log(`${stream}:\n${String(text).split('\n').map(inertLine).join('\n')}`);
      }
    }
  }

    return checksExitFor(result);
}
