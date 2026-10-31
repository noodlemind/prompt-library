import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Reuse git observations for one read-only validation. A later call reads git again. */
export function withGitObservationCache(run) {
  if (storage.getStore()) return run();
  return storage.run(new Map(), run);
}

export function cachedGitObservation(key, read) {
  const map = storage.getStore();
  if (!map) return read();
  const id = JSON.stringify(key);
  if (map.has(id)) return map.get(id);
  const value = read();
  map.set(id, value);
  return value;
}
