import fs from 'node:fs';
import path from 'node:path';

/** Where the cache lives — beside the config it complements. */
export function modelCachePath(copilotHome) {
  return path.join(copilotHome, 'harness', 'models.json');
}

export const CACHE_SCHEMA = 1;

export function readModelCache(copilotHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelCachePath(copilotHome), 'utf8'));
    if (parsed?.schema !== CACHE_SCHEMA || typeof parsed.providers !== 'object') return {};
    const out = {};
    for (const [id, entry] of Object.entries(parsed.providers)) {
      if (!Array.isArray(entry?.models) || !entry.models.length) continue;
      out[id] = {
        models: entry.models.filter((m) => typeof m === 'string' && m),
        labels: entry.labels && typeof entry.labels === 'object' ? entry.labels : {},
        fetchedAt: typeof entry.fetchedAt === 'string' ? entry.fetchedAt : null,
                client: entry.client && typeof entry.client === 'object' ? entry.client : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeModelCache(copilotHome, { provider, models, labels = {}, fetchedAt, client = null }) {
  const file = modelCachePath(copilotHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const providers = readModelCache(copilotHome);
  providers[provider] = { models: [...models], labels: { ...labels }, fetchedAt, ...(client ? { client } : {}) };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: CACHE_SCHEMA, providers }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return providers[provider];
}

/** How long ago, in words, or null when it was never fetched. */
export function cacheAge(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return null;
  const then = Date.parse(fetchedAt);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
