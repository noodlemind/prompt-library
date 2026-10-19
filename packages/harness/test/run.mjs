import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(directory, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => path.join(directory, entry.name)).sort();
if (!files.length) throw new Error('No package test files found');
const env = { ...process.env };
delete env.HARNESS_HOME;
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: path.dirname(directory), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
