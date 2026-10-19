#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runStudy } from './study.mjs';
import { PROVIDERS } from '../../lib/provider.mjs';

const args = process.argv.slice(2);
const options = {};
const allowed = ['out', 'provider', 'model', 'split', 'repeats', 'policies', 'retention-policy'];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--live') { options.live = true; continue; }
  const name = args[i].slice(2);
  if (!args[i].startsWith('--') || !allowed.includes(name) || options[name] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid argument: ${args[i]}`);
  options[name] = args[++i];
}
if (!options.out) throw new Error('--out <new-external-directory> is required');
const out = path.resolve(options.out);
const checkout = path.resolve(import.meta.dirname, '../../../..');
if (fs.existsSync(out) || !path.relative(checkout, out).startsWith(`..${path.sep}`)) throw new Error('--out must be a new directory outside the checkout');
if (options.live && (!Object.hasOwn(PROVIDERS, options.provider) || !options.model || options.model.toLowerCase() === 'auto')) throw new Error('live runs require an explicit provider and an exact available model; no fallback is selected');
const split = options.split || 'all';
if (!['all', 'development', 'held-out'].includes(split)) throw new Error('split must be all, development or held-out');
const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'cases.json'), 'utf8'));
const cases = catalog.cases.filter(task => split === 'all' || task.split === split);
const bin = path.resolve(import.meta.dirname, '../../bin/harness.mjs');

function execute({ task, workspace, copilotHome, harnessHome, policy, model, protocol }) {
  const env = { ...process.env, COPILOT_HOME: copilotHome, HARNESS_HOME: harnessHome };
  const common = ['--workspace', workspace, '--copilot-home', copilotHome, '--harness-home', harnessHome, '--no-events', '--json'];
  const setup = spawnSync(process.execPath, [bin, 'config', 'set', 'agent.enabled', 'true', '--scope', 'user', ...common], { env, encoding: 'utf8', timeout: 15_000 });
  if (setup.status !== 0) throw new Error(`fixture configuration failed: ${setup.stderr?.slice(0, 1000)}`);
  const prompt = `${task.prompt}\nAllowed changed files: ${task.editable.join(', ')}. Preserve all other files. Independently check your changes before finishing.`;
  const result = spawnSync(process.execPath, [bin, 'agent', prompt, '--profile', 'autonomous', '--provider', options.provider, '--model', model,
    '--max-turns', String(protocol.maxTurns), '--max-seconds', String(protocol.maxSeconds), '--context-policy', policy, '--retention-policy', protocol.retentionPolicy,
    ...task.seeds.flatMap(file => ['--file', file]), ...common], { cwd: workspace, env, encoding: 'utf8', timeout: (protocol.maxSeconds + 30) * 1000, maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw new Error(`agent process failed: ${result.error.code}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error(`agent returned no result (exit ${result.status}): ${result.stderr?.slice(0, 1000)}`); }
  return parsed;
}

const result = await runStudy({ root: out, cases, dryRun: !options.live, execute, model: options.model || null,
  host: options.live ? `cli:${options.provider}` : 'dry-run',
  ...(options.repeats ? { repeats: Number(options.repeats) } : {}),
  ...(options.policies ? { policies: options.policies.split(',') } : {}),
  ...(options['retention-policy'] ? { retentionPolicy: options['retention-policy'] } : {}),
});
console.log(JSON.stringify({ output: out, ...result.summary }, null, 2));
