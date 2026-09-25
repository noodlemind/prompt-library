import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyHarnessHomeFlag, resolveCopilotHome } from '../lib/paths.mjs';
import { parseFlags } from '../lib/flags.mjs';

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a nonexistent XDG copilot dir never shadows ~/.copilot', () => {
  withEnv({ COPILOT_HOME: undefined, XDG_CONFIG_HOME: path.join(os.tmpdir(), 'definitely-missing-xdg-home') }, () => {
    assert.equal(
      resolveCopilotHome(),
      path.join(os.homedir(), '.copilot'),
      'an XDG path that does not exist must not empty every host report'
    );
  });
});

test('a repeated --harness-home uses the last path for both the env and parsed flags', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-first-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-second-'));
  withEnv({ HARNESS_HOME: first }, () => {
    const chosen = applyHarnessHomeFlag(['--harness-home', first, '--harness-home', second]);
    assert.equal(chosen, path.resolve(second));
    assert.equal(process.env.HARNESS_HOME, path.resolve(second));
    const flags = parseFlags(['--harness-home', first, '--harness-home', second]);
    assert.equal(path.resolve(flags.harnessHome), path.resolve(second));
    assert.equal(path.resolve(flags.home), path.resolve(second));
  });
});

test('an existing XDG copilot dir wins over ~/.copilot', () => {
  const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdg-config-'));
  fs.mkdirSync(path.join(xdgRoot, 'copilot'));
  withEnv({ COPILOT_HOME: undefined, XDG_CONFIG_HOME: xdgRoot }, () => {
    assert.equal(resolveCopilotHome(), path.join(xdgRoot, 'copilot'));
  });
});

test('explicit COPILOT_HOME beats everything', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  withEnv({ COPILOT_HOME: home, XDG_CONFIG_HOME: undefined }, () => {
    assert.equal(resolveCopilotHome(), path.resolve(home));
  });
});
