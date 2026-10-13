import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';
import { createRedactor } from './redact.mjs';
import { collectEditorInventory, validateInventoryCollection, EDITOR_FAMILIES, INVENTORY_SETTINGS_KEYS } from './inventory-editors.mjs';

const INVENTORY_VERSION = 1;
const CACHE_REL = 'inventory/editors.json';
const MAX_BYTES = 2 * 1024 * 1024;

function fail(message) {
  throw new Error(`Inventory: ${message}`);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value, allowed) {
  return object(value) && Object.keys(value).every(key => allowed.includes(key));
}

function text(value, max = 8192, nullable = false) {
  return (nullable && value === null) || (typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value));
}

function observation(value, launcher = false) {
  return keys(value, ['value', 'source', 'scope', 'observed', ...(launcher ? ['resolved_path'] : [])]) && text(value.value, 4096, true) && text(value.source) && text(value.scope, 128) && typeof value.observed === 'boolean'
    && (!launcher || text(value.resolved_path, 4096, true));
}

function settings(value) {
  if (!keys(value, ['overrides', 'source', 'scope', 'effective_known']) || value.effective_known !== false || !text(value.source, 8192, true) || !text(value.scope, 128) || !keys(value.overrides, INVENTORY_SETTINGS_KEYS)) return false;
  for (const [key, override] of Object.entries(value.overrides)) {
    if (!key.endsWith('Locations')) {
      if (typeof override !== 'boolean') return false;
    } else if (!object(override) || Object.keys(override).length > 32 || Object.entries(override).some(([location, enabled]) => !text(location, 1024) || typeof enabled !== 'boolean')) return false;
  }
  return true;
}

function coverage(value) {
  const names = ['directories', 'files', 'bytes', 'milliseconds'];
  return keys(value, ['complete', 'directories', 'files', 'bytes', 'elapsed_ms', 'limits']) && typeof value.complete === 'boolean'
    && ['directories', 'files', 'bytes', 'elapsed_ms'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && keys(value.limits, names) && names.every(key => Number.isSafeInteger(value.limits[key]) && value.limits[key] >= 0)
    && ['directories', 'files', 'bytes'].every(key => value[key] <= value.limits[key]);
}

function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function safeCachePath(home) {
  const root = path.parse(home).root;
  if (!assertNoSymlinkAncestors(root, path.relative(root, home))) fail('Harness home has unsafe ancestors');
  const full = assertNoSymlinkAncestors(home, CACHE_REL);
  if (!full) fail('cache has unsafe ancestors');
  return full;
}

function validateCache(value) {
  if (!keys(value, ['inventory_version', 'collected_at', 'host', 'editors']) || value.inventory_version !== INVENTORY_VERSION || !timestamp(value.collected_at) || !keys(value.host, ['platform', 'architecture', 'hostname', 'source', 'scope']) || !object(value.editors)
    || Object.keys(value.editors).some(key => !EDITOR_FAMILIES.includes(key))
    || !['platform', 'architecture', 'hostname', 'source', 'scope'].every(key => text(value.host[key], 256))) fail('cache schema is invalid');
  for (const [family, record] of Object.entries(value.editors)) {
    if (!keys(record, ['family', 'collected_at', 'status', 'installation', 'product', 'user_data', 'profile', 'extensions', 'settings', 'launcher', 'running_instance', 'remote', 'coverage', 'warnings', 'configurations']) || record.family !== family || !timestamp(record.collected_at) || !['collected', 'partial', 'not-found'].includes(record.status)
      || !Array.isArray(record.extensions) || record.extensions.length > 512 || !Array.isArray(record.warnings) || record.warnings.length > 64
      || record.warnings.some(warning => !text(warning))
      || record.running_instance !== null || !keys(record.remote, ['status', 'scope']) || record.remote.status !== 'uncollected' || record.remote.scope !== 'remote'
      || !settings(record.settings) || !coverage(record.coverage)
      || !['installation', 'launcher', 'profile'].every(key => observation(record[key], key === 'launcher'))
      || !keys(record.product, ['name', 'version', 'build', 'source', 'scope'])
      || !['name', 'version', 'build', 'source'].every(key => text(record.product[key], 8192, true)) || record.product.scope !== 'local-installation'
      || (family === 'jetbrains' ? !Array.isArray(record.configurations) || record.configurations.length > 32 || record.configurations.some(config => !keys(config, ['id', 'path', 'source', 'scope']) || !['id', 'path', 'source', 'scope'].every(key => text(config[key]))) : !observation(record.user_data))) fail('cache editor record is invalid');
    for (const extension of record.extensions) {
      if (!keys(extension, ['id', 'name', 'version', 'enabled', 'source', 'scope', 'configuration', 'profile']) || !text(extension.id, family === 'jetbrains' ? 256 : 257)
        || !text(extension.source) || !text(extension.name, family === 'jetbrains' ? 512 : 256, true) || !text(extension.version, 256, true)
        || (family === 'jetbrains' ? !['bundled', 'downloaded'].includes(extension.scope) || ![null, false].includes(extension.enabled) || !text(extension.configuration, 4096, true) || (extension.enabled === false && !extension.configuration) : extension.scope !== 'local-installed' || extension.enabled !== null || !text(extension.profile, 128, true))) fail('cache extension observation is invalid');
    }
  }
  return value;
}

function readCache(home) {
  const full = safeCachePath(home);
  try { fs.lstatSync(full); } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('cache is unreadable');
  }
  const raw = readFileNoFollow(full, { root: home, maxBytes: MAX_BYTES });
  if (raw === null) fail('cache must be a bounded regular file');
  let value;
  try {
    value = JSON.parse(raw);
    if (YAML.parseDocument(raw, { schema: 'json', uniqueKeys: true }).errors.length) fail('cache has duplicate or invalid JSON keys');
  } catch { fail('cache must contain valid JSON without duplicate keys'); }
  return validateCache(value);
}

function resultFor(verb, inventory, extra = {}) {
  const collected = Boolean(inventory);
  return {
    schema: INVENTORY_VERSION, mode: 'inventory', verb, status: 'ok', exitCode: 0,
    collected, published: false, inventory,
    freshness: collected ? { status: 'cached-not-revalidated', editors: Object.fromEntries(Object.entries(inventory.editors).map(([family, record]) => [family, { age_ms: Math.max(0, Date.now() - Date.parse(record.collected_at)), currentness_known: false }])) } : { status: 'not-collected', editors: {} },
    output: [{ line: collected ? `Cached inventory has ${Object.keys(inventory.editors).length} editor observation(s); enabled, effective and running state remain unknown.` : 'Editor inventory is not collected. Refresh it only when the task needs these observations.' }],
    ...extra,
  };
}

export function runInventory(options = {}) {
  const verb = options.verb || 'show';
  try {
    if (!['show', 'refresh'].includes(verb)) fail('verb must be show or refresh');
    if (options.editor !== undefined && !EDITOR_FAMILIES.includes(options.editor)) fail('--editor must be vscode, cursor or jetbrains');
    if (verb === 'refresh' && !options.editor) fail('refresh requires --editor');
    if (verb === 'refresh') validateInventoryCollection(options);
    const home = path.resolve(options.home || harnessGlobalHome());
    const full = safeCachePath(home);
    const existing = readCache(home);
    if (verb === 'show') {
      const safe = existing ? createRedactor().redactValue(existing) : null;
      if (safe && options.editor) safe.editors = Object.hasOwn(safe.editors, options.editor) ? { [options.editor]: safe.editors[options.editor] } : {};
      return resultFor(verb, safe, { path: full });
    }
    if (options.dryRun) return resultFor(verb, existing ? createRedactor().redactValue(existing) : null, { dryRun: true, path: full, collection_planned: options.editor });
    const record = collectEditorInventory(options);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    safeCachePath(home);
    return withPlanUpdateLock(full, () => {
      const latest = readCache(home);
      const now = new Date().toISOString();
      const inventory = createRedactor().redactValue({
        inventory_version: INVENTORY_VERSION, collected_at: now,
        host: { platform: process.platform, architecture: process.arch, hostname: os.hostname(), source: 'node-host', scope: 'local-host' },
        editors: { ...(latest?.editors || {}), [options.editor]: record },
      });
      validateCache(inventory);
      const bytes = `${JSON.stringify(inventory, null, 2)}\n`;
      if (Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) fail('merged cache exceeds its size bound');
      const publish = options.publish || writeFileContained;
      if (publish(home, CACHE_REL, bytes) === null) fail('could not publish cache safely; previous cache was retained');
      return resultFor(verb, inventory, { published: true, path: full });
    });
  } catch (error) {
    const reason = createRedactor().redactText(error.message);
    return { schema: INVENTORY_VERSION, mode: 'inventory', verb, status: 'failed', exitCode: 1, collected: false, published: false, inventory: null, reason, output: [{ line: reason }] };
  }
}
