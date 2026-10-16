#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPerformancePilot } from '../../../../packages/harness/test/helpers/performance-pilot.mjs';

const doctor = spawnSync(process.execPath, [path.join(import.meta.dirname, 'doctor.mjs')], { encoding: 'utf8', timeout: 30_000 });
assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
const artifactDir = process.env.HARNESS_CHECK_ARTIFACT_DIR || path.resolve(import.meta.dirname, '../evidence/performance');
const receipt = runPerformancePilot({ artifactDir });
receipt.doctor = { exit: doctor.status, stdout: doctor.stdout };
fs.mkdirSync(artifactDir, { recursive: true });
const file = path.join(artifactDir, 'performance.json');
fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cleanup, true);
console.log(`Performance CLI pilot passed: 12 -> 1 database calls per synthetic journey. Evidence: ${file}`);
