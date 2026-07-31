import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('collectVerifierEvidence prefers reward.json, captures pytest counts, and hashes the tree', () => {
  const trial = tmpdir();
  const verifierDir = path.join(trial, 'artifacts', 'logs', 'verifier');
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

test('an ambiguous reward.json falls back to a valid reward.txt', () => {
  const trial = tmpdir();
  const officialDir = path.join(trial, 'artifacts', 'logs', 'verifier');
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

test('reward evidence is only trusted from the official logs/verifier directory', () => {
  const trial = tmpdir();
  const officialDir = path.join(trial, 'artifacts', 'logs', 'verifier');
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

test('collectVerifierEvidence reports a missing reward as null evidence, not zero', () => {
  const trial = tmpdir();
  fs.mkdirSync(path.join(trial, 'artifacts'), { recursive: true });
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
});
