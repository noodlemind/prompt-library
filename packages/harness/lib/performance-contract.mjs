import path from 'node:path';
import YAML from 'yaml';
import { scanSecrets } from './secret-scan.mjs';

export const DEFAULT_PERFORMANCE_PROFILE = '.github/harness/performance.json';
export const PERFORMANCE_LIMITS = Object.freeze({ profile: 1024 * 1024, source: 200 * 1024, total: 8 * 1024 * 1024, repos: 32, sources: 256, nodes: 256, edges: 512, journeys: 32, rules: 128 });
export const METRICS = Object.freeze(['latency', 'reliability', 'throughput', 'cost']);
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
const CURRENCIES = new Set([...Intl.supportedValuesOf('currency'), 'XTS', 'XXX']);

export function performanceError(message) {
  return Object.assign(new Error(`performance: ${message}`), { code: 'E_USAGE', exit: 2 });
}

export function boundedText(value, max = 1024) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
}

export function validSlug(value) { return boundedText(value, 64) && SLUG.test(value) && scanSecrets(value).length === 0; }

export function safeRelativePath(value) {
  return boundedText(value, 1024) && !path.isAbsolute(value) && !/[\\:*?\[\]{}]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw performanceError(`${label} must be an object`);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw performanceError(`${label} contains an unsupported field`);
}

function text(value, label, max = 1024) {
  if (!boundedText(value, max)) throw performanceError(`${label} requires bounded nonempty text`);
}

function slug(value, label) {
  if (!validSlug(value)) throw performanceError(`${label} requires a lowercase slug of at most 64 bytes`);
}

function array(value, max, label) {
  if (!Array.isArray(value) || value.length > max) throw performanceError(`${label} must be an array of at most ${max} entries`);
}

function collection(value, max, label) {
  array(value, max, label);
  const ids = new Set();
  for (const entry of value) {
    slug(entry?.id, `${label} ID`);
    if (ids.has(entry.id)) throw performanceError(`${label} IDs must be unique`);
    ids.add(entry.id);
  }
  return ids;
}

function references(values, available, label, max = PERFORMANCE_LIMITS.sources) {
  array(values, max, label);
  if (new Set(values).size !== values.length || values.some(value => !available.has(value))) throw performanceError(`${label} must name unique declared members`);
}

export function parsePerformanceJson(bytes, label = 'input') {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(source);
    const document = YAML.parseDocument(source, { schema: 'json', uniqueKeys: true, merge: false, strict: true });
    if (document.errors.length || document.warnings.length) throw performanceError(`${label} contains duplicate keys or invalid JSON`);
    return value;
  } catch (error) {
    if (error?.code === 'E_USAGE') throw error;
    throw performanceError(`${label} must contain strict UTF-8 JSON with unique keys`);
  }
}

function metric(value, label, observation = false) {
  object(value, observation ? ['journey', 'node', 'metric', 'statistic', 'unit', 'basis', 'value', 'samples'] : ['metric', 'statistic', 'unit', 'basis', 'target'], label);
  if (!METRICS.includes(value.metric)) throw performanceError(`${label} metric is unsupported`);
  text(value.basis, `${label} basis`);
  const valid = {
    latency: ['p50', 'p95', 'p99', 'mean', 'max'].includes(value.statistic) && ['ms', 's'].includes(value.unit),
    reliability: value.statistic === 'ratio' && value.unit === 'ratio',
    throughput: value.statistic === 'rate' && value.unit === 'requests/s',
    cost: ['mean', 'total'].includes(value.statistic) && typeof value.unit === 'string' && /^[A-Z]{3}\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.unit) && value.unit.length <= 68 && CURRENCIES.has(value.unit.slice(0, 3)),
  }[value.metric];
  const amount = observation ? value.value : value.target;
  if (!valid || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || (value.metric === 'reliability' && amount > 1)) throw performanceError(`${label} has an invalid statistic, unit or finite nonnegative value`);
  if (observation && (!Number.isSafeInteger(value.samples) || value.samples <= 0)) throw performanceError(`${label} samples must be a positive safe integer`);
}

export function validatePerformanceProfile(value) {
  object(value, ['version', 'domain', 'sources', 'nodes', 'edges', 'journeys', 'rules', 'observations'], 'profile');
  if (value.version !== 1) throw performanceError('profile version must be 1');
  if (value.domain !== undefined) slug(value.domain, 'profile domain');
  const rules = value.rules === undefined ? [] : value.rules;
  const observations = value.observations === undefined ? [] : value.observations;
  const sourceIds = collection(value.sources, PERFORMANCE_LIMITS.sources, 'sources');
  const nodeIds = collection(value.nodes, PERFORMANCE_LIMITS.nodes, 'nodes');
  collection(value.edges, PERFORMANCE_LIMITS.edges, 'edges');
  const journeyIds = collection(value.journeys, PERFORMANCE_LIMITS.journeys, 'journeys');
  collection(rules, PERFORMANCE_LIMITS.rules, 'rules');
  for (const source of value.sources) {
    object(source, ['id', 'repo', 'path', 'kind'], 'source');
    slug(source.repo, 'source repo');
    if (!safeRelativePath(source.path)) throw performanceError('source path must name an exact safe relative file');
    if (!['code', 'manifest', 'design', 'evidence'].includes(source.kind)) throw performanceError('source kind is unsupported');
  }
  const locations = value.sources.map(source => `${source.repo}\0${source.path}`);
  if (new Set(locations).size !== locations.length) throw performanceError('source repo/path selections must be unique');
  for (const node of value.nodes) {
    object(node, ['id', 'label', 'kind', 'sources'], 'node');
    text(node.label, 'node label', 256);
    if (!['operation', 'service', 'queue', 'store', 'external', 'module'].includes(node.kind)) throw performanceError('node kind is unsupported');
    references(node.sources, sourceIds, 'node sources');
  }
  for (const edge of value.edges) {
    object(edge, ['id', 'from', 'to', 'mode', 'sources'], 'edge');
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw performanceError('edge endpoints must name declared nodes');
    if (!['sync', 'async', 'data', 'unknown'].includes(edge.mode)) throw performanceError('edge mode is unsupported');
    references(edge.sources, sourceIds, 'edge sources');
  }
  for (const journey of value.journeys) {
    object(journey, ['id', 'title', 'entry', 'completion', 'nodes', 'environment', 'workload', 'maxAgeSeconds', 'goals', 'constraints'], 'journey');
    text(journey.title, 'journey title', 256);
    references(journey.nodes, nodeIds, 'journey nodes', PERFORMANCE_LIMITS.nodes);
    if (!journey.nodes.includes(journey.entry) || !journey.nodes.includes(journey.completion)) throw performanceError('journey entry and completion must name selected journey nodes');
    text(journey.environment, 'journey environment', 256);
    text(journey.workload, 'journey workload', 1024);
    if (!Number.isSafeInteger(journey.maxAgeSeconds) || journey.maxAgeSeconds < 0 || journey.maxAgeSeconds > 315360000) throw performanceError('journey maxAgeSeconds must be an integer between 0 and 315360000');
    array(journey.goals, 4, 'journey goals');
    for (const goal of journey.goals) metric(goal, 'goal');
    if (new Set(journey.goals.map(goal => goal.metric)).size !== journey.goals.length) throw performanceError('journeys allow at most one goal per metric');
    collection(journey.constraints, 128, 'journey constraints');
    for (const constraint of journey.constraints) {
      object(constraint, ['id', 'text', 'sources'], 'constraint');
      text(constraint.text, 'constraint text', 2048);
      references(constraint.sources, sourceIds, 'constraint sources');
    }
  }
  for (const rule of rules) {
    if (!journeyIds.has(rule.journey)) throw performanceError('rule journey must name a declared journey');
    text(rule.rationale, 'rule rationale', 2048);
    const journey = value.journeys.find(entry => entry.id === rule.journey);
    if (['requires-path', 'forbids-edge'].includes(rule.kind)) {
      object(rule, ['id', 'kind', 'journey', 'from', 'to', 'rationale'], 'graph rule');
      if (!journey.nodes.includes(rule.from) || !journey.nodes.includes(rule.to)) throw performanceError('graph rule endpoints must belong to its journey');
    } else if (rule.kind === 'forbidden-package') {
      object(rule, ['id', 'kind', 'journey', 'source', 'package', 'rationale'], 'package rule');
      if (value.sources.find(source => source.id === rule.source)?.kind !== 'manifest') throw performanceError('forbidden-package source must name a selected manifest');
      if (!journeySourceIds(value, journey).has(rule.source)) throw performanceError('forbidden-package source must belong to its journey');
      text(rule.package, 'forbidden package', 256);
    } else throw performanceError('rule kind is unsupported');
  }
  references(observations, new Set(value.sources.filter(source => source.kind === 'evidence').map(source => source.id)), 'observations');
  return { ...value, rules, observations };
}

export function journeySourceIds(profile, journey) {
  const nodes = new Set(journey.nodes);
  return new Set([
    ...profile.nodes.filter(node => nodes.has(node.id)).flatMap(node => node.sources),
    ...profile.edges.filter(edge => nodes.has(edge.from) && nodes.has(edge.to)).flatMap(edge => edge.sources),
    ...journey.constraints.flatMap(constraint => constraint.sources),
  ]);
}

function isoDate(value) {
  if (!boundedText(value, 64)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59;
}

export function validatePerformanceObservation(value, profile, repoIds) {
  object(value, ['version', 'provenance', 'capturedAt', 'environment', 'workload', 'sourceHashes', 'metrics', 'deployments'], 'observation export');
  if (value.version !== 1) throw performanceError('observation version must be 1');
  object(value.provenance, ['kind', 'description'], 'observation provenance');
  if (!['synthetic', 'exported'].includes(value.provenance.kind)) throw performanceError('observation provenance kind must be synthetic or exported');
  text(value.provenance.description, 'observation provenance description', 2048);
  if (!isoDate(value.capturedAt)) throw performanceError('observation capturedAt must be a valid ISO timestamp with timezone');
  text(value.environment, 'observation environment', 256);
  text(value.workload, 'observation workload', 1024);
  const sourceIds = new Set(profile.sources.filter(source => source.kind !== 'evidence').map(source => source.id));
  object(value.sourceHashes, [...sourceIds], 'observation sourceHashes');
  if (Object.entries(value.sourceHashes).some(([, sha256]) => typeof sha256 !== 'string' || !HASH.test(sha256))) throw performanceError('observation sourceHashes requires lowercase SHA-256 values');
  array(value.metrics, 512, 'observation metrics');
  for (const entry of value.metrics) {
    metric(entry, 'observation metric', true);
    const journey = profile.journeys.find(journey => journey.id === entry.journey);
    if (!journey || (entry.node !== undefined && !journey.nodes.includes(entry.node))) throw performanceError('observation metric journey or node is outside the declared journey');
  }
  if (value.deployments !== undefined) {
    array(value.deployments, PERFORMANCE_LIMITS.nodes, 'observation deployments');
    if (new Set(value.deployments.map(entry => entry?.node)).size !== value.deployments.length) throw performanceError('observation deployment nodes must be unique');
    for (const entry of value.deployments) {
      object(entry, ['node', 'artifact', 'build', 'repo', 'commit'], 'observation deployment');
      if (!profile.nodes.some(node => node.id === entry.node)) throw performanceError('observation deployment must name a selected node');
      for (const field of ['artifact', 'build']) if (entry[field] !== undefined) text(entry[field], `deployment ${field}`, 1024);
      if (entry.repo !== undefined && !repoIds.has(entry.repo)) throw performanceError('observation deployment repo must name a selected repository');
      if (entry.commit !== undefined && (typeof entry.commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(entry.commit))) throw performanceError('observation deployment commit must be a full lowercase Git SHA');
    }
  }
  return value;
}
