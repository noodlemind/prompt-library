import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { coerceValue, setConfigValue } from '../lib/config.mjs';
import {
  applyModelPreferences,
  effortForRole,
  hostModelValue,
  resolveRoleModel,
  roleForAgent,
  setCopilotModel,
} from '../lib/model-preferences.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const corpusAgents = path.join(packageRoot, 'corpus', 'agents');

test('each host renders its native model field and inherit omits it', () => {
  assert.equal(roleForAgent('java-reviewer.agent.md'), 'reviewer');
  assert.equal(roleForAgent('agents\\repo-research-analyst.agent.md'), 'researcher');
  assert.equal(roleForAgent('code-implementer.agent.md'), 'specialist');
  assert.equal(effortForRole('reviewer'), 'high');
  assert.equal(effortForRole('researcher'), 'low');
  const values = { 'models.reviewer': 'claude-opus-5', 'models.researcher': 'inherit', 'models.low': 'claude-haiku-4-5' };
  assert.equal(resolveRoleModel(values, 'reviewer'), 'claude-opus-5');
  assert.equal(resolveRoleModel(values, 'researcher'), null);
  assert.equal(resolveRoleModel(values, 'specialist'), 'claude-haiku-4-5');
  assert.equal(hostModelValue('copilot', 'claude-opus-5', 'high'), 'claude-opus-5');
  assert.equal(hostModelValue('copilot', 'Gemini 3 Flash (Preview)', 'high'), null);
  assert.equal(hostModelValue('claude', 'Gemini 3 Flash (Preview)', 'low'), 'Gemini 3 Flash (Preview)');
  assert.equal(hostModelValue('cursor', 'claude-opus-5', 'high'), 'claude-opus-5[effort=high]');
  assert.deepEqual(hostModelValue('codex', 'claude-opus-5', 'high'), { model: 'claude-opus-5', model_reasoning_effort: 'high' });
  assert.equal(hostModelValue('copilot', null, 'high'), null);
  const engineer = fs.readFileSync(path.join(corpusAgents, 'engineer.agent.md'), 'utf8');
  assert.equal(setCopilotModel(engineer, null), engineer.replace(/\r\n/g, '\n'));
  assert.match(setCopilotModel(engineer, 'claude-opus-5'), /model: "claude-opus-5"/);
  assert.match(setCopilotModel(engineer, 'claude-opus-5'), /handoffs:/);
});

test('install stamping keeps windows-style paths inside the home and clears inherit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae model home '));
  const corpus = path.join(root, 'corpus', 'agents');
  const target = path.join(root, 'copilot');
  fs.mkdirSync(corpus, { recursive: true });
  fs.mkdirSync(path.join(target, 'agents'), { recursive: true });
  for (const [name, body] of [['engineer.agent.md', 'Own delivery.\n'], ['java-reviewer.agent.md', 'Review.\n']]) {
    const text = `---\nname: ${name.replace(/\.agent\.md$/, '')}\n---\n\n${body}`;
    fs.writeFileSync(path.join(corpus, name), text);
    fs.writeFileSync(path.join(target, 'agents', name), text);
  }
  const stamped = applyModelPreferences({
    corpusAgents: corpus,
    targetRoot: target,
    values: { 'models.engineer': 'claude-opus-5', 'models.reviewer': 'Gemini 3 Flash (Preview)' },
  });
  assert.ok(stamped.files.every((rel) => !path.isAbsolute(rel) && !rel.split('/').includes('..')));
  const engineer = fs.readFileSync(path.join(target, 'agents', 'engineer.agent.md'), 'utf8');
  assert.match(engineer, /model: "claude-opus-5"/);
  const reviewer = fs.readFileSync(path.join(target, 'agents', 'java-reviewer.agent.md'), 'utf8');
  assert.equal(reviewer.includes('model:'), false);
  assert.equal(stamped.omitted.some((row) => row.host === 'copilot' && row.reason === 'parentheses'), true);
  const cursor = fs.readFileSync(path.join(target, 'hosts', 'cursor', 'agents', 'engineer.md'), 'utf8');
  assert.match(cursor, /model: "claude-opus-5\[effort=high\]"/);
  const claude = fs.readFileSync(path.join(target, 'hosts', 'claude', 'agents', 'java-reviewer.md'), 'utf8');
  assert.match(claude, /Gemini 3 Flash \(Preview\)/);
  const codex = fs.readFileSync(path.join(target, 'hosts', 'codex', 'engineer.config.toml'), 'utf8');
  assert.match(codex, /model = "claude-opus-5"/);
  assert.match(codex, /model_reasoning_effort = "high"/);
  applyModelPreferences({ corpusAgents: corpus, targetRoot: target, values: {} });
  assert.equal(fs.existsSync(path.join(target, 'hosts', 'codex', 'engineer.config.toml')), false);
  assert.equal(fs.readFileSync(path.join(target, 'agents', 'engineer.agent.md'), 'utf8').includes('model:'), false);
});

test('model config accepts inherit and rejects a path', () => {
  assert.equal(coerceValue('models.reviewer', 'inherit'), 'inherit');
  assert.equal(coerceValue('models.high', ''), '');
  assert.throws(() => coerceValue('models.engineer', 'C:\\models\\opus'), (error) => error.code === 'E_USAGE');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-model-config-'));
  const copilot = path.join(root, 'copilot');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const written = setConfigValue({
    scope: 'user', key: 'models.engineer', value: 'inherit', copilotHome: copilot, workspace,
  });
  assert.equal(written.value, 'inherit');
  assert.equal(path.basename(path.dirname(written.file)), 'harness');
});

test('ae install stamps the user model into the copilot agent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae model install '));
  const copilot = path.join(root, 'copilot');
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'ae');
  fs.mkdirSync(workspace, { recursive: true });
  setConfigValue({
    scope: 'user', key: 'models.reviewer', value: 'claude-haiku-4-5', copilotHome: copilot, workspace,
  });
  const result = spawnSync(process.execPath, [
    binPath, 'install', '--target', 'cli', '--copilot-home', copilot, '--harness-home', home, '--workspace', workspace, '--json',
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, HOME: root, USERPROFILE: root, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const reviewer = fs.readFileSync(path.join(copilot, 'agents', 'java-reviewer.agent.md'), 'utf8');
  assert.match(reviewer, /model: "claude-haiku-4-5"/);
  const engineer = fs.readFileSync(path.join(copilot, 'agents', 'engineer.agent.md'), 'utf8');
  assert.equal(engineer.includes('\nmodel:'), false);
});
