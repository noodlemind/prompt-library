import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Development-only observation of synchronous CLI/hook calls. No payloads or
// environment values are retained, and commands behave exactly as before.
const spawn = childProcess.spawnSync;
childProcess.spawnSync = function(command, args = [], options) {
  const started = performance.now();
  const result = spawn.call(this, command, args, options);
  const entry = typeof args[0] === 'string' ? args[0].replace(/\\/g, '/') : '';
  if (process.env.HARNESS_MECHANICS_TRACE && (/\/bin\/harness\.mjs$/.test(entry) || /\/hooks\/[^/]+\.mjs$/.test(entry))) {
    fs.appendFileSync(process.env.HARNESS_MECHANICS_TRACE, JSON.stringify({ kind: entry.endsWith('/harness.mjs') ? 'cli' : 'hook', operation: entry.endsWith('/harness.mjs') ? args[1] : path.basename(entry), exit: result.status, stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || ''), wallMs: performance.now() - started }) + '\n');
  }
  return result;
};
syncBuiltinESMExports();
