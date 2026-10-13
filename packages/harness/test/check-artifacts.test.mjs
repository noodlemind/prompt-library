import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runNamedCheck, validateCommand } from '../lib/checks.mjs';
import { validateCheckArtifacts, allocateCheckArtifacts, captureCheckArtifacts } from '../lib/check-artifacts.mjs';
import { tempDir } from './helpers/temp.mjs';

function fixture(t) {
  const workspace = tempDir('check-artifacts-');
  const home = tempDir('check-artifacts-home-');
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  return { workspace, home };
}

const writer = "const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.HARNESS_CHECK_ARTIFACT_DIR,'receipt.json'),JSON.stringify({action:'write',result:'observed'}));";

test('check invocations bind distinct JSON artifacts and detect later tampering', async t => {
  const { workspace, home } = fixture(t);
  const config = { command: [process.execPath, '-e', writer], artifacts: ['receipt.json'] };
  const [first, second] = await Promise.all([runNamedCheck(workspace, 'proof', config, { copilotHome: home }), runNamedCheck(workspace, 'proof', config, { copilotHome: home })]);
  for (const result of [first, second]) {
    assert.equal(result.status, 'passed', result.message);
    assert.equal(result.artifacts.length, 1);
    assert.match(result.artifacts[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(validateCheckArtifacts(workspace, config, result).pass, true);
  }
  assert.notEqual(first.artifacts[0].path, second.artifacts[0].path);
  fs.writeFileSync(path.join(workspace, first.artifacts[0].path), '{"result":"forged"}');
  assert.equal(validateCheckArtifacts(workspace, config, first).pass, false);
  fs.rmSync(path.join(workspace, second.artifacts[0].path));
  assert.equal(validateCheckArtifacts(workspace, config, second).pass, false);
});

test('a zero exit without its declared artifact is a failed check', async t => {
  const { workspace, home } = fixture(t);
  const result = await runNamedCheck(workspace, 'proof', { command: [process.execPath, '-e', 'void 0'], artifacts: ['receipt.json'] }, { copilotHome: home });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /artifact/i);
});

for (const paths of [['../escape.json'], ['/absolute.json'], ['C:\\escape.json'], ['same.json', 'same.json'], Array.from({ length: 17 }, (_, i) => `${i}.json`)]) {
  test(`invalid artifact declaration is rejected before execution: ${JSON.stringify(paths)}`, () => {
    assert.match(validateCommand('proof', { command: ['node', 'unused.mjs'], artifacts: paths }), /artifact/i);
  });
}

test('artifact collection rejects non-JSON and oversized output', async t => {
  const { workspace, home } = fixture(t);
  for (const value of ['not JSON secret-token', 'x'.repeat(1024 * 1024 + 1)]) {
    const command = [process.execPath, '-e', `require('node:fs').writeFileSync(require('node:path').join(process.env.HARNESS_CHECK_ARTIFACT_DIR,'receipt.json'),${value.length > 1024 * 1024 ? "'x'.repeat(1048577)" : JSON.stringify(value)})`];
    const result = await runNamedCheck(workspace, 'proof', { command, artifacts: ['receipt.json'] }, { copilotHome: home });
    assert.equal(result.status, 'failed');
    assert.equal(fs.existsSync(path.join(workspace, result.artifactRoot)), false);
  }
});

test('a symlinked artifact cannot supply proof', { skip: process.platform === 'win32' }, async t => {
  const { workspace, home } = fixture(t);
  const target = path.join(workspace, 'outside.json');
  fs.writeFileSync(target, '{"result":"outside"}');
  const command = [process.execPath, '-e', `require('node:fs').symlinkSync(${JSON.stringify(target)},require('node:path').join(process.env.HARNESS_CHECK_ARTIFACT_DIR,'receipt.json'))`];
  assert.equal((await runNamedCheck(workspace, 'proof', { command, artifacts: ['receipt.json'] }, { copilotHome: home })).status, 'failed');
});


test('another check invocation cannot replace the retained directory through a symlink', { skip: process.platform === 'win32' }, async t => {
  const { workspace, home } = fixture(t), config = { command: [process.execPath, '-e', writer], artifacts: ['receipt.json'] };
  const first = await runNamedCheck(workspace, 'proof', config, { copilotHome: home });
  const second = await runNamedCheck(workspace, 'proof', config, { copilotHome: home });
  fs.rmSync(path.join(workspace, first.artifactRoot), { recursive: true });
  fs.symlinkSync(path.join(workspace, second.artifactRoot), path.join(workspace, first.artifactRoot));
  assert.equal(validateCheckArtifacts(workspace, config, first).pass, false);
});

test('redaction-sensitive artifact filenames are rejected before launch', () => {
  assert.match(validateCommand('proof', { command: ['node', 'unused.mjs'], artifacts: ['sk-zzzzzzzzzzzzzzzzzzzzzzzz.json'] }), /artifact/i);
});

test('internal raw validator runs before duplicate fields can disappear during JSON capture', t => {
  const { workspace } = fixture(t); const root = allocateCheckArtifacts(workspace, 'strict');
  const raw = '{"version":1,"version":2}'; fs.writeFileSync(path.join(workspace, root, 'receipt.json'), raw);
  assert.throws(() => captureCheckArtifacts(workspace, root, ['receipt.json'], value => value, (name, bytes) => { assert.equal(name, 'receipt.json'); assert.equal(bytes.toString(), raw); throw new Error('duplicate identity'); }), /duplicate identity/);
  assert.equal(fs.readFileSync(path.join(workspace, root, 'receipt.json'), 'utf8'), raw);
});
