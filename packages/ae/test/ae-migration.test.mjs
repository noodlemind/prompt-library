import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyHarnessHomeFlag, harnessGlobalHome } from '../lib/paths.mjs';
import { installGlobalHarnessShim } from '../lib/global-bin.mjs';
import { analyzeTerminalEffects } from '../corpus/hooks/lib/tool-payload.mjs';
import { harnessHome as hookHome } from '../corpus/hooks/lib/external-plans.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the distribution package installs the ae command without claiming harness', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'ae-harness');
  assert.deepEqual(manifest.bin, { ae: './bin/ae.mjs' });
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/ae.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), manifest.version);
});

test('a fresh managed shim uses ae without creating a harness executable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-shim-'));
  try {
    const result = installGlobalHarnessShim(home, {}, () => {});
    assert.equal(result.path, path.join(home, 'bin', 'ae'));
    assert.equal(fs.existsSync(path.join(home, 'bin', 'harness')), false);
    assert.match(fs.readFileSync(result.path, 'utf8'), /\.ae-bin.*ae\.mjs/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('canonical home settings resolve the same authority as the legacy alias', () => {
  const home = path.join(os.tmpdir(), 'ae-selected-home');
  withEnvironment({ AE_HOME: home, HARNESS_HOME: undefined }, () => {
    assert.equal(harnessGlobalHome(), path.resolve(home));
  });
  withEnvironment({ AE_HOME: home, HARNESS_HOME: home }, () => {
    assert.equal(harnessGlobalHome(), path.resolve(home));
  });
});

test('conflicting canonical and legacy home settings reject before creating stores', () => {
  withEnvironment({ AE_HOME: '/one', HARNESS_HOME: '/two' }, () => {
    assert.throws(() => harnessGlobalHome(), { code: 'E_USAGE' });
  });
});

test('explicit canonical home flags override inherited environment choices', () => {
  const home = path.join(os.tmpdir(), 'ae-explicit-home');
  withEnvironment({ AE_HOME: '/inherited-one', HARNESS_HOME: '/inherited-two' }, () => {
    assert.equal(applyHarnessHomeFlag(['--ae-home', home]), path.resolve(home));
    assert.equal(harnessGlobalHome(), path.resolve(home));
  });
});

test('contradictory new and old home flags fail closed', () => {
  withEnvironment({ AE_HOME: undefined, HARNESS_HOME: undefined }, () => {
    assert.throws(() => applyHarnessHomeFlag(['--ae-home', '/one', '--harness-home', '/two']), { code: 'E_USAGE' });
  });
});

test('the canonical terminal command retains bounded control admission', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-terminal-'));
  try {
    const result = analyzeTerminalEffects('ae orient --read', workspace);
    assert.equal(result.opaqueInvocations.length, 0, JSON.stringify(result));
    const wrapped = analyzeTerminalEffects('ae orient --read; node -e "write()"', workspace);
    assert.ok(wrapped.opaqueInvocations.length > 0, JSON.stringify(wrapped));
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('the public Engineer keeps its identity and invokes ae', () => {
  const agent = fs.readFileSync(path.join(root, 'corpus/agents/engineer.agent.md'), 'utf8');
  assert.match(agent, /ae orient --read/);
  assert.match(agent, /agent: engineer/);
  assert.equal(fs.existsSync(path.join(root, 'corpus/agents/ae.agent.md')), false);
});

test('fresh CLI and hook processes select the same default state authority', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-default-home-'));
  try {
    withEnvironment({ HOME: home, AE_HOME: undefined, HARNESS_HOME: undefined }, () => {
      assert.equal(harnessGlobalHome(), path.join(home, '.ae'));
      assert.equal(hookHome(), harnessGlobalHome());
      fs.mkdirSync(path.join(home, '.harness'));
      fs.writeFileSync(path.join(home, '.harness', 'saved-plan.md'), 'original');
      assert.equal(hookHome(), path.join(home, '.harness'));
      assert.equal(hookHome(), harnessGlobalHome());
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
