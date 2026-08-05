const MAX_METADATA_BYTES = 4_096;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SNAPSHOT_REFERENCE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[a-f0-9]{64})$/;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const SECRET_VALUE = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{4,}|gh[pousr]_[A-Za-z0-9]{4,}|xox[baprs]-[A-Za-z0-9-]{4,}|hf_[A-Za-z0-9]{4,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,}|(?:api[_-]?key|authorization|credential|password|secret|token)\s*[=:]\s*[^\s&,;]{4,})/i;

export const DAYTONA_PLATFORM_METADATA_ENVIRONMENT_NAMES = Object.freeze([
  'DAYTONA_ORGANIZATION_ID',
  'DAYTONA_OTEL_ENDPOINT',
  'DAYTONA_REGION_ID',
  'DAYTONA_SANDBOX_ID',
  'DAYTONA_SANDBOX_SNAPSHOT',
  'DAYTONA_SANDBOX_USER',
]);

const DAYTONA_PLATFORM_METADATA = new Set(DAYTONA_PLATFORM_METADATA_ENVIRONMENT_NAMES);

export class PlatformEnvironmentError extends Error {
  constructor(message, code = 'ERR_PLATFORM_ENVIRONMENT') {
    super(message);
    this.name = 'PlatformEnvironmentError';
    this.code = code;
  }
}

function fail(message) {
  throw new PlatformEnvironmentError(message);
}

function validEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    return false;
  }
  return endpoint.protocol === 'https:'
    && endpoint.hostname.length > 0
    && endpoint.username === ''
    && endpoint.password === ''
    && endpoint.search === ''
    && endpoint.hash === '';
}

function validateMetadata(name, value) {
  if (typeof value !== 'string' || value.length === 0
      || Buffer.byteLength(value) > MAX_METADATA_BYTES
      || CONTROL_CHARACTER.test(value) || SECRET_VALUE.test(value)) {
    fail('Daytona platform metadata is invalid');
  }
  if (name === 'DAYTONA_OTEL_ENDPOINT') {
    if (!validEndpoint(value)) fail('Daytona platform metadata is invalid');
  } else if (name === 'DAYTONA_SANDBOX_SNAPSHOT') {
    if (Buffer.byteLength(value) > 512 || !SNAPSHOT_REFERENCE.test(value)) {
      fail('Daytona platform metadata is invalid');
    }
  } else if (name === 'DAYTONA_ORGANIZATION_ID' || name === 'DAYTONA_SANDBOX_ID') {
    if (!UUID.test(value)) fail('Daytona platform metadata is invalid');
  } else if (name === 'DAYTONA_REGION_ID') {
    if (value !== 'us') fail('Daytona platform metadata is invalid');
  } else if (name === 'DAYTONA_SANDBOX_USER') {
    if (value !== 'root') fail('Daytona platform metadata is invalid');
  }
}

/**
 * Remove only Daytona-injected, non-secret platform facts from a fresh copy.
 * Every other variable is preserved for the caller's strict credential check.
 */
export function scrubDaytonaPlatformMetadata(environment) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('platform environment must be an inspectable object');
  }
  let names;
  try {
    names = Object.keys(environment);
  } catch {
    fail('platform environment cannot be inspected');
  }
  const scrubbed = Object.create(null);
  for (const name of names) {
    let value;
    try {
      value = environment[name];
    } catch {
      fail('platform environment cannot be inspected');
    }
    if (DAYTONA_PLATFORM_METADATA.has(name)) {
      validateMetadata(name, value);
      continue;
    }
    Object.defineProperty(scrubbed, name, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(scrubbed);
}

/**
 * Validate every present platform fact before deleting any of them from the
 * live process environment. Unknown Daytona and provider names are untouched
 * so the caller's strict credential policy can still reject them.
 */
export function scrubDaytonaPlatformMetadataInPlace(environment) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('platform environment must be an inspectable object');
  }
  const planned = [];
  try {
    for (const name of DAYTONA_PLATFORM_METADATA_ENVIRONMENT_NAMES) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, name);
      if (descriptor === undefined) continue;
      if (!descriptor.configurable || !Object.hasOwn(descriptor, 'value')) {
        fail('Daytona platform metadata cannot be safely removed');
      }
      validateMetadata(name, descriptor.value);
      planned.push({ name, descriptor });
    }
  } catch (error) {
    if (error instanceof PlatformEnvironmentError) throw error;
    fail('platform environment cannot be inspected');
  }

  const removed = [];
  try {
    for (const entry of planned) {
      if (!Reflect.deleteProperty(environment, entry.name)) {
        fail('Daytona platform metadata could not be removed');
      }
      removed.push(entry);
    }
    for (const { name } of planned) {
      if (Object.getOwnPropertyDescriptor(environment, name) !== undefined) {
        fail('Daytona platform metadata deletion could not be verified');
      }
    }
  } catch {
    for (const entry of removed.reverse()) {
      try {
        Object.defineProperty(environment, entry.name, entry.descriptor);
      } catch {
        // The caller still fails closed; restoration is best-effort for exotic
        // proxy objects and deterministic for ordinary objects/process.env.
      }
    }
    fail('Daytona platform metadata could not be removed');
  }

  return Object.freeze({
    removed: Object.freeze(planned.map(({ name }) => name)),
  });
}
