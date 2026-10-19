import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { partitionTests, readManifests, readTestFiles, runShard, verifyShardManifests } from '../../../scripts/ci-tests.mjs';

test('weighted shards are deterministic, disjoint, complete and include unmeasured files', () => {
  const files = ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs', 'new.test.mjs'];
  const costs = { 'a.test.mjs': 90, 'b.test.mjs': 60, 'c.test.mjs': 40, 'd.test.mjs': 20 };
  const shards = partitionTests(files, costs, 2);
  assert.deepEqual(shards, partitionTests([...files].reverse(), costs, 2));
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), [...files].sort());
  assert.equal(new Set(shards.flatMap(shard => shard.files)).size, files.length);
  assert.ok(shards.every(shard => shard.files.length));
  assert.ok(Math.max(...shards.map(shard => shard.estimatedMs)) - Math.min(...shards.map(shard => shard.estimatedMs)) <= 90);
  assert.throws(() => partitionTests([...files, files[0]], costs, 2), /duplicate/i);
  assert.throws(() => partitionTests(files, { 'a.test.mjs': -1 }, 2), /cost/i);
  assert.throws(() => partitionTests(files, costs, 6), /shard/i);
});

test('the actual discovered source inventory is assigned exactly once across four shards', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const files = readTestFiles(root);
  const costs = JSON.parse(fs.readFileSync(path.join(root, '.github/ci/windows-test-costs.json'), 'utf8')).files;
  const shards = partitionTests(files, costs, 4);
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), files);
  assert.ok(files.includes('ci-test-shards.test.mjs'));
  assert.ok(files.includes('deterministic-delivery.test.mjs'));
});

function fixture(t, failing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ci-shards-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'packages/ae/test');
  fs.mkdirSync(path.join(directory, 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'helpers/isolate-runtime-env.mjs'), '');
  fs.writeFileSync(path.join(directory, 'a.test.mjs'), "import {test} from 'node:test'; test('first', () => {});\n");
  fs.writeFileSync(path.join(directory, 'b.test.mjs'), `import {test} from 'node:test'; test('second', () => { ${failing ? "throw new Error('expected fixture failure');" : ''} });\n`);
  const env = { ...process.env, GITHUB_SHA: 'fixture-source' };
  delete env.NODE_TEST_CONTEXT;
  return { root, env };
}

test('real Node execution retains file timings and a complete same-source manifest', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'packages/ae/test/b.test.mjs'), "import {test} from 'node:test'; test('parent', async t => { await t.test('nested child', () => {}); });\n");
  const manifest = await runShard({ repoRoot: f.root, shard: 1, shards: 1, costs: {}, env: f.env });
  assert.equal(manifest.exitCode, 0);
  assert.deepEqual(manifest.files, ['a.test.mjs', 'b.test.mjs']);
  assert.deepEqual(manifest.results.map(result => result.file).sort(), manifest.files);
  assert.ok(manifest.results.every(result => result.passed && Number.isFinite(result.durationMs)));
  assert.equal(manifest.counts.tests, 3);
  assert.deepEqual(verifyShardManifests([manifest], { files: manifest.files, sourceSha: 'fixture-source', shards: 1 }), { files: 2, shards: 1 });
});

test('a failing real test preserves its nonzero exit and cannot satisfy the aggregate gate', async t => {
  const f = fixture(t, true);
  const manifest = await runShard({ repoRoot: f.root, shard: 1, shards: 1, costs: {}, env: f.env });
  assert.notEqual(manifest.exitCode, 0);
  assert.ok(manifest.results.some(result => !result.passed));
  assert.throws(() => verifyShardManifests([manifest], { files: manifest.files, sourceSha: 'fixture-source', shards: 1 }), /failed|pass/i);
});

test('downloaded artifact layout proves two real shards and refuses a missing manifest', async t => {
  const f = fixture(t);
  const artifacts = path.join(f.root, 'windows-shards');
  for (const shard of [1, 2]) {
    const manifest = await runShard({ repoRoot: f.root, shard, shards: 2, costs: {}, env: f.env });
    const directory = path.join(artifacts, `windows-tests-${shard}`, 'ci-test-results');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  }
  const expected = { files: readTestFiles(f.root), sourceSha: 'fixture-source', shards: 2 };
  assert.deepEqual(verifyShardManifests(readManifests(artifacts), expected), { files: 2, shards: 2 });
  fs.rmSync(path.join(artifacts, 'windows-tests-2/ci-test-results/manifest.json'));
  assert.throws(() => readManifests(artifacts));
});

test('inventory proof rejects missing shards, duplicate files, stale revisions and missing executions', () => {
  const files = ['a.test.mjs', 'b.test.mjs'];
  const one = (shard, file) => ({ version: 1, shard, shards: 2, sourceSha: 'current', allFiles: files, files: [file], exitCode: 0, results: [{ file, passed: true, durationMs: 1 }] });
  const manifests = [one(1, files[0]), one(2, files[1])];
  const expected = { files, sourceSha: 'current', shards: 2 };
  assert.deepEqual(verifyShardManifests(manifests, expected), { files: 2, shards: 2 });
  assert.throws(() => verifyShardManifests(manifests.slice(1), expected), /shard/i);
  assert.throws(() => verifyShardManifests([manifests[0], one(2, files[0])], expected), /inventory|duplicate/i);
  assert.throws(() => verifyShardManifests([{ ...manifests[0], sourceSha: 'old' }, manifests[1]], expected), /source|revision/i);
  assert.throws(() => verifyShardManifests([{ ...manifests[0], results: [] }, manifests[1]], expected), /execution|inventory/i);
});
