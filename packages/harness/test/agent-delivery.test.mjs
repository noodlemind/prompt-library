import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DELIVER_AGENT_TOOLS, DELIVER_PROFILE, buildSystemPrompt, runAgentLoop } from '../lib/agent-loop.mjs';
import { approveProject, trustStatus } from '../lib/trust.mjs';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { cliHarnessHome } from './helpers/cli.mjs';

process.env.HARNESS_HOME = cliHarnessHome();
const bin = path.resolve(import.meta.dirname, '../bin/harness.mjs');
const persona = { name: 'engineer', text: fs.readFileSync(path.resolve(import.meta.dirname, '../corpus/agents/engineer.agent.md'), 'utf8') };
const say = text => ({ text, toolCalls: [] });
const call = (name, input) => ({ text: '', toolCalls: [{ id: 'call', name, input }] });

function fixture(t, { gated = false, reviewRequired = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-delivery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws'), home = path.join(root, 'copilot');
  fs.mkdirSync(ws); fs.mkdirSync(home);
  const plan = writeVersionedPlan(ws);
  if (reviewRequired) fs.writeFileSync(path.join(ws, plan), fs.readFileSync(path.join(ws, plan), 'utf8').replace('required: []', 'required: [code-review]'));
  initGit(ws);
  assert.equal(spawnSync('git', ['checkout', '-b', 'feature/delivery'], { cwd: ws }).status, 0);
  approveProject({ workspace: ws, copilotHome: home });
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', ws, '--copilot-home', home, '--harness-home', process.env.HARNESS_HOME, '--json', '--no-events'], { cwd: ws, encoding: 'utf8' });
  if (gated) {
    assert.equal(cli('orient', '--read', '--query', 'Change the example.', '--file', 'src/example.js').status, 0);
    assert.equal(cli('gate', '--phase', 'implement', '--plan', plan).status, 0);
  }
  const requests = [];
  const run = (script, maxTurns = script.length) => {
    let cursor = 0;
    return runAgentLoop({ task: 'Change the product and prove it.', workspace: ws, copilotHome: home, persona, profile: DELIVER_PROFILE, maxTurns, maxSeconds: 60,
      startProviderFn: () => ({ async complete(request) {
        requests.push(request);
        const step = script[cursor++];
        return { ...(typeof step === 'function' ? await step(request) : step || say('done')), blocks: [], usage: {} };
      }, close() {} }),
    });
  };
  return { ws, home, plan, cli, run, requests };
}

test('Deliver retains the engineer completion rules and exposes lifecycle commands', () => {
  const system = buildSystemPrompt({ persona, profile: DELIVER_PROFILE });
  assert.match(system, /For changed work, run/);
  assert.match(system, /fresh Harness proof before completion/);
  assert.match(system, /--query/);
  assert.ok(DELIVER_AGENT_TOOLS.some(tool => tool.name === 'harness'));
});

for (const [name, input] of [
  ['edit', { path: '.github/harness/checks.yaml', old: 'version: 1', new: 'version: 2' }],
  ['write', { path: 'src/new.js', content: 'export const value = 2;\n' }],
  ['apply', { changes: [{ path: 'src/example.js', old: 'value = 1', new: 'value = 2' }] }],
  ['bash', { script: 'echo changed > src/example.js' }],
]) test(`Deliver refuses ${name} before an explicit implement gate`, async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.ws, '.github/harness/checks.yaml'), 'utf8');
  const result = await f.run([call(name, input), say('done')]);
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /implement.gate/i);
  assert.equal(fs.readFileSync(path.join(f.ws, '.github/harness/checks.yaml'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.ws, 'src/new.js')), false);
  assert.match(fs.readFileSync(path.join(f.ws, 'src/example.js'), 'utf8'), /value = 1/);
  assert.equal(trustStatus({ workspace: f.ws, copilotHome: f.home }).state, 'trusted');
  assert.notEqual(result.status, 'ok');
});

test('Deliver refuses files outside the orient read list, including atomic apply', async t => {
  const f = fixture(t, { gated: true });
  const sessionFile = path.join(f.ws, '.harness/session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile));
  fs.writeFileSync(sessionFile, JSON.stringify({ ...session, files: ['src/other.js'] }));
  const result = await f.run([call('apply', { changes: [{ path: 'src/example.js', old: 'value = 1', new: 'value = 2' }] }), say('done')]);
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /orient.*file list/);
});

test('a passed implement gate does not replace explicit orientation with touched files', async t => {
  const f = fixture(t, { gated: true });
  const file = path.join(f.ws, '.harness/session.json');
  const session = JSON.parse(fs.readFileSync(file));
  delete session.lastOrientReadAt;
  fs.writeFileSync(file, JSON.stringify({ ...session, files: [] }));
  const result = await f.run([call('edit', { path: 'src/example.js', old: 'value = 1', new: 'value = 2' }), say('done')]);
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /missing-orient-read/);
});

test('Deliver cannot approve trust through exec, bash or the lifecycle tool', async t => {
  const f = fixture(t);
  const script = [
    call('exec', { argv: [process.execPath, bin, 'trust', 'approve'] }),
    call('bash', { script: 'harness trust approve' }),
    call('harness', { argv: ['trust', 'approve'] }), say('done'),
  ];
  const result = await f.run(script);
  for (const turn of result.turns.slice(0, 3)) {
    assert.equal(turn.tools[0].dispatched, false);
    assert.match(turn.tools[0].reason, /person|human/i);
  }
});

test('a no-tool final without a plan cannot count as Deliver success', async t => {
  const f = fixture(t);
  const result = await f.run([say('done')]);
  assert.equal(result.stopReason, 'delivery-incomplete');
  assert.equal(result.status, 'failed');
});

test('malformed execution arguments return a refusal without crashing Deliver', async t => {
  const f = fixture(t);
  const result = await f.run([call('exec', { argv: 'not-an-array' }), say('blocked')]);
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /argv/);
  assert.equal(result.status, 'failed');
});

test('failed verify and uncollected review cannot count as Deliver success', async t => {
  const f = fixture(t, { gated: true });
  const planFile = path.join(f.ws, f.plan);
  fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replace('required: []', 'required: [code-review]'));
  const result = await f.run([call('harness', { argv: ['verify', '--plan', f.plan, '--base', 'HEAD'] }), say('Verification failed, stopping.')]);
  assert.equal(result.turns[0].tools[0].status, 'failed');
  assert.equal(result.stopReason, 'delivery-incomplete');
  assert.equal(result.status, 'failed');
});

test('passed verify still requires compounding and bound completion; repair can continue', async t => {
  const f = fixture(t, { gated: true, reviewRequired: true });
  const result = await f.run([
    call('edit', { path: 'src/example.js', old: 'value = 1', new: 'value = 2' }),
    call('harness', { argv: ['review', 'prepare', '--plan', f.plan, '--base', 'HEAD'] }),
    () => {
      const packets = path.join(f.ws, '.harness/reviews/packets');
      const packet = JSON.parse(fs.readFileSync(path.join(packets, fs.readdirSync(packets)[0])));
      return call('harness', { argv: ['review', 'assemble', '--plan', f.plan, '--packet', packet.id], decision: { packet: packet.id, results: packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: ['Scripted fixture judgment; no model quality claim.'], testing_gaps: [] })) } });
    },
    call('harness', { argv: ['verify', '--plan', f.plan, '--base', 'HEAD'] }),
    say('done'),
    call('harness', { argv: ['compound', '--plan', f.plan], decision: { operation: 'no-learning', decision: 'no-learning', rationale: 'Synthetic fixture has no durable lesson.' } }),
    () => call('harness', { argv: ['plan-update', '--plan', f.plan], decision: { version: 1, id: 'complete', action: 'complete', expect: createHash('sha256').update(fs.readFileSync(path.join(f.ws, f.plan))).digest('hex') } }),
    say('complete'),
  ]);
  assert.equal(result.status, 'ok', result.detail);
  assert.equal(result.stopReason, 'done');
  assert.ok(f.requests.some(request => request.messages.some(message => /Completion blocked/.test(message.text || ''))));
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.ws, '.harness/session.json'))).lastEditAt);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 3;\n');
  const stale = await f.run([say('done')]);
  assert.equal(stale.stopReason, 'delivery-incomplete');
});

test('a completed legacy plan cannot omit code review for changed Deliver work', async t => {
  const f = fixture(t, { gated: true });
  const result = await f.run([
    call('edit', { path: 'src/example.js', old: 'value = 1', new: 'value = 2' }),
    call('harness', { argv: ['verify', '--plan', f.plan, '--base', 'HEAD'] }),
    call('harness', { argv: ['compound', '--plan', f.plan], decision: { operation: 'no-learning', decision: 'no-learning', rationale: 'Synthetic fixture has no durable lesson.' } }),
    () => call('harness', { argv: ['plan-update', '--plan', f.plan], decision: { version: 1, id: 'complete', action: 'complete', expect: createHash('sha256').update(fs.readFileSync(path.join(f.ws, f.plan))).digest('hex') } }),
    say('complete'),
  ]);
  assert.equal(result.stopReason, 'delivery-incomplete');
  assert.match(result.stopDetail, /code.review/i);
});

test('an authorized pinned-policy edit stays stale until a person approves it', async t => {
  const f = fixture(t);
  const policyFile = '.github/harness/checks.yaml';
  const planFile = path.join(f.ws, f.plan);
  fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replace('`src/example.js`', `\u0060${policyFile}\u0060`));
  assert.equal(f.cli('orient', '--read', '--query', 'Update the check configuration.', '--file', policyFile).status, 0);
  assert.equal(f.cli('gate', '--phase', 'implement', '--plan', f.plan).status, 0);
  const result = await f.run([
    call('edit', { path: policyFile, old: 'version: 1', new: 'version: 2' }),
    call('harness', { argv: ['verify', '--plan', f.plan, '--base', 'HEAD'] }), say('Approval needed.'),
  ]);
  assert.equal(result.turns[0].tools[0].status, 'ok');
  assert.equal(result.turns[1].tools[0].status, 'failed');
  assert.equal(trustStatus({ workspace: f.ws, copilotHome: f.home }).state, 'stale');
  assert.equal(result.status, 'failed');
});

test('orient without --file exposes constraints, trust and the planned import neighborhood', t => {
  const f = fixture(t, { gated: true });
  fs.writeFileSync(path.join(f.ws, f.plan), fs.readFileSync(path.join(f.ws, f.plan), 'utf8') + '\n## Constraints\n- Do not wait for a full rebuild\n');
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), "import { publish } from './publish.js';\nexport const value = publish();\n");
  fs.writeFileSync(path.join(f.ws, 'src/publish.js'), 'export function publish() { return 1; }\n');
  assert.equal(spawnSync('git', ['add', 'src'], { cwd: f.ws }).status, 0);
  for (const read of [false, true]) {
    const result = f.cli('orient', ...(read ? ['--read'] : []), '--query', 'keep products searchable', '--plan', f.plan);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(output.planGoal.constraints.includes('Do not wait for a full rebuild'));
    assert.equal(output.trust.state, 'trusted');
    assert.ok(output.neighborhood.files.some(file => file.rel === 'src/publish.js'));
  }
});
