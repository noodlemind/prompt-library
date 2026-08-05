import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildControlledProviderBrokerPolicy,
  controlledProviderBrokerStaticPolicyHash,
  getControlledOpenRouterProfile,
} from '../../../evals/runtime/controlled-provider-policy.mjs';
import { getProfile } from '../../../evals/lib/model-profiles.mjs';
import { providerBrokerStaticPolicyHash } from '../../../evals/runtime/provider-broker.mjs';

const HASH = (character) => character.repeat(64);

test('one code-owned profile drives both model telemetry and the runtime broker policy', () => {
  const runtime = getControlledOpenRouterProfile('kimi-k2.7-code');
  const model = getProfile('kimi-k2.7-code');
  assert.deepEqual(runtime, model);
  assert.equal(runtime.provider.allowFallbacks, false);
  assert.deepEqual(runtime.provider.expectedResolvedModels, [runtime.catalogPin.canonicalSlug]);

  const policy = buildControlledProviderBrokerPolicy({
    profileId: runtime.id,
    sessionCeilingMicrousd: 1_300_000,
    trial: {
      leaseId: 'engineer-lease-1',
      leaseDigest: HASH('0'),
      trialId: 'trial-1',
      leaseSequence: 2,
      trialCeilingMicrousd: 650_000,
    },
  });
  assert.equal(policy.endpoint, runtime.url);
  assert.equal(policy.model, runtime.model);
  assert.deepEqual(policy.provider, runtime.provider);
  assert.deepEqual(policy.pricing, runtime.pricing);
  assert.equal(policy.sessionCeilingUsd, 1.3);
  assert.equal(policy.trials[0].ceilingUsd, 0.65);
  assert.equal(
    controlledProviderBrokerStaticPolicyHash({
      profileId: runtime.id,
      sessionCeilingMicrousd: 1_300_000,
    }),
    providerBrokerStaticPolicyHash(policy),
  );
});

test('runtime provider policy rejects unknown profiles and inexact budget bindings', () => {
  assert.throws(
    () => controlledProviderBrokerStaticPolicyHash({
      profileId: 'unknown',
      sessionCeilingMicrousd: 1_300_000,
    }),
    /unknown|profile/i,
  );
  assert.throws(
    () => buildControlledProviderBrokerPolicy({
      profileId: 'kimi-k2.7-code',
      sessionCeilingMicrousd: 1_300_000,
      trial: {
        leaseId: 'engineer-lease-1',
        leaseDigest: HASH('0'),
        trialId: 'trial-1',
        leaseSequence: 2,
        trialCeilingMicrousd: 650_000.5,
      },
    }),
    /microusd|integer|budget/i,
  );
  assert.throws(
    () => buildControlledProviderBrokerPolicy({
      profileId: 'kimi-k2.7-code',
      sessionCeilingMicrousd: 10_000_000,
      trial: {
        leaseId: 'engineer-lease-1',
        leaseDigest: HASH('0'),
        trialId: 'trial-1',
        leaseSequence: 2,
        trialCeilingMicrousd: 5_000_001,
      },
    }),
    /profile|trial.*ceiling|budget/i,
  );
});
