/**
 * Lease-scoped Docker Engine API policy proxy.
 *
 * This is intentionally not a general Docker proxy. It exposes only the
 * offline API calls needed by the pinned Harbor trial and binds every dynamic
 * container/exec identifier to one lease. The provider-facing process never
 * receives the daemon socket itself.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

const DEFAULTS = Object.freeze({
  maxHeaderBytes: 32 * 1024,
  maxHeaderCount: 64,
  maxTargetBytes: 16 * 1024,
  maxQueryBytes: 8 * 1024,
  maxJsonBodyBytes: 1024 * 1024,
  maxArchiveBodyBytes: 64 * 1024 * 1024,
  maxResponseBodyBytes: 4 * 1024 * 1024,
  maxHijackHeadBytes: 64 * 1024,
  maxExecIds: 128,
  maxAuditEvents: 512,
  requestTimeoutMs: 30_000,
});

const SAFE_LEASE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const DOCKER_ID = /^[a-f0-9]{64}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BUFFERED_RESPONSE_KINDS = new Set([
  'container-create',
  'container-delete',
  'container-inspect',
  'container-list',
  'container-start',
  'exec-create',
  'image-inspect',
  'image-list',
  'network-list',
  'volume-list',
]);
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'connection',
  'content-length',
  'content-type',
  'docker-experimental',
  'host',
  'transfer-encoding',
  'upgrade',
  'user-agent',
]);
const ZERO_HASH = '0'.repeat(64);
const AUDITED_ERROR = Symbol('docker-proxy-audited-error');
const UNSENT_FORWARD_ERRORS = new WeakSet();
const SAFE_AUDIT_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_AUDIT_METHOD = /^[A-Z]{1,16}$/;
const MAX_AUDIT_EVENTS = 4_096;
const CONTAINER_CREATE_FIELDS = canonicalFieldMap([
  'Hostname', 'Domainname', 'User', 'AttachStdin', 'AttachStdout', 'AttachStderr',
  'ExposedPorts', 'Tty', 'OpenStdin', 'StdinOnce', 'Env', 'Cmd', 'Healthcheck',
  'ArgsEscaped', 'Image', 'Volumes', 'WorkingDir', 'Entrypoint', 'NetworkDisabled',
  'MacAddress', 'OnBuild', 'Labels', 'StopSignal', 'StopTimeout', 'Shell',
  'HostConfig', 'NetworkingConfig',
]);
const HOST_CONFIG_FIELDS = canonicalFieldMap([
  'Binds', 'ContainerIDFile', 'LogConfig', 'NetworkMode', 'PortBindings',
  'RestartPolicy', 'AutoRemove', 'VolumeDriver', 'VolumesFrom', 'Mounts',
  'ConsoleSize', 'Annotations', 'CapAdd', 'CapDrop', 'CgroupnsMode', 'Dns',
  'DnsOptions', 'DnsSearch', 'ExtraHosts', 'GroupAdd', 'IpcMode', 'Cgroup',
  'Links', 'OomScoreAdj', 'PidMode', 'Privileged', 'PublishAllPorts',
  'ReadonlyRootfs', 'SecurityOpt', 'StorageOpt', 'Tmpfs', 'UTSMode', 'UsernsMode',
  'ShmSize', 'Sysctls', 'Runtime', 'Isolation', 'MaskedPaths', 'ReadonlyPaths',
  'CpuShares', 'Memory', 'CgroupParent', 'BlkioWeight', 'BlkioWeightDevice',
  'BlkioDeviceReadBps', 'BlkioDeviceWriteBps', 'BlkioDeviceReadIOps',
  'BlkioDeviceWriteIOps', 'CpuPeriod', 'CpuQuota', 'CpuRealtimePeriod',
  'CpuRealtimeRuntime', 'CpusetCpus', 'CpusetMems', 'Devices',
  'DeviceCgroupRules', 'DeviceRequests', 'KernelMemory', 'KernelMemoryTCP',
  'MemoryReservation', 'MemorySwap', 'MemorySwappiness', 'NanoCpus',
  'OomKillDisable', 'Init', 'PidsLimit', 'Ulimits', 'CpuCount', 'CpuPercent',
  'IOMaximumIOps', 'IOMaximumBandwidth',
]);
const NETWORKING_CONFIG_FIELDS = canonicalFieldMap(['EndpointsConfig']);
const LOG_CONFIG_FIELDS = canonicalFieldMap(['Type', 'Config']);
const RESTART_POLICY_FIELDS = canonicalFieldMap(['Name', 'MaximumRetryCount']);
const HEALTHCHECK_FIELDS = canonicalFieldMap([
  'Test', 'Interval', 'Timeout', 'Retries', 'StartPeriod', 'StartInterval',
]);

export class DockerPolicyError extends Error {
  constructor(message, { code = 'DOCKER_POLICY_DENIED', statusCode = 403 } = {}) {
    super(message);
    this.name = 'DockerPolicyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function deny(message, options) {
  throw new DockerPolicyError(message, options);
}

function requireSafeValue(value, field) {
  if (typeof value !== 'string' || !SAFE_LEASE_VALUE.test(value)) {
    throw new TypeError(`${field} must be a safe, non-empty identifier`);
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
  return value;
}

function requireAuditEventLimit(value) {
  requirePositiveInteger(value, 'maxAuditEvents');
  if (value > MAX_AUDIT_EVENTS) throw new TypeError(`maxAuditEvents must be at most ${MAX_AUDIT_EVENTS}`);
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalFieldMap(fields) {
  return new Map(fields.map((field) => [field.toLowerCase(), field]));
}

function requireCanonicalFields(value, canonicalFields, field) {
  const seen = new Set();
  for (const key of Object.keys(value)) {
    const folded = key.toLowerCase();
    if (seen.has(folded)) deny(`${field} contains duplicate case-folded fields`);
    seen.add(folded);
    if (canonicalFields.get(folded) !== key) deny(`${field} contains an unknown or non-canonical field`);
  }
}

function isEmptyObject(value) {
  return plainObject(value) && Object.keys(value).length === 0;
}

function isEmptyCollection(value) {
  return value == null || (Array.isArray(value) && value.length === 0) || isEmptyObject(value);
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value == null) return Buffer.alloc(0);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError('request and response bodies must be Buffer-compatible bytes');
}

function lowerHeaderObject(headers = {}) {
  const normalized = Object.create(null);
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    normalized[name] = Array.isArray(rawValue) ? rawValue.map(String).join(', ') : String(rawValue);
  }
  return normalized;
}

function rawHeaderPairs(headers, rawHeaders) {
  if (Array.isArray(rawHeaders) && rawHeaders.length) return rawHeaders;
  return Object.entries(headers ?? {}).flatMap(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]);
}

function validateHeaders({ headers, rawHeaders, body }, limits) {
  const pairs = rawHeaderPairs(headers, rawHeaders);
  if (pairs.length % 2 !== 0) deny('malformed raw header list', { statusCode: 400, code: 'MALFORMED_HEADERS' });
  if (pairs.length / 2 > limits.maxHeaderCount) deny('too many request headers', { statusCode: 431, code: 'HEADER_LIMIT' });
  let bytes = 2;
  const seen = new Set();
  for (let index = 0; index < pairs.length; index += 2) {
    const name = String(pairs[index]);
    const value = String(pairs[index + 1]);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (!HEADER_NAME.test(name)) deny('invalid request header name', { statusCode: 400, code: 'MALFORMED_HEADERS' });
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value) || /[\r\n]/.test(value)) {
      deny('invalid control character in request header', { statusCode: 400, code: 'MALFORMED_HEADERS' });
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) deny(`duplicate request header is not allowed: ${lower}`, { statusCode: 400, code: 'DUPLICATE_HEADER' });
    if (!ALLOWED_REQUEST_HEADERS.has(lower)) deny(`request header is not allowed: ${lower}`, { statusCode: 400, code: 'HEADER_POLICY' });
    seen.add(lower);
  }
  if (bytes > limits.maxHeaderBytes) deny('request headers are too large', { statusCode: 431, code: 'HEADER_LIMIT' });

  const normalized = lowerHeaderObject(Object.fromEntries(
    Array.from({ length: pairs.length / 2 }, (_, index) => [String(pairs[index * 2]), String(pairs[index * 2 + 1])])
  ));
  if (normalized['content-length'] != null && normalized['transfer-encoding'] != null) {
    deny('ambiguous request framing: content-length and transfer-encoding cannot coexist', {
      statusCode: 400,
      code: 'AMBIGUOUS_FRAMING',
    });
  }
  if (normalized['transfer-encoding'] != null && normalized['transfer-encoding'].trim().toLowerCase() !== 'chunked') {
    deny('unsupported transfer-encoding', { statusCode: 400, code: 'AMBIGUOUS_FRAMING' });
  }
  if (normalized['content-length'] != null) {
    if (!/^(0|[1-9][0-9]*)$/.test(normalized['content-length'])) {
      deny('invalid content-length', { statusCode: 400, code: 'AMBIGUOUS_FRAMING' });
    }
    const length = Number(normalized['content-length']);
    if (!Number.isSafeInteger(length) || length !== body.length) {
      deny('content-length does not match the parsed body', { statusCode: 400, code: 'AMBIGUOUS_FRAMING' });
    }
  }
  return normalized;
}

function parseTarget(rawTarget, limits) {
  if (typeof rawTarget !== 'string' || !rawTarget.startsWith('/') || rawTarget.startsWith('//')) {
    deny('request target must use origin-form', { statusCode: 400, code: 'MALFORMED_TARGET' });
  }
  if (Buffer.byteLength(rawTarget) > limits.maxTargetBytes) deny('request target is too large', { statusCode: 414, code: 'TARGET_LIMIT' });
  if (/[#\\\u0000-\u001f\u007f]/.test(rawTarget)) deny('request target contains a forbidden control or path character', {
    statusCode: 400,
    code: 'MALFORMED_TARGET',
  });
  if (/%(?![0-9A-Fa-f]{2})/.test(rawTarget)) deny('request target has malformed percent encoding', {
    statusCode: 400,
    code: 'MALFORMED_ENCODING',
  });

  const queryAt = rawTarget.indexOf('?');
  const rawPath = queryAt === -1 ? rawTarget : rawTarget.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? '' : rawTarget.slice(queryAt + 1);
  if (Buffer.byteLength(rawQuery) > limits.maxQueryBytes) deny('request query is too large', { statusCode: 414, code: 'QUERY_LIMIT' });
  if (rawPath.includes('//')) deny('request path must be canonical', { statusCode: 400, code: 'MALFORMED_TARGET' });

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    deny('request target has malformed percent encoding', { statusCode: 400, code: 'MALFORMED_ENCODING' });
  }
  if (/[\\\u0000-\u001f\u007f]/.test(decodedPath) || decodedPath.includes('%')) {
    deny('request path contains an ambiguous encoding or control character', { statusCode: 400, code: 'MALFORMED_ENCODING' });
  }
  if (decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    deny('request path traversal is not allowed', { statusCode: 400, code: 'PATH_TRAVERSAL' });
  }

  let normalizedPath = rawPath;
  const version = normalizedPath.match(/^\/v([0-9]+)\.([0-9]+)(?=\/)/);
  if (version) {
    const major = Number(version[1]);
    const minor = Number(version[2]);
    if (major !== 1 || !Number.isSafeInteger(minor) || minor > 99) {
      deny('unsupported Docker API version prefix', { statusCode: 400, code: 'MALFORMED_VERSION' });
    }
    normalizedPath = normalizedPath.slice(version[0].length);
  }
  if (/^\/v[0-9]+\.[0-9]+(?=\/)/.test(normalizedPath)) {
    deny('multiple Docker API version prefixes are not allowed', { statusCode: 400, code: 'MALFORMED_VERSION' });
  }

  const query = new URLSearchParams(rawQuery);
  const queryKeys = new Set();
  for (const [key] of query) {
    if (queryKeys.has(key)) deny(`duplicate query field is not allowed: ${key}`, { statusCode: 400, code: 'DUPLICATE_QUERY' });
    queryKeys.add(key);
  }
  return {
    path: normalizedPath,
    query,
    normalizedTarget: normalizedPath + (rawQuery ? `?${rawQuery}` : ''),
  };
}

function assertOnlyQuery(query, allowed, { required = [] } = {}) {
  for (const key of query.keys()) {
    if (!allowed.has(key)) deny(`query field is not allowed: ${key}`, { statusCode: 400, code: 'QUERY_POLICY' });
  }
  for (const key of required) {
    if (!query.has(key)) deny(`required query field is missing: ${key}`, { statusCode: 400, code: 'QUERY_POLICY' });
  }
}

function requireNoQuery(query) {
  assertOnlyQuery(query, new Set());
}

function parseJson(body, maxBytes, field = 'request') {
  if (body.length > maxBytes) deny(`${field} body is too large`, { statusCode: 413, code: 'BODY_LIMIT' });
  if (!body.length) deny(`${field} body must contain JSON`, { statusCode: 400, code: 'MALFORMED_JSON' });
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    deny(`${field} body is malformed JSON`, { statusCode: 400, code: 'MALFORMED_JSON' });
  }
  if (!plainObject(value)) deny(`${field} JSON must be an object`, { statusCode: 400, code: 'MALFORMED_JSON' });
  return value;
}

function requireJsonContentType(headers) {
  const contentType = headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') deny('Docker JSON request must use application/json', {
    statusCode: 400,
    code: 'CONTENT_TYPE_POLICY',
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function bindingHash(value) {
  return createHash('sha256').update('engineer-harness/docker-binding/v1\0').update(String(value)).digest('hex');
}

function auditMethod(method) {
  return typeof method === 'string' && SAFE_AUDIT_METHOD.test(method) ? method : 'INVALID';
}

function auditError(error) {
  const code = error instanceof DockerPolicyError && SAFE_AUDIT_CODE.test(error.code)
    ? error.code
    : 'UPSTREAM_FAILURE';
  const statusCode = error instanceof DockerPolicyError && Number.isInteger(error.statusCode) &&
      error.statusCode >= 100 && error.statusCode <= 599
    ? error.statusCode
    : 502;
  return { code, statusCode };
}

function markAudited(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      Object.defineProperty(error, AUDITED_ERROR, { value: true, configurable: false, enumerable: false });
    } catch {
      // A frozen foreign error is still safe to return; the caller may record a duplicate denial.
    }
  }
  return error;
}

function markUnsentForward(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    UNSENT_FORWARD_ERRORS.add(error);
  }
  return error;
}

/**
 * Bounded, content-free, hash-linked evidence. Entries intentionally contain
 * only fixed vocabulary, integer counters, status codes, and one-way hashes of
 * Docker IDs. Request targets, headers, bodies, labels, names, and paths never
 * enter this ledger.
 */
class DockerAuditLedger {
  constructor(maxEvents) {
    this.maxEvents = requireAuditEventLimit(maxEvents);
    this.events = [];
    this.totalEvents = 0;
    this.droppedEvents = 0;
    this.anchorHash = ZERO_HASH;
    this.tailHash = ZERO_HASH;
    this.eventCounts = new Map();
  }

  record(payload) {
    const sequence = this.totalEvents + 1;
    const canonicalEvent = Object.freeze({ sequence, previousHash: this.tailHash, ...payload });
    const event = Object.freeze({ ...canonicalEvent, eventHash: canonicalHash(canonicalEvent) });
    this.events.push(event);
    this.totalEvents = sequence;
    this.tailHash = event.eventHash;
    const countKey = `${payload.phase}.${payload.outcome}`;
    this.eventCounts.set(countKey, (this.eventCounts.get(countKey) ?? 0) + 1);
    if (this.events.length > this.maxEvents) {
      const removed = this.events.shift();
      this.anchorHash = removed.eventHash;
      this.droppedEvents += 1;
    }
    return event;
  }

  snapshot(state) {
    const events = this.events.map((event) => ({ ...event }));
    const evidence = {
      schema: 'engineer-harness/docker-proxy-audit/v1',
      hashAlgorithm: 'sha256',
      canonicalization: 'recursive-key-sort-json-v1',
      complete: this.droppedEvents === 0,
      totalEvents: this.totalEvents,
      droppedEvents: this.droppedEvents,
      retainedFromSequence: events[0]?.sequence ?? this.totalEvents + 1,
      anchorHash: events[0]?.previousHash ?? this.anchorHash,
      tailHash: this.tailHash,
      eventCounts: Object.fromEntries([...this.eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      events,
      state,
    };
    return { ...evidence, evidenceHash: canonicalHash(evidence) };
  }
}

function ensureExactArray(actual, expected, field, { caseInsensitive = false } = {}) {
  if (!Array.isArray(actual) || actual.length !== expected.length) deny(`container create ${field} policy mismatch`);
  const normalize = (value) => caseInsensitive ? String(value).toUpperCase() : canonicalJson(value);
  const left = [...actual].map(normalize).sort();
  const right = [...expected].map(normalize).sort();
  if (left.some((value, index) => value !== right[index])) deny(`container create ${field} policy mismatch`);
}

function assertNoDockerSocketMount(value) {
  const serialized = typeof value === 'string' ? value : canonicalJson(value);
  if (/(^|[/:])docker\.sock(?=[:/]|$)|\/var\/run\/docker|\/run\/docker/i.test(serialized)) {
    deny('container create Docker socket mounts are not allowed');
  }
}

function filterValues(value, field) {
  if (Array.isArray(value)) return value.map(String);
  if (plainObject(value)) {
    for (const enabled of Object.values(value)) {
      if (enabled !== true) deny(`${field} filter values must be enabled booleans`);
    }
    return Object.keys(value);
  }
  deny(`${field} filter must be an array or enabled-value object`, { statusCode: 400, code: 'FILTER_POLICY' });
}

function parseFilters(query) {
  const encoded = query.get('filters');
  if (encoded == null || encoded.length === 0 || Buffer.byteLength(encoded) > 16 * 1024) {
    deny('a bounded filters object is required', { statusCode: 400, code: 'FILTER_POLICY' });
  }
  let filters;
  try {
    filters = JSON.parse(encoded);
  } catch {
    deny('filters must be valid JSON', { statusCode: 400, code: 'FILTER_POLICY' });
  }
  if (!plainObject(filters)) deny('filters must be a JSON object', { statusCode: 400, code: 'FILTER_POLICY' });
  return filters;
}

function validateComposeScopedResourceFilters(query, composeProject) {
  assertOnlyQuery(query, new Set(['filters']), { required: ['filters'] });
  const filters = parseFilters(query);
  if (Object.keys(filters).length !== 1 || filters.label == null) {
    deny('resource-list filters must contain only a Compose project label', { code: 'FILTER_POLICY' });
  }
  const labels = filterValues(filters.label, 'label');
  if (labels.length !== 1 || labels[0] !== `com.docker.compose.project=${composeProject}`) {
    deny('resource-list filters are not scoped to the active Compose project', { code: 'FILTER_POLICY' });
  }
}

function normalizedArchivePath(query, allowlist) {
  assertOnlyQuery(query, new Set(['path', 'noOverwriteDirNonDir']), { required: ['path'] });
  if (query.has('noOverwriteDirNonDir') && !['0', '1', 'false', 'true'].includes(query.get('noOverwriteDirNonDir'))) {
    deny('invalid archive overwrite option', { statusCode: 400, code: 'ARCHIVE_POLICY' });
  }
  const value = query.get('path');
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\u0000-\u001f\u007f%]/.test(value)) {
    deny('archive path must be an absolute, unambiguous POSIX path', { statusCode: 400, code: 'ARCHIVE_POLICY' });
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.split('/').some((segment) => segment === '..' || segment === '.')) {
    deny('archive path must be normalized and traversal-free', { statusCode: 400, code: 'ARCHIVE_POLICY' });
  }
  const allowed = allowlist.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
  if (!allowed) deny('archive path is outside the lease allowlist', { statusCode: 403, code: 'ARCHIVE_POLICY' });
  return value;
}

function safeResponseJson(body, field) {
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    deny(`Docker daemon returned malformed ${field} JSON`, { statusCode: 502, code: 'UPSTREAM_POLICY' });
  }
  return value;
}

function readDockerId(body, field) {
  const value = safeResponseJson(body, field);
  const id = value?.Id ?? value?.ID;
  if (typeof id !== 'string' || !DOCKER_ID.test(id)) {
    deny(`Docker daemon returned an invalid ${field} id`, { statusCode: 502, code: 'UPSTREAM_POLICY' });
  }
  return id;
}

export class DockerProxyPolicy {
  #auditDecisionMetadata;
  #auditLedger;
  #pendingCreateDecision;
  #auditRequestSequence;

  constructor(options = {}) {
    this.leaseId = requireSafeValue(options.leaseId, 'leaseId');
    this.composeProject = requireSafeValue(options.composeProject, 'composeProject');
    this.containerName = requireSafeValue(options.containerName, 'containerName');
    this.leaseLabel = options.leaseLabel ?? 'com.engineer-harness.eval.lease';
    if (!HEADER_NAME.test(this.leaseLabel)) throw new TypeError('leaseLabel must be a safe label key');
    if (typeof options.pinnedImage !== 'string' || !DIGEST_IMAGE.test(options.pinnedImage)) {
      throw new TypeError('pinnedImage must be an immutable digest-qualified image reference');
    }
    this.pinnedImage = options.pinnedImage;
    this.resources = Object.freeze({
      nanoCpus: requirePositiveInteger(options.resources?.nanoCpus, 'resources.nanoCpus'),
      memoryBytes: requirePositiveInteger(options.resources?.memoryBytes, 'resources.memoryBytes'),
      pidsLimit: requirePositiveInteger(options.resources?.pidsLimit, 'resources.pidsLimit'),
    });
    this.requireReadOnlyRootfs = options.requireReadOnlyRootfs !== false;
    const configuredBindSets = options.allowedBindSets ?? [options.allowedBinds ?? []];
    if (!Array.isArray(configuredBindSets) || configuredBindSets.length < 1
        || configuredBindSets.length > 8 || configuredBindSets.some((set) => !Array.isArray(set))) {
      throw new TypeError('allowedBindSets must contain one to eight bind arrays');
    }
    this.allowedBindSets = configuredBindSets.map((set) => {
      const binds = set.map((value) => String(value));
      if (binds.length > 32 || new Set(binds).size !== binds.length) {
        throw new TypeError('each allowed bind set must be bounded and duplicate-free');
      }
      binds.forEach(assertNoDockerSocketMount);
      return Object.freeze([...binds].sort());
    });
    if (new Set(this.allowedBindSets.map(canonicalJson)).size !== this.allowedBindSets.length) {
      throw new TypeError('allowedBindSets must not contain duplicate alternatives');
    }
    this.allowedBinds = new Set(this.allowedBindSets.flat());
    this.allowedMounts = new Set((options.allowedMounts ?? []).map(canonicalJson));
    this.allowedArchivePaths = (options.allowedArchivePaths ?? []).map((value) => {
      if (typeof value !== 'string' || !value.startsWith('/') || path.posix.normalize(value) !== value || value === '/') {
        throw new TypeError('allowedArchivePaths entries must be normalized absolute paths below /');
      }
      return value;
    });
    if (!this.allowedArchivePaths.length) throw new TypeError('allowedArchivePaths must contain at least one path');
    this.execUser = options.execUser == null ? null : String(options.execUser);
    this.limits = Object.freeze(Object.fromEntries(
      Object.entries(DEFAULTS).map(([key, fallback]) => [
        key,
        key === 'maxAuditEvents'
          ? requireAuditEventLimit(options[key] ?? fallback)
          : requirePositiveInteger(options[key] ?? fallback, key),
      ])
    ));
    this.containerId = null;
    this.execIds = new Set();
    this.createPending = false;
    this.leaseTerminated = false;
    this.#auditLedger = new DockerAuditLedger(this.limits.maxAuditEvents);
    this.#auditRequestSequence = 0;
    this.#auditDecisionMetadata = new WeakMap();
    this.#pendingCreateDecision = null;
  }

  snapshot() {
    return { containerId: this.containerId, execIds: [...this.execIds].sort() };
  }

  auditSnapshot() {
    return this.#auditLedger.snapshot({
      cleanupComplete: this.leaseTerminated && this.containerId == null && this.execIds.size === 0 && !this.createPending,
      containerBound: this.containerId != null,
      containerBindingHash: this.containerId == null ? null : bindingHash(this.containerId),
      createPending: this.createPending,
      execBindingCount: this.execIds.size,
      execBindingHashes: [...this.execIds].map(bindingHash).sort(),
      leaseTerminated: this.leaseTerminated,
    });
  }

  recordProxyLifecycle(action) {
    if (!['listener-started', 'listener-failed', 'listener-closed'].includes(action)) {
      throw new TypeError('unsupported Docker proxy lifecycle audit action');
    }
    this.#auditLedger.record({ phase: 'proxy', outcome: 'observed', action });
  }

  recordProxyDenial({ method, error, phase = 'request', decision = null } = {}) {
    if (error?.[AUDITED_ERROR]) return;
    const safePhase = phase === 'response' ? 'response' : 'request';
    const sanitized = auditError(error);
    const metadata = decision && this.#auditDecisionMetadata.get(decision);
    this.#auditLedger.record({
      phase: safePhase,
      outcome: 'denied',
      requestId: metadata?.requestId ?? ++this.#auditRequestSequence,
      method: auditMethod(method ?? decision?.method),
      ...(decision?.kind ? { kind: decision.kind } : {}),
      ...sanitized,
    });
    markAudited(error);
  }

  requestBodyLimit({ method, target }) {
    try {
      const parsed = parseTarget(target, this.limits);
      if (method === 'PUT' && /^\/containers\/[a-f0-9]{64}\/archive$/.test(parsed.path)) return this.limits.maxArchiveBodyBytes;
      if (['POST', 'PUT'].includes(method)) return this.limits.maxJsonBodyBytes;
      return 0;
    } catch (error) {
      this.recordProxyDenial({ method, error });
      throw error;
    }
  }

  #requireBoundContainer(id) {
    if (this.containerId == null || id !== this.containerId) deny('foreign or unbound container id is denied');
  }

  #validateCreate(body) {
    requireCanonicalFields(body, CONTAINER_CREATE_FIELDS, 'container create');
    if (body.Image !== this.pinnedImage) deny('container create image does not match the pinned digest');
    if (!plainObject(body.Labels)) deny('container create labels are required');
    if (body.Labels[this.leaseLabel] !== this.leaseId) deny('container create lease label does not match the active lease');
    if (body.Labels['com.docker.compose.project'] !== this.composeProject) {
      deny('container create Compose project label does not match the active lease');
    }
    if (body.Volumes != null && !isEmptyObject(body.Volumes)) deny('container create anonymous volumes are not allowed');
    if (body.NetworkingConfig != null) {
      if (!plainObject(body.NetworkingConfig) || !isEmptyCollection(body.NetworkingConfig.EndpointsConfig)) {
        deny('container create network endpoints are not allowed');
      }
      requireCanonicalFields(body.NetworkingConfig, NETWORKING_CONFIG_FIELDS, 'container create NetworkingConfig');
      for (const key of Object.keys(body.NetworkingConfig)) {
        if (key !== 'EndpointsConfig') deny(`container create networking field is not allowed: ${key}`);
      }
    }
    if (body.Healthcheck != null) {
      if (!plainObject(body.Healthcheck)) deny('container create healthcheck is malformed');
      requireCanonicalFields(body.Healthcheck, HEALTHCHECK_FIELDS, 'container create Healthcheck');
    }

    const host = body.HostConfig;
    if (!plainObject(host)) deny('container create HostConfig is required');
    requireCanonicalFields(host, HOST_CONFIG_FIELDS, 'container create HostConfig');
    if (host.NetworkMode !== 'none') deny('container create network mode must be none');
    if (host.Privileged !== false) deny('container create privileged must be explicitly false');
    if (Boolean(host.ReadonlyRootfs) !== this.requireReadOnlyRootfs) deny('container create read-only root policy mismatch');
    if (host.NanoCpus !== this.resources.nanoCpus) deny('container create CPU policy mismatch');
    if (host.Memory !== this.resources.memoryBytes) deny('container create memory policy mismatch');
    if (host.PidsLimit !== this.resources.pidsLimit) deny('container create PID policy mismatch');
    ensureExactArray(host.CapDrop, ['ALL'], 'cap-drop', { caseInsensitive: true });
    ensureExactArray(host.CapAdd ?? [], [], 'cap-add');
    ensureExactArray(host.Devices ?? [], [], 'devices');
    ensureExactArray(host.DeviceRequests ?? [], [], 'device requests');
    ensureExactArray(host.VolumesFrom ?? [], [], 'volumes-from');
    if (!Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 1 ||
        !['NO-NEW-PRIVILEGES', 'NO-NEW-PRIVILEGES:TRUE', 'NO-NEW-PRIVILEGES=TRUE'].includes(String(host.SecurityOpt[0]).toUpperCase())) {
      deny('container create security options must enable only no-new-privileges');
    }

    const binds = host.Binds ?? [];
    if (!Array.isArray(binds) || new Set(binds).size !== binds.length) {
      deny('container create binds must be a duplicate-free array');
    }
    for (const bind of binds) {
      assertNoDockerSocketMount(bind);
      if (!this.allowedBinds.has(bind)) deny('container create bind is outside the exact allowlist');
    }
    const normalizedBinds = canonicalJson([...binds].sort());
    if (!this.allowedBindSets.some((allowed) => canonicalJson(allowed) === normalizedBinds)) {
      deny('container create binds do not match one complete allowed set');
    }
    const mounts = host.Mounts ?? [];
    if (!Array.isArray(mounts)) deny('container create mounts must be an array');
    for (const mount of mounts) {
      assertNoDockerSocketMount(mount);
      if (!this.allowedMounts.has(canonicalJson(mount))) deny('container create mount is outside the exact allowlist');
    }

    const emptyFields = [
      'PortBindings',
      'Links',
      'ExtraHosts',
      'Dns',
      'DnsSearch',
      'DnsOptions',
      'GroupAdd',
      'Ulimits',
      'Tmpfs',
      'DeviceCgroupRules',
      'Sysctls',
      'StorageOpt',
    ];
    for (const field of emptyFields) {
      if (!isEmptyCollection(host[field])) deny(`container create ${field} is not allowed`);
    }
    for (const field of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupParent']) {
      if (host[field] != null && host[field] !== '') deny(`container create ${field} is not allowed`);
    }
    if (host.Runtime != null && !['', 'runc'].includes(host.Runtime)) deny('container create alternate runtime is not allowed');
    if (host.CgroupnsMode != null && !['', 'private'].includes(host.CgroupnsMode)) deny('container create host cgroup namespace is not allowed');
    for (const field of ['ReadonlyPaths', 'MaskedPaths']) {
      if (Object.hasOwn(host, field)) deny(`container create ${field} overrides are not allowed`);
    }
    if (host.PublishAllPorts === true) deny('container create published ports are not allowed');
    if (host.OomKillDisable === true) deny('container create OOM-kill disable is not allowed');
    if (host.MemorySwap != null && ![0, this.resources.memoryBytes].includes(host.MemorySwap)) {
      deny('container create memory-swap policy mismatch');
    }
    for (const field of ['CpuPeriod', 'CpuQuota', 'CpuShares', 'CpusetCpus', 'CpusetMems']) {
      if (host[field] != null && host[field] !== 0 && host[field] !== '') deny(`container create ${field} conflicts with exact CPU policy`);
    }
    if (plainObject(host.RestartPolicy) && !['', 'no'].includes(host.RestartPolicy.Name ?? '')) {
      deny('container create restart policy must be disabled');
    }
    if (plainObject(host.RestartPolicy)) {
      requireCanonicalFields(host.RestartPolicy, RESTART_POLICY_FIELDS, 'container create RestartPolicy');
    }
    if (plainObject(host.LogConfig)) {
      requireCanonicalFields(host.LogConfig, LOG_CONFIG_FIELDS, 'container create LogConfig');
      if (!['', 'json-file', 'local', 'none'].includes(host.LogConfig.Type ?? '') || !isEmptyCollection(host.LogConfig.Config)) {
        deny('container create external log drivers are not allowed');
      }
    } else if (host.LogConfig != null) {
      deny('container create log configuration is malformed');
    }
  }

  #validateContainerFilters(query) {
    assertOnlyQuery(query, new Set(['all', 'limit', 'size', 'filters']), { required: ['filters'] });
    if (query.has('all') && !['0', '1', 'false', 'true'].includes(query.get('all'))) deny('invalid container-list all option');
    if (query.has('size') && !['0', '1', 'false', 'true'].includes(query.get('size'))) deny('invalid container-list size option');
    if (query.has('limit') && !/^[1-9][0-9]{0,5}$/.test(query.get('limit'))) deny('invalid container-list limit option');
    const filters = parseFilters(query);
    const allowed = new Set(['label', 'name', 'id']);
    for (const key of Object.keys(filters)) {
      if (!allowed.has(key)) deny(`container-list filter is not allowed: ${key}`, { code: 'FILTER_POLICY' });
    }
    const labels = filterValues(filters.label, 'label');
    const projectAnchor = `com.docker.compose.project=${this.composeProject}`;
    if (!labels.includes(projectAnchor)) deny('container-list filters are not scoped to the active Compose project', { code: 'FILTER_POLICY' });
    for (const label of labels) {
      const allowedLabel = label === projectAnchor ||
        label === `${this.leaseLabel}=${this.leaseId}` ||
        label.startsWith('com.docker.compose.service=') ||
        label.startsWith('com.docker.compose.container-number=') ||
        label.startsWith('com.docker.compose.oneoff=');
      if (!allowedLabel) deny('container-list label filter is outside the active lease scope', { code: 'FILTER_POLICY' });
    }
    if (filters.name != null) {
      const names = filterValues(filters.name, 'name');
      if (names.length !== 1 || ![this.containerName, `^/${this.containerName}$`].includes(names[0])) {
        deny('container-list name filter is outside the active lease scope', { code: 'FILTER_POLICY' });
      }
    }
    if (filters.id != null) {
      const ids = filterValues(filters.id, 'id');
      if (!this.containerId || ids.length !== 1 || ids[0] !== this.containerId) {
        deny('container-list id filter is outside the active lease scope', { code: 'FILTER_POLICY' });
      }
    }
  }

  #validateImageFilters(query) {
    assertOnlyQuery(query, new Set(['all', 'digests', 'filters']), { required: ['filters'] });
    for (const option of ['all', 'digests']) {
      if (query.has(option) && !['0', '1', 'false', 'true'].includes(query.get(option))) deny(`invalid image-list ${option} option`);
    }
    const filters = parseFilters(query);
    if (Object.keys(filters).length !== 1 || filters.reference == null) deny('image-list filters must contain only the pinned reference');
    const references = filterValues(filters.reference, 'reference');
    if (references.length !== 1 || references[0] !== this.pinnedImage) deny('image-list filter does not match the pinned image');
  }

  authorize(input) {
    const requestId = ++this.#auditRequestSequence;
    try {
      return this.#authorize(input, requestId);
    } catch (error) {
      const sanitized = auditError(error);
      this.#auditLedger.record({
        phase: 'request',
        outcome: 'denied',
        requestId,
        method: auditMethod(input?.method),
        ...sanitized,
      });
      throw markAudited(error);
    }
  }

  #authorize(input, requestId) {
    const method = input?.method;
    if (typeof method !== 'string' || method !== method.toUpperCase() || !/^[A-Z]+$/.test(method)) {
      deny('invalid HTTP method', { statusCode: 400, code: 'MALFORMED_METHOD' });
    }
    const body = asBuffer(input.body);
    const headers = validateHeaders({ ...input, body }, this.limits);
    const parsed = parseTarget(input.target, this.limits);
    const decision = (kind, extras = {}) => {
      const result = Object.freeze({
        kind,
        method,
        normalizedTarget: parsed.normalizedTarget,
        bodyLimit: kind === 'archive-put' ? this.limits.maxArchiveBodyBytes : this.limits.maxJsonBodyBytes,
        bufferResponse: BUFFERED_RESPONSE_KINDS.has(kind),
        ...extras,
      });
      this.#auditDecisionMetadata.set(result, { requestId });
      this.#auditLedger.record({ phase: 'request', outcome: 'allowed', requestId, method, kind });
      return result;
    };

    if (method === 'HEAD' && parsed.path === '/_ping') {
      requireNoQuery(parsed.query);
      if (body.length) deny('ping request body is not allowed');
      return decision('ping');
    }
    if (method === 'GET' && parsed.path === '/version') {
      requireNoQuery(parsed.query);
      if (body.length) deny('version request body is not allowed');
      return decision('version');
    }
    if (method === 'GET' && parsed.path === '/info') {
      requireNoQuery(parsed.query);
      if (body.length) deny('info request body is not allowed');
      return decision('info');
    }

    if (method === 'GET' && parsed.path === '/images/json') {
      if (body.length) deny('image-list request body is not allowed');
      this.#validateImageFilters(parsed.query);
      return decision('image-list');
    }
    if (method === 'GET' && parsed.path.startsWith('/images/') && parsed.path.endsWith('/json')) {
      requireNoQuery(parsed.query);
      let image;
      try {
        image = decodeURIComponent(parsed.path.slice('/images/'.length, -'/json'.length));
      } catch {
        deny('image reference has malformed encoding', { statusCode: 400, code: 'MALFORMED_ENCODING' });
      }
      if (image !== this.pinnedImage) deny('foreign image inspect is denied');
      if (body.length) deny('image-inspect request body is not allowed');
      return decision('image-inspect');
    }

    if (method === 'GET' && parsed.path === '/containers/json') {
      if (body.length) deny('container-list request body is not allowed');
      this.#validateContainerFilters(parsed.query);
      return decision('container-list');
    }
    if (method === 'GET' && parsed.path === '/networks') {
      if (body.length) deny('network-list request body is not allowed');
      validateComposeScopedResourceFilters(parsed.query, this.composeProject);
      return decision('network-list');
    }
    if (method === 'GET' && parsed.path === '/volumes') {
      if (body.length) deny('volume-list request body is not allowed');
      validateComposeScopedResourceFilters(parsed.query, this.composeProject);
      return decision('volume-list');
    }
    if (method === 'POST' && parsed.path === '/containers/create') {
      assertOnlyQuery(parsed.query, new Set(['name']), { required: ['name'] });
      if (parsed.query.get('name') !== this.containerName) deny('container create name does not match the active lease');
      if (this.leaseTerminated) deny('container create is denied after the lease container was deleted');
      if (this.containerId != null) deny('container create is denied after a container is already bound to the lease');
      if (this.createPending) deny('container create is denied while another create is pending for the lease');
      requireJsonContentType(headers);
      const create = parseJson(body, this.limits.maxJsonBodyBytes, 'container create');
      this.#validateCreate(create);
      const createDecision = decision('container-create');
      this.createPending = true;
      this.#pendingCreateDecision = createDecision;
      return createDecision;
    }

    const containerRoute = parsed.path.match(/^\/containers\/([a-f0-9]{64})\/(json|start|stop|exec|archive)$/);
    if (containerRoute) {
      const [, containerId, action] = containerRoute;
      this.#requireBoundContainer(containerId);
      if (action === 'json' && method === 'GET') {
        requireNoQuery(parsed.query);
        if (body.length) deny('container-inspect request body is not allowed');
        return decision('container-inspect', { containerId });
      }
      if (action === 'start' && method === 'POST') {
        requireNoQuery(parsed.query);
        if (body.length) deny('container-start request body is not allowed');
        return decision('container-start', { containerId });
      }
      if (action === 'stop' && method === 'POST') {
        assertOnlyQuery(parsed.query, new Set(['t']));
        if (parsed.query.has('t') && !/^(?:[0-9]|[12][0-9]|30)$/.test(parsed.query.get('t'))) deny('container stop timeout must be between 0 and 30 seconds');
        if (body.length) deny('container-stop request body is not allowed');
        return decision('container-stop', { containerId });
      }
      if (action === 'exec' && method === 'POST') {
        requireNoQuery(parsed.query);
        requireJsonContentType(headers);
        const exec = parseJson(body, this.limits.maxJsonBodyBytes, 'exec create');
        if (exec.Privileged === true) deny('privileged exec is not allowed');
        if (this.execUser != null && exec.User !== this.execUser) deny('exec user does not match the lease policy');
        if (this.execIds.size >= this.limits.maxExecIds) deny('exec id limit reached for this lease');
        return decision('exec-create', { containerId });
      }
      if (action === 'archive' && ['HEAD', 'PUT'].includes(method)) {
        const archivePath = normalizedArchivePath(parsed.query, this.allowedArchivePaths);
        if (method === 'HEAD') {
          if (body.length) deny('archive HEAD request body is not allowed');
          return decision('archive-head', { containerId, archivePath });
        }
        if (body.length > this.limits.maxArchiveBodyBytes) deny('archive body is too large', { statusCode: 413, code: 'BODY_LIMIT' });
        if (headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-tar') {
          deny('archive PUT must use application/x-tar', { statusCode: 400, code: 'CONTENT_TYPE_POLICY' });
        }
        return decision('archive-put', { containerId, archivePath });
      }
    }

    const deleteRoute = parsed.path.match(/^\/containers\/([a-f0-9]{64})$/);
    if (deleteRoute && method === 'DELETE') {
      const containerId = deleteRoute[1];
      this.#requireBoundContainer(containerId);
      assertOnlyQuery(parsed.query, new Set(['force', 'v']), { required: ['force'] });
      if (!['1', 'true'].includes(parsed.query.get('force'))) deny('container deletion must be forced');
      if (parsed.query.has('v') && !['0', '1', 'false', 'true'].includes(parsed.query.get('v'))) deny('invalid container-delete volume option');
      if (body.length) deny('container-delete request body is not allowed');
      return decision('container-delete', { containerId });
    }

    const execStart = parsed.path.match(/^\/exec\/([a-f0-9]{64})\/start$/);
    if (execStart && method === 'POST') {
      requireNoQuery(parsed.query);
      const execId = execStart[1];
      if (!this.execIds.has(execId)) deny('foreign or unbound exec id is denied');
      requireJsonContentType(headers);
      const start = parseJson(body, this.limits.maxJsonBodyBytes, 'exec start');
      if (start.Detach !== false) deny('exec start must use attached transport');
      if (typeof start.Tty !== 'boolean') deny('exec start must declare Tty explicitly');
      return decision('exec-start', { execId });
    }

    deny(`Docker API route is denied by the offline lease policy: ${method} ${parsed.path}`);
  }

  observeResponse(decision, response) {
    const before = {
      containerId: this.containerId,
      execIds: new Set(this.execIds),
      createPending: this.createPending,
      leaseTerminated: this.leaseTerminated,
    };
    const metadata = decision && this.#auditDecisionMetadata.get(decision);
    const requestId = metadata?.requestId ?? ++this.#auditRequestSequence;
    try {
      const result = this.#observeResponse(decision, response);
      const statusCode = response.statusCode;
      this.#auditLedger.record({
        phase: 'response',
        outcome: (statusCode >= 200 && statusCode < 300) || statusCode === 101 ? 'accepted' : 'upstream-rejected',
        requestId,
        method: auditMethod(decision.method),
        kind: decision.kind,
        statusCode,
      });
      this.#auditStateChanges(before);
      return result;
    } catch (error) {
      const sanitized = auditError(error);
      this.#auditLedger.record({
        phase: 'response',
        outcome: 'denied',
        requestId,
        method: auditMethod(decision?.method),
        ...(decision?.kind ? { kind: decision.kind } : {}),
        ...sanitized,
      });
      throw markAudited(error);
    }
  }

  releaseUnsentCreate(decision) {
    if (this.#pendingCreateDecision !== decision) return false;
    const before = {
      containerId: this.containerId,
      execIds: new Set(this.execIds),
      createPending: this.createPending,
      leaseTerminated: this.leaseTerminated,
    };
    this.createPending = false;
    this.#pendingCreateDecision = null;
    this.#auditStateChanges(before);
    return true;
  }

  #auditStateChanges(before) {
    if (before.containerId == null && this.containerId != null) {
      this.#auditLedger.record({
        phase: 'state',
        outcome: 'changed',
        action: 'container-bound',
        bindingHash: bindingHash(this.containerId),
      });
    }
    for (const execId of this.execIds) {
      if (!before.execIds.has(execId)) {
        this.#auditLedger.record({
          phase: 'state',
          outcome: 'changed',
          action: 'exec-bound',
          bindingHash: bindingHash(execId),
        });
      }
    }
    if (before.containerId != null && this.containerId == null && !before.leaseTerminated && this.leaseTerminated) {
      this.#auditLedger.record({
        phase: 'state',
        outcome: 'changed',
        action: 'container-cleaned',
        bindingHash: bindingHash(before.containerId),
        clearedExecBindings: before.execIds.size,
      });
    } else if (before.createPending && !this.createPending && before.containerId == null && this.containerId == null) {
      this.#auditLedger.record({
        phase: 'state',
        outcome: 'changed',
        action: 'create-reservation-released',
      });
    }
  }

  #observeResponse(decision, response) {
    if (!decision || typeof decision.kind !== 'string') throw new TypeError('a policy decision is required');
    const statusCode = response?.statusCode;
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      deny('Docker daemon returned an invalid status', { statusCode: 502, code: 'UPSTREAM_POLICY' });
    }
    const body = asBuffer(response.body);
    if (body.length > this.limits.maxResponseBodyBytes) {
      deny('Docker daemon response exceeds the policy limit', { statusCode: 502, code: 'UPSTREAM_POLICY' });
    }
    if (statusCode < 200 || statusCode >= 300) {
      if (decision.kind === 'container-create') {
        this.createPending = false;
        if (this.#pendingCreateDecision === decision) this.#pendingCreateDecision = null;
      }
      return;
    }

    if (decision.kind === 'container-create') {
      const id = readDockerId(body, 'container');
      if (this.containerId != null && this.containerId !== id) deny('conflicting container id returned for an already bound lease', {
        statusCode: 502,
        code: 'UPSTREAM_POLICY',
      });
      this.containerId = id;
      this.createPending = false;
      if (this.#pendingCreateDecision === decision) this.#pendingCreateDecision = null;
      return;
    }
    if (decision.kind === 'exec-create') {
      if (decision.containerId !== this.containerId) deny('exec response no longer belongs to the active container', {
        statusCode: 502,
        code: 'UPSTREAM_POLICY',
      });
      this.execIds.add(readDockerId(body, 'exec'));
      return;
    }
    if (decision.kind === 'container-delete') {
      if (decision.containerId === this.containerId) {
        this.containerId = null;
        this.execIds.clear();
        this.leaseTerminated = true;
      }
      return;
    }
    if (decision.kind === 'container-list') {
      const list = safeResponseJson(body, 'container-list');
      if (!Array.isArray(list)) deny('Docker daemon returned a non-array container list', { statusCode: 502, code: 'UPSTREAM_POLICY' });
      for (const container of list) {
        const id = container?.Id;
        const labels = container?.Labels;
        if (!this.containerId || id !== this.containerId || labels?.[this.leaseLabel] !== this.leaseId || labels?.['com.docker.compose.project'] !== this.composeProject) {
          deny('Docker daemon container-list response escaped the active lease scope', { statusCode: 502, code: 'UPSTREAM_POLICY' });
        }
      }
      return;
    }
    if (decision.kind === 'container-inspect') {
      const inspect = safeResponseJson(body, 'container-inspect');
      if (inspect?.Id !== this.containerId || inspect?.Config?.Labels?.[this.leaseLabel] !== this.leaseId ||
          inspect?.Config?.Labels?.['com.docker.compose.project'] !== this.composeProject || inspect?.Config?.Image !== this.pinnedImage) {
        deny('Docker daemon container-inspect response escaped the active lease scope', { statusCode: 502, code: 'UPSTREAM_POLICY' });
      }
      return;
    }
    if (decision.kind === 'image-list') {
      const list = safeResponseJson(body, 'image-list');
      if (!Array.isArray(list) || list.some((image) => !Array.isArray(image?.RepoDigests) || !image.RepoDigests.includes(this.pinnedImage))) {
        deny('Docker daemon image-list response escaped the pinned-image scope', { statusCode: 502, code: 'UPSTREAM_POLICY' });
      }
      return;
    }
    if (decision.kind === 'image-inspect') {
      const inspect = safeResponseJson(body, 'image-inspect');
      if (!Array.isArray(inspect?.RepoDigests) || !inspect.RepoDigests.includes(this.pinnedImage)) {
        deny('Docker daemon image-inspect response escaped the pinned-image scope', { statusCode: 502, code: 'UPSTREAM_POLICY' });
      }
      return;
    }
    if (decision.kind === 'network-list') {
      const list = safeResponseJson(body, 'network-list');
      if (!Array.isArray(list) || list.length !== 0) {
        deny('Docker daemon returned a network despite the network-none lease', { statusCode: 502, code: 'UPSTREAM_POLICY' });
      }
      return;
    }
    if (decision.kind === 'volume-list') {
      const list = safeResponseJson(body, 'volume-list');
      if (!plainObject(list) || (list.Volumes != null && (!Array.isArray(list.Volumes) || list.Volumes.length !== 0))) {
        deny('Docker daemon returned a volume outside the no-volume lease', { statusCode: 502, code: 'UPSTREAM_POLICY' });
      }
    }
  }
}

function cleanForwardHeaders(headers, body, { upgrade = false } = {}) {
  const outgoing = Object.create(null);
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || name === 'content-length' || name === 'host') continue;
    outgoing[name] = rawValue;
  }
  outgoing.host = 'docker';
  outgoing['content-length'] = String(body.length);
  if (upgrade) {
    outgoing.connection = 'Upgrade';
    outgoing.upgrade = 'tcp';
  } else {
    outgoing.connection = 'close';
  }
  return outgoing;
}

function cleanResponseHeaders(headers) {
  const outgoing = Object.create(null);
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    outgoing[name] = rawValue;
  }
  return outgoing;
}

function collectStream(stream, limit, initial = Buffer.alloc(0), { exactLength = null } = {}) {
  return new Promise((resolve, reject) => {
    let chunks = initial.length ? [initial] : [];
    let length = initial.length;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const combined = Buffer.concat(chunks, length);
      chunks = [];
      if (exactLength != null && combined.length < exactLength) {
        reject(new DockerPolicyError('request body ended before content-length bytes arrived', {
          statusCode: 400,
          code: 'AMBIGUOUS_FRAMING',
        }));
        return;
      }
      resolve(combined);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      length += chunk.length;
      if (length > limit) {
        fail(new DockerPolicyError('request body is too large', { statusCode: 413, code: 'BODY_LIMIT' }));
        return;
      }
      chunks.push(chunk);
      if (exactLength != null && length >= exactLength) finish();
    };
    const onEnd = () => finish();
    const onAborted = () => fail(new DockerPolicyError('request body was aborted', { statusCode: 400, code: 'ABORTED_BODY' }));
    const onError = (error) => fail(error);
    const cleanup = () => {
      stream.off?.('data', onData);
      stream.off?.('end', onEnd);
      stream.off?.('aborted', onAborted);
      stream.off?.('error', onError);
    };
    if (length > limit) {
      fail(new DockerPolicyError('request body is too large', { statusCode: 413, code: 'BODY_LIMIT' }));
      return;
    }
    if (exactLength != null && length >= exactLength) {
      finish();
      return;
    }
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('aborted', onAborted);
    stream.once('error', onError);
    stream.resume?.();
  });
}

function rawResponseHead(response, { bodyLength = null } = {}) {
  const version = /^\d+\.\d+$/.test(response.httpVersion ?? '') ? response.httpVersion : '1.1';
  const status = Number.isInteger(response.statusCode) ? response.statusCode : 502;
  const message = String(response.statusMessage ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, '');
  const lines = [`HTTP/${version} ${status} ${message || 'Unknown'}`];
  const rawHeaders = bodyLength == null
    ? (Array.isArray(response.rawHeaders) ? response.rawHeaders : [])
    : Object.entries({ ...cleanResponseHeaders(response.headers), 'content-length': String(bodyLength), connection: 'close' }).flat();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]);
    const value = String(rawHeaders[index + 1]);
    if (!HEADER_NAME.test(name) || /[\r\n]/.test(value)) continue;
    lines.push(`${name}: ${value}`);
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}

/**
 * Establish the raw bidirectional relay used by Docker's exec-start upgrade.
 * Pre-read bytes are never discarded: daemon bytes go to the client and any
 * client bytes received after its JSON body go to the daemon before piping.
 */
export function relayHijackedTransport({
  downstreamSocket,
  upstreamSocket,
  upstreamResponse,
  upstreamHead = Buffer.alloc(0),
  downstreamHead = Buffer.alloc(0),
}) {
  if (!downstreamSocket?.write || !downstreamSocket?.pipe || !upstreamSocket?.write || !upstreamSocket?.pipe) {
    throw new TypeError('hijack relay requires two writable, pipeable sockets');
  }
  downstreamSocket.write(rawResponseHead(upstreamResponse));
  if (upstreamHead.length) downstreamSocket.write(upstreamHead);
  if (downstreamHead.length) upstreamSocket.write(downstreamHead);
  downstreamSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(downstreamSocket);
  downstreamSocket.on?.('error', (error) => upstreamSocket.destroy?.(error));
  upstreamSocket.on?.('error', (error) => downstreamSocket.destroy?.(error));
  downstreamSocket.on?.('close', () => upstreamSocket.destroy?.());
  upstreamSocket.on?.('close', () => downstreamSocket.destroy?.());
}

function writeRawError(socket, error) {
  const status = error instanceof DockerPolicyError ? error.statusCode : 502;
  const reason = status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : status === 413 ? 'Payload Too Large' : 'Bad Gateway';
  const code = error instanceof DockerPolicyError ? error.code : 'UPSTREAM_FAILURE';
  const body = Buffer.from(JSON.stringify({ error: code }));
  socket.end?.(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
}

function sendHttpError(response, error) {
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  const status = error instanceof DockerPolicyError ? error.statusCode : 502;
  const payload = Buffer.from(JSON.stringify({ error: error instanceof DockerPolicyError ? error.code : 'UPSTREAM_FAILURE' }));
  response.writeHead(status, {
    connection: 'close',
    'content-type': 'application/json',
    'content-length': payload.length,
  });
  response.end(payload);
}

export class DockerSocketProxy {
  #listenerFailed;

  constructor({
    listenSocketPath,
    upstreamSocketPath,
    policy,
    onContainerStarted = null,
    ...policyOptions
  } = {}) {
    if (!path.isAbsolute(listenSocketPath ?? '') || !path.isAbsolute(upstreamSocketPath ?? '')) {
      throw new TypeError('listenSocketPath and upstreamSocketPath must be absolute paths');
    }
    if (listenSocketPath === upstreamSocketPath) throw new TypeError('proxy and upstream socket paths must differ');
    if (onContainerStarted !== null && typeof onContainerStarted !== 'function') {
      throw new TypeError('onContainerStarted must be a function when supplied');
    }
    this.listenSocketPath = listenSocketPath;
    this.upstreamSocketPath = upstreamSocketPath;
    this.policy = policy instanceof DockerProxyPolicy ? policy : new DockerProxyPolicy(policy ?? policyOptions);
    this.onContainerStarted = onContainerStarted;
    this.server = null;
    this.socketIdentity = null;
    this.upstreamIdentity = null;
    this.#listenerFailed = false;
    this.connections = new Set();
  }

  auditSnapshot() {
    return this.policy.auditSnapshot();
  }

  #captureUpstreamIdentity() {
    const parent = fs.lstatSync(path.dirname(this.upstreamSocketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('upstream socket parent must be a real directory');
    const stat = fs.lstatSync(this.upstreamSocketPath);
    if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error('upstream Docker path must be a real Unix socket');
    this.upstreamIdentity = { dev: stat.dev, ino: stat.ino };
  }

  #assertUpstreamIdentity() {
    const stat = fs.lstatSync(this.upstreamSocketPath);
    if (!stat.isSocket() || stat.isSymbolicLink() || !this.upstreamIdentity ||
        stat.dev !== this.upstreamIdentity.dev || stat.ino !== this.upstreamIdentity.ino) {
      throw new DockerPolicyError('upstream Docker socket identity changed', {
        statusCode: 502,
        code: 'UPSTREAM_IDENTITY_CHANGED',
      });
    }
  }

  async start() {
    if (this.server) throw new Error('Docker policy proxy is already started');
    this.#listenerFailed = false;
    try {
      fs.lstatSync(this.listenSocketPath);
      throw new Error(`refusing to replace existing proxy socket path: ${this.listenSocketPath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(this.listenSocketPath);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('proxy socket parent must be a real directory');
    this.#captureUpstreamIdentity();

    const server = http.createServer({
      maxHeaderSize: this.policy.limits.maxHeaderBytes,
      requireHostHeader: true,
      joinDuplicateHeaders: false,
    }, (request, response) => void this.#handleRequest(request, response));
    server.on('upgrade', (request, socket, head) => void this.#handleUpgrade(request, socket, head));
    server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
    });
    server.on('clientError', (error, socket) => {
      const policyError = new DockerPolicyError('malformed HTTP request', {
        statusCode: error?.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400,
        code: 'MALFORMED_HTTP',
      });
      this.policy.recordProxyDenial({ method: null, error: policyError });
      writeRawError(socket, policyError);
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.listenSocketPath);
    });
    fs.chmodSync(this.listenSocketPath, 0o660);
    const stat = fs.lstatSync(this.listenSocketPath);
    if (!stat.isSocket()) {
      server.close();
      throw new Error('proxy listener path is not a Unix socket');
    }
    this.socketIdentity = { dev: stat.dev, ino: stat.ino };
    server.on('error', () => this.#handleListenerError(server));
    this.server = server;
    this.policy.recordProxyLifecycle('listener-started');
    return this;
  }

  #handleListenerError(server) {
    if (this.server !== server || this.#listenerFailed) return;
    this.#listenerFailed = true;
    this.policy.recordProxyLifecycle('listener-failed');
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    server.close();
  }

  async close() {
    const server = this.server;
    const wasActive = server != null || this.socketIdentity != null;
    this.server = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    if (this.socketIdentity) {
      try {
        const stat = fs.lstatSync(this.listenSocketPath);
        if (stat.isSocket() && stat.dev === this.socketIdentity.dev && stat.ino === this.socketIdentity.ino) {
          fs.unlinkSync(this.listenSocketPath);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      } finally {
        this.socketIdentity = null;
        this.upstreamIdentity = null;
      }
    }
    if (wasActive) this.policy.recordProxyLifecycle('listener-closed');
  }

  async #handleRequest(request, response) {
    let decision = null;
    try {
      const limit = this.policy.requestBodyLimit({ method: request.method, target: request.url });
      const body = await collectStream(request, limit);
      decision = this.policy.authorize({
        method: request.method,
        target: request.url,
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        body,
      });
      await this.#forward(decision, request.headers, body, response);
    } catch (error) {
      this.policy.recordProxyDenial({
        method: request.method,
        error,
        phase: decision ? 'response' : 'request',
        decision,
      });
      if (decision && UNSENT_FORWARD_ERRORS.has(error)) this.policy.releaseUnsentCreate(decision);
      sendHttpError(response, error);
    }
  }

  #forward(decision, headers, body, downstreamResponse) {
    return new Promise((resolve, reject) => {
      try {
        this.#assertUpstreamIdentity();
      } catch (error) {
        reject(markUnsentForward(error));
        return;
      }
      let upstreamRequest;
      try {
        upstreamRequest = http.request({
          socketPath: this.upstreamSocketPath,
          method: decision.method,
          path: decision.normalizedTarget,
          headers: cleanForwardHeaders(headers, body),
          timeout: this.policy.limits.requestTimeoutMs,
        });
      } catch (error) {
        reject(markUnsentForward(error));
        return;
      }
      upstreamRequest.once('timeout', () => upstreamRequest.destroy(new Error('Docker daemon request timed out')));
      upstreamRequest.once('error', (error) => {
        const definitivelyUnsent = ['EACCES', 'ECONNREFUSED', 'ENOENT', 'ENOTSOCK'].includes(error?.code);
        reject(definitivelyUnsent ? markUnsentForward(error) : error);
      });
      upstreamRequest.once('response', async (upstreamResponse) => {
        try {
          if (decision.bufferResponse) {
            const responseBody = await collectStream(upstreamResponse, this.policy.limits.maxResponseBodyBytes);
            this.policy.observeResponse(decision, {
              statusCode: upstreamResponse.statusCode,
              headers: upstreamResponse.headers,
              body: responseBody,
            });
            if (decision.kind === 'container-start'
                && upstreamResponse.statusCode >= 200
                && upstreamResponse.statusCode < 300
                && this.onContainerStarted) {
              const state = this.policy.auditSnapshot().state;
              if (state.containerBound !== true || typeof state.containerBindingHash !== 'string') {
                throw new DockerPolicyError('container start lacks an active audit binding', {
                  statusCode: 502,
                  code: 'UPSTREAM_POLICY',
                });
              }
              await this.onContainerStarted({
                containerId: decision.containerId,
                containerBindingHash: state.containerBindingHash,
              });
            }
            const responseHeaders = cleanResponseHeaders(upstreamResponse.headers);
            responseHeaders['content-length'] = String(responseBody.length);
            downstreamResponse.writeHead(upstreamResponse.statusCode, responseHeaders);
            downstreamResponse.end(responseBody);
            resolve();
            return;
          }
          downstreamResponse.writeHead(upstreamResponse.statusCode, cleanResponseHeaders(upstreamResponse.headers));
          upstreamResponse.once('error', reject);
          upstreamResponse.once('end', () => {
            try {
              this.policy.observeResponse(decision, {
                statusCode: upstreamResponse.statusCode,
                headers: upstreamResponse.headers,
                body: Buffer.alloc(0),
              });
              resolve();
            } catch (error) {
              reject(error);
            }
          });
          upstreamResponse.pipe(downstreamResponse);
        } catch (error) {
          reject(error);
        }
      });
      upstreamRequest.end(body);
    });
  }

  async #handleUpgrade(request, downstreamSocket, initialHead) {
    let decision = null;
    try {
      const rawLength = request.headers['content-length'];
      if (request.headers['transfer-encoding'] != null || !/^(0|[1-9][0-9]*)$/.test(String(rawLength ?? ''))) {
        deny('hijacked exec request requires an exact content-length', { statusCode: 400, code: 'AMBIGUOUS_FRAMING' });
      }
      const bodyLength = Number(rawLength);
      if (!Number.isSafeInteger(bodyLength) || bodyLength > this.policy.limits.maxJsonBodyBytes) {
        deny('hijacked exec request body is too large', { statusCode: 413, code: 'BODY_LIMIT' });
      }
      const bodyPrefix = initialHead.subarray(0, Math.min(initialHead.length, bodyLength));
      const initialExtra = initialHead.subarray(bodyPrefix.length);
      const collected = await collectStream(
        request,
        bodyLength + this.policy.limits.maxHijackHeadBytes,
        bodyPrefix,
        { exactLength: bodyLength }
      );
      const body = collected.subarray(0, bodyLength);
      const downstreamHead = Buffer.concat([collected.subarray(bodyLength), initialExtra]);
      decision = this.policy.authorize({
        method: request.method,
        target: request.url,
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        body,
      });
      if (decision.kind !== 'exec-start') deny('HTTP upgrade is allowed only for a bound exec start');
      this.#assertUpstreamIdentity();

      const upstreamRequest = http.request({
        socketPath: this.upstreamSocketPath,
        method: decision.method,
        path: decision.normalizedTarget,
        headers: cleanForwardHeaders(request.headers, body, { upgrade: true }),
        timeout: this.policy.limits.requestTimeoutMs,
      });
      upstreamRequest.once('timeout', () => upstreamRequest.destroy(new Error('Docker daemon upgrade timed out')));
      upstreamRequest.once('error', (error) => {
        this.policy.recordProxyDenial({ method: request.method, error, phase: 'response', decision });
        writeRawError(downstreamSocket, error);
      });
      upstreamRequest.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
        try {
          this.policy.observeResponse(decision, {
            statusCode: upstreamResponse.statusCode,
            headers: upstreamResponse.headers,
            body: Buffer.alloc(0),
          });
          relayHijackedTransport({ downstreamSocket, upstreamSocket, upstreamResponse, upstreamHead, downstreamHead });
        } catch (error) {
          upstreamSocket.destroy(error);
          writeRawError(downstreamSocket, error);
        }
      });
      upstreamRequest.once('response', async (upstreamResponse) => {
        try {
          const responseBody = await collectStream(upstreamResponse, this.policy.limits.maxResponseBodyBytes);
          this.policy.observeResponse(decision, {
            statusCode: upstreamResponse.statusCode,
            headers: upstreamResponse.headers,
            body: responseBody,
          });
          downstreamSocket.end(Buffer.concat([rawResponseHead(upstreamResponse, { bodyLength: responseBody.length }), responseBody]));
        } catch (error) {
          this.policy.recordProxyDenial({ method: request.method, error, phase: 'response', decision });
          writeRawError(downstreamSocket, error);
        }
      });
      upstreamRequest.end(body);
    } catch (error) {
      this.policy.recordProxyDenial({
        method: request.method,
        error,
        phase: decision ? 'response' : 'request',
        decision,
      });
      writeRawError(downstreamSocket, error);
    }
  }
}

export function createDockerPolicyProxy(options) {
  return new DockerSocketProxy(options);
}
