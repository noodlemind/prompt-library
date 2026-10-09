#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };
const authored = (value, max) => typeof value === 'string' && value.trim() && !/^TODO\b/i.test(value) && value.length <= max;

function argumentsOf(argv) {
  const names = new Set(['--workspace', '--copilot-home', '--plan', '--map', '--stage', '--harness-home']);
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!names.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || flags[argv[i]]) fail('Use --workspace, --copilot-home, --plan, --map and --stage broken|fixed; optional --harness-home');
    flags[argv[i]] = argv[++i];
  }
  for (const name of ['--workspace', '--copilot-home', '--plan', '--map', '--stage']) if (!flags[name]) fail(`Missing ${name}`);
  if (!['broken', 'fixed'].includes(flags['--stage'])) fail('Stage must be broken or fixed');
  return flags;
}

function main() {
  const flags = argumentsOf(process.argv.slice(2)), workspace = path.resolve(flags['--workspace']), copilotHome = path.resolve(flags['--copilot-home']);
  const inside = path.relative(workspace, copilotHome);
  if (!inside || (!inside.startsWith('..') && !path.isAbsolute(inside))) fail('Use a separate installed home outside the product workspace');
  const bin = path.join(copilotHome, '.harness-bin/bin/harness.mjs'), hook = path.join(copilotHome, 'hooks/require-verification.mjs');
  for (const file of [bin, hook]) if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) fail('Install the built Harness package into the selected home first');
  const env = { ...process.env, COPILOT_HOME: copilotHome };
  if (flags['--harness-home']) env.HARNESS_HOME = path.resolve(flags['--harness-home']);
  delete env.HARNESS_BIN;
  const observations = [];
  const run = (family, args = [], input) => {
    const result = spawnSync(process.execPath, family === 'Stop' ? [hook] : [bin, family, ...args, '--workspace', workspace, '--copilot-home', copilotHome, '--json', ...(flags['--harness-home'] ? ['--harness-home', flags['--harness-home']] : [])], { cwd: workspace, env, input, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    let value;
    try { value = JSON.parse(result.stdout); } catch { fail(`${family} did not return bounded JSON (exit ${result.status}): ${String(result.stderr || result.stdout).slice(0, 500)}`); }
    if (result.error) fail(`${family} failed: ${result.error.message}`);
    observations.push({ operation: family, exit: result.status, digest: hash(value), bytes: Buffer.byteLength(result.stdout) });
    return { exit: result.status, value };
  };
  const mapRead = run('get', ['--path', flags['--map'], '--max-bytes', '65536', '--lines', '10000']);
  if (mapRead.exit !== 0 || mapRead.value.truncated) fail('Feature map is unavailable, unsafe or exceeds the input bound');
  let map;
  try { map = JSON.parse(mapRead.value.excerpt); } catch { fail('Feature map must be JSON'); }
  if (map?.schema !== 1 || Object.keys(map).some(k => !['schema', 'product', 'environment', 'flow'].includes(k)) || !authored(map.product, 256) || !authored(map.environment, 256)) fail('Feature map needs schema1, authored product/environment and one flow');
  const flow = map.flow;
  if (!flow || Object.keys(flow).some(k => !['id', 'acceptance', 'checks'].includes(k)) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(flow.id || '') || !authored(flow.acceptance, 4096) || !Array.isArray(flow.checks) || !flow.checks.length || flow.checks.length > 32 || flow.checks.some(c => !authored(c, 100))) fail('Flow needs a stable id, observable acceptance and 1–32 named checks');
  const doctor = run('doctor');
  const stage = flags['--stage'];
  const execution = stage === 'broken' ? run('verify', ['--plan', flags['--plan']]) : run('status', ['--validate-evidence', '--plan', flags['--plan']]);
  const facts = run('report', ['--facts', '--plan', flags['--plan'], '--max-bytes', '16384']);
  let verification = execution.value;
  if (stage === 'fixed' && facts.value.work?.proof?.source) {
    const source = facts.value.work.proof.source;
    const observed = run('get', ['--path', source.path, '--max-bytes', '65536', '--lines', '10000']);
    if (observed.exit !== 0 || observed.value.truncated || observed.value.sha256 !== source.sha256) fail('Executed proof is unavailable, changed or exceeds the retrieval bound');
    try { verification = JSON.parse(observed.value.excerpt); } catch { fail('Executed proof must be JSON'); }
  }
  const stop = run('Stop', [], JSON.stringify({ cwd: workspace, hook_event_name: 'Stop' }));
  const checks = flow.checks.map(name => ({ name, result: verification.checks?.find(check => check.id === name)?.status || 'unavailable' }));
  const stopDecision = stop.value.hookSpecificOutput?.decision === 'block' ? 'block' : stop.exit === 0 && stop.value.continue === true ? 'allow' : 'unavailable';
  const pass = doctor.exit === 0 && facts.exit === 0 && stop.exit === 0 && (stage === 'broken'
    ? verification.outcome !== 'passed' && checks.some(c => c.result === 'failed') && stopDecision === 'block'
    : execution.exit === 0 && execution.value.pass === true && verification.outcome === 'passed' && checks.every(c => c.result === 'passed') && facts.value.work?.proof?.pass === true && facts.value.work?.completion?.pass === true && stopDecision === 'allow');
  const result = { schema: 1, status: pass ? 'ok' : 'failed', pass, stage, flow: flow.id, product: map.product, environment: map.environment, mapSource: { path: flags['--map'], sha256: mapRead.value.sha256 }, installedRuntime: bin, installation: 'installed runtime invoked; clean-home provenance requires the install journey', doctor: doctor.value, proofOperation: stage === 'broken' ? 'executed verification' : 'validated bound execution record', verifyOutcome: verification.outcome, checks, stopDecision, work: facts.value.work, observations, liveHost: 'unverified', adequacy: 'agent must assess whether the product adapter proves this acceptance flow' };
  if (Buffer.byteLength(JSON.stringify(result)) > 16383) fail('Proof summary exceeds16KiB; retrieve underlying records');
  console.log(JSON.stringify(result));
  process.exitCode = pass ? 0 : 1;
}

try { main(); } catch (error) {
  console.log(JSON.stringify({ schema: 1, status: 'failed', pass: false, reason: String(error.message).slice(0, 1000), liveHost: 'unverified' }));
  process.exitCode = 1;
}
