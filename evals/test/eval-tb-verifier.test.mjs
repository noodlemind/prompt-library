import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  parseReward,
  verdictFromReward,
  parsePytestSummary,
  hashTree,
  collectVerifierEvidence,
} from '../external/terminal_bench/verifier.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-verifier-'));
}

test('parseReward reads harbor reward.json with a reward key', () => {
  assert.deepEqual(parseReward('{"reward": 1}', 'reward.json'), { reward: 1, metrics: { reward: 1 } });
  assert.deepEqual(parseReward('{"reward": 0.25}', 'reward.json'), { reward: 0.25, metrics: { reward: 0.25 } });
});

test('parseReward never grades a reward-less official JSON — no numeric fallback', () => {
  // {"failed": 3} from a verifier schema drift must not read as reward 3
  // (which would grade a recorded failure as a PASS).
  assert.equal(parseReward('{"failed": 3}', 'reward.json').reward, null);
  assert.equal(parseReward('{"accuracy": 0.5}', 'reward.json').reward, null);
  const ambiguous = parseReward('{"a": 1, "b": 0}', 'reward.json');
  assert.equal(ambiguous.reward, null, 'no reward key means no grade, ever');
});

test('the pytest summary is taken from the FINAL duration-bearing line, not agent stdout', () => {
  const spoofed = ['captured stdout:', '9999 passed', '==== 1 failed, 2 passed in 0.44s ===='].join('\n');
  assert.deepEqual(parsePytestSummary(spoofed), { passed: 2, failed: 1 });
});

test('an oversized verifier log degrades advisory assertions without grading a writable reward', () => {
  const trial = tmpdir();
  const verifierDir = path.join(trial, 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  fs.writeFileSync(path.join(verifierDir, 'reward.json'), '{"reward": 0}');
  fs.writeFileSync(path.join(verifierDir, 'huge.log'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
  assert.equal(evidence.pytest, null);
  assert.match(evidence.degraded ?? '', /agent-writable.*assertion evidence degraded/i);
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

test('hashTree attests setuid, setgid, and sticky bits while ignoring write-bit containment chmod', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX special mode bits are unavailable on Windows');
  const baseline = tmpdir();
  const changed = tmpdir();
  for (const dir of [baseline, changed]) {
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n');
    fs.chmodSync(path.join(dir, 'run.sh'), 0o555);
  }
  const baselineHash = hashTree(baseline);
  for (const special of [0o4000, 0o2000, 0o1000]) {
    fs.chmodSync(path.join(changed, 'run.sh'), 0o555 | special);
    const observed = fs.lstatSync(path.join(changed, 'run.sh')).mode & 0o7777;
    if ((observed & special) === 0) return t.skip(`filesystem does not expose mode bit ${special.toString(8)}`);
    assert.notEqual(hashTree(changed), baselineHash, `mode bit ${special.toString(8)} must change the digest`);
  }
  fs.chmodSync(path.join(changed, 'run.sh'), 0o755);
  assert.equal(hashTree(changed), baselineHash, 'write bits remain excluded from the attested mode');
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

test('hashTree detects a file mutated during inspection or reading', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'changing.bin');
  fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024));
  const originalReadSync = fs.readSync;
  let mutated = false;
  fs.readSync = function mutateAfterFirstRead(...args) {
    const count = Reflect.apply(originalReadSync, fs, args);
    if (!mutated && count > 0) {
      mutated = true;
      fs.appendFileSync(file, Buffer.from([1]));
    }
    return count;
  };
  try {
    assert.throws(() => hashTree(dir), /detected mutation/i);
    assert.equal(mutated, true, 'the test must mutate during the actual file read');
  } finally {
    fs.readSync = originalReadSync;
  }
});

test('collectVerifierEvidence keeps verifier diagnostics advisory and hashes the full tree', () => {
  const trial = tmpdir();
  const verifierDir = path.join(trial, 'logs', 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  fs.writeFileSync(path.join(verifierDir, 'reward.txt'), '0');
  fs.writeFileSync(path.join(verifierDir, 'reward.json'), '{"reward": 1}');
  fs.writeFileSync(path.join(verifierDir, 'pytest.log'), '==== 4 passed, 2 failed in 1.0s ====');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null, 'neither agent-writable reward format may grade');
  assert.equal(evidence.rewardPath, null);
  assert.equal(evidence.metrics, null);
  assert.deepEqual(evidence.pytest, { passed: 4, failed: 2 });
  assert.match(evidence.treeHash, /^[0-9a-f]{64}$/);
  assert.match(evidence.degraded, /agent-writable/i);
});

test('agent-writable verifier reward files cannot grade without runner-owned attestation', () => {
  for (const layout of [['verifier'], ['logs', 'verifier']]) {
    const trial = tmpdir();
    const verifierDir = path.join(trial, ...layout);
    fs.mkdirSync(verifierDir, { recursive: true });
    fs.writeFileSync(path.join(verifierDir, 'reward.json'), '{"reward": 1}');
    const evidence = collectVerifierEvidence(trial);
    assert.equal(evidence.reward, null, `${layout.join('/')} is writable by the evaluated agent`);
    assert.equal(evidence.rewardPath, null);
  }
});

test('collectVerifierEvidence never allocates or parses an oversized untrusted reward', () => {
  const trial = tmpdir();
  const verifierDir = path.join(trial, 'logs', 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  const reward = path.join(verifierDir, 'reward.txt');
  fs.writeFileSync(reward, '1');
  fs.truncateSync(reward, 4 * 1024 * 1024 + 1);
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
  assert.match(evidence.treeHash, /^[0-9a-f]{64}$/);
});

test('a valid reward.txt cannot rescue an ambiguous agent-writable reward.json', () => {
  const trial = tmpdir();
  const officialDir = path.join(trial, 'logs', 'verifier');
  fs.mkdirSync(officialDir, { recursive: true });
  fs.writeFileSync(path.join(officialDir, 'reward.json'), '{"a": 1, "b": 0}');
  fs.writeFileSync(path.join(officialDir, 'reward.txt'), '1');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
});

test("harbor 0.20.0's direct-child verifier directory is advisory because the agent also mounts it", () => {
  const trial = tmpdir();
  const verifierDir = path.join(trial, 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  fs.writeFileSync(path.join(verifierDir, 'reward.txt'), '1');
  fs.writeFileSync(path.join(verifierDir, 'test-stdout.txt'), '==== 3 passed in 0.33s ====');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
  assert.deepEqual(evidence.pytest, { passed: 3, failed: 0 });
});

test('a verifier-named directory nested in agent artifacts cannot restore grading trust', () => {
  const trial = tmpdir();
  fs.mkdirSync(path.join(trial, 'verifier'), { recursive: true });
  fs.writeFileSync(path.join(trial, 'verifier', 'reward.txt'), '0');
  const spoof = path.join(trial, 'artifacts', 'workspace', 'verifier');
  fs.mkdirSync(spoof, { recursive: true });
  fs.writeFileSync(path.join(spoof, 'reward.json'), '{"reward": 1}');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
});

test('logs/verifier nested in the agent workspace cannot spoof official evidence', () => {
  const trial = tmpdir();
  fs.mkdirSync(path.join(trial, 'verifier'), { recursive: true });
  fs.writeFileSync(path.join(trial, 'verifier', 'reward.txt'), '0');
  const spoof = path.join(trial, 'artifacts', 'workspace', 'logs', 'verifier');
  fs.mkdirSync(spoof, { recursive: true });
  fs.writeFileSync(path.join(spoof, 'reward.json'), '{"reward": 1}');
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null, 'all agent-writable verifier paths must be ignored');
  assert.equal(evidence.rewardPath, null);
});

test('trial-root logs/verifier and workspace reward files are both untrusted', () => {
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
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
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
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
});

test('collectVerifierEvidence reports a missing reward as null evidence, not zero', () => {
  const trial = tmpdir();
  fs.mkdirSync(path.join(trial, 'artifacts'), { recursive: true });
  const evidence = collectVerifierEvidence(trial);
  assert.equal(evidence.reward, null);
  assert.equal(evidence.rewardPath, null);
});
