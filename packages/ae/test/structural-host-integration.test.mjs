import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseFlags } from '../lib/flags.mjs';
import { parseQueryFromArgv } from '../lib/argv.mjs';
import { buildLearningsLines } from '../lib/context-pack.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');

test('explicit question kind is validated and excluded from task text', () => {
  const argv = ['--question-kind', 'change-impact', '--context-version', '2', '--read', 'retry', 'processing'];
  const flags = parseFlags(argv);
  assert.equal(flags.questionKind, 'change-impact');
  assert.equal(parseQueryFromArgv(argv, flags), 'retry processing');
  assert.throws(() => parseFlags(['--question-kind', 'invented']), /question-kind/);
  assert.throws(() => parseFlags(['--question-kind']), /question-kind/);
});

test('memory display retains applicability warnings alongside historical status', () => {
  const lines = buildLearningsLines([{ id: 'L1', trigger: 'retry', claimLine: 'Use bounded retries', status: 'active', applicability: { state: 'needs-review' } }]);
  assert.match(lines.join('\n'), /applicability: needs-review/);
  assert.match(lines.join('\n'), /untrusted memory/);
});

test('SessionStart keeps v2 graph and source coverage rather than discarding the envelope', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-session-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, 'fake-cli.mjs');
  const argsFile = path.join(root, 'args.json');
  const slice = { neighborhood: null, graph: { commands: ['ae graph impact'], scope: 'git-tracked-source' }, learnings: [], skills: [], instructions: [], contacts: [], index: {}, gateStatus: 'blocked', activePlan: null };
  fs.writeFileSync(fake, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(${JSON.stringify(JSON.stringify({ schema: 'harness.context.v2', contextId: 'bound-context', slice, evidence: [], coverage: { sourceState: 'validated', renderBarrier: false } }))});\n`);
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../corpus/hooks/load-context.mjs')], { cwd: root, env: { ...process.env, HARNESS_BIN: fake }, input: JSON.stringify({ workspace: root }), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const returned = JSON.parse(output.additionalContext.split('harness-orient-slice: ')[1]);
  assert.deepEqual(returned.graph, slice.graph);
  assert.equal(returned.contextEvidence?.contextId, 'bound-context');
  assert.equal(returned.contextEvidence?.coverage.sourceState, 'validated');
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.equal(args[args.indexOf('--context-version') + 1], '2');
});

test('explicit impact orientation returns current bounded evidence in every JSON lane', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-impact-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace);
  const env = { ...process.env, AE_HOME: path.join(root, 'home'), COPILOT_HOME: path.join(root, 'copilot'), HARNESS_NO_EVENTS: '1', NODE_USE_ENV_PROXY: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const args of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) assert.equal(spawnSync('git', args, { cwd: workspace, env }).status, 0);
  fs.writeFileSync(path.join(workspace, 'caller.mjs'), "import { process } from './processor.mjs';\nexport function submit() { return process(); }\n");
  fs.writeFileSync(path.join(workspace, 'processor.mjs'), 'export function process() { return 1; }\n');
  for (const args of [['add', '.'], ['commit', '-qm', 'fixture']]) assert.equal(spawnSync('git', args, { cwd: workspace, env }).status, 0);
  for (const lane of ['json', 'json-envelope']) {
    const result = spawnSync(process.execPath, [bin, 'orient', '--read', '--context-version', '2', '--question-kind', 'change-impact', '--file', 'processor.mjs', '--query', 'change retry processing', ...(lane === 'json' ? ['--json'] : ['--output', lane])], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const value = JSON.parse(result.stdout);
    const packet = value.slice?.impactContext;
    assert.equal(packet?.schema, 'harness.change-impact.v1');
    assert.equal(packet.questionKind, 'change-impact');
    assert.equal(packet.authority, 'descriptive-context');
    assert.ok(packet.sources.some(source => source.location === 'caller.mjs'));
    assert.equal(packet.coverage.sourceState, 'validated');
  }
});
