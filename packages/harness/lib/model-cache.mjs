/**
 * The model catalogue, as fetched — and where it came from.
 *
 * A model list is not a fact about this repository. Copilot's differs by plan
 * (Individual, Business, Enterprise) and an org policy can disable models per
 * seat; every other provider adds and retires models on its own schedule. A
 * list written into the source is therefore wrong in both directions at once —
 * missing models the account has, offering models it does not — and the surface
 * presents it with exactly the same confidence as a true one, which is what
 * makes a stale catalogue worse than an absent one.
 *
 * So the catalogue is FETCHED (`fetchModels` in lib/provider.mjs, through the
 * adapter, on `harness model refresh` and nowhere else) and cached here with
 * the time it was taken. Every reader gets the provenance along with the list,
 * because "these are the models" and "these were the models an hour ago" are
 * different claims and a picker should not blur them.
 *
 * READING NEVER FETCHES. This file only touches disk, so the LLM-free property
 * of every read path is unchanged: a stale cache is reported as stale, never
 * silently refreshed.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Where the cache lives — beside the config it complements. */
export function modelCachePath(copilotHome) {
  return path.join(copilotHome, 'harness', 'models.json');
}

export const CACHE_SCHEMA = 1;

/**
 * Read the cache. Any trouble — absent, unreadable, malformed, written by a
 * schema this build does not know — degrades to "nothing cached", because the
 * fallback is a working catalogue rather than an error.
 */
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
        // The client identity the provider's refresh recorded (today: the VS
        // Code version its update API was shipping) — same provenance rules as
        // the models beside it.
        client: entry.client && typeof entry.client === 'object' ? entry.client : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Record one provider's catalogue, leaving every other provider's alone.
 *
 * Read-modify-write rather than overwrite: refreshing Copilot must not discard
 * what is known about OpenRouter. Written through a temp file and renamed, the
 * same way config is, so an interrupted write cannot leave a half-parsed
 * catalogue behind — the failure mode a reader degrades on would then be
 * indistinguishable from "never fetched".
 */
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
