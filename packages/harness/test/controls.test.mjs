import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ENFORCEMENT_CLASSES,
  STATIC_CONTROLS,
  resolveControls,
  resolveNetworkControl,
} from '../lib/controls.mjs';
import { setConfigValue } from '../lib/config.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function scopes() {
  return { workspace: tempDir('ctl-ws-'), copilotHome: tempDir('ctl-home-') };
}

/** A fresh cache per call, so one test's probe never decides another's. */
const freshCache = () => new Map();

const spawnOk = () => ({ status: 0 });
const spawnFails = () => ({ status: 1 });

test('every control declares a class from the closed vocabulary', () => {
  for (const control of STATIC_CONTROLS) {
    assert.ok(ENFORCEMENT_CLASSES.includes(control.class), `${control.id} declares an unknown class`);
    assert.ok(control.constrains, `${control.id} must say what it constrains`);
  }
});

test('network allow reports audit-only because nothing was asked for, not because something failed', () => {
  const control = resolveNetworkControl({ policy: 'allow', platform: 'linux', spawn: spawnOk, cache: freshCache() });
  assert.equal(control.realized, 'audit-only');
  assert.match(control.reason, /policy is allow/);
  assert.deepEqual(control.wrapper, []);
});

test('network deny is enforced where a working primitive exists', () => {
  for (const platform of ['darwin', 'linux']) {
    const control = resolveNetworkControl({ policy: 'deny', platform, spawn: spawnOk, cache: freshCache() });
    assert.equal(control.realized, 'enforced', `${platform} has a primitive`);
    assert.ok(control.wrapper.length > 0, 'an enforced control must actually wrap the child');
  }
});

test('network deny degrades to audit-only on a platform with no primitive', () => {
  const control = resolveNetworkControl({ policy: 'deny', platform: 'win32', spawn: spawnOk, cache: freshCache() });
  assert.equal(control.declared, 'enforced');
  assert.equal(control.realized, 'audit-only');
  assert.match(control.reason, /no network-isolation primitive on win32/);
  assert.deepEqual(control.wrapper, [], 'a degraded control must not pretend by wrapping with something that does nothing');
});

test('a primitive that is present but unusable degrades rather than being trusted', () => {
  const control = resolveNetworkControl({ policy: 'deny', platform: 'linux', spawn: spawnFails, cache: freshCache() });
  assert.equal(control.realized, 'audit-only');
  assert.match(control.reason, /present but not usable/);
});

test('a probe that throws is a failed probe, not a crash', () => {
  const control = resolveNetworkControl({
    policy: 'deny',
    platform: 'linux',
    spawn: () => { throw new Error('ENOENT'); },
    cache: freshCache(),
  });
  assert.equal(control.realized, 'audit-only');
});

test('the probe runs once per process, not once per execution', () => {
  const cache = freshCache();
  let probes = 0;
  const counting = () => { probes += 1; return { status: 0 }; };
  for (let i = 0; i < 5; i += 1) resolveNetworkControl({ policy: 'deny', platform: 'linux', spawn: counting, cache });
  assert.equal(probes, 1, 'a control that costs a child process per run costs more than it protects');
});

test('resolveControls reports the degraded set separately so a caller cannot miss it', () => {
  const enforced = resolveControls({ networkPolicy: 'deny', platform: 'darwin', spawn: spawnOk, cache: freshCache() });
  assert.deepEqual(enforced.degraded, []);
  assert.ok(enforced.networkWrapper.length > 0);

  const degraded = resolveControls({ networkPolicy: 'deny', platform: 'win32', spawn: spawnOk, cache: freshCache() });
  assert.equal(degraded.degraded.length, 1);
  assert.equal(degraded.degraded[0].id, 'network-policy');
  assert.deepEqual(degraded.networkWrapper, []);
});

// --- end to end, on this platform ---

test('the audit records what each control achieved, and the operator’s argv rather than the wrapper', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.network', value: 'deny', ...s });
  spawnSync(process.execPath, [binPath, 'exec', '--workspace', s.workspace, '--copilot-home', s.copilotHome, '--', process.execPath, '-e', '0'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });

  const [event] = fs.readFileSync(path.join(s.workspace, '.harness', 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'exec');

  assert.deepEqual(event.exec.argv, [process.execPath, '-e', '0'],
    'an audit showing the isolation wrapper as the thing that ran would misattribute it');
  const network = event.exec.controls.find((c) => c.id === 'network-policy');
  assert.ok(network, 'every control must appear in the record');
  assert.ok(ENFORCEMENT_CLASSES.includes(network.realized));
  assert.equal(Array.isArray(event.exec.degraded), true);
});

test('network deny actually stops a child reaching the network', { skip: process.platform !== 'darwin' && process.platform !== 'linux' }, () => {
  const probe = resolveNetworkControl({ policy: 'deny', cache: freshCache() });
  if (probe.realized !== 'enforced') return; // degraded here; the degradation tests above cover it

  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.network', value: 'deny', ...s });
    const verdictFile = path.join(s.workspace, 'verdict');
  const scriptFile = path.join(s.workspace, 'probe.js');
  fs.writeFileSync(scriptFile, `
    const fs = require('node:fs');
    const done = (v) => { try { fs.writeFileSync(${JSON.stringify(verdictFile)}, v); } catch {} process.exit(0); };
    const s = require('node:net').connect(443, 'example.com');
    s.on('connect', () => done('reached'));
    s.on('error', () => done('blocked'));
    setTimeout(() => done('blocked'), 8000);
  `);
  const res = spawnSync(
    process.execPath,
    [binPath, 'exec', '--workspace', s.workspace, '--copilot-home', s.copilotHome, '--no-events', '--timeout', '20', '--', process.execPath, scriptFile],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  assert.ok(fs.existsSync(verdictFile), `the probe must have run: ${res.stdout}${res.stderr}`);
  assert.equal(fs.readFileSync(verdictFile, 'utf8'), 'blocked',
    'an enforced network policy that still lets a socket connect is decorative');
});

test('a degraded control is printed, not buried in the JSON', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.network', value: 'deny', ...s });
  const res = spawnSync(
    process.execPath,
    [binPath, 'exec', '--workspace', s.workspace, '--copilot-home', s.copilotHome, '--no-events', '--', process.execPath, '-e', '0'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  const network = resolveNetworkControl({ policy: 'deny', cache: freshCache() });
  if (network.realized === 'enforced') {
    assert.equal(res.stdout.includes('control'), false, 'nothing degraded, so nothing to warn about');
  } else {
    assert.match(res.stdout, /control.*network-policy/, 'a policy that achieved nothing must say so on the terminal');
  }
});

test('exec.network is restrictive — a project may cut the network off and never restore it', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.network', value: 'deny', ...s });
  fs.mkdirSync(path.join(s.workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(s.workspace, '.github', 'harness', 'config.yaml'), 'version: 1\nexec.network: allow\n');
  const res = spawnSync(
    process.execPath,
    [binPath, 'config', 'get', 'exec.network', '--json', '--workspace', s.workspace, '--copilot-home', s.copilotHome, '--no-events'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  assert.equal(JSON.parse(res.stdout).value, 'deny');
});
