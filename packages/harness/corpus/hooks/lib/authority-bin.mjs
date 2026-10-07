import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function authorityBin() {
  if (process.env.HARNESS_BIN) return process.env.HARNESS_BIN;
  const candidates = ['../../.harness-bin/bin/harness.mjs', '../../../bin/harness.mjs'];
  return candidates.map(rel => fileURLToPath(new URL(rel, import.meta.url))).find(full => {
    try { return fs.statSync(full).isFile(); } catch { return false; }
  }) || null;
}
