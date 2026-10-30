import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeHookConfig } from '../lib/hosts/native-hook.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(packageRoot, 'lib/hosts/native-hook.mjs');

function fixture(t, configName = 'config home') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-native-hook-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), configHome = path.join(root, configName), skillsHome = path.join(root, 'skills'), home = path.join(root, 'state');
  fs.mkdirSync(workspace); fs.mkdirSync(configHome);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace }).status, 0);
  fs.writeFileSync(path.join(workspace, 'example.txt'), 'original\n');
  const run = (host, event, payload, extra = {}) => spawnSync(process.execPath, [bridge, '--host', host, '--event', event, '--config-home', configHome, '--skills-home', skillsHome, '--ae-home', home], {
    cwd: configHome, env: { ...process.env, AE_HOME: home, HARNESS_HOME: home }, encoding: 'utf8',
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), timeout: 15000, ...extra,
  });
  return { root, workspace, configHome, skillsHome, home, run };
}

test('native hook configuration uses each host dialect and preserves selected roots', () => {
  const roots = { configHome: '/tmp/native config', skillsHome: '/tmp/native skills', home: '/tmp/ae state', packageRoot };
  for (const host of ['claude-code', 'codex']) {
    const result = nativeHookConfig({ host, ...roots });
    assert.equal(result.path, host === 'codex' ? 'hooks.json' : 'settings.json');
    assert.ok(result.value.hooks.PreToolUse[0].hooks[0].command.includes('--skills-home'));
    assert.ok(result.value.hooks.PreToolUse[0].hooks[0].command.includes('--ae-home'));
    assert.ok(result.value.hooks.Stop);
    assert.equal(result.value.trust, undefined);
  }
  const cursor = nativeHookConfig({ host: 'cursor', ...roots });
  assert.equal(cursor.value.version, 1);
  assert.equal(cursor.value.hooks.preToolUse[0].failClosed, true);
  assert.equal(cursor.value.hooks.preToolUse[0].hooks, undefined);
  assert.ok(cursor.value.hooks.stop[0].command.includes('--event'));
  assert.throws(() => nativeHookConfig({ host: 'unknown', ...roots }), /Unsupported native host/);
});

for (const host of ['claude-code', 'codex', 'cursor']) test(`${host} denies unplanned native edits and binds workspace from payload, not hook cwd`, t => {
  const f = fixture(t);
  const result = f.run(host, 'pre', { cwd: f.workspace, session_id: 'native', tool_name: 'Write', tool_input: { file_path: path.join(f.workspace, 'example.txt'), content: 'changed\n' } });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  const reason = host === 'cursor' ? decision.agent_message : decision.hookSpecificOutput?.permissionDecisionReason;
  assert.match(reason, /missing-implement-gate/);
  assert.equal(host === 'cursor' ? decision.permission : decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'example.txt'), 'utf8'), 'original\n');
  assert.equal(fs.existsSync(path.join(f.configHome, '.harness')), false);
});

test('native read is admitted, but unknown and malformed pre payloads fail closed', t => {
  const f = fixture(t);
  const input = { cwd: f.workspace, session_id: 'native', tool_name: 'Read', tool_input: { file_path: path.join(f.workspace, 'example.txt') } };
  assert.equal(f.run('claude-code', 'pre', input).stdout.trim(), '{}');
  for (const payload of ['not JSON', {}, { ...input, cwd: 'relative' }, { ...input, tool_name: 'MysteryAction', tool_input: {} }, { ...input, tool_name: 'Bash', tool_input: {} }]) {
    const result = f.run('codex', 'pre', payload);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision, 'deny', result.stderr + result.stdout);
  }
});

test('generated command executes with quoted home paths and native workspace identity', t => {
  const f = fixture(t, "config ' quote $ home");
  const config = nativeHookConfig({ host: 'claude-code', ...f, packageRoot });
  const invoke = config.value.hooks.PreToolUse[0].hooks[0].command;
  const result = spawnSync(invoke, {
    shell: true, cwd: f.configHome, encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({ cwd: f.workspace, tool_name: 'Read', tool_input: { file_path: path.join(f.workspace, 'example.txt') } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '{}');
  assert.equal(fs.existsSync(path.join(f.configHome, '.harness')), false);
});

test('Codex apply_patch is treated as an edit rather than a read or shell exemption', t => {
  const f = fixture(t);
  const result = f.run('codex', 'pre', { cwd: f.workspace, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: example.txt\n@@\n-original\n+changed\n*** End Patch' } });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision, 'deny');
});

test('native shell execution directories cannot replace the payload workspace authority', t => {
  const f = fixture(t), foreign = path.join(f.root, 'foreign-product');
  fs.mkdirSync(foreign);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: foreign }).status, 0);
  for (const host of ['claude-code', 'codex', 'cursor']) {
    for (const field of ['working_directory', 'workdir', 'cwd']) {
      for (const directory of [foreign, path.relative(f.workspace, foreign)]) {
        const result = f.run(host, 'pre', { cwd: f.workspace, tool_name: host === 'cursor' ? 'Shell' : 'Bash', tool_input: { command: 'git -C . status', [field]: directory } });
        const output = JSON.parse(result.stdout);
        assert.match(host === 'cursor' ? output.agent_message : output.hookSpecificOutput?.permissionDecisionReason, /execution directory conflicts with native workspace/, `${host}/${field}/${directory}`);
      }
      const same = f.run(host, 'pre', { cwd: f.workspace, tool_name: 'Bash', tool_input: { command: 'pwd', [field]: '.' } });
      assert.equal(same.stdout.trim(), '{}');
    }
  }
});

test('known Codex delegation dispatch does not grant child edit authority', t => {
  const f = fixture(t);
  for (const name of ['spawn_agent', 'wait_agent', 'send_input', 'close_agent', 'resume_agent']) {
    const result = f.run('codex', 'pre', { cwd: f.workspace, session_id: 'parent', tool_name: name, tool_input: { agent_type: 'security-sentinel', message: 'Review only' } });
    assert.equal(result.stdout.trim(), '{}', name);
  }
  const child = f.run('codex', 'pre', { cwd: f.workspace, session_id: 'child', tool_name: 'Write', tool_input: { file_path: path.join(f.workspace, 'example.txt'), content: 'changed' } });
  assert.equal(JSON.parse(child.stdout).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'example.txt'), 'utf8'), 'original\n');
});

test('post hooks never synthesize complete skill-read evidence from success or missing output', t => {
  const f = fixture(t), skill = path.join(f.skillsHome, 'create-primitive/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, '# Full procedure\nRead all lines.\n');
  for (const response of [undefined, {}, { success: true }, { truncated: true, content: '# Full procedure\nRead all lines.\n' }]) {
    const result = f.run('claude-code', 'post', { cwd: f.workspace, session_id: 'native', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: skill }, tool_response: response });
    assert.equal(result.status, 0, result.stderr);
    const session = path.join(f.workspace, '.harness/session.json');
    assert.equal(fs.existsSync(session) ? JSON.parse(fs.readFileSync(session)).activatedSkills?.['create-primitive'] : undefined, undefined);
  }
});

for (const host of ['claude-code', 'codex', 'cursor']) test(`${host} binds an actual full skill read from a separately selected skills root`, t => {
  const f = fixture(t), skill = path.join(f.skillsHome, 'create-primitive/SKILL.md');
  const source = '# Full procedure\nRead all lines and preserve the source binding.\n';
  fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, source);
  const payload = {
    cwd: f.workspace, session_id: 'split-root-native', hook_event_name: host === 'cursor' ? 'postToolUse' : 'PostToolUse',
    tool_name: 'Read', tool_input: { file_path: skill },
    ...(host === 'cursor' ? { tool_output: JSON.stringify({ content: source }) } : { tool_response: { content: source } }),
  };
  const result = f.run(host, 'post', payload);
  assert.equal(result.status, 0, result.stderr);
  const session = JSON.parse(fs.readFileSync(path.join(f.workspace, '.harness/session.json'), 'utf8'));
  const activation = session.activatedSkills['create-primitive'];
  assert.equal(activation.complete, true);
  assert.equal(activation.sessionId, 'split-root-native');
  assert.equal(activation.source.path, fs.realpathSync.native(skill));
  assert.match(activation.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(f.configHome, 'skills/create-primitive/SKILL.md')), false);
});

test('Cursor stop is a bounded continuation hint, not a hard denial guarantee', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, '.harness'));
  fs.writeFileSync(path.join(f.workspace, '.harness/session.json'), JSON.stringify({ version: 1, lastEditAt: new Date().toISOString() }));
  const result = f.run('cursor', 'stop', { cwd: f.workspace, status: 'completed', loop_count: 0 });
  const output = JSON.parse(result.stdout);
  assert.equal(typeof output.followup_message, 'string');
  assert.equal(output.permission, undefined);
  assert.match(output.followup_message, /verification|verify/);
  for (const status of ['aborted', 'error']) {
    assert.deepEqual(JSON.parse(f.run('cursor', 'stop', { cwd: f.workspace, status }).stdout), {});
  }
});
