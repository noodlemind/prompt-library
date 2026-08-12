import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { PINNED_FILES, approveProject, trustStatus, trustStorePath } from '../lib/trust.mjs';
import { resolveConfig, setConfigValue } from '../lib/config.mjs';
import { resolveControls } from '../lib/controls.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const scopes = () => ({ workspace: tempDir('cxr-ws-'), copilotHome: tempDir('cxr-home-') });

function writeChecks(workspace, body) {
  fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.github', 'harness', 'checks.yaml'), body);
}

function run(argv, { workspace, copilotHome }, extra = {}) {
  const harnessFlags = ['--workspace', workspace, '--copilot-home', copilotHome];
  const boundary = argv.indexOf('--');
  const full = boundary === -1
    ? [...argv, ...harnessFlags]
    : [...argv.slice(0, boundary), ...harnessFlags, ...argv.slice(boundary)];
  return spawnSync(process.execPath, [binPath, ...full], {
    cwd: packageRoot, encoding: 'utf8', env: { ...process.env, ...(extra.env || {}) },
  });
}

test('F1: rewriting checks.yaml after approval invalidates trust', () => {
  const s = scopes();
  const marker = path.join(s.workspace, 'MARKER');
  writeChecks(s.workspace, 'version: 1\nchecks:\n  c:\n    command: ["node", "-e", "0"]\n');
  approveProject(s);
  assert.equal(trustStatus(s).state, 'trusted');

  writeChecks(s.workspace, `version: 1\nchecks:\n  c:\n    command: ${JSON.stringify([process.execPath, '-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`])}\n`);
  assert.equal(trustStatus(s).state, 'stale', 'the executed file must be pinned like every other authority-bearing file');

  const res = run(['checks', 'run', 'c', '--no-events'], s);
  assert.equal(res.status, EXIT.needsApproval);
  assert.equal(fs.existsSync(marker), false, 'the rewritten command must not have run');
  assert.ok(PINNED_FILES.some((f) => f.endsWith('checks.yaml')));
});

test('F2: the control set reports environment-allowlist as audit-only when the child inherits', () => {
  const inheriting = resolveControls({ environmentAllowlisted: false, spawn: () => ({ status: 0 }) });
  const env = inheriting.controls.find((c) => c.id === 'environment-allowlist');
  assert.equal(env.realized, 'audit-only', 'an audit that contradicts reality is worse than none, because it is believed');
  assert.ok(inheriting.degraded.some((c) => c.id === 'environment-allowlist'));

  const applied = resolveControls({ environmentAllowlisted: true, spawn: () => ({ status: 0 }) });
  assert.equal(applied.controls.find((c) => c.id === 'environment-allowlist').realized, 'enforced');
});

test('F3: --dry-run describes the execution instead of performing it', () => {
  const s = scopes();
  const marker = path.join(s.workspace, 'RAN');
  const res = run(['exec', '--dry-run', '--no-events', '--', process.execPath, '-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], s);
  assert.equal(res.status, EXIT.ok, res.stderr);
  assert.equal(fs.existsSync(marker), false, 'a flag meaning "show me what you would do" must not do it');
});

test('F4: a project cannot loosen a restrictive key past the default when no user value exists', () => {
  const s = scopes();
  fs.mkdirSync(path.join(s.workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(s.workspace, '.github', 'harness', 'config.yaml'), 'version: 1\nexec.timeout_seconds: 3600\n');
  approveProject(s);
  const { values, provenance } = resolveConfig({ ...s, projectTrusted: true });
  assert.equal(values['exec.timeout_seconds'], 600, 'restrictive arithmetic must not depend on a second scope existing');
  assert.match(provenance['exec.timeout_seconds'].note, /less restrictive/);
});

test('F4: the user scope is still free to raise a limit above the default', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.timeout_seconds', value: '900', ...s });
  assert.equal(resolveConfig(s).values['exec.timeout_seconds'], 900);
});

test('F5: an execute-class command fails closed on a configuration it could not read', () => {
  const s = scopes();
  fs.mkdirSync(path.join(s.copilotHome, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(s.copilotHome, 'harness', 'config.yaml'), 'version: 1\nexec.bash_enabled: definitely-not-false\n');

  const res = run(['bash', '--no-events', '--', 'echo BAD_CONFIG_STILL_RAN'], s);
  assert.equal(res.status, EXIT.needsApproval);
  assert.equal((res.stdout + res.stderr).includes('BAD_CONFIG_STILL_RAN'), false,
    'the dropped key can be the gate itself');
});

test('F6: config set --scope project reports the trust its own write just invalidated', () => {
  const s = scopes();
  approveProject(s);
  const res = run(['config', 'set', 'exec.timeout_seconds', '5', '--scope', 'project', '--json', '--no-events'], s);
  const result = JSON.parse(res.stdout);
  assert.equal(result.trustNowStale, true, 'the write made the project stale and the answer must say so');
  assert.equal(result.value, 600, 'a stale project contributes nothing, so the effective value is the default');
  assert.equal(trustStatus(s).state, 'stale');
});

// F7 — a truncated store parsed as "no records", and approve then overwrote it.
test('F7: a structurally partial trust store denies and refuses to be overwritten', () => {
  const s = scopes();
  approveProject(s);
  fs.writeFileSync(trustStorePath(s.copilotHome), 'version: 1\nprojects:\n');
  assert.equal(trustStatus(s).trusted, false, 'a damaged store is not an empty one');
  assert.throws(() => approveProject(s), (e) => e.code === 'E_TARGET',
    'overwriting it would discard every approval and revocation it held');
});

// F8 — safety controls answered every malformed spelling with a silent default.
test('F8: a malformed single-value flag is a usage error, not a silent default', () => {
  const s = scopes();
  const cases = [
    ['exec', '--timeout=', '--no-events', '--', process.execPath, '-e', '0'],
    ['exec', '--cwd', '--timeout=1', '--no-events', '--', process.execPath, '-e', '0'],
    ['exec', '--timeout', '11', '--timeout', '22', '--no-events', '--', process.execPath, '-e', '0'],
    ['exec', '--timeout', '11', '--timeout=22', '--no-events', '--', process.execPath, '-e', '0'],
  ];
  for (const argv of cases) {
    const res = run(argv, s);
    assert.equal(res.status, EXIT.usage, `${argv.join(' ')} must be refused, not run under a value nobody chose`);
  }
  assert.equal(run(['exec', '--timeout', '30', '--no-events', '--', process.execPath, '-e', '0'], s).status, EXIT.ok,
    'a well-formed flag still works');
});

test('F9: bash takes exactly one script argument', () => {
  const s = scopes();
  const multi = run(['bash', '--no-events', '--', 'printf', '[%s]', 'a b'], s);
  assert.equal(multi.status, EXIT.usage, 'joining tokens changes quoting and misdescribes the audit');

  const single = run(['bash', '--no-events', '--', 'echo one; echo two'], s);
  assert.equal(single.status, EXIT.ok, single.stderr);
  assert.match(single.stdout, /one/);
  assert.match(single.stdout, /two/);
});

// F11 — the envelope said `timed-out` while every lane exited 1.
test('F11: a timed-out check exits with the reserved timed-out code', () => {
  const s = scopes();
  writeChecks(s.workspace, `version: 1\nchecks:\n  slow:\n    command: ${JSON.stringify([process.execPath, '-e', 'setTimeout(() => {}, 60000)'])}\n    timeout_seconds: 1\n`);
  approveProject(s);
  const res = run(['checks', 'run', 'slow', '--no-events', '--output', 'json-envelope'], s);
  assert.equal(res.status, EXIT.timedOut, 'the reported status and the exit code must mean the same thing');
  assert.equal(JSON.parse(res.stdout).status, 'timed-out');
});

// F12 — the shape of a value depended on how many files happened to mention it.
test('F12: a list is normalized whether one scope or two contributed it', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.allow_env', value: 'A,A', ...s });
  assert.deepEqual(resolveConfig(s).values['exec.allow_env'], ['A']);
});
