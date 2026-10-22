import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

test('the downstream verification workflow installs the distribution that provides ae', () => {
  const template = YAML.parse(fs.readFileSync(path.join(packageRoot, '../../.github/workflow-templates/harness-plan-verification.yml'), 'utf8'));
  const install = template.jobs['harness-verification'].steps.find(step => step.run?.includes('npm install --global'));
  const distribution = /npm install --global "([^@"]+)@/.exec(install.run)?.[1];
  assert.equal(distribution, readJson('package.json').name);
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
