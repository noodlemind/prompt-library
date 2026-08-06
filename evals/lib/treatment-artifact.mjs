/** Canonical exact-treatment identity shared by every private eval boundary. */
import crypto from 'node:crypto';

export const TREATMENT_ARTIFACT_SCHEMA = 'engineer-harness-treatment-artifact.v1';
export const HARNESS_PACKAGE_NAME = '@dev-kit/harness';
export const TREATMENT_ARTIFACT_FIELDS = Object.freeze([
  'schema', 'bundleManifestHash', 'harnessPackage', 'conditionExposure',
]);
export const TREATMENT_PACKAGE_FIELDS = Object.freeze([
  'name', 'version', 'sha256', 'integrity', 'packedSize', 'unpackedSize', 'fileCount', 'lockfileSha256',
]);
export const TREATMENT_EXPOSURE_FIELDS = Object.freeze(['generic', 'harness']);

const LOWER_SHA256_HEX = /^[a-f0-9]{64}$/;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const CANONICAL_SHA512_SRI_PATTERN = '^sha512-[A-Za-z0-9+/]{85}[AQgw]==$';
const SHA512_SRI = new RegExp(CANONICAL_SHA512_SRI_PATTERN);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const TREATMENT_ARTIFACT_JSON_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: [...TREATMENT_ARTIFACT_FIELDS],
  properties: {
    schema: { const: TREATMENT_ARTIFACT_SCHEMA },
    bundleManifestHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    harnessPackage: {
      type: 'object',
      additionalProperties: false,
      required: [...TREATMENT_PACKAGE_FIELDS],
      properties: {
        name: { const: HARNESS_PACKAGE_NAME },
        version: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$' },
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        integrity: { type: 'string', pattern: CANONICAL_SHA512_SRI_PATTERN },
        packedSize: { type: 'integer', minimum: 1 },
        unpackedSize: { type: 'integer', minimum: 1 },
        fileCount: { type: 'integer', minimum: 1 },
        lockfileSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
    conditionExposure: {
      type: 'object',
      additionalProperties: false,
      required: [...TREATMENT_EXPOSURE_FIELDS],
      properties: {
        generic: { const: false },
        harness: { const: true },
      },
    },
  },
});

function exactObjectKeys(value, expected) {
  return value != null && !Array.isArray(value) && typeof value === 'object' &&
    Object.keys(value).length === expected.length && expected.every((field) => Object.hasOwn(value, field));
}

function canonicalSha512Integrity(value) {
  if (typeof value !== 'string' || !SHA512_SRI.test(value)) return false;
  const encoded = value.slice('sha512-'.length);
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === encoded;
}

function positiveBoundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export function harnessPackageIdentityVerdict(value, {
  expectedVersion = null,
  maximumPackedSize = Number.MAX_SAFE_INTEGER,
  maximumUnpackedSize = Number.MAX_SAFE_INTEGER,
  maximumFileCount = Number.MAX_SAFE_INTEGER,
} = {}) {
  const reasons = [];
  const note = (reason) => reasons.push(reason);
  if (!exactObjectKeys(value, TREATMENT_PACKAGE_FIELDS)) note('package fields are missing or unexpected');
  if (value?.name !== HARNESS_PACKAGE_NAME) note('package name is not the Harness package');
  if (!PACKAGE_VERSION.test(String(value?.version ?? ''))) note('package version is malformed');
  if (expectedVersion != null && value?.version !== expectedVersion) {
    note('package version does not match the evaluated Harness');
  }
  if (!LOWER_SHA256_HEX.test(String(value?.sha256 ?? ''))) note('package sha256 is malformed');
  if (!canonicalSha512Integrity(value?.integrity)) note('package integrity is not a canonical sha512 SRI value');
  if (!positiveBoundedInteger(value?.packedSize, maximumPackedSize)) note('package packedSize is outside its allowance');
  if (!positiveBoundedInteger(value?.unpackedSize, maximumUnpackedSize)) note('package unpackedSize is outside its allowance');
  if (!positiveBoundedInteger(value?.fileCount, maximumFileCount)) note('package fileCount is outside its allowance');
  if (!LOWER_SHA256_HEX.test(String(value?.lockfileSha256 ?? ''))) note('package lockfileSha256 is malformed');
  if (reasons.length > 0) return { ok: false, packageIdentity: null, reasons };
  return {
    ok: true,
    packageIdentity: Object.freeze(Object.fromEntries(
      TREATMENT_PACKAGE_FIELDS.map((field) => [field, value[field]]),
    )),
    reasons: [],
  };
}

export function assertHarnessPackageIdentity(value, options = {}) {
  const { label = 'Harness package identity', ...validation } = options;
  const verdict = harnessPackageIdentityVerdict(value, validation);
  if (!verdict.ok) throw new Error(`${label} is invalid (${verdict.reasons.join('; ')})`);
  return verdict.packageIdentity;
}

export function harnessTreatmentArtifactVerdict(value, {
  expectedHarnessVersion = null,
  maximumPackedSize = Number.MAX_SAFE_INTEGER,
  maximumUnpackedSize = Number.MAX_SAFE_INTEGER,
  maximumFileCount = Number.MAX_SAFE_INTEGER,
} = {}) {
  const reasons = [];
  const note = (reason) => reasons.push(reason);
  if (!exactObjectKeys(value, TREATMENT_ARTIFACT_FIELDS)) note('artifact fields are missing or unexpected');
  if (value?.schema !== TREATMENT_ARTIFACT_SCHEMA) note('artifact schema is unsupported');
  if (!LOWER_SHA256_HEX.test(String(value?.bundleManifestHash ?? ''))) {
    note('bundle manifest digest is malformed');
  }
  const packageVerdict = harnessPackageIdentityVerdict(value?.harnessPackage, {
    expectedVersion: expectedHarnessVersion,
    maximumPackedSize,
    maximumUnpackedSize,
    maximumFileCount,
  });
  reasons.push(...packageVerdict.reasons);
  if (!exactObjectKeys(value?.conditionExposure, TREATMENT_EXPOSURE_FIELDS)) {
    note('condition exposure fields are missing or unexpected');
  }
  if (value?.conditionExposure?.generic !== false || value?.conditionExposure?.harness !== true) {
    note('condition exposure does not isolate the Harness from Generic');
  }
  if (reasons.length > 0) return { ok: false, artifact: null, artifactHash: null, reasons };
  const artifact = deepFreeze({
    schema: TREATMENT_ARTIFACT_SCHEMA,
    bundleManifestHash: value.bundleManifestHash,
    harnessPackage: { ...packageVerdict.packageIdentity },
    conditionExposure: { generic: false, harness: true },
  });
  return {
    ok: true,
    artifact,
    artifactHash: crypto.createHash('sha256').update(JSON.stringify(artifact)).digest('hex'),
    reasons: [],
  };
}

export function assertHarnessTreatmentArtifact(value, options = {}) {
  const { label = 'Harness treatment artifact', ...validation } = options;
  const verdict = harnessTreatmentArtifactVerdict(value, validation);
  if (!verdict.ok) throw new Error(`${label} is invalid (${verdict.reasons.join('; ')})`);
  return verdict;
}
