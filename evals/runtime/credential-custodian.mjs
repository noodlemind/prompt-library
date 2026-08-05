/**
 * External-controller custody for the paid evaluation provider credential.
 *
 * The custodian deliberately has a one-way lifecycle:
 * loaded -> preflight -> per-trial one-shot handoffs -> postflight -> disposed.
 * It retains the credential only as an owned mutable Buffer. Provider metadata
 * is projected to bounded integer evidence before it is retained.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const OPENROUTER_KEY_METADATA_ENDPOINT = 'https://openrouter.ai/api/v1/key';
export const PROVIDER_KEY_FINGERPRINT_DOMAIN = 'engineer-harness/openrouter-key/v1\0';

/**
 * Preflight allowance and postflight allowance may each be independently
 * rounded to the nearest microusd. Runtime spend is conservatively rounded up
 * once per issued trial. The reconciliation tolerance is therefore this
 * two-microusd base plus at most one microusd for each issued trial.
 */
export const ALLOWANCE_RECONCILIATION_TOLERANCE_MICROUSD = 2;

const DEFAULT_MAX_KEY_BYTES = 1_024;
const MAX_CONFIGURED_KEY_BYTES = 8_192;
const MAX_METADATA_RESPONSE_CHARS = 64 * 1_024;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBE_TIMEOUT_MS = 2 * 60_000;
const MAX_METADATA_MICROUSD = 10_000_000_000;
const RELEASE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TRIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export class ProviderCredentialCustodianError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderCredentialCustodianError';
    this.code = code;
  }
}

function fault(code, message) {
  return new ProviderCredentialCustodianError(code, message);
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw fault('INVALID_ARGUMENT', `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function checkedInstant(clock) {
  const raw = clock.now();
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw fault('INVALID_CLOCK', 'provider credential clock returned an invalid instant');
  }
  return date.toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateConstructorOptions({ keyFd, releaseSha, maxKeyBytes, probeTimeoutMs, io, fetchImpl, clock }) {
  integer(keyFd, 'provider key descriptor', { min: 3 });
  if (typeof releaseSha !== 'string' || !RELEASE_SHA.test(releaseSha)) {
    throw fault('INVALID_RELEASE_SHA', 'release SHA must be a lowercase 40- or 64-character hexadecimal digest');
  }
  integer(maxKeyBytes, 'provider key byte bound', { min: 8, max: MAX_CONFIGURED_KEY_BYTES });
  integer(probeTimeoutMs, 'provider metadata timeout', { min: 1, max: MAX_PROBE_TIMEOUT_MS });
  for (const method of ['fstatSync', 'readSync', 'closeSync']) {
    if (typeof io?.[method] !== 'function') {
      throw fault('INVALID_IO', `provider credential IO is missing ${method}`);
    }
  }
  if (typeof fetchImpl !== 'function') {
    throw fault('INVALID_FETCH', 'provider metadata fetch implementation is required');
  }
  if (typeof clock?.now !== 'function') {
    throw fault('INVALID_CLOCK', 'provider credential clock must expose now()');
  }
}

function validateCredentialBytes(bytes) {
  if (bytes.length === 0) {
    throw fault('EMPTY_PROVIDER_KEY', 'provider key must not be empty');
  }
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fault('INVALID_PROVIDER_KEY_ENCODING', 'provider key must contain valid UTF-8');
  }
  if (CONTROL_CHARACTERS.test(decoded)) {
    throw fault('INVALID_PROVIDER_KEY_CONTROL', 'provider key must not contain control characters');
  }
  if (decoded.trim() !== decoded) {
    throw fault('INVALID_PROVIDER_KEY_WHITESPACE', 'provider key must not contain leading or trailing whitespace');
  }
}

/**
 * Transfer one inherited FIFO/socket descriptor into one mutable owned Buffer.
 * The descriptor is closed exactly once on every path after ownership transfer.
 */
function readOwnedInheritedCredential({ descriptor, maxBytes, io }) {
  const scratch = Buffer.alloc(maxBytes + 1);
  let owned = null;
  try {
    const stat = io.fstatSync(descriptor);
    if (!stat || (typeof stat.isFIFO !== 'function') || (typeof stat.isSocket !== 'function') ||
        (!stat.isFIFO() && !stat.isSocket())) {
      throw fault('INVALID_PROVIDER_KEY_DESCRIPTOR', 'provider key descriptor must be an inherited pipe or socket');
    }

    let used = 0;
    while (used < scratch.length) {
      const count = io.readSync(descriptor, scratch, used, scratch.length - used, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > scratch.length - used) {
        throw fault('INVALID_PROVIDER_KEY_READ', 'provider key descriptor returned an invalid byte count');
      }
      if (count === 0) break;
      used += count;
    }
    if (used > maxBytes) {
      throw fault('OVERSIZED_PROVIDER_KEY', 'provider key exceeds the inherited descriptor byte bound');
    }
    validateCredentialBytes(scratch.subarray(0, used));
    owned = Buffer.alloc(used);
    scratch.copy(owned, 0, 0, used);
    return owned;
  } catch (error) {
    owned?.fill(0);
    throw error;
  } finally {
    scratch.fill(0);
    try {
      io.closeSync(descriptor);
    } catch {
      owned?.fill(0);
      throw fault('PROVIDER_KEY_CLOSE_FAILED', 'provider key descriptor could not be closed exactly once');
    }
  }
}

function releaseFingerprint(keyBytes, releaseSha) {
  return crypto.createHmac('sha256', keyBytes)
    .update(PROVIDER_KEY_FINGERPRINT_DOMAIN)
    .update(releaseSha)
    .digest('hex');
}

/** Round a bounded non-negative decimal USD amount to integer microusd. */
function usdToMicrousd(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'number' && !Number.isFinite(value))) {
    throw fault('INVALID_PROVIDER_METADATA', `${label} must be a bounded non-negative USD amount`);
  }
  const text = String(value);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/.exec(text);
  if (!match) {
    throw fault('INVALID_PROVIDER_METADATA', `${label} must be a bounded non-negative USD amount`);
  }
  const fraction = (match[2] ?? '').padEnd(7, '0');
  let micros = BigInt(match[1]) * 1_000_000n + BigInt(fraction.slice(0, 6) || '0');
  if (Number(fraction[6] ?? '0') >= 5) micros += 1n;
  if (micros > BigInt(MAX_METADATA_MICROUSD)) {
    throw fault('INVALID_PROVIDER_METADATA', `${label} exceeds the bounded metadata range`);
  }
  return Number(micros);
}

function sanitizedReset(value) {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return 'configured';
  throw fault('INVALID_PROVIDER_METADATA', 'provider limit reset metadata is invalid');
}

function parseMetadataResponse(text, phase, checkedAt) {
  if (typeof text !== 'string' || text.length > MAX_METADATA_RESPONSE_CHARS) {
    throw fault('INVALID_PROVIDER_METADATA', 'provider key metadata response exceeds its character bound');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fault('INVALID_PROVIDER_METADATA', 'provider key metadata response is not valid JSON');
  }
  const data = parsed?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw fault('INVALID_PROVIDER_METADATA', 'provider key metadata response is missing data');
  }
  const limitMicrousd = usdToMicrousd(data.limit, 'provider limit');
  const limitRemainingMicrousd = usdToMicrousd(data.limit_remaining, 'provider remaining allowance');
  if (limitRemainingMicrousd > limitMicrousd) {
    throw fault('INVALID_PROVIDER_METADATA', 'provider remaining allowance exceeds its hard limit');
  }
  return deepFreeze({
    schema: 'engineer-openrouter-key-metadata.v1',
    phase,
    checkedAt,
    limitMicrousd,
    limitRemainingMicrousd,
    reset: sanitizedReset(data.limit_reset),
  });
}

async function boundedResponseText(response) {
  if (typeof response?.text !== 'function') {
    throw fault('INVALID_PROVIDER_METADATA', 'provider key metadata response has no bounded text reader');
  }
  return response.text();
}

/**
 * Create the external release controller's one-shot provider-key custodian.
 * Trial credential Buffers are caller-owned and must be zeroed immediately
 * after their single inherited-descriptor handoff to the isolated broker.
 */
export function createProviderCredentialCustodian({
  keyFd,
  releaseSha,
  maxKeyBytes = DEFAULT_MAX_KEY_BYTES,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  io = fs,
  fetchImpl = globalThis.fetch,
  clock = { now: () => new Date() },
} = {}) {
  validateConstructorOptions({ keyFd, releaseSha, maxKeyBytes, probeTimeoutMs, io, fetchImpl, clock });
  let ownerBytes = readOwnedInheritedCredential({ descriptor: keyFd, maxBytes: maxKeyBytes, io });
  const keyFingerprint = releaseFingerprint(ownerBytes, releaseSha);
  const issuedTrialIds = new Set();
  let state = 'loaded';
  let keyMaterialDisposed = false;
  let preflightEvidence = null;
  let postflightEvidence = null;
  let reconciliationEvidence = null;
  let failureCode = null;

  function disposeKeyMaterial() {
    if (keyMaterialDisposed) return false;
    ownerBytes.fill(0);
    ownerBytes = null;
    keyMaterialDisposed = true;
    return true;
  }

  function assertUsable(action) {
    if (state === 'disposed') throw fault('CREDENTIAL_DISPOSED', `provider credential is disposed and cannot ${action}`);
    if (state === 'failed') throw fault('CREDENTIAL_FAILED', `provider credential failed closed and cannot ${action}`);
  }

  function failClosed(code, message) {
    failureCode = code;
    state = 'failed';
    disposeKeyMaterial();
    throw fault(code, message);
  }

  async function probe(phase) {
    let keyText = null;
    let authorization = null;
    const controller = new AbortController();
    let timer = null;
    try {
      keyText = ownerBytes.toString('utf8');
      authorization = `Bearer ${keyText}`;
      const request = (async () => {
        const response = await fetchImpl(OPENROUTER_KEY_METADATA_ENDPOINT, {
          method: 'GET',
          headers: { authorization },
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (!response?.ok) {
          const status = Number.isSafeInteger(response?.status) ? response.status : 'error';
          throw fault('PROVIDER_METADATA_HTTP', `provider key metadata probe returned HTTP ${status}`);
        }
        const text = await boundedResponseText(response);
        return parseMetadataResponse(text, phase, checkedInstant(clock));
      })();
      return await Promise.race([
        request,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(fault('PROVIDER_METADATA_TIMEOUT', 'provider key metadata probe timed out'));
          }, probeTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      authorization = null;
      keyText = null;
    }
  }

  async function preflight() {
    assertUsable('run preflight');
    if (state !== 'loaded') {
      throw fault('PREFLIGHT_ALREADY_USED', 'provider key metadata preflight already completed or is in progress');
    }
    state = 'probing-preflight';
    try {
      preflightEvidence = await probe('preflight');
      state = 'ready';
      return preflightEvidence;
    } catch (error) {
      const code = error instanceof ProviderCredentialCustodianError
        ? error.code
        : 'PROVIDER_METADATA_PROBE_FAILED';
      const message = error instanceof ProviderCredentialCustodianError
        ? error.message
        : 'provider key metadata preflight failed';
      return failClosed(code, message);
    }
  }

  function issueTrialCredential(trialId) {
    assertUsable('issue a trial credential');
    if (state !== 'ready') {
      const reason = state === 'reconciled'
        ? 'provider postflight already completed'
        : 'provider preflight must complete before a trial credential is issued';
      throw fault('INVALID_CREDENTIAL_STATE', reason);
    }
    if (typeof trialId !== 'string' || !TRIAL_ID.test(trialId)) {
      throw fault('INVALID_TRIAL_ID', 'trial ID must be a bounded safe identifier');
    }
    if (issuedTrialIds.has(trialId)) {
      throw fault('TRIAL_CREDENTIAL_ALREADY_ISSUED', `provider credential was already issued for trial ${trialId}`);
    }
    issuedTrialIds.add(trialId);
    const copy = Buffer.alloc(ownerBytes.length);
    ownerBytes.copy(copy);
    return copy;
  }

  async function postflight({ sessionSpentMicrousd } = {}) {
    integer(sessionSpentMicrousd, 'session spent microusd', { max: MAX_METADATA_MICROUSD });
    assertUsable('run postflight');
    if (state !== 'ready') {
      const reason = state === 'reconciled'
        ? 'provider metadata postflight already completed'
        : 'provider metadata preflight must complete before postflight';
      throw fault('INVALID_CREDENTIAL_STATE', reason);
    }
    state = 'probing-postflight';
    try {
      postflightEvidence = await probe('postflight');
      const observedAllowanceDeltaMicrousd =
        preflightEvidence.limitRemainingMicrousd - postflightEvidence.limitRemainingMicrousd;
      const differenceMicrousd = Math.abs(observedAllowanceDeltaMicrousd - sessionSpentMicrousd);
      const allowanceDidNotIncrease = observedAllowanceDeltaMicrousd >= 0;
      const hardLimitStable = preflightEvidence.limitMicrousd === postflightEvidence.limitMicrousd;
      const resetStable = preflightEvidence.reset === postflightEvidence.reset;
      const toleranceMicrousd = ALLOWANCE_RECONCILIATION_TOLERANCE_MICROUSD +
        Math.max(0, issuedTrialIds.size - 1);
      const verified = allowanceDidNotIncrease && hardLimitStable && resetStable &&
        differenceMicrousd <= toleranceMicrousd;
      reconciliationEvidence = deepFreeze({
        schema: 'engineer-openrouter-allowance-reconciliation.v1',
        verified,
        preflightRemainingMicrousd: preflightEvidence.limitRemainingMicrousd,
        postflightRemainingMicrousd: postflightEvidence.limitRemainingMicrousd,
        observedAllowanceDeltaMicrousd,
        sessionSpentMicrousd,
        differenceMicrousd,
        toleranceMicrousd,
      });
      if (!allowanceDidNotIncrease) {
        return failClosed('PROVIDER_ALLOWANCE_INCREASED', 'provider remaining allowance increased during the release session');
      }
      if (!hardLimitStable || !resetStable) {
        return failClosed('PROVIDER_LIMIT_DRIFT', 'provider key limit policy changed during the release session');
      }
      if (!verified) {
        return failClosed(
          'PROVIDER_ALLOWANCE_MISMATCH',
          'provider allowance delta does not reconcile with session spent microusd'
        );
      }
      state = 'reconciled';
      return reconciliationEvidence;
    } catch (error) {
      if (state === 'failed') throw error;
      const code = error instanceof ProviderCredentialCustodianError
        ? error.code
        : 'PROVIDER_METADATA_PROBE_FAILED';
      const message = error instanceof ProviderCredentialCustodianError
        ? error.message
        : 'provider key metadata postflight failed';
      return failClosed(code, message);
    }
  }

  function keyFingerprintOf() {
    assertUsable('return its fingerprint');
    return keyFingerprint;
  }

  function dispose() {
    const changed = disposeKeyMaterial();
    if (state !== 'failed') state = 'disposed';
    return changed;
  }

  function snapshot() {
    return deepFreeze({
      schema: 'engineer-provider-credential-custodian-snapshot.v1',
      state,
      releaseSha,
      keyFingerprint,
      keyMaterialDisposed,
      issuedTrialCount: issuedTrialIds.size,
      preflight: preflightEvidence,
      postflight: postflightEvidence,
      reconciliation: reconciliationEvidence,
      ...(failureCode ? { failureCode } : {}),
    });
  }

  return Object.freeze({
    keyFingerprint: keyFingerprintOf,
    preflight,
    issueTrialCredential,
    postflight,
    snapshot,
    dispose,
  });
}
