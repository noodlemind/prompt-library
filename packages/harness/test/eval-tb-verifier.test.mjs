import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  parseReward,
  verdictFromReward,
  parsePytestSummary,
  hashTree,
  collectVerifierEvidence,
} from '../../../evals/external/terminal_bench/verifier.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-verifier-'));
}

test('parseReward reads harbor reward.json with a reward key', () => {
  assert.deepEqual(parseReward('{"reward": 1}', 'reward.json'), { reward: 1, metrics: { reward: 1 } });
  assert.deepEqual(parseReward('{"reward": 0.25}', 'reward.json'), { reward: 0.25, metrics: { reward: 0.25 } });
});

test('parseReward falls back to a single numeric metric when no reward key exists', () => {
  assert.deepEqual(parseReward('{"accuracy": 0.5}', 'reward.json'), { reward: 0.5, metrics: { accuracy: 0.5 } });
  const ambiguous = parseReward('{"a": 1, "b": 0}', 'reward.json');
  assert.equal(ambiguous.reward, null, 'two metrics with no reward key is ambiguous');
});

test('parseReward reads reward.txt plain numbers and rejects garbage', () => {
  assert.equal(parseReward('1\n', 'reward.txt').reward, 1);
  assert.equal(parseReward('0', 'reward.txt').reward, 0);
  assert.equal(parseReward('not-a-number', 'reward.txt'), null);
  assert.equal(parseReward('{invalid json', 'reward.json'), null);
  assert.equal(parseReward('1 of 2', 'reward.txt'), null, 'trailing garbage must not grade as a pass');
  assert.equal(parseReward(' 0.5 ', 'reward.txt').reward, 0.5);
});

test('verdictFromReward compares against the passing reward', () => {
  assert.equal(verdictFromReward(1), 'pass');
  assert.equal(verdictFromReward(0.99), 'fail');
  assert.equal(verdictFromReward(0.5, { passingReward: 0.5 }), 'pass');
  assert.equal(verdictFromReward(null), 'fail');
});

test('parsePytestSummary extracts passed and failed counts', () => {
  assert.deepEqual(parsePytestSummary('==== 3 passed, 1 failed in 0.52s ===='), { passed: 3, failed: 1 });
  assert.deepEqual(parsePytestSummary('5 passed in 1.2s'), { passed: 5, failed: 0 });
  assert.deepEqual(parsePytestSummary('2 failed in 0.1s'), { passed: 0, failed: 2 });
  assert.equal(parsePytestSummary('no tests ran'), null);
});

test('hashTree is deterministic, content-sensitive, and path-sensitive', () => {
  const a = tmpdir();
  const b = tmpdir();
  for (const dir of [a, b]) {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'x.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'y.txt'), 'world');
  }
  assert.equal(hashTree(a), hashTree(b), 'identical trees hash identically');
  fs.writeFileSync(path.join(b, 'y.txt'), 'world!');
  assert.notEqual(hashTree(a), hashTree(b), 'content change changes the hash');
  fs.writeFileSync(path.join(b, 'y.txt'), 'world');
  fs.renameSync(path.join(b, 'y.txt'), path.join(b, 'z.txt'));
  assert.notEqual(hashTree(a), hashTree(b), 'path change changes the hash');
});

test('hashTree includes empty directories and regular-file mode in its typed manifest', (t) => {
  const a = tmpdir();
  const b = tmpdir();
  fs.writeFileSync(path.join(a, 'run.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(b, 'run.sh'), '#!/bin/sh\n');
  assert.equal(hashTree(a), hashTree(b));

  fs.mkdirSync(path.join(b, 'empty'));
  assert.notEqual(hashTree(a), hashTree(b), 'an extra empty directory must change the digest');
  fs.rmdirSync(path.join(b, 'empty'));

  const beforeMode = fs.lstatSync(path.join(b, 'run.sh')).mode & 0o7777;
  fs.chmodSync(path.join(b, 'run.sh'), beforeMode ^ 0o100);
  const afterMode = fs.lstatSync(path.join(b, 'run.sh')).mode & 0o7777;
  if (afterMode === beforeMode) t.skip('filesystem does not expose executable mode changes');
  else assert.notEqual(hashTree(a), hashTree(b), 'a mode change must change the digest');
});

test('hashTree rejects symlinks instead of following or silently omitting them', (t) => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'target.txt'), 'inside');
  try {
    fs.symlinkSync('target.txt', path.join(dir, 'link.txt'));
  } catch (error) {
    if (['EPERM', 'ENOSYS'].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`);
    throw error;
  }
  assert.throws(() => hashTree(dir), /rejects symbolic link.*link\.txt/i);
  assert.throws(() => hashTree(path.join(dir, 'link.txt')), /root must be a directory.*symbolic link/i);
});

test('hashTree rejects special filesystem nodes', (t) => {
  if (process.platform === 'win32') return t.skip('mkfifo is not portable to Windows');
  const dir = tmpdir();
  const fifo = path.join(dir, 'stream');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (created.error || created.status !== 0) return t.skip(`mkfifo unavailable: ${created.error?.code ?? created.stderr}`);
  assert.throws(() => hashTree(dir), /rejects FIFO.*stream/i);
});

test('hashTree enforces entry, byte, depth, and relative-path bounds', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'data.txt'), '12345');
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.mkdirSync(path.join(dir, 'nested', 'deeper'));
  assert.throws(() => hashTree(dir, { maxEntries: 1 }), /exceeds maxEntries 1/);
  assert.throws(() => hashTree(dir, { maxBytes: 4 }), /exceeds maxBytes 4/);
  assert.throws(() => hashTree(dir, { maxDepth: 1 }), /exceeds maxDepth 1/);
  assert.throws(() => hashTree(dir, { maxPathLength: 4 }), /exceeds maxPathLength 4/);
  assert.throws(() => hashTree(dir, { maxEntries: 50_001 }), /maxEntries must be an integer/);
});

test('hashTree rejects an unreadable regular file when permissions are enforced', (t) => {
  const dir = tmpdir();
  const file = path.join(dir, 'private.txt');
  fs.writeFileSync(file, 'secret');
  fs.chmodSync(file, 0);
  try {
    let error = null;
    try {
      hashTree(dir);
    } catch (caught) {
      error = caught;
    }
    if (!error) return t.skip('current user can read mode-000 files');
    assert.match(error.message, /cannot open file private\.txt.*(?:EACCES|EPERM)/i);
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

test('hashTree detects a file mutated during inspection or reading', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'changing.bin');
  fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024));
  const script = [
    "const fs = require('node:fs');",
    'const fd = fs.openSync(process.argv[1], \'r+\');',
    "process.stdout.write('ready\\n');",
    'const bytes = [Buffer.from([1]), Buffer.from([2])];',
    'const end = Date.now() + 10_000;',
    'let index = 0;',
    'while (Date.now() < end) fs.writeSync(fd, bytes[index++ & 1], 0, 1, 0);',
    'fs.closeSync(fd);',
  ].join('\n');
  const mutator = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(mutator, 'exit');
  await once(mutator.stdout, 'data');
  try {
    assert.throws(() => hashTree(dir), /detected mutation/i);
  } finally {
    mutator.kill('SIGKILL');
    await exited;
  }
});

test('collectVerifierEvidence prefers reward.json, captures pytest counts, and hashes the tree', () => {
  const trial = tmpdir();
  const verifierDir = path.join(trial, 'logs', 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  fs.writeFileSync(path.join(verifierDir, 'reward.txt'), '0');
  fs.writeFileSync(path.join(verifierDir, 'reward.json'), '{"reward": 1}');
  fs.writeFileSync(path.join(verifierDir, 'pytest.log'), '==== 4 passed, 2 failed in 1.0s ====');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, 1, 'reward.json wins over reward.txt');
  assert.match(evidence.rewardPath, /reward\.json$/);
  assert.deepEqual(evidence.pytest, { passed: 4, failed: 2 });
  assert.match(evidence.treeHash, /^[0-9a-f]{64}$/);
});

test('collectVerifierEvidence bounds official files before allocating or parsing them', () => {
  const trial = tmpdir();
  const verifierDir = path.join(trial, 'logs', 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  const reward = path.join(verifierDir, 'reward.txt');
  fs.writeFileSync(reward, '1');
  fs.truncateSync(reward, 4 * 1024 * 1024 + 1);
  assert.throws(() => collectVerifierEvidence(trial), /evidence file exceeds 4194304 bytes.*reward\.txt/i);
});

test('an ambiguous reward.json falls back to a valid reward.txt', () => {
  const trial = tmpdir();
  const officialDir = path.join(trial, 'logs', 'verifier');
  fs.mkdirSync(officialDir, { recursive: true });
  fs.writeFileSync(path.join(officialDir, 'reward.json'), '{"a": 1, "b": 0}');
  fs.writeFileSync(path.join(officialDir, 'reward.txt'), '1');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, 1, 'a json file without a usable reward must not mask the txt verdict');
  assert.match(evidence.rewardPath, /reward\.txt$/);
});

test("harbor 0.20.0's host-side layout — a direct-child verifier directory — is official evidence", () => {
  const trial = tmpdir();
  const verifierDir = path.join(trial, 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  fs.writeFileSync(path.join(verifierDir, 'reward.txt'), '1');
  fs.writeFileSync(path.join(verifierDir, 'test-stdout.txt'), '==== 3 passed in 0.33s ====');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, 1);
  assert.deepEqual(evidence.pytest, { passed: 3, failed: 0 });
});

test('a verifier-named directory nested in agent artifacts is still not official', () => {
  const trial = tmpdir();
  fs.mkdirSync(path.join(trial, 'verifier'), { recursive: true });
  fs.writeFileSync(path.join(trial, 'verifier', 'reward.txt'), '0');
  const spoof = path.join(trial, 'artifacts', 'workspace', 'verifier');
  fs.mkdirSync(spoof, { recursive: true });
  fs.writeFileSync(path.join(spoof, 'reward.json'), '{"reward": 1}');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, 0, 'only the trial-root verifier dir (or logs/verifier) counts');
});

test('logs/verifier nested in the agent workspace cannot spoof official evidence', () => {
  const trial = tmpdir();
  fs.mkdirSync(path.join(trial, 'verifier'), { recursive: true });
  fs.writeFileSync(path.join(trial, 'verifier', 'reward.txt'), '0');
  const spoof = path.join(trial, 'artifacts', 'workspace', 'logs', 'verifier');
  fs.mkdirSync(spoof, { recursive: true });
  fs.writeFileSync(path.join(spoof, 'reward.json'), '{"reward": 1}');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, 0, 'an agent-writable logs/verifier path must be ignored');
  assert.match(evidence.rewardPath, /verifier[/\\]reward\.txt$/);
});

test('reward evidence is only trusted from the official logs/verifier directory', () => {
  const trial = tmpdir();
  const officialDir = path.join(trial, 'logs', 'verifier');
  fs.mkdirSync(officialDir, { recursive: true });
  fs.writeFileSync(path.join(officialDir, 'reward.txt'), '0');
  // A file the agent (or anything else) dropped elsewhere in the tree must
  // never override the official verifier verdict.
  const spoofDir = path.join(trial, 'artifacts', 'workspace', 'a');
  fs.mkdirSync(spoofDir, { recursive: true });
  fs.writeFileSync(path.join(spoofDir, 'reward.json'), '{"reward": 1}');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, 0, 'the spoofed reward.json must be ignored');
  assert.match(evidence.rewardPath, /logs[/\\]verifier[/\\]reward\.txt$/);
});

test('reward evidence below artifacts is rejected even at an otherwise official layout', () => {
  const trial = tmpdir();
  const officialDir = path.join(trial, 'verifier');
  fs.mkdirSync(officialDir, { recursive: true });
  fs.writeFileSync(path.join(officialDir, 'reward.txt'), '0');
  const spoofDir = path.join(trial, 'artifacts', 'logs', 'verifier');
  fs.mkdirSync(spoofDir, { recursive: true });
  fs.writeFileSync(path.join(spoofDir, 'reward.json'), '{"reward": 1}');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, 0);
  assert.match(evidence.rewardPath, /verifier[/\\]reward\.txt$/);
});

test('collectVerifierEvidence reports a missing reward as null evidence, not zero', () => {
  const trial = tmpdir();
  fs.mkdirSync(path.join(trial, 'artifacts'), { recursive: true });
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
});
