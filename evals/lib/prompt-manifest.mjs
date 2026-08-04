import crypto from 'node:crypto';

export const PROMPT_COMPONENT_MANIFEST_SCHEMA = 'prompt-component-manifest.v1';
export const PROMPT_COMPONENT_MANIFEST_SEPARATOR = '\n\n';
export const PROMPT_COMPONENT_MANIFEST_FIELDS = Object.freeze([
  'schema',
  'separator',
  'systemPromptChars',
  'systemPromptBytes',
  'systemPromptHash',
  'complete',
  'components',
]);
export const PROMPT_COMPONENT_FIELDS = Object.freeze([
  'id',
  'ordinal',
  'startChar',
  'endChar',
  'chars',
  'bytes',
  'sha256',
]);

const MANIFEST_FIELD_SET = new Set(PROMPT_COMPONENT_MANIFEST_FIELDS);
const COMPONENT_FIELD_SET = new Set(PROMPT_COMPONENT_FIELDS);
const SHA256_HEX = /^[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPlainRecord(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeSum(values) {
  let total = 0;
  for (const value of values) {
    if (!nonnegativeSafeInteger(value) || total > Number.MAX_SAFE_INTEGER - value) return null;
    total += value;
  }
  return total;
}

function safeProduct(left, right) {
  if (!nonnegativeSafeInteger(left) || !nonnegativeSafeInteger(right) ||
      (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left))) {
    return null;
  }
  return left * right;
}

function sanitizedManifest(manifest) {
  return {
    schema: manifest.schema,
    separator: manifest.separator,
    systemPromptChars: manifest.systemPromptChars,
    systemPromptBytes: manifest.systemPromptBytes,
    systemPromptHash: manifest.systemPromptHash,
    complete: manifest.complete,
    components: manifest.components.map((component) => ({
      id: component.id,
      ordinal: component.ordinal,
      startChar: component.startChar,
      endChar: component.endChar,
      chars: component.chars,
      bytes: component.bytes,
      sha256: component.sha256,
    })),
  };
}

/**
 * Validate the content-free manifest contract without access to prompt text.
 * Consumers that hold the prompt must additionally verify the recorded hashes
 * and byte spans against that content.
 */
export function validatePromptComponentManifestStructure(manifest) {
  if (!hasExactFields(manifest, MANIFEST_FIELD_SET) ||
      !Array.isArray(manifest?.components) ||
      manifest.components.some((component) => !hasExactFields(component, COMPONENT_FIELD_SET))) {
    return { valid: false, reason: 'unexpected-field' };
  }
  if (manifest.schema !== PROMPT_COMPONENT_MANIFEST_SCHEMA ||
      manifest.separator !== PROMPT_COMPONENT_MANIFEST_SEPARATOR ||
      manifest.complete !== true ||
      !nonnegativeSafeInteger(manifest.systemPromptChars) || manifest.systemPromptChars === 0 ||
      !nonnegativeSafeInteger(manifest.systemPromptBytes) ||
      manifest.systemPromptBytes < manifest.systemPromptChars ||
      typeof manifest.systemPromptHash !== 'string' || !SHA256_HEX.test(manifest.systemPromptHash) ||
      manifest.components.length === 0) {
    return { valid: false, reason: 'invalid-root' };
  }

  const ids = new Set();
  let expectedStart = 0;
  let componentChars = 0;
  let componentBytes = 0;
  for (let ordinal = 0; ordinal < manifest.components.length; ordinal += 1) {
    const component = manifest.components[ordinal];
    if (typeof component.id !== 'string' || component.id.length === 0 || ids.has(component.id) ||
        component.ordinal !== ordinal ||
        !nonnegativeSafeInteger(component.startChar) || component.startChar !== expectedStart ||
        !nonnegativeSafeInteger(component.endChar) || component.endChar <= component.startChar ||
        !nonnegativeSafeInteger(component.chars) || component.chars !== component.endChar - component.startChar ||
        !nonnegativeSafeInteger(component.bytes) || component.bytes < component.chars ||
        typeof component.sha256 !== 'string' || !SHA256_HEX.test(component.sha256)) {
      return { valid: false, reason: 'invalid-component' };
    }
    ids.add(component.id);
    componentChars = safeSum([componentChars, component.chars]);
    componentBytes = safeSum([componentBytes, component.bytes]);
    if (componentChars == null || componentBytes == null) {
      return { valid: false, reason: 'inconsistent-totals' };
    }
    expectedStart = component.endChar + (
      ordinal < manifest.components.length - 1 ? PROMPT_COMPONENT_MANIFEST_SEPARATOR.length : 0
    );
    if (!Number.isSafeInteger(expectedStart)) {
      return { valid: false, reason: 'inconsistent-totals' };
    }
  }

  const separatorCount = manifest.components.length - 1;
  const separatorChars = safeProduct(separatorCount, PROMPT_COMPONENT_MANIFEST_SEPARATOR.length);
  const separatorBytes = safeProduct(
    separatorCount,
    Buffer.byteLength(PROMPT_COMPONENT_MANIFEST_SEPARATOR, 'utf8')
  );
  if (separatorChars == null || separatorBytes == null ||
      expectedStart !== manifest.systemPromptChars ||
      safeSum([componentChars, separatorChars]) !== manifest.systemPromptChars ||
      safeSum([componentBytes, separatorBytes]) !== manifest.systemPromptBytes) {
    return { valid: false, reason: 'inconsistent-totals' };
  }
  return { valid: true, reason: null, manifest: sanitizedManifest(manifest) };
}

/** Build the exact system prompt plus its content-free structural manifest. */
export function buildPromptComponentManifest(components) {
  if (!Array.isArray(components)) throw new Error('prompt components must be an array');
  const selected = components.filter(
    (component) => typeof component?.content === 'string' && component.content.length > 0
  );
  if (!selected.length) throw new Error('at least one prompt component is required');
  const systemPrompt = selected
    .map((component) => component.content)
    .join(PROMPT_COMPONENT_MANIFEST_SEPARATOR);
  let startChar = 0;
  const manifest = {
    schema: PROMPT_COMPONENT_MANIFEST_SCHEMA,
    separator: PROMPT_COMPONENT_MANIFEST_SEPARATOR,
    systemPromptChars: systemPrompt.length,
    systemPromptBytes: Buffer.byteLength(systemPrompt, 'utf8'),
    systemPromptHash: sha256(systemPrompt),
    complete: true,
    components: selected.map((component, ordinal) => {
      const entry = {
        id: component.id,
        ordinal,
        startChar,
        endChar: startChar + component.content.length,
        chars: component.content.length,
        bytes: Buffer.byteLength(component.content, 'utf8'),
        sha256: sha256(component.content),
      };
      startChar = entry.endChar + (
        ordinal < selected.length - 1 ? PROMPT_COMPONENT_MANIFEST_SEPARATOR.length : 0
      );
      return entry;
    }),
  };
  const validation = validatePromptComponentManifestStructure(manifest);
  if (!validation.valid) throw new Error(`prompt component manifest is invalid: ${validation.reason}`);
  return { systemPrompt, manifest: validation.manifest };
}
