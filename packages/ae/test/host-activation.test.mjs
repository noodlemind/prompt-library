import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { normalizeToolPayload, toolMutationSucceeded } from '../corpus/hooks/lib/tool-payload.mjs';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { runGet } from '../lib/get-cmd.mjs';
import { afterDeliveryTool } from '../lib/agent-delivery.mjs';

const hook = path.resolve(import.meta.dirname, '../corpus/hooks/record-successful-edit.mjs');
const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
const body = '---\nname: create-primitive\n---\n# Create primitive\nRead the entire procedure.\n';
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, workspaceName = 'product') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-host-activation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, workspaceName), home = path.join(root, 'copilot'), state = path.join(root, 'ae');
  const source = path.join(home, 'skills/create-primitive/SKILL.md');
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, body);
  const env = { ...process.env, COPILOT_HOME: home, AE_HOME: state, HARNESS_HOME: state };
  const read = (input = { filePath: source }, result = { truncated: false }, extra = {}) => {
    const payload = { cwd: ws, session_id: 'host-session', tool_name: 'Read', tool_input: input, tool_response: result, ...extra };
    const run = spawnSync(process.execPath, [hook], { cwd: ws, env, input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const session = path.join(ws, '.harness/session.json');
    return fs.existsSync(session) ? JSON.parse(fs.readFileSync(session)).activatedSkills?.['create-primitive'] : undefined;
  };
  return { root, ws, home, state, source, env, read };
}

test('documented CLI camel and VS Code compatible envelopes preserve tool effects', () => {
  for (const [native, canonical] of [['bash', 'Bash'], ['powershell', 'Bash'], ['view', 'Read'], ['create', 'Write']]) {
    const args = native === 'bash' || native === 'powershell' ? { command: 'rm -rf tmp/output' } : { path: 'src/app.js' };
    const camel = normalizeToolPayload({ toolName: native, toolArgs: args });
    const snake = normalizeToolPayload({ tool_name: canonical, tool_input: args });
    assert.equal(camel.mutation, snake.mutation, native);
    assert.deepEqual(camel.targets, snake.targets, native);
    assert.equal(camel.command, snake.command, native);
  }
});

test('explicit result failures in either documented CLI envelope never count as success', () => {
  for (const payload of [{ tool_result: { result_type: 'failure' } }, { toolResult: { resultType: 'failure' } }, { hookEventName: 'postToolUseFailure' }]) {
    assert.equal(toolMutationSucceeded(payload), false, JSON.stringify(payload));
  }
});

test('conflicting documented request aliases remain opaque rather than choosing a harmless interpretation', () => {
  const normalized = normalizeToolPayload({ tool_name: 'Read', toolName: 'bash', tool_input: { path: 'src/app.js' }, toolArgs: { command: 'rm -rf tmp/output' } });
  assert.equal(normalized.mutation, true);
  assert.equal(normalized.terminalEffects.hasOpaque, true);
});

for (const camel of [false, true]) test(`installed full skill read in documented CLI ${camel ? 'camel' : 'snake'} output binds actual source bytes`, t => {
  const f = fixture(t);
  const extra = camel
    ? { tool_name: undefined, tool_input: undefined, tool_response: undefined, toolName: 'view', toolArgs: { path: f.source }, toolResult: { resultType: 'success', textResultForLlm: body } }
    : { tool_response: undefined, tool_result: { result_type: 'success', text_result_for_llm: body } };
  const activation = f.read(undefined, undefined, extra);
  assert.equal(activation?.complete, true);
  assert.equal(activation.source.path, fs.realpathSync.native(f.source));
  assert.equal(activation.source.sha256, hash(body));
});

test('a look-alike repository workflow cannot establish installed skill activation', t => {
  const f = fixture(t), decoy = path.join(f.ws, 'tmp/skills/create-primitive/SKILL.md');
  fs.mkdirSync(path.dirname(decoy), { recursive: true }); fs.writeFileSync(decoy, body);
  assert.notEqual(f.read({ filePath: decoy })?.complete, true);
});

test('a native relative repository decoy cannot borrow installed source identity', t => {
  const f = fixture(t), decoy = path.join(f.ws, 'skills/create-primitive/SKILL.md');
  fs.mkdirSync(path.dirname(decoy), { recursive: true }); fs.writeFileSync(decoy, body);
  assert.notEqual(f.read({ path: 'skills/create-primitive/SKILL.md' })?.complete, true);
});

test('an actual workspace path containing skills does not prevent an installed workflow read', t => {
  const f = fixture(t, 'skills/project');
  assert.equal(f.read()?.complete, true);
});

test('headless read bytes changing before post-record cannot establish activation', t => {
  const f = fixture(t);
  const read = runGet({ workspace: f.ws, copilotHome: f.home, flags: { path: 'skills/create-primitive/SKILL.md', lines: 500, maxBytes: 20000 } });
  assert.equal(read.truncated, false);
  Object.assign(read, { status: 'ok', exitCode: 0 });
  fs.appendFileSync(f.source, 'Changed after the read.\n');
  const recorded = afterDeliveryTool({ name: 'read', input: { path: 'skills/create-primitive/SKILL.md' } }, read, { workspace: f.ws, copilotHome: f.home, harnessHome: f.state, sessionId: 'headless' });
  assert.equal(recorded.pass, true);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/session.json')), false);
});

test('a different Copilot home cannot supply the selected workflow activation', t => {
  const f = fixture(t), other = path.join(f.root, 'other-home/skills/create-primitive/SKILL.md');
  fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, body);
  assert.notEqual(f.read({ filePath: other })?.complete, true);
});

test('a hydrated hook cannot activate its old home after a different home is selected', t => {
  const f = fixture(t), selected = path.join(f.root, 'selected-home');
  fs.cpSync(path.dirname(hook), path.join(f.home, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(selected, 'skills/create-primitive'), { recursive: true });
  fs.writeFileSync(path.join(selected, 'skills/create-primitive/SKILL.md'), body);
  const result = spawnSync(process.execPath, [path.join(f.home, 'hooks/record-successful-edit.mjs')], {
    cwd: f.ws, env: { ...f.env, COPILOT_HOME: selected }, encoding: 'utf8',
    input: JSON.stringify({ cwd: f.ws, session_id: 'host', tool_name: 'Read', tool_input: { filePath: f.source }, tool_response: { truncated: false } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/session.json')), false);
});

test('a custom hydrated hook resolves its own profile when no home override is set', t => {
  const f = fixture(t), env = { ...f.env };
  delete env.COPILOT_HOME;
  fs.cpSync(path.dirname(hook), path.join(f.home, 'hooks'), { recursive: true });
  const result = spawnSync(process.execPath, [path.join(f.home, 'hooks/record-successful-edit.mjs')], {
    cwd: f.ws, env, encoding: 'utf8',
    input: JSON.stringify({ cwd: f.ws, session_id: 'host', tool_name: 'Read', tool_input: { filePath: f.source }, tool_response: { truncated: false } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.ws, '.harness/session.json'))).activatedSkills['create-primitive'].source.sha256, hash(body));
});

test('a symlinked workflow cannot stand in for the selected source', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside.md');
  fs.writeFileSync(outside, body); fs.unlinkSync(f.source);
  try { fs.symlinkSync(outside, f.source); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('host does not permit a file symlink'); throw error; }
  assert.notEqual(f.read()?.complete, true);
});

for (const input of [{ startLine: 1, endLine: 1 }, { view_range: [1, 2] }, { offset: 2 }, { lines: 1 }, { offset: 1, limit: 1 }]) {
  test(`a complete response to a partial requested skill range is not complete activation ${JSON.stringify(input)}`, t => {
    const f = fixture(t);
    assert.notEqual(f.read({ filePath: f.source, ...input })?.complete, true);
  });
}

test('full source range and numbered CLI returned content can establish complete activation', t => {
  const f = fixture(t);
  const numbered = body.trimEnd().split('\n').map((line, index) => `${index + 1}. ${line}`).join('\n');
  assert.equal(f.read({ filePath: f.source, startLine: 1, endLine: 500 }, undefined, { tool_response: undefined, tool_result: { result_type: 'success', text_result_for_llm: numbered } })?.complete, true);
});

test('failed or truncated official CLI skill output cannot activate a workflow', t => {
  const f = fixture(t);
  for (const result of [{ result_type: 'failure', text_result_for_llm: body }, { result_type: 'success', text_result_for_llm: body.slice(0, 10) }, { result_type: 'success', text_result_for_llm: body, truncated: true }]) {
    assert.notEqual(f.read(undefined, undefined, { tool_response: undefined, tool_result: result })?.complete, true);
  }
});

test('a completeness flag cannot override different returned bytes or a different read hash', t => {
  const f = fixture(t);
  assert.notEqual(f.read(undefined, { truncated: false, content: body.split('\n')[0] })?.complete, true);
  assert.notEqual(f.read(undefined, { truncated: false, sha256: hash('another version') })?.complete, true);
});

test('structured or unsupported returned bodies cannot hide clipped skill contents', t => {
  for (const content of [[{ type: 'text', text: 'Only a clipped first line' }], { unexpected: body }, [{ type: 'image', text: body }], null, 5]) {
    const f = fixture(t);
    assert.notEqual(f.read(undefined, { truncated: false, content })?.complete, true, JSON.stringify(content));
  }
});

test('recognized full text blocks preserve complete native reads', t => {
  for (const content of [[{ type: 'text', text: body }], [{ type: 'text', text: body.slice(0, 12) }, { type: 'text', text: body.slice(12) }]]) {
    const f = fixture(t);
    assert.equal(f.read(undefined, { truncated: false, content })?.complete, true);
  }
});

test('all present textual result aliases must prove the current complete source', t => {
  const f = fixture(t);
  assert.notEqual(f.read(undefined, { truncated: false, content: [{ type: 'text', text: 'Only first line' }], textResultForLlm: body })?.complete, true);
});

test('a name-only skill tool cannot establish activation from its name or hash alone', t => {
  for (const response of [undefined, { truncated: false }, { truncated: false, sha256: hash(body) }]) {
    const f = fixture(t);
    assert.notEqual(f.read(undefined, undefined, { tool_name: 'read_skill', tool_input: { name: 'create-primitive' }, tool_response: response, success: true })?.complete, true);
  }
});

test('a name-only skill read may establish activation from observed complete current text', t => {
  const f = fixture(t);
  const result = f.read(undefined, undefined, { tool_name: 'read_skill', tool_input: { name: 'create-primitive' }, tool_response: { content: [{ type: 'text', text: body }] }, success: true });
  assert.equal(result?.complete, true);
  assert.equal(result.source.sha256, hash(body));
});

test('changed workflow bytes invalidate a recorded activation before plan provenance amendment', t => {
  const f = fixture(t), plan = writeVersionedPlan(f.ws, { taskChecked: false });
  initGit(f.ws); spawnSync('git', ['checkout', '-b', 'feature/activation'], { cwd: f.ws });
  const full = path.join(f.ws, plan);
  const decision = (action, extra = {}) => ({ version: 1, id: action, action, expect: hash(fs.readFileSync(full)), ...extra });
  const op = input => spawnSync(process.execPath, [bin, 'plan-update', '--plan', plan, '--file', '-', '--workspace', f.ws, '--copilot-home', f.home, '--ae-home', f.state, '--json'], { cwd: f.ws, env: f.env, encoding: 'utf8', input: JSON.stringify(input) });
  const start = op(decision('start')); assert.equal(start.status, 0, start.stdout + start.stderr);
  const session = JSON.parse(fs.readFileSync(path.join(f.ws, '.harness/session.json')));
  assert.equal(f.read(undefined, undefined, { session_id: session.sessionId })?.complete, true);
  fs.appendFileSync(f.source, 'Changed instructions.\n');
  const amended = op(decision('amend', { rationale: 'Record the actual workflow used.', changes: { skillsUsed: ['create-primitive'] } }));
  assert.notEqual(amended.status, 0, amended.stdout + amended.stderr);
  assert.match(amended.stdout + amended.stderr, /read|source|activation/);
  assert.equal(f.read(undefined, undefined, { session_id: session.sessionId })?.complete, true);
  const reread = op(decision('amend', { id: 'amend-after-reread', rationale: 'Record the current workflow after an actual reread.', changes: { skillsUsed: ['create-primitive'] } }));
  assert.equal(reread.status, 0, reread.stdout + reread.stderr);
});
