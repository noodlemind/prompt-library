/**
 * Temp directory lifecycle for harness tests.
 * Prefer realpath so macOS /var → /private/var does not break path comparisons.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} [prefix='harness-']
 * @returns {string} absolute realpath of a new empty temp directory
 */
export function tempDir(prefix = 'harness-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Create a temp dir, run fn, always rmSync recursive.
 * @template T
 * @param {string} prefix
 * @param {(dir: string) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTemp(prefix, fn) {
  const dir = tempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Synchronous withTemp for non-async tests.
 * @template T
 * @param {string} prefix
 * @param {(dir: string) => T} fn
 * @returns {T}
 */
export function withTempSync(prefix, fn) {
  const dir = tempDir(prefix);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
