import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { probeExperimentIsolation } from '../lib/experiment-isolation.mjs';

test('actual selected runtime can write artifacts and cannot write frozen inputs or reach a listening loopback server', { skip: process.platform !== 'darwin' }, async t => {
  const root = fs.realpathSync(tempDir('experiment-isolation-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await probeExperimentIsolation({ runtime: process.execPath, artifactRoot: path.join(root, 'artifacts') });
  assert.equal(result.supported, true, result.message);
  assert.equal(result.proof.artifactWrite, true);
  assert.equal(result.proof.frozenWriteRejected, true);
  assert.equal(result.proof.networkRejected, true);
  assert.equal(result.proof.serverListeningBefore, true);
  assert.equal(result.proof.serverListeningAfter, true);
  assert.match(result.identity.runtimeSha256, /^[a-f0-9]{64}$/);
});

test('unsupported platform and pre-cancelled probe never acquire isolation authority', async t => {
  const root = fs.realpathSync(tempDir('experiment-isolation-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts');
  assert.equal((await probeExperimentIsolation({ artifactRoot, platform: 'win32' })).supported, false);
  const controller = new AbortController(); controller.abort();
  assert.equal((await probeExperimentIsolation({ artifactRoot, signal: controller.signal })).supported, false);
});
