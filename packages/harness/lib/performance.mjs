import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readDomain, observeDomainRepositoryIdentity } from './domain-contract.mjs';
import { snapshotDomain } from './domain-bindings.mjs';
import { assertNoSymlinkAncestors, canonicalPath, readFileNoFollow } from './fs-safe.mjs';
import { extract } from './repo-map/lexical-extractor.mjs';
import { redactSecrets } from './secret-scan.mjs';
import { DEFAULT_PERFORMANCE_PROFILE, PERFORMANCE_LIMITS, METRICS, boundedText, validSlug, safeRelativePath, performanceError, parsePerformanceJson, validatePerformanceProfile, validatePerformanceObservation, journeySourceIds } from './performance-contract.mjs';

export { DEFAULT_PERFORMANCE_PROFILE } from './performance-contract.mjs';
const PACKAGE_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const LIMITATIONS = [
  'This report is a snapshot of selected local files and declared journeys. It does not execute application code or fetch remote evidence.',
  'Architecture nodes and edges are declared design. Lexical imports and symbols are heuristic extracted evidence, not complete dependency or runtime call proof.',
  'Imported measurements are attributed evidence. Current file hashes and Git revisions do not authenticate production identity or establish causal bottlenecks.',
  'No percentiles are summed, no ambiguous measurements are aggregated, and no critical path or CPU hotspot is inferred.',
  'Secret screening uses the existing pattern-based scanner and is not a guarantee that every secret has been detected.',
];

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function digest(value) { return sha256(JSON.stringify(canonical(value))); }

function screened(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(screened);
  if (value && typeof value === 'object') {
    const entries = new Map();
    for (const [key, entry] of Object.entries(value)) {
      let safeKey = redactSecrets(key);
      if (entries.has(safeKey)) safeKey = `[redacted key collision ${entries.size}]`;
      entries.set(safeKey, screened(entry));
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function workspaceRoot(workspace) {
  if (!boundedText(workspace, 4096) || !path.isAbsolute(workspace)) throw performanceError('workspace must be an absolute directory');
  const root = path.resolve(workspace), anchor = path.parse(root).root;
  if (!assertNoSymlinkAncestors(anchor, path.relative(anchor, root))) throw performanceError('workspace is unsafe or symlinked');
  try {
    if (!fs.lstatSync(root).isDirectory()) throw performanceError('workspace must be a directory');
    return canonicalPath(root);
  } catch { throw performanceError('workspace is unavailable or not a directory'); }
}

function selectedBytes(root, relative, maxBytes) {
  const full = assertNoSymlinkAncestors(root, relative);
  return full ? readFileNoFollow(full, { root, maxBytes, encoding: null }) : null;
}

function profileBytes(root, profilePath) {
  if (!safeRelativePath(profilePath)) throw performanceError('profile path must name an exact workspace-relative JSON file');
  const bytes = selectedBytes(root, profilePath, PERFORMANCE_LIMITS.profile);
  if (bytes === null) throw performanceError('profile is missing, unreadable, oversized or not a safe regular file');
  return bytes;
}

function liveRepositories(workspace, home, selectedDomain) {
  let domain = null, domainRecord = null, domainBytes = null;
  const available = new Map();
  if (selectedDomain !== undefined) {
    if (!validSlug(selectedDomain)) throw performanceError('domain requires a lowercase slug of at most 64 bytes');
    try {
      domainRecord = readDomain(selectedDomain, home == null ? {} : { home });
      if (domainRecord.config.domain_version !== 2) throw performanceError('performance domain requires domain_version 2');
      domainBytes = readFileNoFollow(domainRecord.configPath, { root: domainRecord.home, maxBytes: 64 * 1024, encoding: null });
      if (domainBytes === null) throw performanceError('domain config is unavailable');
      domain = { ...snapshotDomain(domainRecord), config: { path: domainRecord.configPath, sha256: sha256(domainBytes) } };
      for (const member of domain.bindings.repos) {
        const descriptor = domain.logical.repos.find(repo => repo.id === member.id);
        const observed = observeDomainRepositoryIdentity(member.root, descriptor);
        if (observed.status !== 'available' || !observed.observed.head) throw performanceError('selected domain repository HEAD is unavailable');
        available.set(member.id, { id: member.id, root: member.root, head: observed.observed.head });
      }
    } catch (error) {
      if (error?.code === 'E_USAGE') throw error;
      throw performanceError(error?.code?.startsWith('E_DOMAIN') ? error.message : 'domain binding is unavailable');
    }
  }
  if (selectedDomain === undefined) {
    let self;
    try {
      const observed = observeDomainRepositoryIdentity(workspace, { id: 'self' });
      self = { id: 'self', root: workspace, head: observed.status === 'available' ? observed.observed.head : null };
    } catch { self = { id: 'self', root: workspace, head: null }; }
    available.set('self', self);
  }
  return { available, domain, domainRecord, domainBytes };
}

function manifests(source, bytes) {
  if (source.kind !== 'manifest' || bytes === null) return { state: 'unavailable', packages: [] };
  try {
    const value = parsePerformanceJson(bytes, 'manifest');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid', packages: [] };
    const packages = new Set();
    for (const section of PACKAGE_SECTIONS) {
      if (!Object.hasOwn(value, section)) continue;
      const entries = value[section];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return { state: 'invalid', packages: [] };
      for (const [name, version] of Object.entries(entries)) {
        if (!boundedText(name, 256) || !boundedText(version, 1024) || packages.size >= 4096) return { state: 'invalid', packages: [] };
        packages.add(name);
      }
    }
    return { state: 'regular', packages: [...packages].sort() };
  } catch { return { state: 'invalid', packages: [] }; }
}

function implementationView(profile, sources, bytes, unknowns) {
  const manifestData = new Map();
  const nodes = sources.map(source => {
    const content = bytes.get(source.id);
    const extracted = source.kind === 'code' && content !== null ? extract(source.path, content.toString('utf8')) : { symbols: [], imports: [] };
    const limitsReached = extracted.limitsReached || { symbols: false, imports: false, refs: false };
    const truncated = Object.keys(limitsReached).filter(key => limitsReached[key]);
    if (truncated.length) unknowns.push(`Source ${source.id} lexical extraction is truncated for ${truncated.join(', ')}; additional entries are omitted.`);
    const manifest = manifests(source, content);
    if (source.kind === 'manifest') {
      manifestData.set(source.id, manifest);
      if (source.state === 'regular' && manifest.state !== 'regular') unknowns.push(`Manifest ${source.id} is malformed or exceeds the bounded dependency contract; package choices are unknown.`);
    }
    return { ...source, symbols: extracted.symbols.map(value => value.slice(0, 256)), imports: extracted.imports.map(value => value.slice(0, 1024)), limitsReached, packages: manifest.packages };
  });
  const byLocation = new Map(profile.sources.map(source => [`${source.repo}\0${source.path}`, source.id]));
  const edges = [];
  for (const source of nodes) {
    for (const dependency of source.imports) {
      let to = null;
      if (dependency.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(source.path), dependency));
        const candidates = [base, ...['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.java'].map(extension => base + extension), ...['index.mjs', 'index.js', 'index.ts'].map(file => `${base}/${file}`)];
        const matches = [...new Set(candidates.map(candidate => byLocation.get(`${source.repo}\0${candidate}`)).filter(Boolean))];
        if (matches.length === 1) to = matches[0];
      }
      edges.push({ from: source.id, to, dependency, provenance: 'extracted', fidelity: 'lexical' });
    }
  }
  return { nodes, edges, manifestData };
}

function graphEdges(profile, journey) {
  const nodes = new Set(journey.nodes);
  return profile.edges.filter(edge => nodes.has(edge.from) && nodes.has(edge.to));
}

function hasPath(edges, from, to) {
  const pending = [from], seen = new Set();
  while (pending.length) {
    const next = pending.pop();
    if (next === to) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const edge of edges) if (edge.from === next) pending.push(edge.to);
  }
  return false;
}

function structuralDiagnostics(profile, manifestData) {
  const diagnostics = [];
  for (const rule of profile.rules) {
    const journey = profile.journeys.find(journey => journey.id === rule.journey);
    const edges = graphEdges(profile, journey);
    const sources = [...journeySourceIds(profile, journey)];
    const base = { id: `rule-${rule.id}`, journeys: [rule.journey], detail: rule.rationale };
    if (rule.kind === 'forbidden-package') {
      const manifest = manifestData.get(rule.source);
      if (manifest?.state !== 'regular') diagnostics.push({ ...base, view: 'implementation', kind: 'unknown', nodes: profile.nodes.filter(node => journey.nodes.includes(node.id) && node.sources.includes(rule.source)).map(node => node.id), sources: [rule.source], title: 'Package rule cannot be evaluated from the selected manifest', provenance: 'extracted' });
      else if (manifest.packages.includes(rule.package)) diagnostics.push({ ...base, view: 'implementation', kind: 'structural-violation', nodes: profile.nodes.filter(node => journey.nodes.includes(node.id) && node.sources.includes(rule.source)).map(node => node.id), sources: [rule.source], title: `Selected manifest declares forbidden package ${rule.package}`, provenance: 'extracted' });
    } else if (rule.kind === 'requires-path' && !hasPath(edges, rule.from, rule.to)) {
      diagnostics.push({ ...base, view: 'architecture', kind: 'structural-violation', nodes: [rule.from, rule.to], sources, title: 'Declared journey has no required completion path', provenance: 'declared' });
    } else if (rule.kind === 'forbids-edge' && edges.some(edge => edge.from === rule.from && edge.to === rule.to)) {
      diagnostics.push({ ...base, view: 'architecture', kind: 'structural-violation', nodes: [rule.from, rule.to], sources, title: 'Declared journey contains a forbidden direct edge', provenance: 'declared' });
    }
  }
  return diagnostics;
}

function observationFreshness(profile, journey, observation, sources, repos, now) {
  const at = Date.parse(observation.capturedAt);
  if (at > now) return { status: 'unknown', reason: 'Observation capture is in the future.' };
  if (now - at > journey.maxAgeSeconds * 1000) return { status: 'stale', reason: 'Observation exceeds the journey maximum age.' };
  const relevant = [...journeySourceIds(profile, journey)].map(id => sources.get(id)).filter(source => source.kind !== 'evidence');
  if (relevant.some(source => source.state !== 'regular')) return { status: 'unknown', reason: 'A selected journey source is unavailable.' };
  if (relevant.some(source => Object.hasOwn(observation.sourceHashes, source.id) && observation.sourceHashes[source.id] !== source.sha256)) return { status: 'stale', reason: 'Observation source hashes differ from current selected journey bytes.' };
  if (relevant.some(source => !Object.hasOwn(observation.sourceHashes, source.id))) return { status: 'unknown', reason: 'Observation does not map every selected non-evidence journey source.' };
  if (relevant.length === 0) return { status: 'unknown', reason: 'Journey has no selected non-evidence source binding.' };
  for (const deployment of observation.deployments ?? []) {
    if (!journey.nodes.includes(deployment.node)) continue;
    if (deployment.commit !== undefined) {
      if (deployment.repo === undefined || !repos.get(deployment.repo)?.head) return { status: 'unknown', reason: 'Deployment commit has no current selected repository HEAD mapping.' };
      if (deployment.commit !== repos.get(deployment.repo).head) return { status: 'stale', reason: 'Deployment commit differs from the current selected repository HEAD.' };
    }
  }
  return { status: 'current', reason: 'Selected source bytes, capture age and supplied deployment revisions are current.' };
}

function evaluateGoals(profile, observations, sources, repos, now, diagnostics, unknowns) {
  return profile.journeys.map(journey => ({
    ...journey,
    goals: METRICS.map(metric => {
      const direction = ['latency', 'cost'].includes(metric) ? 'max' : 'min';
      const goal = journey.goals.find(goal => goal.metric === metric);
      if (!goal) return { metric, direction, status: 'unknown', reason: 'No goal declared for this dimension.' };
      const declared = { ...goal, direction };
      const matches = observations.flatMap(observation => observation.environment === journey.environment && observation.workload === journey.workload
        ? observation.metrics.filter(value => value.journey === journey.id && value.node === undefined && value.metric === metric && value.statistic === declared.statistic && value.unit === declared.unit && value.basis === declared.basis).map(value => ({ observation, value }))
        : []);
      if (matches.length !== 1) return { ...declared, status: 'unknown', reason: matches.length ? 'Multiple compatible journey measurements are ambiguous; no aggregation is performed.' : 'No compatible journey-level measurement matches statistic, unit, basis, environment and workload.' };
      const { observation, value } = matches[0];
      const freshness = observationFreshness(profile, journey, observation, sources, repos, now);
      const evidence = { source: observation.source, capturedAt: observation.capturedAt, value: value.value, samples: value.samples, provenance: observation.provenance };
      if (freshness.status !== 'current') return { ...declared, ...freshness, observation: evidence };
      const met = direction === 'max' ? value.value <= declared.target : value.value >= declared.target;
      if (!met) diagnostics.push({ id: `goal-${journey.id}-${metric}`, view: 'architecture', kind: 'measured-symptom', journeys: [journey.id], nodes: [], sources: [observation.source], title: `Observed journey ${metric} misses its declared goal`, detail: `The compatible imported measurement is ${value.value} ${declared.unit}; the declared ${direction === 'max' ? 'maximum' : 'minimum'} is ${declared.target}. This comparison does not identify a causal component.`, provenance: 'observed' });
      return { ...declared, direction, status: met ? 'met' : 'missed', reason: `Compatible current journey measurement ${met ? 'meets' : 'misses'} the declared ${direction === 'max' ? 'maximum' : 'minimum'}.`, observation: evidence };
    }),
  })).map(journey => {
    for (const goal of journey.goals) if (goal.status === 'unknown' || goal.status === 'stale') unknowns.push(`${journey.id} ${goal.metric}: ${goal.reason}`);
    return journey;
  });
}

function recheckInputs(root, profilePath, originalProfile, profile, repositories, sources, selectedDomain, home) {
  if (!profileBytes(root, profilePath).equals(originalProfile)) throw performanceError('profile changed during analysis; rerun with stable input bytes');
  for (const source of sources) {
    const bytes = selectedBytes(repositories.available.get(source.repo).root, source.path, PERFORMANCE_LIMITS.source);
    if ((bytes === null ? null : sha256(bytes)) !== source.sha256) throw performanceError('a selected source changed during analysis; rerun with stable input bytes');
  }
  const current = liveRepositories(root, home, selectedDomain);
  if (digest(current.domain) !== digest(repositories.domain)) throw performanceError('domain binding changed during analysis; rerun with stable inputs');
  for (const repo of new Set([...(selectedDomain === undefined ? ['self'] : []), ...profile.sources.map(source => source.repo)])) {
    if (digest(current.available.get(repo)) !== digest(repositories.available.get(repo))) throw performanceError('repository identity or HEAD changed during analysis');
  }
}

export function analyzePerformance({ workspace, home, profilePath = DEFAULT_PERFORMANCE_PROFILE, domain, now = Date.now() } = {}) {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw performanceError('now must be a finite millisecond timestamp');
  const root = workspaceRoot(workspace);
  const rawProfile = profileBytes(root, profilePath);
  const profile = validatePerformanceProfile(parsePerformanceJson(rawProfile, 'profile'));
  if (domain !== undefined && profile.domain !== undefined && domain !== profile.domain) throw performanceError('explicit domain must match the profile domain');
  const selectedDomain = domain ?? profile.domain;
  const repositories = liveRepositories(root, home, selectedDomain);
  const repoIds = new Set([...(selectedDomain === undefined ? ['self'] : []), ...profile.sources.map(source => source.repo)]);
  if (repoIds.size > PERFORMANCE_LIMITS.repos || [...repoIds].some(id => !repositories.available.has(id))) throw performanceError('sources must select at most 32 repositories from self in local mode or explicit selected version 2 domain members');
  const repos = [...repoIds].sort().map(id => repositories.available.get(id));
  const bytes = new Map(), unknowns = [];
  let total = 0;
  const sources = profile.sources.map(source => {
    const content = selectedBytes(repositories.available.get(source.repo).root, source.path, PERFORMANCE_LIMITS.source);
    if (content !== null) total += content.length;
    if (total > PERFORMANCE_LIMITS.total) throw performanceError('selected source bytes exceed the 8 MiB total read limit');
    bytes.set(source.id, content);
    if (content === null) unknowns.push(`Source ${source.id} is missing, unsafe, unreadable, oversized or not a regular file.`);
    return { ...source, state: content === null ? 'unavailable' : 'regular', sha256: content === null ? null : sha256(content), bytes: content === null ? null : content.length };
  });
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  const implementation = implementationView(profile, sources, bytes, unknowns);
  const diagnostics = structuralDiagnostics(profile, implementation.manifestData);
  const observations = profile.observations.flatMap(id => {
    if (bytes.get(id) === null) { unknowns.push(`Observation ${id} is unavailable; no measurements are inferred.`); return []; }
    const observation = validatePerformanceObservation(parsePerformanceJson(bytes.get(id), `observation ${id}`), profile, repoIds);
    const relevantJourneys = [...new Set(observation.metrics.map(metric => metric.journey))];
    const freshness = relevantJourneys.map(id => ({ journey: id, ...observationFreshness(profile, profile.journeys.find(journey => journey.id === id), observation, sourceMap, repositories.available, now) }));
    unknowns.push(`Observation ${id} does not authenticate production identity; deployment artifact, build and repository chain links are ${observation.deployments?.length ? 'only supplied where explicitly exported' : 'unknown'}.`);
    for (const deployment of observation.deployments ?? []) if (['artifact', 'build', 'repo', 'commit'].some(field => deployment[field] === undefined)) unknowns.push(`Observation ${id} deployment ${deployment.node} has unknown artifact, build, repository or commit chain links.`);
    return [{ source: id, ...observation, freshness }];
  });
  const journeys = evaluateGoals(profile, observations, sourceMap, repositories.available, now, diagnostics, unknowns);
  const report = screened({
    version: 1,
    profile: { path: profilePath, sha256: sha256(rawProfile) },
    inputs: { domain: repositories.domain, repos, sources },
    architecture: { nodes: profile.nodes, edges: profile.edges },
    implementation: { nodes: implementation.nodes, edges: implementation.edges },
    journeys, diagnostics, observations,
    coverage: { selected: sources.length, read: sources.filter(source => source.state === 'regular').length, unavailable: sources.filter(source => source.state !== 'regular').length },
    unknowns: [...new Set(unknowns)], limitations: LIMITATIONS,
  });
  recheckInputs(root, profilePath, rawProfile, profile, repositories, sources, selectedDomain, home);
  return { version: 1, id: digest(report), ...report };
}

function contextFiles(files) {
  if (!Array.isArray(files) || files.length > PERFORMANCE_LIMITS.total) throw performanceError('context scope must be a bounded array of file paths');
  let bytes = 0;
  for (const file of files) {
    if (!boundedText(file, 4096) || (bytes += Buffer.byteLength(file)) > PERFORMANCE_LIMITS.total) throw performanceError('context scope paths must contain at most 8 MiB of bounded text');
  }
  return [...new Set(files)].sort();
}

function matchedSourceIds(root, report, files) {
  const requested = files.map(file => {
    let full = path.resolve(root, file);
    try { full = canonicalPath(full); } catch {}
    let directory = /[/\\]$/.test(file);
    if (!directory) {
      try { directory = fs.lstatSync(full, { throwIfNoEntry: false })?.isDirectory() === true; } catch {}
    }
    return { full, directory };
  });
  const repos = new Map(report.inputs.repos.map(repo => [repo.id, repo.root]));
  return new Set(report.inputs.sources.filter(source => {
    let full = path.resolve(repos.get(source.repo), source.path);
    try { full = canonicalPath(full); } catch {}
    return requested.some(request => full === request.full || (request.directory && full.startsWith(request.full + path.sep)));
  }).map(source => source.id));
}

function boundedContext(context, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PERFORMANCE_LIMITS.profile) throw performanceError('context maxBytes must be a positive integer of at most 1 MiB');
  while (Buffer.byteLength(JSON.stringify(context)) > maxBytes && context.journeys.length) {
    context.journeys.pop(); context.omitted.journeys++;
  }
  if (Buffer.byteLength(JSON.stringify(context)) > maxBytes && context.error) context.error = 'Performance profile is invalid or unavailable.';
  if (Buffer.byteLength(JSON.stringify(context)) > maxBytes) throw performanceError('context byte budget cannot retain the full performance input binding');
  return context;
}

export function performanceContext({ workspace, home, files = [], maxBytes = 4096 } = {}) {
  const relative = DEFAULT_PERFORMANCE_PROFILE;
  let root;
  if (typeof workspace === 'string' && workspace) {
    root = path.resolve(workspace);
    try { if (!fs.lstatSync(path.join(root, relative), { throwIfNoEntry: false })) return null; } catch {}
  }
  const selectedFiles = contextFiles(files);
  let profile = { path: relative, sha256: null };
  let report;
  try {
    root = workspaceRoot(workspace);
    const raw = selectedBytes(root, relative, PERFORMANCE_LIMITS.profile);
    profile = { path: relative, sha256: raw === null ? null : sha256(raw) };
    report = analyzePerformance({ workspace: root, home });
  }
  catch (error) {
    const message = redactSecrets(String(error?.message || 'Performance profile is invalid.')).slice(0, 480);
    const reportId = digest({ state: 'invalid', profile, error: message });
    return boundedContext({ version: 1, state: 'invalid', profile, domain: null, reportId, error: message, journeys: [], omitted: { journeys: 0 }, binding: { version: 1, reportId, filesHash: digest(selectedFiles), profilePath: relative, domain: null } }, maxBytes);
  }
  const matches = matchedSourceIds(root, report, selectedFiles);
  const journeys = selectedFiles.length ? report.journeys.flatMap(journey => {
    const linked = journeySourceIds(report.architecture, journey);
    for (const observation of report.observations) {
      if (observation.metrics.some(metric => metric.journey === journey.id)) linked.add(observation.source);
    }
    const sourceIds = [...linked].filter(id => matches.has(id));
    return sourceIds.length ? [{ id: journey.id, title: journey.title, goals: journey.goals, constraints: journey.constraints, sourceIds, paths: report.inputs.sources.filter(source => sourceIds.includes(source.id)).map(({ repo, path }) => ({ repo, path })) }] : [];
  })
    : report.journeys.map(journey => ({ id: journey.id, title: journey.title, goals: journey.goals.map(({ metric, direction, statistic, unit, basis, target, status, reason }) => ({ metric, direction, ...(statistic === undefined ? {} : { statistic, unit, basis, target }), status, reason })) }));
  const domain = report.inputs.domain?.name ?? null;
  return boundedContext({ version: 1, state: 'available', profile: report.profile, domain, reportId: report.id, journeys, omitted: { journeys: 0 }, binding: { version: 1, reportId: report.id, filesHash: digest(selectedFiles), profilePath: relative, domain } }, maxBytes);
}

export function performanceContextIsCurrent({ workspace, home, context } = {}) {
  if (context === null) {
    try { return performanceContext({ workspace, home }) === null; } catch { return false; }
  }
  const binding = context?.binding;
  if (binding?.version !== 1 || binding.profilePath !== DEFAULT_PERFORMANCE_PROFILE || binding.profilePath !== context.profile?.path || binding.domain !== context.domain || typeof binding.reportId !== 'string' || binding.reportId !== context.reportId || !/^[a-f0-9]{64}$/.test(binding.filesHash || '') || Object.keys(binding).some(key => !['version', 'reportId', 'filesHash', 'profilePath', 'domain'].includes(key))) return false;
  try {
    const current = performanceContext({ workspace, home, maxBytes: PERFORMANCE_LIMITS.profile });
    return current !== null && current.state === context.state && current.domain === binding.domain && current.reportId === binding.reportId && digest(current.profile) === digest(context.profile);
  } catch { return false; }
}
