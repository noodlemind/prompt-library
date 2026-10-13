import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

export const EXPERIMENT_WORKLOAD = 'linear-json-v1';
export const EXPERIMENT_EVALUATOR_PATH = fileURLToPath(new URL('./experiment-evaluator.mjs', import.meta.url));
export const EXPERIMENT_MAX_INPUT_BYTES = 1024 * 1024;
export const EXPERIMENT_MAX_DIMENSIONS = 128;
export const EXPERIMENT_MAX_ROWS = 4096;
export const EXPERIMENT_ENVIRONMENT = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
const invocations = new WeakMap();

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const experimentDigest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const fail = message => { throw new Error(`Experiment contract: ${message}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e100;
const positive = value => Number.isSafeInteger(value) && value > 0;

function keys(value, expected, label) {
  if (!object(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail(`${label} requires exactly ${expected.join(', ')}`);
}

export function experimentSafePath(value) {
  return typeof value === 'string' && value.length <= 512 && value.endsWith('.json') && !/[\\:*?\[\]{}\x00-\x1f]/.test(value) && !path.posix.isAbsolute(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
}

export function validateExperimentContract(experiment, { impactedFiles } = {}) {
  keys(experiment, ['version', 'workload', 'candidate', 'editable_files', 'metric', 'scorer_check', 'correctness_checks', 'dependencies', 'protocol', 'target', 'budget'], 'experiment');
  if (experiment.version !== 1 || experiment.workload !== EXPERIMENT_WORKLOAD) fail('unsupported experiment version or workload');
  if (!experimentSafePath(experiment.candidate) || /(^|\/)(\.git|\.github|\.harness|plans|intent|intents|helpers|checks)(\/|$)/i.test(experiment.candidate)) fail('candidate requires an exact unprotected JSON path');
  if (!Array.isArray(experiment.editable_files) || experiment.editable_files.length !== 1 || experiment.editable_files[0] !== experiment.candidate) fail('editable_files must contain only the candidate');
  if (impactedFiles !== undefined && (!Array.isArray(impactedFiles) || !impactedFiles.includes(experiment.candidate))) fail('candidate must be an exact accepted impacted file');
  keys(experiment.metric, ['name', 'units', 'direction'], 'metric');
  if (experiment.metric.name !== 'mean-absolute-error' || experiment.metric.units !== 'absolute-error' || experiment.metric.direction !== 'minimize') fail('unsupported metric');
  const checkId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
  if (!checkId(experiment.scorer_check) || !Array.isArray(experiment.correctness_checks) || experiment.correctness_checks.length !== 1 || !checkId(experiment.correctness_checks[0]) || experiment.correctness_checks[0] === experiment.scorer_check) fail('one distinct named scorer and correctness check are required');
  if (!Array.isArray(experiment.dependencies) || experiment.dependencies.length !== 1 || !experimentSafePath(experiment.dependencies[0]) || experiment.dependencies.includes(experiment.candidate)) fail('one separate frozen workload dependency is required');
  keys(experiment.protocol, ['deterministic', 'repetitions', 'minimum_improvement'], 'protocol');
  if (experiment.protocol.deterministic !== true || experiment.protocol.repetitions !== 1 || !finite(experiment.protocol.minimum_improvement) || experiment.protocol.minimum_improvement <= 0) fail('only deterministic single repetition with a positive minimum improvement is supported');
  if (!finite(experiment.target) || experiment.target < 0) fail('target must be a bounded finite nonnegative value');
  keys(experiment.budget, ['max_invocations', 'max_seconds', 'timeout_seconds', 'max_repair_reruns'], 'budget');
  if (!positive(experiment.budget.max_invocations) || experiment.budget.max_invocations > 10000 || !positive(experiment.budget.max_seconds) || experiment.budget.max_seconds > 604800 || !positive(experiment.budget.timeout_seconds) || experiment.budget.timeout_seconds > 3600 || !Number.isSafeInteger(experiment.budget.max_repair_reruns) || experiment.budget.max_repair_reruns < 0 || experiment.budget.max_repair_reruns > 2) fail('budget requires bounded positive invocation, wall and timeout limits and at most two repairs');
  return experiment;
}

export function parseExperimentJson(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (Buffer.byteLength(text) > EXPERIMENT_MAX_INPUT_BYTES) fail('JSON is oversized');
  let value;
  try {
    value = JSON.parse(text);
    const document = YAML.parseDocument(text, { schema: 'json', uniqueKeys: true, maxAliasCount: 0 });
    if (document.errors.length) throw new Error(document.errors[0].message);
    document.toJS({ maxAliasCount: 0 });
  } catch (error) { fail(`invalid or duplicate JSON: ${error.message.slice(0, 180)}`); }
  const visit = (entry, depth = 0) => {
    if (depth > 16) fail('JSON nesting is excessive');
    if (typeof entry === 'number' && !Number.isFinite(entry)) fail('JSON numbers must be finite');
    if (entry && typeof entry === 'object') for (const child of Object.values(entry)) visit(child, depth + 1);
  };
  visit(value);
  return value;
}

export function validateLinearCandidate(candidate) {
  keys(candidate, ['version', 'weights'], 'candidate');
  if (candidate.version !== 1 || !Array.isArray(candidate.weights) || !candidate.weights.length || candidate.weights.length > EXPERIMENT_MAX_DIMENSIONS || !candidate.weights.every(finite)) fail('candidate weights must be bounded finite numbers');
  return candidate;
}

export function validateLinearWorkload(workload, dimensions) {
  keys(workload, ['version', 'objective', 'guards'], 'workload');
  if (workload.version !== 1 || !positive(dimensions) || dimensions > EXPERIMENT_MAX_DIMENSIONS) fail('unsupported workload dimensions');
  for (const [label, fields] of [['objective', ['features', 'expected']], ['guards', ['features', 'min', 'max']]]) {
    const rows = workload[label];
    if (!Array.isArray(rows) || !rows.length || rows.length > EXPERIMENT_MAX_ROWS) fail(`${label} requires bounded nonempty rows`);
    for (const row of rows) {
      keys(row, fields, `${label} row`);
      if (!Array.isArray(row.features) || row.features.length !== dimensions || !row.features.every(finite)) fail(`${label} row dimensions or values are invalid`);
      if (label === 'objective' ? !finite(row.expected) : !finite(row.min) || !finite(row.max) || row.min > row.max) fail(`${label} row expected or guard bounds are invalid`);
    }
  }
  return workload;
}

export function createExperimentInvocation(details) {
  const capability = Object.freeze({});
  invocations.set(capability, details);
  return capability;
}

export function consumeExperimentInvocation(capability, { workspace, name, config, recordRoot }) {
  const details = invocations.get(capability);
  if (!details || details.workspace !== workspace || details.name !== name || details.recordRoot !== recordRoot || details.configDigest !== experimentDigest(config)) throw new Error('Experiment invocation lacks bound internal authority');
  invocations.delete(capability);
  return details;
}

export function isExperimentCheck(config) {
  return Boolean(config?.experiment || config?.command?.some(part => typeof part === 'string' && path.resolve(part) === path.resolve(EXPERIMENT_EVALUATOR_PATH)));
}
