#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const suites = {
  common: ['apply-command', 'cli-evidence-verify', 'plan-update', 'adaptive-ladder', 'insight-compound', 'route'],
  phase2: ['plan-operations', 'review-assembly', 'consolidation-packets', 'resource-governance', 'report-facts', 'deterministic-delivery', 'publication-lock'],
};
const allowed = new Set(['--root', '--out', '--label', '--lane', '--runs']);
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!allowed.has(key) || !value || value.startsWith('--') || flags[key]) throw new Error('Use --root <package-root> --out <empty-directory> --label <label> --lane common|phase2 --runs 3');
  flags[key] = value;
}
const root = path.resolve(flags['--root'] || '.'), out = path.resolve(flags['--out'] || 'eval/results/mechanics');
const lane = flags['--lane'] || 'common', runs = Number(flags['--runs'] || 3);
if (!suites[lane] || !Number.isInteger(runs) || runs < 1 || runs > 10 || !flags['--label']) throw new Error('A label, supported lane and 1–10 runs are required');
if (fs.existsSync(out)) throw new Error('Use a new output directory to preserve prior receipts');
const files = suites[lane].map(name => `test/${name}.test.mjs`);
const fixtures = [...files, ...fs.readdirSync(path.join(root, 'test/helpers')).filter(name => name.endsWith('.mjs')).map(name => `test/helpers/${name}`), 'eval/adaptive/fixture.mjs', 'eval/adaptive/ladder.mjs'];
const fixtureHashes = Object.fromEntries(fixtures.map(rel => [rel, createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]));
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (git.status !== 0) throw new Error('Evaluation requires an exact Git revision');
const dirty = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8' });
if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error('Commit the package candidate before recording an exact-revision comparison');
fs.mkdirSync(out, { recursive: true });
const records = [];
for (let run = 1; run <= runs; run++) {
  const trace = path.join(out, `run-${run}.jsonl`), started = performance.now();
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(import.meta.dirname, 'observe.mjs')).href, '--test', '--test-concurrency=4', ...files], { cwd: root, env: { ...process.env, HARNESS_MECHANICS_TRACE: trace }, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  const wallMs = performance.now() - started;
  fs.writeFileSync(path.join(out, `run-${run}.tap`), result.stdout || '');
  fs.writeFileSync(path.join(out, `run-${run}.stderr`), result.stderr || '');
  const observations = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const count = name => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(result.stdout || '')?.[1] ?? NaN);
  const record = { run, exit: result.status, error: result.error?.message || null, tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), wallMs, observedSyncCalls: observations.length, stdoutBytes: observations.reduce((n, row) => n + row.stdoutBytes, 0), stderrBytes: observations.reduce((n, row) => n + row.stderrBytes, 0), modelTokens: null, agentRepairTurns: null, interventionFrequency: null };
  records.push(record);
  console.log(JSON.stringify(record));
  if (result.status !== 0 || record.failed !== 0 || !record.tests) break;
}
const report = { schema: 1, label: flags['--label'], lane, revision: git.stdout.trim(), node: process.version, platform: process.platform, fixtureHashes, testConcurrency: 4, records, pass: records.length === runs && records.every(row => row.exit === 0 && row.failed === 0), assurance: 'Synthetic mechanical regression trials. Counts include observed synchronous CLI/hook calls only. No model runs; tokens, agent repair turns and intervention frequency are unmeasured. Fixture judgments are authored test expectations, not semantic product evaluation.' };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.pass ? 0 : 1;
