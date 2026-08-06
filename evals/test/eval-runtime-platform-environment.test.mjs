import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DAYTONA_PLATFORM_METADATA_ENVIRONMENT_NAMES,
  PlatformEnvironmentError,
  scrubDaytonaPlatformMetadata,
  scrubDaytonaPlatformMetadataInPlace,
} from '../runtime/platform-environment.mjs';

const SNAPSHOT_REFERENCE =
  `registry.daytona.invalid/snapshots/engineer-runtime:release-v1-${'a'.repeat(40)}`;
const DAYTONA_METADATA = Object.freeze({
  DAYTONA_ORGANIZATION_ID: '123e4567-e89b-42d3-a456-426614174000',
  DAYTONA_OTEL_ENDPOINT: 'https://telemetry.invalid',
  DAYTONA_REGION_ID: 'us',
  DAYTONA_SANDBOX_ID: '8d2890a2-57ef-4d75-91d5-2b0a81256b89',
  DAYTONA_SANDBOX_SNAPSHOT: SNAPSHOT_REFERENCE,
  DAYTONA_SANDBOX_USER: 'daytona',
});

test('scrubs exactly the six validated Daytona platform metadata variables', () => {
  assert.equal(Buffer.byteLength(SNAPSHOT_REFERENCE), 103);
  assert.deepEqual(DAYTONA_PLATFORM_METADATA_ENVIRONMENT_NAMES, Object.keys(DAYTONA_METADATA));
  assert.equal(Object.isFrozen(DAYTONA_PLATFORM_METADATA_ENVIRONMENT_NAMES), true);
  const source = {
    PATH: '/usr/bin:/bin',
    ...DAYTONA_METADATA,
    DAYTONA_UNKNOWN: 'must-reach-the-strict-check',
    OPENROUTER_API_KEY: 'must-also-reach-the-strict-check',
  };

  const scrubbed = scrubDaytonaPlatformMetadata(source);

  assert.equal(Object.getPrototypeOf(scrubbed), null);
  assert.equal(Object.isFrozen(scrubbed), true);
  assert.deepEqual(Object.keys(scrubbed).sort(), [
    'DAYTONA_UNKNOWN', 'OPENROUTER_API_KEY', 'PATH',
  ]);
  assert.equal(scrubbed.DAYTONA_UNKNOWN, source.DAYTONA_UNKNOWN);
  assert.equal(scrubbed.OPENROUTER_API_KEY, source.OPENROUTER_API_KEY);
  assert.deepEqual(Object.keys(source), [
    'PATH', ...DAYTONA_PLATFORM_METADATA_ENVIRONMENT_NAMES,
    'DAYTONA_UNKNOWN', 'OPENROUTER_API_KEY',
  ]);
});

test('accepts bounded Daytona snapshot references but keeps OTEL credential-free HTTPS', () => {
  assert.doesNotThrow(() => scrubDaytonaPlatformMetadata({
    DAYTONA_SANDBOX_SNAPSHOT:
      `registry.daytona.invalid/snapshots/runtime@sha256:${'a'.repeat(64)}`,
    DAYTONA_OTEL_ENDPOINT: 'https://telemetry.daytona.invalid/v1/traces',
  }));
  for (const value of [
    'snapshot reference with whitespace',
    `registry.daytona.invalid/snapshots/runtime:${'a'.repeat(500)}`,
  ]) {
    assert.throws(
      () => scrubDaytonaPlatformMetadata({ DAYTONA_SANDBOX_SNAPSHOT: value }),
      PlatformEnvironmentError,
    );
  }
  for (const value of [
    'http://telemetry.daytona.invalid',
    'https://user@telemetry.daytona.invalid',
    'https://telemetry.daytona.invalid?token=present',
    'https://telemetry.daytona.invalid/#fragment',
  ]) {
    assert.throws(
      () => scrubDaytonaPlatformMetadata({ DAYTONA_OTEL_ENDPOINT: value }),
      PlatformEnvironmentError,
    );
  }
});

test('accepts Daytona sandbox-user metadata without treating it as the runtime uid', () => {
  for (const value of ['daytona', 'root']) {
    assert.doesNotThrow(() => scrubDaytonaPlatformMetadata({
      DAYTONA_SANDBOX_USER: value,
    }));
  }
  for (const value of ['runner', 'Daytona', 'daytona-admin']) {
    assert.throws(
      () => scrubDaytonaPlatformMetadata({ DAYTONA_SANDBOX_USER: value }),
      PlatformEnvironmentError,
    );
  }
});

test('in-place scrub validates then deletes exactly known metadata', () => {
  const environment = {
    PATH: '/usr/bin:/bin',
    ...DAYTONA_METADATA,
    DAYTONA_UNKNOWN: 'strict-check-must-see-this',
    OPENROUTER_API_KEY: 'strict-check-must-see-this-too',
  };
  const receipt = scrubDaytonaPlatformMetadataInPlace(environment);
  assert.deepEqual(receipt, {
    removed: DAYTONA_PLATFORM_METADATA_ENVIRONMENT_NAMES,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.removed), true);
  for (const name of DAYTONA_PLATFORM_METADATA_ENVIRONMENT_NAMES) {
    assert.equal(Object.hasOwn(environment, name), false);
  }
  assert.equal(environment.DAYTONA_UNKNOWN, 'strict-check-must-see-this');
  assert.equal(environment.OPENROUTER_API_KEY, 'strict-check-must-see-this-too');
  assert.equal(environment.PATH, '/usr/bin:/bin');
});

test('in-place scrub is transactional on validation or deletion preflight failure', () => {
  const invalid = { ...DAYTONA_METADATA, DAYTONA_SANDBOX_USER: 'invalid user' };
  const invalidBefore = Object.getOwnPropertyDescriptors(invalid);
  assert.throws(() => scrubDaytonaPlatformMetadataInPlace(invalid), PlatformEnvironmentError);
  assert.deepEqual(Object.getOwnPropertyDescriptors(invalid), invalidBefore);

  const undeletable = { ...DAYTONA_METADATA };
  Object.defineProperty(undeletable, 'DAYTONA_REGION_ID', {
    value: 'us', enumerable: true, writable: true, configurable: false,
  });
  const undeletableBefore = Object.getOwnPropertyDescriptors(undeletable);
  assert.throws(() => scrubDaytonaPlatformMetadataInPlace(undeletable), PlatformEnvironmentError);
  assert.deepEqual(Object.getOwnPropertyDescriptors(undeletable), undeletableBefore);
});

test('in-place scrub rolls back a runtime deletion failure', () => {
  const target = { ...DAYTONA_METADATA };
  let deletionCount = 0;
  const environment = new Proxy(target, {
    deleteProperty(object, name) {
      deletionCount += 1;
      if (deletionCount === 2) return false;
      return Reflect.deleteProperty(object, name);
    },
  });
  assert.throws(() => scrubDaytonaPlatformMetadataInPlace(environment), PlatformEnvironmentError);
  assert.deepEqual(target, DAYTONA_METADATA);
});

test('opaque token shapes cannot masquerade as safe-name metadata', () => {
  const opaqueValues = [
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzYW5kYm94In0.signature',
    'c2FuZGJveC1wbGF0Zm9ybS10b2tlbg==',
    'a'.repeat(64),
  ];
  for (const name of [
    'DAYTONA_ORGANIZATION_ID',
    'DAYTONA_REGION_ID',
    'DAYTONA_SANDBOX_ID',
    'DAYTONA_SANDBOX_SNAPSHOT',
    'DAYTONA_SANDBOX_USER',
  ]) {
    for (const value of opaqueValues) {
      assert.throws(
        () => scrubDaytonaPlatformMetadata({ ...DAYTONA_METADATA, [name]: value }),
        PlatformEnvironmentError,
      );
    }
  }
});

test('rejects unsafe metadata without disclosing its value', () => {
  const unsafeValues = [
    42,
    '',
    'contains\0nul',
    'contains\ncontrol',
    'sk-or-v1-secret-platform-metadata',
    'x'.repeat(4_097),
  ];
  for (const value of unsafeValues) {
    let observed;
    try {
      scrubDaytonaPlatformMetadata({ DAYTONA_SANDBOX_ID: value });
      assert.fail('unsafe Daytona metadata unexpectedly passed');
    } catch (error) {
      observed = error;
    }
    assert.ok(observed instanceof PlatformEnvironmentError);
    assert.equal(observed.code, 'ERR_PLATFORM_ENVIRONMENT');
    if (String(value).length > 3) {
      assert.equal(String(observed).includes(String(value)), false);
    }
  }
});

test('fails closed when the environment cannot be inspected', () => {
  assert.throws(() => scrubDaytonaPlatformMetadata(null), PlatformEnvironmentError);
  assert.throws(() => scrubDaytonaPlatformMetadata([]), PlatformEnvironmentError);
  assert.throws(
    () => scrubDaytonaPlatformMetadata(new Proxy({}, {
      ownKeys: () => { throw new Error('secret proxy detail'); },
    })),
    PlatformEnvironmentError,
  );
  const unreadable = {};
  Object.defineProperty(unreadable, 'DAYTONA_REGION_ID', {
    enumerable: true,
    get: () => { throw new Error('secret getter detail'); },
  });
  assert.throws(() => scrubDaytonaPlatformMetadata(unreadable), PlatformEnvironmentError);
});
