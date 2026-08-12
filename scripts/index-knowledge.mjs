#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessBin = path.join(repoRoot, 'packages/harness/bin/harness.mjs');

const result = spawnSync(process.execPath, [harnessBin, 'index', '--workspace', repoRoot], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
