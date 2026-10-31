import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { harnessRunnerSource, RUNNER_VERSION, writeHarnessRunner, resolveHarnessBin } from '../lib/resolve-harness-bin.mjs';
import { INSTALL_FIX_HINT } from '../lib/global-bin.mjs';
import { runHarness } from './helpers/index.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = path.join(root, '.harness', 'run.mjs');
  fs.mkdirSync(path.dirname(runner), { recursive: true });
  const env = { ...process.env, COPILOT_HOME: path.join(root, 'copilot') };
  for (const key of Object.keys(env)) if (/^(?:AE_BIN|HARNESS_BIN|PATH)$/i.test(key)) delete env[key];
  env.PATH = '';
  return { root, runner, env };
}

test('same-version generated runners with obsolete install guidance are refreshed', t => {
  const f = fixture(t);
  const stale = harnessRunnerSource().replace(INSTALL_FIX_HINT, 'npx @devkit/harness install');
  fs.writeFileSync(f.runner, stale);
  assert.equal(writeHarnessRunner(f.root, false).updated, true);
  assert.equal(fs.readFileSync(f.runner, 'utf8'), harnessRunnerSource());
  const result = spawnSync(process.execPath, [f.runner, 'help'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ae install/);
  assert.doesNotMatch(result.stderr, /@devkit|npx/);
});

test('doctor rejects same-version stale guidance and explains custom and newer runner conflicts', t => {
  const f = fixture(t);
  const observe = () => {
    const result = runHarness(['doctor', '--target', 'cli', '--workspace', f.root, '--copilot-home', f.env.COPILOT_HOME, '--json']);
    return JSON.parse(result.stdout).checks.find(check => check.id === 'H13');
  };
  fs.writeFileSync(f.runner, harnessRunnerSource().replace(INSTALL_FIX_HINT, 'npm install -g @devkit/harness'));
  assert.equal(observe().pass, false);
  writeHarnessRunner(f.root, false);
  assert.equal(observe().pass, true);
  fs.writeFileSync(f.runner, 'console.log("custom");\n');
  assert.match(observe().hint, /preserve and inspect/);
  fs.writeFileSync(f.runner, harnessRunnerSource().replace(`@harness-runner-version ${RUNNER_VERSION}`, `@harness-runner-version ${RUNNER_VERSION + 1}`));
  assert.match(observe().hint, /newer AE installation/);
});

test('runner regeneration preserves an unrelated local script', t => {
  const f = fixture(t), authored = 'console.log("my project runner");\n';
  fs.writeFileSync(f.runner, authored);
  assert.throws(() => writeHarnessRunner(f.root, false), { code: 'E_TARGET' });
  assert.equal(fs.readFileSync(f.runner, 'utf8'), authored);
});

test('older installations cannot downgrade a newer generated runner', t => {
  const f = fixture(t);
  const newer = harnessRunnerSource().replace(`@harness-runner-version ${RUNNER_VERSION}`, `@harness-runner-version ${RUNNER_VERSION + 1}`);
  fs.writeFileSync(f.runner, newer);
  assert.throws(() => writeHarnessRunner(f.root, false), { code: 'E_RUNNER_NEWER' });
  assert.equal(fs.readFileSync(f.runner, 'utf8'), newer);
});

test('runner refresh dry-run identifies stale content without replacing bytes', t => {
  const f = fixture(t), stale = harnessRunnerSource().replace(INSTALL_FIX_HINT, 'old install command');
  fs.writeFileSync(f.runner, stale);
  assert.equal(writeHarnessRunner(f.root, true).updated, true);
  assert.equal(fs.readFileSync(f.runner, 'utf8'), stale);
});

test('runner regeneration refuses symlinked local state without writing outside the checkout', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.rmSync(path.dirname(f.runner), { recursive: true });
  fs.symlinkSync(outside, path.dirname(f.runner), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeHarnessRunner(f.root, false), { code: 'E_TARGET' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('an explicitly selected unavailable runtime cannot silently fall back to another installation', t => {
  const f = fixture(t), fallback = path.join(f.env.COPILOT_HOME, 'bin', 'ae');
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  fs.writeFileSync(fallback, 'console.log("WRONG INSTALLATION");\n');
  writeHarnessRunner(f.root, false);
  const result = spawnSync(process.execPath, [f.runner, 'help'], { env: { ...f.env, AE_BIN: path.join(f.root, 'missing.mjs') }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_NO_HARNESS_BIN/);
  assert.doesNotMatch(result.stdout, /WRONG INSTALLATION/);
});

test('runtime discovery reports an unavailable explicit selection instead of a different installation', t => {
  const f = fixture(t), oldAE = process.env.AE_BIN, oldLegacy = process.env.HARNESS_BIN;
  const fallback = path.join(f.env.COPILOT_HOME, 'bin', 'ae');
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  fs.writeFileSync(fallback, 'console.log("WRONG INSTALLATION");\n');
  process.env.AE_BIN = path.join(f.root, 'missing.mjs');
  delete process.env.HARNESS_BIN;
  try {
    const selected = resolveHarnessBin({ workspace: f.root, copilotHome: f.env.COPILOT_HOME });
    assert.equal(selected.bin, null);
    assert.match(selected.error, /selected.*runtime/i);
  } finally {
    if (oldAE === undefined) delete process.env.AE_BIN; else process.env.AE_BIN = oldAE;
    if (oldLegacy === undefined) delete process.env.HARNESS_BIN; else process.env.HARNESS_BIN = oldLegacy;
  }
});

test('runner reports child launch errors rather than a silent exit', t => {
  const f = fixture(t), invalid = path.join(f.root, 'bin', process.platform === 'win32' ? 'ae.exe' : 'ae');
  fs.mkdirSync(path.dirname(invalid), { recursive: true });
  fs.writeFileSync(invalid, process.platform === 'win32' ? 'invalid binary' : '#!/ae-missing-interpreter\n');
  fs.chmodSync(invalid, 0o755);
  writeHarnessRunner(f.root, false);
  const result = spawnSync(process.execPath, [f.runner, 'help'], { env: { ...f.env, PATH: path.dirname(invalid) }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_RUNTIME_START/);
});

test('Windows npm PATH installation runs through Node without shell parsing', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), prefix = path.join(f.root, 'npm prefix & with spaces');
  const cli = path.join(prefix, 'node_modules', 'ae-harness', 'bin', 'ae.mjs');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  fs.writeFileSync(path.join(prefix, 'ae.cmd'), '@echo SHOULD_NOT_EXECUTE\nexit /b 9\n');
  writeHarnessRunner(f.root, false);
  const result = spawnSync(process.execPath, [f.runner, 'help', 'literal & value'], { env: { ...f.env, PATH: prefix }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).slice(0, 2), ['help', 'literal & value']);
});
