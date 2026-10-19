import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { loadPlan } from './plan-parse.mjs';
import { planRevision } from './plan-decisions.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';
import { projectStoreDir } from './project-layout.mjs';
import { readFileNoFollow } from './fs-safe.mjs';
import { redactedJson } from './redact.mjs';
import { parseExperimentJson, experimentDigest } from './experiment-contract.mjs';
import { experimentEvaluatorSetup } from './experiment-isolation.mjs';
import { snapshotExperimentInputs, runExperimentMeasurement, experimentInputsCheck } from './experiment-measurement.mjs';
import { prepareExperimentAuthority, experimentMeasurementCheck } from './experiment-authority.mjs';
import { experimentStatus, reserveExperimentAttempt, markExperimentRunning, markExperimentChildStarted, recordExperimentChildSpawn, recordExperimentChildResult, recordExperimentMeasurement, resolveExperimentAttempt, recoverExperimentAttempt } from './experiment-state.mjs';

export const EXPERIMENT_VERBS = Object.freeze(['begin', 'evaluate', 'resolve', 'status']);
const OPTIONS = { begin: ['--plan', '--file'], evaluate: ['--plan', '--attempt'], resolve: ['--plan', '--file'], status: ['--plan', '--attempt'] };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const usage = message => Object.assign(new Error(`experiment: ${message}`), { code: 'E_USAGE', exit: 2, hint: 'ae help experiment' });

export function parseExperimentArguments(argv) {
  const positionals = [], values = new Map(), seen = new Set();
  const booleans = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
  const valued = new Set(['--workspace', '--ae-home', '--harness-home', '--copilot-home', ...Object.values(OPTIONS).flat()]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--' && index === argv.length - 1) break;
    if (!token.startsWith('-')) { positionals.push(token); continue; }
    const split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
    if (seen.has(key)) throw usage(`duplicate option ${key}`);
    seen.add(key);
    if (booleans.has(name) && split < 0) continue;
    if (!valued.has(name)) throw usage(`unsupported option ${name}`);
    const value = split < 0 ? argv[++index] : token.slice(split + 1);
    if (!value || value.startsWith('-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw usage(`${name} requires a bounded value`);
    values.set(name, value);
  }
  const verb = positionals[0];
  if (!EXPERIMENT_VERBS.includes(verb) || positionals.length !== 1) throw usage('unsupported verb or unexpected positional argument');
  const allowed = new Set(['--workspace', '--ae-home', '--harness-home', '--copilot-home', ...OPTIONS[verb]]);
  for (const key of values.keys()) if (!allowed.has(key)) throw usage(`${key} is unsupported for ${verb}`);
  if (verb !== 'status') for (const key of OPTIONS[verb]) if (!values.has(key)) throw usage(`${verb} requires ${key}`);
  if (values.has('--attempt') && !values.has('--plan')) throw usage('--attempt requires --plan');
  if (values.has('--attempt') && !UUID.test(values.get('--attempt'))) throw usage('--attempt requires an invocation UUID');
  return { verb, values, flags: parseFlags(argv), value: name => values.get(name) };
}

function decision(parsed, workspace, plan) {
  const raw = readFileNoFollow(path.resolve(workspace, parsed.value('--file')), { maxBytes: 1024 * 1024 });
  if (raw === null) throw usage('decision is missing or unsafe');
  const input = parseExperimentJson(raw);
  const required = parsed.verb === 'begin' ? ['version', 'id', 'expect', 'hypothesis'] : ['version', 'id', 'expect', 'attempt', 'decision', 'description'];
  const allowed = new Set([...required, ...(parsed.verb === 'begin' ? ['repair_of'] : [])]);
  if (!input || typeof input !== 'object' || Array.isArray(input) || required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !allowed.has(key)) || input.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(input.id || '') || input.expect !== planRevision(plan.text)) throw usage('decision requires exact supported fields and the current plan revision');
  const authored = parsed.verb === 'begin' ? input.hypothesis : input.description;
  if (typeof authored !== 'string' || !authored.trim() || authored.length > 2000 || /[\x00-\x1f\x7f]/.test(authored)) throw usage('decision requires one bounded authored explanation');
  if (parsed.verb === 'resolve' && (!UUID.test(input.attempt || '') || !['keep', 'discard', 'cancel'].includes(input.decision))) throw usage('resolve requires invocation UUID and keep, discard or cancel');
  if (input.repair_of !== undefined && !UUID.test(input.repair_of)) throw usage('repair_of requires invocation UUID');
  return input;
}

function attemptSummary(attempt) {
  if (!attempt) return null;
  const measurement = attempt.measurement;
  return { id: attempt.id, ordinal: attempt.ordinal, kind: attempt.kind, state: attempt.state, cost: attempt.cost,
    hypothesis: attempt.hypothesis?.slice(0, 400), repairOf: attempt.repairOf,
    ...(measurement ? { measurement: { status: measurement.status, metric: measurement.metric, correctness: { passed: measurement.correctness?.passed }, groupReaped: measurement.groupReaped,
      artifacts: measurement.checks?.flatMap(check => check.artifacts || []), message: measurement.message } } : {}),
    ...(attempt.children ? { children: Object.fromEntries(Object.entries(attempt.children).map(([mode, child]) => [mode, { state: child.state, childId: child.childId, pid: child.pid, groupId: child.groupId, groupReaped: child.result?.groupReaped }])) } : {}),
    ...(attempt.resolution ? { resolution: { decision: attempt.resolution.decision, description: attempt.resolution.description?.slice(0, 400) } } : {}) };
}

function statusSummary(state, selected) {
  const summary = { version: 1, status: state.status, spent: state.spent, origin: state.origin,
    ...(selected ? { attempt: attemptSummary(selected) } : {}),
    active: attemptSummary(state.active), lastKept: attemptSummary(state.lastKept), editability: state.editability,
    root: state.root, budget: state.budget, frozenDigest: state.frozenDigest, message: state.message,
    workspace: { pass: state.workspace?.pass, unclaimed: state.workspace?.unclaimed, message: state.workspace?.message }, inputs: state.inputs, retention: state.retention,
    attempts: (state.attempts || []).slice(-8).map(attemptSummary), omittedAttempts: Math.max(0, (state.attempts?.length || 0) - 8) };
  while (summary.attempts.length && Buffer.byteLength(JSON.stringify(summary)) > 7 * 1024) { summary.attempts.shift(); summary.omittedAttempts++; }
  return summary;
}

export async function experimentResultOf(argv, ctx = {}) {
  const parsed = parseExperimentArguments(argv), { verb, flags, value } = parsed;
  const workspace = path.resolve(flags.workspace), home = flags.harnessHome || ctx.harnessHome || harnessGlobalHome();
  const copilotHome = resolveCopilotHome(flags.copilotHome || ctx.copilotHome);
  if (verb === 'status' && !flags.plan) return { mode: 'experiment', verb, status: 'ok', exitCode: 0, setup: experimentEvaluatorSetup() };
  const plan = loadPlan(workspace, flags.plan, { home });
  if (!plan?.fm.experiment) throw usage('selected plan must be a supported full experiment plan');
  const common = { workspace, plan, home, copilotHome, recordRoot: projectStoreDir(workspace, { home }) };
  const state = experimentStatus(common);
  if (verb === 'status') {
    if (state.series) {
      const inputs = experimentInputsCheck({ ...common, accepted: state.series.acceptedInputs });
      state.inputs = { pass: inputs.pass, message: inputs.message };
      if (!inputs.pass && state.workspace?.pass) state.status = 'evaluator-invalid';
      if (state.lastKept && !state.active) {
        const retained = experimentMeasurementCheck(common)(state.lastKept);
        state.retention = { pass: retained.pass, message: retained.message };
        if (!retained.pass && state.workspace?.pass) state.status = 'evaluator-invalid';
      }
    }
    const attempt = value('--attempt') ? state.attempts?.find(row => row.id === value('--attempt')) : undefined;
    if (value('--attempt') && !attempt) throw usage('invocation is missing');
    return { ...statusSummary(state, attempt), mode: 'experiment', verb, exitCode: state.status === 'blocked-workspace' ? 1 : 0 };
  }
  if (flags.dryRun) return { mode: 'experiment', verb, status: 'ok', exitCode: 0, dryRun: true, experiment: state };
  const authorityCheck = acceptedInputs => prepareExperimentAuthority({ ...common, acceptedInputs, requireClaim: state.status !== 'absent' });
  let result;
  if (verb === 'begin') {
    const input = decision(parsed, workspace, plan), acceptedInputs = snapshotExperimentInputs(common);
    const previous = state.attempts?.find(row => row.operation === input.id);
    const kind = previous?.kind || (input.repair_of ? 'repair' : ['absent', 'initializing'].includes(state.status) ? 'baseline' : 'candidate');
    const attempt = reserveExperimentAttempt({ ...common, operation: input.id, authoredDigest: experimentDigest(input), kind, hypothesis: input.hypothesis, repairOf: input.repair_of, acceptedInputs, authorityCheck: authorityCheck(acceptedInputs) });
    result = { attempt, attempt_id: attempt.id };
  } else if (verb === 'evaluate') {
    let attempt = state.attempts?.find(row => row.id === value('--attempt'));
    if (!attempt) throw usage('invocation is missing');
    if (attempt.measurement) {
      const passed = attempt.measurement.status === 'passed' && attempt.measurement.correctness?.passed === true;
      return { mode: 'experiment', verb, status: passed ? 'ok' : 'failed', exitCode: passed ? 0 : 1, attempt_id: attempt.id, measurement: attempt.measurement, replayed: true };
    }
    if (attempt.state === 'running') {
      attempt = recoverExperimentAttempt({ ...common, invocation: attempt.id, measurementCheck: experimentMeasurementCheck(common) });
      return { mode: 'experiment', verb, status: 'failed', exitCode: 1, attempt_id: attempt.id, attempt, message: 'Started invocation cannot relaunch; resolve it and reserve a charged repair.' };
    }
    const checked = authorityCheck(attempt.acceptedInputs);
    const running = markExperimentRunning({ ...common, reservation: attempt, authorityCheck: checked });
    const callback = (event, detail) => {
      const options = { ...common, reservation: running, token: running.token, mode: detail.mode, authorityCheck: checked };
      if (event === 'beforeLaunch') markExperimentChildStarted({ ...options, authorityCheck: authorityCheck(running.acceptedInputs) });
      else if (event === 'spawn') recordExperimentChildSpawn({ ...options, ...detail });
      else if (event === 'settled') recordExperimentChildResult({ ...options, authorityCheck: undefined, result: detail.result || detail });
    };
    const measurement = await runExperimentMeasurement({ ...common, reservation: running, signal: ctx.signal, events: ctx.events, onEvent: callback });
    recordExperimentMeasurement({ ...common, reservation: running, token: running.token, result: measurement });
    result = { attempt_id: attempt.id, measurement };
  } else {
    const input = decision(parsed, workspace, plan);
    let attempt = state.attempts?.find(row => row.id === input.attempt);
    if (!attempt) throw usage('invocation is missing');
    if (['running', 'resolving'].includes(attempt.state)) attempt = recoverExperimentAttempt({ ...common, invocation: attempt.id, measurementCheck: experimentMeasurementCheck(common) });
    const checked = input.decision === 'keep' ? authorityCheck(attempt.acceptedInputs) : () => {
      const current = loadPlan(workspace, plan.path, { home });
      return { pass: Boolean(current && current.text === plan.text && current.fm.experiment && current.plan_lock), message: 'Accepted rollback plan changed; reread before resolution' };
    };
    resolveExperimentAttempt({ ...common, invocation: attempt.id, operation: input.id, authoredDigest: experimentDigest(input), decision: input.decision, description: input.description, authorityCheck: checked, measurementCheck: experimentMeasurementCheck(common) });
    result = { attempt_id: attempt.id, experiment: statusSummary(experimentStatus(common)) };
  }
  const pass = !result.measurement || result.measurement.status === 'passed' && result.measurement.correctness?.passed === true;
  return { mode: 'experiment', verb, status: pass ? 'ok' : 'failed', exitCode: pass ? 0 : 1, ...result };
}

export async function cmdExperiment(argv, ctx = {}) {
  const result = await experimentResultOf(argv, ctx);
  console.log(redactedJson(result, { pretty: parseFlags(argv).verbose }));
  ctx.reportStatus?.(result.status);
  return result.exitCode;
}
