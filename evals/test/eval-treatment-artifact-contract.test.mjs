import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  TREATMENT_ARTIFACT_JSON_SCHEMA,
  assertHarnessPackageIdentity,
  harnessTreatmentArtifactVerdict,
} from '../lib/treatment-artifact.mjs';
import { BUNDLE_SOURCE_PATHS } from '../external/terminal_bench/provision.mjs';
import { HARNESS_ASSET_SOURCE_PATHS } from '../../scripts/harness-asset-contract.mjs';

const REPORT_SCHEMA = JSON.parse(
  fs.readFileSync(new URL('../schema/eval-report.v2.schema.json', import.meta.url), 'utf8'),
);

function packageIdentity(overrides = {}) {
  return {
    name: '@dev-kit/harness',
    version: '0.5.0+release.1',
    sha256: '1'.repeat(64),
    integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
    packedSize: 12_345,
    unpackedSize: 67_890,
    fileCount: 321,
    lockfileSha256: '3'.repeat(64),
    ...overrides,
  };
}

test('the report schema is the code-owned treatment contract, not a fourth handwritten copy', () => {
  assert.deepEqual(REPORT_SCHEMA.properties.treatmentArtifact, TREATMENT_ARTIFACT_JSON_SCHEMA);
});

test('the evaluated source snapshot derives every shipped asset input from the builder contract', () => {
  for (const source of HARNESS_ASSET_SOURCE_PATHS) {
    assert.equal(BUNDLE_SOURCE_PATHS.includes(source), true, `eval snapshot omits package input: ${source}`);
  }
  assert.equal(BUNDLE_SOURCE_PATHS.includes('scripts/harness-asset-contract.mjs'), true);
  assert.equal(BUNDLE_SOURCE_PATHS.includes('scripts/build-harness-assets.mjs'), true);
  assert.equal(
    BUNDLE_SOURCE_PATHS.includes('evals/runtime'),
    true,
    'the archived bridge must include its runtime import closure',
  );
});

test('package identity validation shares canonical version, SRI, and boundary rules', () => {
  assert.deepEqual(
    assertHarnessPackageIdentity(packageIdentity(), {
      expectedVersion: '0.5.0+release.1',
      maximumPackedSize: 20_000,
      maximumUnpackedSize: 100_000,
      maximumFileCount: 1_000,
    }),
    packageIdentity(),
  );
  assert.throws(() => assertHarnessPackageIdentity(packageIdentity({ version: 'bad version' })), /version/i);
  assert.throws(() => assertHarnessPackageIdentity(packageIdentity({ integrity: 'sha512-YQ==' })), /integrity/i);
  const canonicalZeroDigest = `sha512-${Buffer.alloc(64).toString('base64')}`;
  const noncanonicalPaddingBits = `${canonicalZeroDigest.slice(0, -3)}B==`;
  assert.deepEqual(
    Buffer.from(noncanonicalPaddingBits.slice('sha512-'.length), 'base64'),
    Buffer.from(canonicalZeroDigest.slice('sha512-'.length), 'base64'),
  );
  assert.equal(
    new RegExp(TREATMENT_ARTIFACT_JSON_SCHEMA.properties.harnessPackage.properties.integrity.pattern)
      .test(noncanonicalPaddingBits),
    false,
  );
  assert.throws(
    () => assertHarnessPackageIdentity(packageIdentity({ integrity: noncanonicalPaddingBits })),
    /integrity/i,
  );
  assert.throws(
    () => assertHarnessPackageIdentity(packageIdentity({ packedSize: 20_001 }), { maximumPackedSize: 20_000 }),
    /packedSize/i,
  );
});

test('artifact validation returns one canonical projection and stable binding hash', () => {
  const artifact = {
    schema: 'engineer-harness-treatment-artifact.v1',
    bundleManifestHash: '4'.repeat(64),
    harnessPackage: packageIdentity(),
    conditionExposure: { generic: false, harness: true },
  };
  const first = harnessTreatmentArtifactVerdict(artifact, { expectedHarnessVersion: '0.5.0+release.1' });
  const second = harnessTreatmentArtifactVerdict(structuredClone(artifact), {
    expectedHarnessVersion: '0.5.0+release.1',
  });
  assert.equal(first.ok, true, first.reasons.join('; '));
  assert.deepEqual(first.artifact, artifact);
  assert.match(first.artifactHash, /^[a-f0-9]{64}$/);
  assert.equal(first.artifactHash, second.artifactHash);

  artifact.conditionExposure.generic = true;
  assert.equal(harnessTreatmentArtifactVerdict(artifact).ok, false);
});
