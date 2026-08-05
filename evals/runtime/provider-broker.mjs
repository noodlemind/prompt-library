/**
 * Privilege-separated OpenRouter broker for paid release evaluations.
 *
 * The broker is intentionally a small, Node-built-in-only process boundary.
 * Its caller supplies prompts over an owner-only Unix socket, but never sees
 * the provider credential. The broker, rather than the caller, constructs the
 * exact pinned provider request, reserves budget atomically, and retains only
 * bounded non-prompt billing evidence.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const PROVIDER_BROKER_PROTOCOL_VERSION = 1;

const EXACT_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000;
const MAX_SESSION_CEILING_USD = 20;
const USD_EPSILON = 1e-12;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const POLICY_FIELDS = [
  'endpoint',
  'model',
  'provider',
  'settings',
  'maxTokens',
  'pricing',
  'sessionCeilingUsd',
  'trials',
];
const REQUEST_FIELDS = [
  'version',
  'type',
  'leaseId',
  'leaseDigest',
  'trialId',
  'leaseSequence',
  'sequence',
  'attemptId',
  'endpoint',
  'model',
  'provider',
  'settings',
  'maxTokens',
  'messages',
  'tools',
];
const EVIDENCE_REQUEST_FIELDS = ['version', 'type', 'nonce'];
const EVIDENCE_RESPONSE_FIELDS = ['version', 'type', 'ok', 'nonce', 'snapshot', 'snapshotHash'];
const EVIDENCE_NONCE_PATTERN = /^[a-f0-9]{32}$/;

class BrokerFault extends Error {
  constructor(kind, reason, { billingUncertain = false } = {}) {
    super(reason);
    this.name = 'BrokerFault';
    this.kind = kind;
    this.reason = reason;
    this.billingUncertain = billingUncertain;
  }
}

function record(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields, label) {
  if (!record(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = fields.slice().sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} fields must exactly match the bounded schema`);
  }
}

function finiteNonnegative(value, label, { positive = false, max = Number.MAX_VALUE } = {}) {
  const valid = typeof value === 'number' && Number.isFinite(value) &&
    value >= (positive ? Number.MIN_VALUE : 0) && value <= max;
  if (!valid) throw new Error(`${label} must be a ${positive ? 'positive' : 'non-negative'} bounded number`);
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
}

function boundedString(value, label, { min = 0, max = 4096, pattern = null } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max ||
      value.includes('\u0000') || (pattern && !pattern.test(value))) {
    throw new Error(`${label} must be a bounded string`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable hash used by the root evidence collector to verify one live broker snapshot. */
export function providerBrokerEvidenceHash(snapshot) {
  if (!record(snapshot)) throw new Error('provider broker evidence snapshot must be an object');
  validateJsonData(snapshot, 'provider broker evidence snapshot');
  const serialized = canonicalJson(snapshot);
  if (Buffer.byteLength(serialized, 'utf8') > DEFAULT_MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error('provider broker evidence snapshot exceeds its byte bound');
  }
  return crypto.createHash('sha256')
    .update('engineer-provider-broker-evidence.v1\0')
    .update(serialized)
    .digest('hex');
}

function roundedUsd(value) {
  return Number(value.toFixed(12));
}

function validateOwnedProviderKeyBytes(value) {
  if (!Buffer.isBuffer(value)) {
    throw new Error('providerKeyBytes must be an owned mutable Buffer');
  }
  if (value.length < 8 || value.length > 512) {
    throw new Error('providerKeyBytes must contain between 8 and 512 bytes');
  }
  for (const byte of value) {
    if (byte < 0x21 || byte > 0x7e) {
      throw new Error('providerKeyBytes must contain printable ASCII without whitespace or line breaks');
    }
  }
  return value;
}

function stringContainsExactSecret(value, secretBytes) {
  if (secretBytes.length === 0) return false;
  const bytes = Buffer.from(value, 'utf8');
  try {
    return bytes.indexOf(secretBytes) !== -1;
  } finally {
    bytes.fill(0);
  }
}

function containsExactSecret(value, secretBytes) {
  if (!secretBytes || secretBytes.length === 0) return false;
  if (typeof value === 'string') return stringContainsExactSecret(value, secretBytes);
  if (Array.isArray(value)) return value.some((item) => containsExactSecret(item, secretBytes));
  if (record(value)) {
    return Object.entries(value).some(([key, item]) =>
      stringContainsExactSecret(key, secretBytes) || containsExactSecret(item, secretBytes));
  }
  return false;
}

function redactSecretFromString(value, secretBytes) {
  if (secretBytes.length === 0) return value;
  const source = Buffer.from(value, 'utf8');
  let sanitized = null;
  try {
    let cursor = 0;
    let index = source.indexOf(secretBytes, cursor);
    if (index === -1) return value;
    const replacement = Buffer.from('[REDACTED_PROVIDER_KEY]', 'utf8');
    const parts = [];
    while (index !== -1) {
      parts.push(source.subarray(cursor, index), replacement);
      cursor = index + secretBytes.length;
      index = source.indexOf(secretBytes, cursor);
    }
    parts.push(source.subarray(cursor));
    sanitized = Buffer.concat(parts);
    return sanitized.toString('utf8');
  } finally {
    source.fill(0);
    sanitized?.fill(0);
  }
}

function redactExactSecret(value, secretBytes) {
  if (!secretBytes || secretBytes.length === 0) return jsonClone(value);
  if (typeof value === 'string') return redactSecretFromString(value, secretBytes);
  if (Array.isArray(value)) return value.map((item) => redactExactSecret(item, secretBytes));
  if (record(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactSecretFromString(key, secretBytes),
      redactExactSecret(item, secretBytes),
    ]));
  }
  return value;
}

function providerAuthorizationHeader(providerKeyBytes) {
  const prefix = Buffer.from('Bearer ', 'ascii');
  const header = Buffer.allocUnsafe(prefix.length + providerKeyBytes.length);
  try {
    prefix.copy(header);
    providerKeyBytes.copy(header, prefix.length);
    return header.toString('ascii');
  } finally {
    prefix.fill(0);
    header.fill(0);
  }
}

function validateJsonData(value, label, { depth = 0, nodes = { count: 0 } } = {}) {
  nodes.count += 1;
  if (nodes.count > 4096 || depth > 16) throw new Error(`${label} exceeds structural bounds`);
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    boundedString(value, label, { max: 65_536 });
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} contains an oversized array`);
    for (const item of value) validateJsonData(item, label, { depth: depth + 1, nodes });
    return;
  }
  if (record(value)) {
    if (Object.keys(value).length > 256) throw new Error(`${label} contains an oversized object`);
    for (const [key, item] of Object.entries(value)) {
      boundedString(key, `${label} key`, { min: 1, max: 256 });
      validateJsonData(item, label, { depth: depth + 1, nodes });
    }
    return;
  }
  throw new Error(`${label} must contain JSON data only`);
}

function validateProvider(provider, label) {
  exactKeys(provider, ['order', 'expectedResolvedNames', 'allowFallbacks'], label);
  if (!Array.isArray(provider.order) || provider.order.length !== 1) {
    throw new Error(`${label}.order must pin exactly one endpoint`);
  }
  if (!Array.isArray(provider.expectedResolvedNames) || provider.expectedResolvedNames.length !== 1) {
    throw new Error(`${label}.expectedResolvedNames must pin exactly one identity`);
  }
  boundedString(provider.order[0], `${label}.order[0]`, { min: 1, max: 256, pattern: SLUG_PATTERN });
  boundedString(provider.expectedResolvedNames[0], `${label}.expectedResolvedNames[0]`, { min: 1, max: 128 });
  if (provider.allowFallbacks !== false) throw new Error(`${label} must disable fallback`);
}

function validateSettings(settings, label) {
  exactKeys(settings, ['temperature', 'reasoning', 'toolChoice'], label);
  if (settings.temperature !== null) finiteNonnegative(settings.temperature, `${label}.temperature`, { max: 2 });
  if (settings.reasoning !== null) validateJsonData(settings.reasoning, `${label}.reasoning`);
  if (!['auto', 'none', 'required'].includes(settings.toolChoice)) {
    throw new Error(`${label}.toolChoice is not allowed`);
  }
}

function validatePricing(pricing) {
  exactKeys(pricing, ['inputPerM', 'cachedInputPerM', 'outputPerM'], 'policy.pricing');
  for (const field of ['inputPerM', 'cachedInputPerM', 'outputPerM']) {
    finiteNonnegative(pricing[field], `policy.pricing.${field}`, { max: 1000 });
  }
  if (pricing.inputPerM === 0 && pricing.cachedInputPerM === 0 && pricing.outputPerM === 0) {
    throw new Error('provider broker requires a paid pricing profile');
  }
}

function validateTrialBinding(binding, index, sessionCeilingUsd) {
  const label = `policy.trials[${index}]`;
  exactKeys(binding, ['leaseId', 'leaseDigest', 'trialId', 'leaseSequence', 'ceilingUsd'], label);
  boundedString(binding.leaseId, `${label}.leaseId`, { min: 1, max: 128, pattern: ID_PATTERN });
  boundedString(binding.trialId, `${label}.trialId`, { min: 1, max: 128, pattern: ID_PATTERN });
  boundedString(binding.leaseDigest, `${label}.leaseDigest`, { min: 64, max: 64, pattern: SHA256_PATTERN });
  safeInteger(binding.leaseSequence, `${label}.leaseSequence`, { min: 1, max: 1_000_000 });
  finiteNonnegative(binding.ceilingUsd, `${label}.ceilingUsd`, { positive: true, max: sessionCeilingUsd });
}

function validatePolicy(rawPolicy) {
  exactKeys(rawPolicy, POLICY_FIELDS, 'provider broker policy');
  if (rawPolicy.endpoint !== EXACT_OPENROUTER_ENDPOINT) {
    throw new Error('provider broker policy requires the exact OpenRouter HTTPS chat-completions endpoint');
  }
  let parsed;
  try {
    parsed = new URL(rawPolicy.endpoint);
  } catch {
    throw new Error('provider broker policy requires the exact OpenRouter HTTPS chat-completions endpoint');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'openrouter.ai' || parsed.port ||
      parsed.username || parsed.password || parsed.pathname !== '/api/v1/chat/completions' ||
      parsed.search || parsed.hash) {
    throw new Error('provider broker policy requires the exact OpenRouter HTTPS chat-completions endpoint');
  }
  boundedString(rawPolicy.model, 'policy.model', { min: 1, max: 256, pattern: SLUG_PATTERN });
  validateProvider(rawPolicy.provider, 'policy.provider');
  validateSettings(rawPolicy.settings, 'policy.settings');
  safeInteger(rawPolicy.maxTokens, 'policy.maxTokens', { min: 1, max: 65_536 });
  validatePricing(rawPolicy.pricing);
  finiteNonnegative(rawPolicy.sessionCeilingUsd, 'policy.sessionCeilingUsd', {
    positive: true,
    max: MAX_SESSION_CEILING_USD,
  });
  if (!Array.isArray(rawPolicy.trials) || rawPolicy.trials.length < 1 || rawPolicy.trials.length > 64) {
    throw new Error('policy.trials must contain between 1 and 64 bindings');
  }
  const bindingKeys = new Set();
  const trialIds = new Set();
  rawPolicy.trials.forEach((binding, index) => {
    validateTrialBinding(binding, index, rawPolicy.sessionCeilingUsd);
    const key = bindingKey(binding);
    if (bindingKeys.has(key) || trialIds.has(binding.trialId)) {
      throw new Error('policy.trials contains a duplicate binding or trial identity');
    }
    bindingKeys.add(key);
    trialIds.add(binding.trialId);
  });
  return deepFreeze(jsonClone(rawPolicy));
}

function staticPolicyProjection(policy) {
  const { trials: _dynamicTrialBindings, ...staticPolicy } = policy;
  return staticPolicy;
}

/** Hash safe to embed in a readiness lease before its final digest exists. */
export function providerBrokerStaticPolicyHash(rawPolicy) {
  const policy = validatePolicy(rawPolicy);
  return crypto.createHash('sha256')
    .update(canonicalJson(staticPolicyProjection(policy)))
    .digest('hex');
}

function bindingKey(value) {
  return [value.leaseId, value.leaseDigest, value.trialId, value.leaseSequence].join('|');
}

function validateMessage(message, index) {
  if (!record(message)) throw new Error(`messages[${index}] must be an object`);
  const allowed = new Set(['role', 'content', 'name', 'tool_call_id', 'tool_calls']);
  for (const key of Object.keys(message)) {
    if (!allowed.has(key)) throw new Error(`messages[${index}] contains an unexpected field`);
  }
  if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) {
    throw new Error(`messages[${index}].role is invalid`);
  }
  if (!(typeof message.content === 'string' || (message.role === 'assistant' && message.content === null))) {
    throw new Error(`messages[${index}].content must be bounded text or an assistant null`);
  }
  if (typeof message.content === 'string') {
    boundedString(message.content, `messages[${index}].content`, { max: 262_144 });
  }
  if (Object.hasOwn(message, 'name')) {
    boundedString(message.name, `messages[${index}].name`, { min: 1, max: 128, pattern: ID_PATTERN });
  }
  if (Object.hasOwn(message, 'tool_call_id')) {
    boundedString(message.tool_call_id, `messages[${index}].tool_call_id`, { min: 1, max: 128, pattern: ID_PATTERN });
  }
  if (Object.hasOwn(message, 'tool_calls')) validateToolCalls(message.tool_calls, `messages[${index}].tool_calls`);
}

function validateToolCalls(toolCalls, label) {
  if (!Array.isArray(toolCalls) || toolCalls.length > 64) throw new Error(`${label} must be a bounded array`);
  toolCalls.forEach((call, index) => {
    const itemLabel = `${label}[${index}]`;
    exactKeys(call, ['id', 'type', 'function'], itemLabel);
    boundedString(call.id, `${itemLabel}.id`, { min: 1, max: 128, pattern: ID_PATTERN });
    if (call.type !== 'function') throw new Error(`${itemLabel}.type must be function`);
    exactKeys(call.function, ['name', 'arguments'], `${itemLabel}.function`);
    boundedString(call.function.name, `${itemLabel}.function.name`, { min: 1, max: 128, pattern: ID_PATTERN });
    boundedString(call.function.arguments, `${itemLabel}.function.arguments`, { max: 262_144 });
  });
}

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length > 64) throw new Error('tools must be a bounded array');
  tools.forEach((tool, index) => {
    const label = `tools[${index}]`;
    exactKeys(tool, ['type', 'function'], label);
    if (tool.type !== 'function') throw new Error(`${label}.type must be function`);
    exactKeys(tool.function, ['name', 'description', 'parameters'], `${label}.function`);
    boundedString(tool.function.name, `${label}.function.name`, { min: 1, max: 128, pattern: ID_PATTERN });
    boundedString(tool.function.description, `${label}.function.description`, { max: 8192 });
    validateJsonData(tool.function.parameters, `${label}.function.parameters`);
  });
}

function validateRequestShape(request) {
  exactKeys(request, REQUEST_FIELDS, 'provider request');
  if (request.version !== PROVIDER_BROKER_PROTOCOL_VERSION || request.type !== 'provider-request') {
    throw new Error('provider request protocol version or type is invalid');
  }
  boundedString(request.leaseId, 'request.leaseId', { min: 1, max: 128, pattern: ID_PATTERN });
  boundedString(request.trialId, 'request.trialId', { min: 1, max: 128, pattern: ID_PATTERN });
  boundedString(request.leaseDigest, 'request.leaseDigest', { min: 64, max: 64, pattern: SHA256_PATTERN });
  boundedString(request.attemptId, 'request.attemptId', { min: 1, max: 128, pattern: ID_PATTERN });
  safeInteger(request.leaseSequence, 'request.leaseSequence', { min: 1, max: 1_000_000 });
  safeInteger(request.sequence, 'request.sequence', { min: 1, max: 1_000_000 });
  boundedString(request.endpoint, 'request.endpoint', { min: 1, max: 512 });
  boundedString(request.model, 'request.model', { min: 1, max: 256, pattern: SLUG_PATTERN });
  validateProvider(request.provider, 'request.provider');
  validateSettings(request.settings, 'request.settings');
  safeInteger(request.maxTokens, 'request.maxTokens', { min: 1, max: 65_536 });
  if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 256) {
    throw new Error('messages must contain between 1 and 256 entries');
  }
  request.messages.forEach(validateMessage);
  validateTools(request.tools);
}

function validateRequestPolicy(request, policy) {
  if (request.endpoint !== policy.endpoint || request.model !== policy.model ||
      request.maxTokens !== policy.maxTokens ||
      !isDeepStrictEqual(request.provider, policy.provider) ||
      !isDeepStrictEqual(request.settings, policy.settings)) {
    throw new BrokerFault('policy', 'request controls differ from the pinned provider policy');
  }
}

function providerBody(request, policy) {
  const body = {
    model: policy.model,
    messages: jsonClone(request.messages),
    tools: jsonClone(request.tools),
    tool_choice: policy.settings.toolChoice,
    max_tokens: policy.maxTokens,
    provider: {
      order: policy.provider.order.slice(),
      allow_fallbacks: false,
    },
  };
  if (policy.settings.temperature !== null) body.temperature = jsonClone(policy.settings.temperature);
  if (policy.settings.reasoning !== null) body.reasoning = jsonClone(policy.settings.reasoning);
  return body;
}

function calculateReservation(payload, policy) {
  const promptTokenUpperBound = Buffer.byteLength(payload, 'utf8');
  return roundedUsd(
    promptTokenUpperBound * policy.pricing.inputPerM / 1_000_000 +
    policy.maxTokens * policy.pricing.outputPerM / 1_000_000
  );
}

function usageEvidence(data, policy) {
  const usage = data?.usage;
  if (!record(usage) || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0 ||
      !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0 ||
      typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost < 0) {
    throw new BrokerFault('billing-uncertain', 'missing-or-malformed-provider-usage', { billingUncertain: true });
  }
  const reportedCached = usage.prompt_tokens_details?.cached_tokens;
  const cachedTokensComplete = Number.isSafeInteger(reportedCached) &&
    reportedCached >= 0 && reportedCached <= usage.prompt_tokens;
  const reportedReasoning = usage.completion_tokens_details?.reasoning_tokens;
  const reasoningTokensComplete = Number.isSafeInteger(reportedReasoning) &&
    reportedReasoning >= 0 && reportedReasoning <= usage.completion_tokens;
  const cachedTokensForCost = cachedTokensComplete ? reportedCached : 0;
  const localCostUsd = roundedUsd(
    (usage.prompt_tokens - cachedTokensForCost) * policy.pricing.inputPerM / 1_000_000 +
    cachedTokensForCost * policy.pricing.cachedInputPerM / 1_000_000 +
    usage.completion_tokens * policy.pricing.outputPerM / 1_000_000
  );
  const providerCostUsd = roundedUsd(usage.cost);
  return {
    promptTokens: usage.prompt_tokens,
    cachedTokens: cachedTokensComplete ? reportedCached : null,
    cachedTokensComplete,
    reasoningTokens: reasoningTokensComplete ? reportedReasoning : null,
    reasoningTokensComplete,
    outputTokens: usage.completion_tokens,
    localCostUsd,
    providerCostUsd,
    reconciledCostUsd: roundedUsd(Math.max(localCostUsd, providerCostUsd)),
  };
}

function providerIdentityDrift(data, policy) {
  if (data?.model !== policy.model) return 'resolved-model-drift';
  if (data?.provider !== policy.provider.expectedResolvedNames[0]) return 'resolved-provider-drift';
  return null;
}

function sanitizeAssistantMessage(data, secret) {
  const choice = Array.isArray(data?.choices) && data.choices.length > 0 ? data.choices[0] : null;
  const message = choice?.message;
  if (data?.error != null || choice?.error != null || choice?.finish_reason === 'error' || !record(message) ||
      message.role !== 'assistant') {
    return null;
  }
  const content = typeof message.content === 'string' ? message.content : message.content === null ? null : undefined;
  if (content === undefined || (typeof content === 'string' && content.length > 1_048_576)) return null;
  let toolCalls = [];
  if (message.tool_calls !== undefined) {
    try {
      validateToolCalls(message.tool_calls, 'provider message tool_calls');
      toolCalls = jsonClone(message.tool_calls);
    } catch {
      return null;
    }
  }
  if ((content == null || content.length === 0) && toolCalls.length === 0) return null;
  return {
    message: redactExactSecret({ role: 'assistant', content, tool_calls: toolCalls }, secret),
    finishReason: typeof choice.finish_reason === 'string' && choice.finish_reason.length <= 128
      ? choice.finish_reason
      : null,
  };
}

function attemptPublicEvidence(attempt) {
  return jsonClone(attempt);
}

function errorResponse(kind, reason, { billingUncertain = false, attempt = null } = {}) {
  return {
    version: PROVIDER_BROKER_PROTOCOL_VERSION,
    type: 'provider-response',
    ok: false,
    error: { kind, reason, billingUncertain },
    ...(attempt ? { evidence: attemptPublicEvidence(attempt) } : {}),
  };
}

function successResponse(attempt, output) {
  return {
    version: PROVIDER_BROKER_PROTOCOL_VERSION,
    type: 'provider-response',
    ok: true,
    attemptId: attempt.attemptId,
    message: output.message,
    finishReason: output.finishReason,
    evidence: attemptPublicEvidence(attempt),
  };
}

function normalizeClock(clock) {
  const now = typeof clock === 'function' ? clock : clock?.now;
  if (typeof now !== 'function') return { now: () => Date.now() };
  return {
    now() {
      const value = now();
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('provider broker clock returned an invalid timestamp');
      }
      return value;
    },
  };
}

function socketParentIsEligible(socketPath, clientGid) {
  const parent = path.dirname(socketPath);
  const stat = fs.lstatSync(parent);
  const uidMatches = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || !uidMatches) return false;
  if (clientGid == null) return (stat.mode & 0o077) === 0;
  return stat.gid === clientGid && (stat.mode & 0o7777) === 0o2710;
}

function providerResponseLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (raw == null || String(raw).trim() === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readProviderJson(response, maxBytes) {
  const declared = providerResponseLength(response);
  if (declared != null && declared > maxBytes) {
    throw new BrokerFault('billing-uncertain', 'oversized-provider-response', { billingUncertain: true });
  }
  if (typeof response?.text === 'function') {
    const text = await response.text();
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new BrokerFault('billing-uncertain', 'oversized-provider-response', { billingUncertain: true });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new BrokerFault('billing-uncertain', 'unparseable-provider-response', { billingUncertain: true });
    }
  }
  if (typeof response?.json !== 'function') {
    throw new BrokerFault('billing-uncertain', 'missing-provider-response-body', { billingUncertain: true });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new BrokerFault('billing-uncertain', 'unparseable-provider-response', { billingUncertain: true });
  }
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    throw new BrokerFault('billing-uncertain', 'unserializable-provider-response', { billingUncertain: true });
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new BrokerFault('billing-uncertain', 'oversized-provider-response', { billingUncertain: true });
  }
  return data;
}

/**
 * Construct a broker. The returned object deliberately has no credential
 * property and every outward-facing value is content-allowlisted.
 */
export function createProviderBroker({
  socketPath,
  providerKeyBytes,
  policy: rawPolicy,
  fetchImpl = globalThis.fetch,
  clock: rawClock = null,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  maxProviderResponseBytes = DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
  clientGid = null,
} = {}) {
  const keyBytes = providerKeyBytes;
  let policy;
  try {
    validateOwnedProviderKeyBytes(keyBytes);
    if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.length > 100) {
      throw new Error('provider broker socketPath must be a bounded absolute Unix socket path');
    }
    policy = validatePolicy(rawPolicy);
    if (containsExactSecret(policy, keyBytes)) throw new Error('provider key must not appear in broker policy');
    if (typeof fetchImpl !== 'function') throw new Error('provider broker fetch implementation is required');
    safeInteger(requestTimeoutMs, 'requestTimeoutMs', { min: 1, max: 60 * 60_000 });
    safeInteger(maxFrameBytes, 'maxFrameBytes', { min: 128, max: 8 * 1024 * 1024 });
    safeInteger(maxProviderResponseBytes, 'maxProviderResponseBytes', { min: 1024, max: 16 * 1024 * 1024 });
    if (clientGid != null) safeInteger(clientGid, 'clientGid', { max: 2 ** 31 - 1 });
  } catch (error) {
    if (Buffer.isBuffer(keyBytes)) keyBytes.fill(0);
    throw error;
  }

  const clock = normalizeClock(rawClock);
  const attempts = [];
  const attemptIds = new Set();
  const session = {
    ceilingUsd: policy.sessionCeilingUsd,
    knownActualUsd: 0,
    uncertainReservedUsd: 0,
    activeReservedUsd: 0,
    breached: false,
    blocked: false,
  };
  const trials = new Map(policy.trials.map((binding) => [bindingKey(binding), {
    binding,
    nextSequence: 1,
    knownActualUsd: 0,
    uncertainReservedUsd: 0,
    activeReservedUsd: 0,
    breached: false,
    blocked: false,
  }]));
  let server = null;
  let startPromise = null;
  let state = 'created';
  let socketIdentity = null;
  let keyDisposed = false;
  const connections = new Set();
  const respondedConnections = new WeakSet();

  function disposeProviderKey() {
    if (keyDisposed) return;
    keyBytes.fill(0);
    keyDisposed = true;
  }

  function exposure(ledger) {
    return roundedUsd(ledger.knownActualUsd + ledger.uncertainReservedUsd + ledger.activeReservedUsd);
  }

  function reserve(trial, usd) {
    if (session.blocked || trial.blocked || session.breached || trial.breached) {
      throw new BrokerFault('budget', 'provider budget is blocked by an earlier uncertain or breached attempt');
    }
    if (session.activeReservedUsd > USD_EPSILON) {
      throw new BrokerFault('budget', 'provider broker permits only one in-flight paid request');
    }
    const sessionNext = exposure(session) + usd;
    const trialNext = exposure(trial) + usd;
    if (sessionNext > session.ceilingUsd + USD_EPSILON || trialNext > trial.binding.ceilingUsd + USD_EPSILON) {
      throw new BrokerFault('budget', 'provider request reservation would cross a hard budget ceiling');
    }
    session.activeReservedUsd = roundedUsd(session.activeReservedUsd + usd);
    trial.activeReservedUsd = roundedUsd(trial.activeReservedUsd + usd);
  }

  function releaseActive(trial, usd) {
    session.activeReservedUsd = roundedUsd(Math.max(0, session.activeReservedUsd - usd));
    trial.activeReservedUsd = roundedUsd(Math.max(0, trial.activeReservedUsd - usd));
  }

  function settleKnown(trial, attempt, usage, outcome) {
    releaseActive(trial, attempt.reservedUsd);
    session.knownActualUsd = roundedUsd(session.knownActualUsd + usage.reconciledCostUsd);
    trial.knownActualUsd = roundedUsd(trial.knownActualUsd + usage.reconciledCostUsd);
    const underReserved = usage.reconciledCostUsd > attempt.reservedUsd + USD_EPSILON;
    session.breached = exposure(session) > session.ceilingUsd + USD_EPSILON || underReserved;
    trial.breached = exposure(trial) > trial.binding.ceilingUsd + USD_EPSILON || underReserved;
    if (session.breached || trial.breached) {
      session.blocked = true;
      trial.blocked = true;
    }
    Object.assign(attempt, {
      state: 'completed',
      outcome,
      completedAt: clock.now(),
      usage,
      actualCostUsd: usage.reconciledCostUsd,
      reservationUnderestimated: underReserved,
      budgetBreached: session.breached || trial.breached,
    });
  }

  function settleUncertain(trial, attempt, reason) {
    if (attempt.state !== 'started') return;
    releaseActive(trial, attempt.reservedUsd);
    // Once dispatch has occurred without complete billing evidence, reserve the
    // limiting ledger's entire remainder and stop. This mirrors the release
    // scheduler's fail-closed rule and prevents a later process from treating
    // apparently unused allowance as safe spend.
    const trialRemainder = Math.max(0, trial.binding.ceilingUsd - exposure(trial));
    const sessionRemainder = Math.max(0, session.ceilingUsd - exposure(session));
    const uncertainUsd = roundedUsd(Math.min(trialRemainder, sessionRemainder));
    session.uncertainReservedUsd = roundedUsd(session.uncertainReservedUsd + uncertainUsd);
    trial.uncertainReservedUsd = roundedUsd(trial.uncertainReservedUsd + uncertainUsd);
    session.blocked = true;
    trial.blocked = true;
    Object.assign(attempt, {
      state: 'billing-uncertain',
      outcome: 'billing-uncertain',
      completedAt: clock.now(),
      billingUncertainReason: reason,
      uncertainReservedUsd: uncertainUsd,
    });
  }

  function settleAnyActiveAttemptAsUncertain(reason) {
    for (const attempt of attempts) {
      if (attempt.state !== 'started') continue;
      const trial = trials.get(bindingKey(attempt));
      if (trial) settleUncertain(trial, attempt, reason);
    }
  }

  async function processRequest(request, lifecycle = {}) {
    if (keyDisposed || state !== 'running') {
      return errorResponse('internal', 'provider broker credential boundary is closed');
    }
    try {
      validateRequestShape(request);
    } catch {
      return errorResponse('policy', 'provider request does not match the bounded schema');
    }
    if (containsExactSecret(request, keyBytes)) {
      return errorResponse('policy', 'provider request contains forbidden credential material');
    }

    const trial = trials.get(bindingKey(request));
    if (!trial || request.sequence !== trial.nextSequence || attemptIds.has(request.attemptId)) {
      return errorResponse('replay', 'lease, trial, sequence, or attempt binding was rejected');
    }
    try {
      validateRequestPolicy(request, policy);
    } catch (error) {
      return errorResponse(error.kind ?? 'policy', error.reason ?? 'request controls differ from provider policy');
    }

    const body = providerBody(request, policy);
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload, 'utf8') > maxFrameBytes) {
      return errorResponse('policy', 'provider request payload exceeds the broker bound');
    }
    const reservedUsd = calculateReservation(payload, policy);
    try {
      reserve(trial, reservedUsd);
    } catch (error) {
      return errorResponse(error.kind ?? 'budget', error.reason ?? 'provider budget reservation failed');
    }

    trial.nextSequence += 1;
    attemptIds.add(request.attemptId);
    const attempt = {
      ordinal: attempts.length + 1,
      attemptId: request.attemptId,
      leaseId: request.leaseId,
      leaseDigest: request.leaseDigest,
      trialId: request.trialId,
      leaseSequence: request.leaseSequence,
      sequence: request.sequence,
      state: 'started',
      outcome: null,
      startedAt: clock.now(),
      completedAt: null,
      model: policy.model,
      providerEndpointTag: policy.provider.order[0],
      expectedResolvedProvider: policy.provider.expectedResolvedNames[0],
      maxTokens: policy.maxTokens,
      requestPayloadBytes: Buffer.byteLength(payload, 'utf8'),
      reservedUsd,
      usage: null,
      actualCostUsd: null,
      reservationUnderestimated: false,
      budgetBreached: false,
    };
    attempts.push(attempt);

    if (lifecycle.isDisconnected?.()) {
      releaseActive(trial, reservedUsd);
      Object.assign(attempt, {
        state: 'completed',
        outcome: 'rejected-disconnected-before-dispatch',
        completedAt: clock.now(),
        actualCostUsd: 0,
      });
      return errorResponse('client-disconnect', 'client disconnected before provider dispatch', { attempt });
    }

    const controller = new AbortController();
    let timer;
    let removeDisconnect = () => {};
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BrokerFault('billing-uncertain', 'provider-timeout-after-dispatch', { billingUncertain: true }));
      }, requestTimeoutMs);
      timer.unref?.();
    });
    const disconnectPromise = new Promise((_, reject) => {
      removeDisconnect = lifecycle.onDisconnect?.(() => {
        controller.abort();
        reject(new BrokerFault('billing-uncertain', 'client-disconnect-after-dispatch', { billingUncertain: true }));
      }) ?? (() => {});
    });

    const providerPromise = (async () => {
      let response;
      try {
        response = await fetchImpl(policy.endpoint, {
          method: 'POST',
          headers: {
            authorization: providerAuthorizationHeader(keyBytes),
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: payload,
          signal: controller.signal,
        });
      } catch {
        throw new BrokerFault('billing-uncertain', 'provider-transport-failure-after-dispatch', {
          billingUncertain: true,
        });
      }
      if (!response || response.ok !== true) {
        throw new BrokerFault('billing-uncertain', 'provider-http-failure-after-dispatch', {
          billingUncertain: true,
        });
      }
      return readProviderJson(response, maxProviderResponseBytes);
    })();
    providerPromise.catch(() => {});

    let data;
    try {
      data = await Promise.race([providerPromise, timeoutPromise, disconnectPromise]);
    } catch (error) {
      const fault = error instanceof BrokerFault
        ? error
        : new BrokerFault('billing-uncertain', 'provider-failure-after-dispatch', { billingUncertain: true });
      settleUncertain(trial, attempt, fault.reason);
      return errorResponse('billing-uncertain', fault.reason, { billingUncertain: true, attempt });
    } finally {
      clearTimeout(timer);
      removeDisconnect();
    }

    let usage;
    try {
      usage = usageEvidence(data, policy);
    } catch (error) {
      settleUncertain(trial, attempt, error.reason ?? 'missing-or-malformed-provider-usage');
      return errorResponse('billing-uncertain', error.reason ?? 'missing-or-malformed-provider-usage', {
        billingUncertain: true,
        attempt,
      });
    }

    const identityDrift = providerIdentityDrift(data, policy);
    if (identityDrift) {
      settleKnown(trial, attempt, usage, 'rejected-provider-drift');
      return errorResponse('provider-drift', identityDrift, { attempt });
    }
    if (usage.reconciledCostUsd > reservedUsd + USD_EPSILON) {
      settleKnown(trial, attempt, usage, 'rejected-cost-overrun');
      return errorResponse('cost-overrun', 'actual provider cost exceeded its hard reservation', { attempt });
    }

    const output = sanitizeAssistantMessage(data, keyBytes);
    const outputFitsIpc = output != null &&
      Buffer.byteLength(JSON.stringify(output), 'utf8') <= Math.floor(maxFrameBytes / 2);
    if (!outputFitsIpc) {
      settleKnown(trial, attempt, usage, 'rejected-partial-completion');
      return errorResponse('provider', 'provider returned a partial or malformed completion', { attempt });
    }

    settleKnown(trial, attempt, usage, 'accepted');
    if (attempt.budgetBreached) {
      attempt.outcome = 'rejected-cost-overrun';
      return errorResponse('cost-overrun', 'actual provider cost crossed a hard budget ceiling', { attempt });
    }
    return successResponse(attempt, output);
  }

  function publicSnapshot() {
    const trialEvidence = [...trials.values()].map((trial) => ({
      leaseId: trial.binding.leaseId,
      leaseDigest: trial.binding.leaseDigest,
      trialId: trial.binding.trialId,
      leaseSequence: trial.binding.leaseSequence,
      ceilingUsd: trial.binding.ceilingUsd,
      nextSequence: trial.nextSequence,
      knownActualUsd: trial.knownActualUsd,
      uncertainReservedUsd: trial.uncertainReservedUsd,
      activeReservedUsd: trial.activeReservedUsd,
      accountedExposureUsd: exposure(trial),
      breached: trial.breached,
      blocked: trial.blocked,
    }));
    return {
      version: PROVIDER_BROKER_PROTOCOL_VERSION,
      state,
      policy: {
        policyHash: crypto.createHash('sha256')
          .update(canonicalJson(staticPolicyProjection(policy)))
          .digest('hex'),
        bindingPolicyHash: crypto.createHash('sha256').update(canonicalJson(policy)).digest('hex'),
        endpointHash: crypto.createHash('sha256').update(policy.endpoint).digest('hex'),
        model: policy.model,
        providerEndpointTag: policy.provider.order[0],
        expectedResolvedProvider: policy.provider.expectedResolvedNames[0],
        settings: jsonClone(policy.settings),
        maxTokens: policy.maxTokens,
        pricing: jsonClone(policy.pricing),
      },
      session: {
        ceilingUsd: session.ceilingUsd,
        knownActualUsd: session.knownActualUsd,
        uncertainReservedUsd: session.uncertainReservedUsd,
        activeReservedUsd: session.activeReservedUsd,
        accountedExposureUsd: exposure(session),
        breached: session.breached,
        blocked: session.blocked,
      },
      trials: trialEvidence,
      attempts: attempts.map(attemptPublicEvidence),
    };
  }

  function processEvidenceRequest(request) {
    try {
      exactKeys(request, EVIDENCE_REQUEST_FIELDS, 'provider evidence request');
      if (request.version !== PROVIDER_BROKER_PROTOCOL_VERSION ||
          request.type !== 'provider-evidence-request' ||
          typeof request.nonce !== 'string' || !EVIDENCE_NONCE_PATTERN.test(request.nonce)) {
        throw new Error('provider evidence request is malformed');
      }
      if (keyDisposed || state !== 'running') {
        throw new Error('provider evidence is unavailable after broker closure');
      }
      const snapshot = publicSnapshot();
      return {
        version: PROVIDER_BROKER_PROTOCOL_VERSION,
        type: 'provider-evidence-response',
        ok: true,
        nonce: request.nonce,
        snapshot,
        snapshotHash: providerBrokerEvidenceHash(snapshot),
      };
    } catch {
      return errorResponse('invalid-ipc', 'provider evidence request was rejected');
    }
  }

  function writeResponse(socket, response) {
    if (socket.destroyed || !socket.writable) return;
    respondedConnections.add(socket);
    const sanitized = redactExactSecret(response, keyBytes);
    let serialized = JSON.stringify(sanitized);
    if (stringContainsExactSecret(serialized, keyBytes)) {
      serialized = JSON.stringify(errorResponse('internal', 'broker response sanitization failed'));
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxFrameBytes) {
      serialized = JSON.stringify(errorResponse('internal', 'broker response exceeded its IPC bound'));
    }
    socket.end(`${serialized}\n`);
  }

  function accept(socket) {
    connections.add(socket);
    let chunks = [];
    let total = 0;
    let dispatched = false;
    let disconnected = false;
    const disconnectHandlers = new Set();
    const notifyDisconnected = () => {
      if (disconnected) return;
      disconnected = true;
      for (const handler of disconnectHandlers) handler();
      disconnectHandlers.clear();
    };
    socket.on('close', () => {
      connections.delete(socket);
      if (dispatched && !respondedConnections.has(socket)) notifyDisconnected();
    });
    socket.on('error', notifyDisconnected);
    socket.on('data', async (chunk) => {
      if (dispatched) {
        notifyDisconnected();
        socket.destroy();
        return;
      }
      total += chunk.length;
      if (total > maxFrameBytes) {
        dispatched = true;
        writeResponse(socket, errorResponse('invalid-ipc', 'provider broker frame exceeded its byte limit'));
        return;
      }
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks, total);
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      dispatched = true;
      const remainder = bytes.subarray(newline + 1).toString('utf8');
      if (remainder.trim().length > 0) {
        writeResponse(socket, errorResponse('invalid-ipc', 'provider broker accepts exactly one frame per connection'));
        return;
      }
      let request;
      try {
        request = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
      } catch {
        writeResponse(socket, errorResponse('invalid-ipc', 'provider broker frame is not valid JSON'));
        return;
      }
      chunks = [];
      const lifecycle = {
        isDisconnected: () => disconnected || socket.destroyed,
        onDisconnect(handler) {
          if (disconnected || socket.destroyed) {
            handler();
            return () => {};
          }
          disconnectHandlers.add(handler);
          return () => disconnectHandlers.delete(handler);
        },
      };
      try {
        const response = request?.type === 'provider-evidence-request'
          ? processEvidenceRequest(request)
          : await processRequest(request, lifecycle);
        writeResponse(socket, response);
      } catch {
        settleAnyActiveAttemptAsUncertain('broker-internal-failure-after-possible-dispatch');
        state = 'failed';
        disposeProviderKey();
        writeResponse(socket, errorResponse('internal', 'provider broker failed closed'));
        for (const connection of connections) {
          if (connection !== socket) connection.destroy();
        }
      }
    });
  }

  async function start() {
    if (state === 'running') return;
    if (startPromise) return startPromise;
    if (state !== 'created') throw new Error('provider broker cannot be restarted after close');
    startPromise = (async () => {
      if (!socketParentIsEligible(socketPath, clientGid)) {
        throw new Error(clientGid == null
          ? 'provider broker socket parent must be owner-only'
          : 'provider broker shared socket parent must be broker-owned setgid 0710 with the exact client GID');
      }
      if (fs.existsSync(socketPath)) throw new Error('provider broker refuses to replace an existing socket path');
      server = net.createServer(accept);
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
        server.listen(socketPath);
      });
      fs.chmodSync(socketPath, clientGid == null ? 0o600 : 0o660);
      const stat = fs.lstatSync(socketPath);
      const expectedSocketMode = clientGid == null ? 0o600 : 0o660;
      if (!stat.isSocket() || (stat.mode & 0o777) !== expectedSocketMode ||
          (clientGid != null && stat.gid !== clientGid)) {
        throw new Error('provider broker socket did not acquire its exact client access policy');
      }
      socketIdentity = { dev: stat.dev, ino: stat.ino };
      server.on('error', () => {
        state = 'failed';
        disposeProviderKey();
        for (const socket of connections) socket.destroy();
      });
      state = 'running';
    })();
    try {
      await startPromise;
    } catch (error) {
      state = 'failed';
      disposeProviderKey();
      server?.close();
      server = null;
      throw error;
    } finally {
      startPromise = null;
    }
  }

  async function close() {
    if (state === 'closed') {
      disposeProviderKey();
      return;
    }
    if (startPromise) {
      try { await startPromise; } catch { /* start already failed closed */ }
    }
    state = 'closing';
    for (const socket of connections) socket.destroy();
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
    }
    try {
      try {
        const stat = fs.lstatSync(socketPath);
        if (stat.isSocket() && socketIdentity && stat.dev === socketIdentity.dev && stat.ino === socketIdentity.ino) {
          fs.unlinkSync(socketPath);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    } finally {
      disposeProviderKey();
      state = 'closed';
    }
  }

  return Object.freeze({
    start,
    close,
    snapshot: publicSnapshot,
  });
}

/** One-request client used by the unprivileged provider bridge. */
export async function requestProviderBroker({
  socketPath,
  request,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS + 5_000,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
} = {}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
    throw new Error('provider broker client requires an absolute socket path');
  }
  safeInteger(timeoutMs, 'provider broker client timeoutMs', { min: 1, max: 60 * 60_000 + 5_000 });
  safeInteger(maxFrameBytes, 'provider broker client maxFrameBytes', { min: 128, max: 8 * 1024 * 1024 });
  let serialized;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw new Error('provider broker request is not serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxFrameBytes) {
    throw new Error('provider broker request exceeds the client IPC bound');
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('provider broker client timed out'));
    }, timeoutMs);
    timer.unref?.();
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    socket.on('connect', () => socket.write(`${serialized}\n`));
    socket.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxFrameBytes) {
        finish(() => {
          socket.destroy();
          reject(new Error('provider broker response exceeds the client IPC bound'));
        });
        return;
      }
      chunks.push(chunk);
    });
    socket.on('error', (error) => finish(() => reject(new Error(`provider broker connection failed: ${error.code ?? 'unknown'}`))));
    socket.on('end', () => finish(() => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('provider broker response was not valid JSON'));
      }
    }));
  });
}

/**
 * Read one nonce-bound, content-free snapshot from the already attested broker
 * socket. The caller must independently validate the socket inode/owner/mode;
 * the nonce prevents a stale response from being substituted on that channel.
 */
export async function requestProviderBrokerEvidence({
  socketPath,
  nonce = crypto.randomBytes(16).toString('hex'),
  timeoutMs = 5_000,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  requestImpl = requestProviderBroker,
} = {}) {
  if (typeof nonce !== 'string' || !EVIDENCE_NONCE_PATTERN.test(nonce)) {
    throw new Error('provider broker evidence nonce must be exactly 128 bits of lowercase hex');
  }
  if (typeof requestImpl !== 'function') {
    throw new Error('provider broker evidence request implementation is required');
  }
  const response = await requestImpl({
    socketPath,
    request: {
      version: PROVIDER_BROKER_PROTOCOL_VERSION,
      type: 'provider-evidence-request',
      nonce,
    },
    timeoutMs,
    maxFrameBytes,
  });
  try {
    exactKeys(response, EVIDENCE_RESPONSE_FIELDS, 'provider broker evidence response');
    if (response.version !== PROVIDER_BROKER_PROTOCOL_VERSION ||
        response.type !== 'provider-evidence-response' || response.ok !== true ||
        response.nonce !== nonce || !record(response.snapshot) ||
        typeof response.snapshotHash !== 'string' || !SHA256_PATTERN.test(response.snapshotHash)) {
      throw new Error('provider broker evidence response nonce or schema mismatch');
    }
    const expectedHash = providerBrokerEvidenceHash(response.snapshot);
    if (!crypto.timingSafeEqual(Buffer.from(response.snapshotHash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      throw new Error('provider broker evidence response hash mismatch');
    }
    return deepFreeze(jsonClone(response));
  } catch (error) {
    if (/provider broker evidence response/i.test(error?.message ?? '')) throw error;
    throw new Error('provider broker evidence response is malformed');
  }
}

function parseCli(argv) {
  const parsed = { socketPath: null, policyPath: null, keyFd: null, clientGid: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value == null) throw new Error(`missing value for ${flag ?? 'argument'}`);
    if (flag === '--socket') parsed.socketPath = value;
    else if (flag === '--policy') parsed.policyPath = value;
    else if (flag === '--key-fd') parsed.keyFd = Number(value);
    else if (flag === '--client-gid') parsed.clientGid = Number(value);
    else throw new Error('provider broker received an unknown argument');
  }
  if (!parsed.socketPath || !parsed.policyPath || !Number.isSafeInteger(parsed.keyFd) || parsed.keyFd < 3) {
    throw new Error('usage: provider-broker --socket PATH --policy FILE --key-fd FD');
  }
  return parsed;
}

function readBoundedFile(file, maxBytes, label, { ownerOnly = false } = {}) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${label} is not a bounded regular file`);
    const uidMatches = typeof process.getuid !== 'function' || stat.uid === process.getuid();
    if (ownerOnly && (!uidMatches || (stat.mode & 0o077) !== 0)) {
      throw new Error(`${label} must be owner-only`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Read a one-shot inherited pipe/socket without allowing an untrusted writer
 * to make the broker allocate an unbounded secret buffer. The caller retains
 * ownership of the descriptor and must close it.
 */
export function readBoundedInheritedSecret(descriptor, maxBytes = 1_024) {
  safeInteger(descriptor, 'provider key descriptor', { min: 3 });
  safeInteger(maxBytes, 'provider key byte bound', { min: 8, max: 8_192 });
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let used = 0;
  try {
    while (used <= maxBytes) {
      const count = fs.readSync(descriptor, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > maxBytes) throw new Error('provider key exceeds the inherited descriptor byte bound');
    return Buffer.from(buffer.subarray(0, used));
  } finally {
    buffer.fill(0);
  }
}

/** Standalone entry point. The raw key is accepted through a private inherited FD, never argv/env. */
export async function runProviderBrokerCli(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (Object.hasOwn(process.env, 'OPENROUTER_API_KEY')) {
    delete process.env.OPENROUTER_API_KEY;
    throw new Error('provider broker refuses raw provider keys in process environment');
  }
  if (process.report) {
    process.report.reportOnFatalError = false;
    process.report.reportOnSignal = false;
    process.report.reportOnUncaughtException = false;
  }
  const policyBytes = readBoundedFile(options.policyPath, 128 * 1024, 'provider broker policy', { ownerOnly: true });
  let keyBytes;
  let ownershipTransferred = false;
  try {
    const keyStat = fs.fstatSync(options.keyFd);
    if (!keyStat.isFIFO() && !keyStat.isSocket()) {
      throw new Error('provider key descriptor must be an inherited pipe or socket');
    }
    keyBytes = readBoundedInheritedSecret(options.keyFd);
  } finally {
    try { fs.closeSync(options.keyFd); } catch { /* inherited descriptor may already be closed */ }
  }
  try {
    const policy = JSON.parse(policyBytes.toString('utf8'));
    const broker = createProviderBroker({
      socketPath: options.socketPath,
      providerKeyBytes: keyBytes,
      policy,
      clientGid: options.clientGid,
    });
    ownershipTransferred = true;
    await broker.start();
    const stop = async () => {
      await broker.close();
      process.exitCode = 0;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return broker;
  } finally {
    policyBytes.fill(0);
    if (!ownershipTransferred) keyBytes?.fill(0);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runProviderBrokerCli().catch(() => {
    process.exitCode = 1;
  });
}
