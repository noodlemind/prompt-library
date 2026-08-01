import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../../evals/external/terminal_bench/bounded-exec.mjs', import.meta.url));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

test('bounded exec cleans up redirected background descendants before returning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bounded-exec-'));
  try {
    const marker = path.join(root, 'late-marker');
    const command = `(sleep 0.25; printf escaped > ${shellQuote(marker)}) >/dev/null 2>&1 &`;
    const result = spawnSync(
      process.execPath,
      [runner, Buffer.from(command).toString('base64'), '4096', '4096', '5000'],
      { encoding: 'utf8', timeout: 5000 }
    );

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, 0);
    assert.equal(envelope.timedOut, false);
    assert.equal(envelope.containmentComplete, true);
    await delay(500);
    assert.equal(fs.existsSync(marker), false, 'a descendant cannot mutate the workspace after the result is emitted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-Linux process-group cleanup is idempotent across exit/close races', { skip: process.platform === 'linux' }, () => {
  for (let iteration = 0; iteration < 25; iteration += 1) {
    const command = '(sleep 0.01) >/dev/null 2>&1 &';
    const result = spawnSync(
      process.execPath,
      [runner, Buffer.from(command).toString('base64'), '4096', '4096', '5000'],
      { encoding: 'utf8', timeout: 5000 }
    );
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, 0, `iteration ${iteration}: ${Buffer.from(envelope.stderrB64 ?? '', 'base64')}`);
    assert.equal(envelope.containmentComplete, true, `iteration ${iteration}`);
  }
});

test('bounded exec reaps a descendant that escapes into a new session', { skip: process.platform !== 'linux' }, async (t) => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (python.status !== 0) {
    t.skip('python3 is not available');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bounded-setsid-'));
  try {
    const marker = path.join(root, 'late-marker');
    const script = [
      'import os,time',
      'pid=os.fork()',
      'if pid:',
      ' time.sleep(0.05)',
      ' os._exit(0)',
      'os.setsid()',
      'time.sleep(0.3)',
      `open(${JSON.stringify(marker)},'w').write('escaped')`,
    ].join('\n');
    const command = `python3 -c ${shellQuote(script)} >/dev/null 2>&1`;
    const result = spawnSync(
      process.execPath,
      [runner, Buffer.from(command).toString('base64'), '4096', '4096', '5000'],
      { encoding: 'utf8', timeout: 5000 }
    );

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, 0);
    assert.equal(envelope.timedOut, false);
    assert.equal(envelope.containmentComplete, true);
    await delay(600);
    assert.equal(fs.existsSync(marker), false, 'a new-session descendant cannot mutate after the observation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux container census ignores workspace Python startup shims and reaps setsid escapees', async (t) => {
  const image = 'node:22-alpine';
  const docker = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 15_000 });
  if (docker.status !== 0) {
    t.skip(`${image} is not available to exercise Linux containment`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bounded-docker-'));
  try {
    const lateMarker = path.join(root, 'late-marker');
    const startupMarker = path.join(root, 'python-startup-marker');
    fs.writeFileSync(path.join(root, 'sitecustomize.py'), `open(${JSON.stringify('/work/python-startup-marker')}, 'w').write('forged')\n`);
    fs.writeFileSync(path.join(root, 'json.py'), 'raise RuntimeError("workspace json shadow loaded")\n');
    fs.writeFileSync(path.join(root, 'python3'), '#!/bin/sh\nprintf forged > /work/python-startup-marker\nexit 0\n', { mode: 0o755 });
    const escaped = 'sleep 0.4; printf escaped > /work/late-marker';
    const command = `setsid sh -c ${shellQuote(escaped)} >/dev/null 2>&1 &`;
    const result = spawnSync('docker', [
      'run', '--rm', '--network', 'none',
      '--mount', `type=bind,src=${runner},dst=/opt/bounded-exec.mjs,readonly`,
      '--mount', `type=bind,src=${root},dst=/work`,
      '--workdir', '/work',
      '--env', 'PATH=/work:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      image,
      'node', '/opt/bounded-exec.mjs', Buffer.from(command).toString('base64'), '4096', '4096', '5000',
    ], { encoding: 'utf8', timeout: 30_000 });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, 0);
    assert.equal(envelope.containmentMode, 'linux-process-census');
    assert.equal(envelope.containmentComplete, true);
    await delay(700);
    assert.equal(fs.existsSync(lateMarker), false, 'a reparented new-session process cannot mutate after return');
    assert.equal(fs.existsSync(startupMarker), false, 'the trusted supervisor never invokes workspace-controlled Python');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded exec distinguishes a command exit 124 from an enforced timeout', () => {
  const legitimate = spawnSync(
    process.execPath,
    [runner, Buffer.from('exit 124').toString('base64'), '4096', '4096', '5000'],
    { encoding: 'utf8', timeout: 10_000 }
  );
  assert.equal(legitimate.status, 0, legitimate.stderr);
  const legitimateEnvelope = JSON.parse(legitimate.stdout);
  assert.equal(legitimateEnvelope.code, 124);
  assert.equal(legitimateEnvelope.timedOut, false);
  assert.equal(legitimateEnvelope.containmentComplete, true);

  const expired = spawnSync(
    process.execPath,
    [runner, Buffer.from('sleep 2').toString('base64'), '4096', '4096', '25'],
    { encoding: 'utf8', timeout: 10_000 }
  );
  assert.equal(expired.status, 0, expired.stderr);
  const expiredEnvelope = JSON.parse(expired.stdout);
  assert.equal(expiredEnvelope.code, 124);
  assert.equal(expiredEnvelope.timedOut, true);
  assert.equal(expiredEnvelope.containmentComplete, true);
});
