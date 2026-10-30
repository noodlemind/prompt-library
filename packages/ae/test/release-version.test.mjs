import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { validateRelease } from '../scripts/check-release.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(packageRoot, rel), 'utf8'));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*))*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;

test('release manifests, lockfile and CLI report the same package version', () => {
  const manifest = readJson('package.json');
  const lock = readJson('package-lock.json');
  assert.match(manifest.version, semver);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version, 'lockfile release version drifted');
  assert.equal(lock.packages[''].version, manifest.version, 'lockfile root package version drifted');
  assert.equal(lock.packages[''].name, manifest.name);
  for (const flag of ['--version', '-V']) {
    const output = execFileSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), flag], { encoding: 'utf8' });
    assert.equal(output.trim(), manifest.version, `${flag} must report the shipped version`);
  }
});

test('the independently versioned bridge declares a valid release', () => {
  const bridge = readJson('vscode-extension/package.json');
  assert.match(bridge.version, semver);
  assert.equal(bridge.name, 'ae-copilot-bridge');
});

test('the downstream diagnostic workflow requires a pinned archive and never grants delivery authority', () => {
  const template = YAML.parse(fs.readFileSync(path.join(packageRoot, '../../.github/workflow-templates/harness-plan-verification.yml'), 'utf8'));
  assert.deepEqual(Object.keys(template.on), ['workflow_dispatch']);
  for (const input of ['archive_url', 'archive_sha256', 'plan_path']) assert.equal(template.on.workflow_dispatch.inputs[input].required, true);
  const scripts = template.jobs['plan-diagnostics'].steps.map(step => step.run || '').join('\n');
  assert.match(scripts, /sha256sum --check/);
  assert.match(scripts, /npm install --global --offline --ignore-scripts/);
  assert.doesNotMatch(scripts, /npm install[^\n]*ae-harness@|\bae (?:trust approve|verify|gate)\b/);
  assert.match(template.name, /diagnostics/i);
  assert.equal(template.permissions.contents, 'read');
});

test('manual diagnostic input validation refuses private, untracked, redirected and invalid selections', { skip: process.platform === 'win32' }, t => {
  const template = YAML.parse(fs.readFileSync(path.join(packageRoot, '../../.github/workflow-templates/harness-plan-verification.yml'), 'utf8'));
  const script = template.jobs['plan-diagnostics'].steps.find(step => step.id === 'inputs').run;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ci-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'selected.md'), '# Shared plan\n');
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'private.md'), '# Private draft\n');
  fs.symlinkSync('selected.md', path.join(root, 'docs', 'plans', 'redirect.md'));
  execFileSync('git', ['add', 'docs/plans/selected.md', 'docs/plans/redirect.md'], { cwd: root });
  const env = { ...process.env, PWD: root, ARCHIVE_URL: 'https://example.invalid/qualified.tgz', ARCHIVE_SHA256: 'a'.repeat(64), PLAN: 'docs/plans/selected.md' };
  const run = overrides => spawnSync('/bin/bash', ['-c', script], { cwd: root, encoding: 'utf8', env: { ...env, ...overrides } });
  assert.equal(run({}).status, 0);
  for (const overrides of [
    { ARCHIVE_URL: 'http://example.invalid/archive' }, { ARCHIVE_SHA256: 'missing' },
    { PLAN: '/private/plan.md' }, { PLAN: 'docs/plans/../selected.md' },
    { PLAN: 'docs/plans/private.md' }, { PLAN: 'docs/plans/redirect.md' },
  ]) assert.notEqual(run(overrides).status, 0, JSON.stringify(overrides));
  for (const step of template.jobs['plan-diagnostics'].steps.filter(step => step.run)) {
    assert.equal(spawnSync('/bin/bash', ['-n'], { input: step.run, encoding: 'utf8' }).status, 0, step.name);
  }
});

test('archive hash refusal happens before offline installation and PATH publication', { skip: process.platform === 'win32' }, t => {
  const template = YAML.parse(fs.readFileSync(path.join(packageRoot, '../../.github/workflow-templates/harness-plan-verification.yml'), 'utf8'));
  const script = template.jobs['plan-diagnostics'].steps.find(step => step.id === 'install').run;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ci-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf qualified-archive > "$RUNNER_TEMP/ae-diagnostic-candidate.tgz"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$RUNNER_TEMP/npm-argv"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, RUNNER_TEMP: root, GITHUB_PATH: path.join(root, 'github-path'), ARCHIVE_URL: 'https://example.invalid/qualified.tgz', ARCHIVE_SHA256: 'a'.repeat(64) };
  const rejected = spawnSync('/bin/bash', ['-c', script], { env, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.equal(fs.existsSync(path.join(root, 'npm-argv')), false);
  assert.equal(fs.existsSync(env.GITHUB_PATH), false);
  const digest = crypto.createHash('sha256').update('qualified-archive').digest('hex');
  const accepted = spawnSync('/bin/bash', ['-c', script], { env: { ...env, ARCHIVE_SHA256: digest }, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(fs.readFileSync(path.join(root, 'npm-argv'), 'utf8'), /--offline\n--ignore-scripts/);
  assert.equal(fs.readFileSync(env.GITHUB_PATH, 'utf8').trim(), path.join(root, 'ae-diagnostic-install', 'bin'));
});

test('release corpus validates agent authority, guardrails and references', () => {
  const output = execFileSync(process.execPath, [
    path.join(packageRoot, 'bin/ae.mjs'), 'resources', 'validate', '--corpus', '--json',
  ], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.ok(result.counts.agent > 0);
  assert.ok(result.counts.skill > 0);
});

test('package-local release checks validate the distribution and source lockfile', () => {
  assert.equal(validateRelease().lockfile, 'checked');
});
