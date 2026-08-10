/**
 * Phase 3 — `harness config`, and the execution policy it feeds.
 *
 * Two things are pinned here, and the second is the one that matters.
 *
 * The first is ordinary: scopes, provenance, schema validation, atomic writes.
 *
 * The second is the merge rule. Precedence is default < user < project, EXCEPT
 * for keys marked restrictive, where the safer scope wins regardless of which
 * is more specific. A repository is content — often content nobody has read —
 * and letting a checked-in file re-enable a shell its owner disabled would make
 * the user-scope setting advisory. Every restrictive-key test below is written
 * from the attacker's side: the project asks for MORE and must not get it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CONFIG_KEYS, CONFIG_SCHEMA, coerceValue, resolveConfig, setConfigValue } from '../lib/config.mjs';
import { EXIT } from '../lib/style.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A workspace + user home pair, the two scopes every test needs. */
function scopes() {
  return { workspace: tempDir('cfg-ws-'), copilotHome: tempDir('cfg-home-') };
}

function writeProjectConfig({ workspace }, body) {
  fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.github', 'harness', 'config.yaml'), body);
}

/**
 * Harness flags go BEFORE any `--`, or `exec`/`bash` would hand them to the
 * child and the command under test would read a different config than the one
 * the test just wrote.
 */
function run(argv, { workspace, copilotHome }) {
  const harnessFlags = ['--workspace', workspace, '--copilot-home', copilotHome, '--no-events'];
  const boundary = argv.indexOf('--');
  const full = boundary === -1
    ? [...argv, ...harnessFlags]
    : [...argv.slice(0, boundary), ...harnessFlags, ...argv.slice(boundary)];
  return spawnSync(process.execPath, [binPath, ...full], { cwd: packageRoot, encoding: 'utf8' });
}

test('every declared key is consumed by code that exists', () => {
  // The guard against a configuration surface growing keys nothing reads. If a
  // key is added here, its reader has to be added with it.
  //
  // Scans all of `lib/` rather than one file: keys are consumed wherever the
  // policy applies — `exec-cmd.mjs` for the execution commands,
  // `checks.mjs` for the named-check path — and pinning the search to a single
  // module would fail an honestly-placed reader while still passing a key that
  // only `config.mjs` mentions.
  const libDir = path.join(packageRoot, 'lib');
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs') && entry.name !== 'config.mjs' && entry.name !== 'config-cmd.mjs') {
        sources.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(libDir);
  const body = sources.join('\n');
  for (const key of CONFIG_KEYS) {
    assert.match(body, new RegExp(key.replace('.', '\\.')), `${key} is declared but nothing reads it`);
  }
});

test('an unset key resolves to its declared default, attributed to default', () => {
  const s = scopes();
  const { values, provenance } = resolveConfig(s);
  for (const key of CONFIG_KEYS) {
    assert.deepEqual(values[key], CONFIG_SCHEMA[key].default);
    assert.equal(provenance[key].source, 'default');
  }
});

test('the user scope overrides the default and says so', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.timeout_seconds', value: '90', ...s });
  const { values, provenance } = resolveConfig(s);
  assert.equal(values['exec.timeout_seconds'], 90);
  assert.equal(provenance['exec.timeout_seconds'].source, 'user');
});

// The core of the merge rule, from the attacker's side.
test('a project cannot loosen a restrictive key the user tightened', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.timeout_seconds', value: '60', ...s });
  writeProjectConfig(s, 'version: 1\nexec.timeout_seconds: 900\n');

  const { values, provenance } = resolveConfig(s);
  assert.equal(values['exec.timeout_seconds'], 60, 'the safer scope must win');
  assert.equal(provenance['exec.timeout_seconds'].source, 'user');
  assert.match(provenance['exec.timeout_seconds'].note, /less restrictive/,
    'a value that silently ignores what the project asked for has to say it did');
});

test('a project CAN tighten a restrictive key — restriction is always allowed', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.timeout_seconds', value: '600', ...s });
  writeProjectConfig(s, 'version: 1\nexec.timeout_seconds: 5\n');
  const { values, provenance } = resolveConfig(s);
  assert.equal(values['exec.timeout_seconds'], 5);
  assert.equal(provenance['exec.timeout_seconds'].source, 'project');
});

test('a project cannot re-enable a shell the user disabled', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.bash_enabled', value: 'false', ...s });
  writeProjectConfig(s, 'version: 1\nexec.bash_enabled: true\n');
  assert.equal(resolveConfig(s).values['exec.bash_enabled'], false);
});

// Trust (P3AC6) is the gate that keeps an unreviewed repository out entirely;
// the restrictive merge is the second line for a repository that IS trusted.
test('an untrusted project contributes no effective value at all', () => {
  const s = scopes();
  writeProjectConfig(s, 'version: 1\nexec.timeout_seconds: 5\n');

  const trusted = resolveConfig({ ...s, projectTrusted: true });
  assert.equal(trusted.values['exec.timeout_seconds'], 5);

  const untrusted = resolveConfig({ ...s, projectTrusted: false });
  assert.equal(untrusted.values['exec.timeout_seconds'], 600, 'an unapproved project must not change execution');
  assert.match(untrusted.provenance['exec.timeout_seconds'].note, /not trusted/);
});

test('a list key unions across scopes', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.allow_env', value: 'FROM_USER', ...s });
  writeProjectConfig(s, 'version: 1\nexec.allow_env: [FROM_PROJECT]\n');
  assert.deepEqual(resolveConfig(s).values['exec.allow_env'], ['FROM_PROJECT', 'FROM_USER']);
});

test('schema validation rejects out-of-range, wrong-typed, and malformed values', () => {
  assert.throws(() => coerceValue('exec.timeout_seconds', '0'), (e) => e.code === 'E_USAGE');
  assert.throws(() => coerceValue('exec.timeout_seconds', '3601'), (e) => e.code === 'E_USAGE');
  assert.throws(() => coerceValue('exec.timeout_seconds', 'soon'), (e) => e.code === 'E_USAGE');
  assert.throws(() => coerceValue('exec.bash_enabled', 'yes'), (e) => e.code === 'E_USAGE');
  assert.throws(() => coerceValue('exec.allow_env', '9NOT-A-NAME'), (e) => e.code === 'E_USAGE');
  assert.throws(() => coerceValue('exec.nope', '1'), (e) => e.code === 'E_USAGE');
  assert.equal(coerceValue('exec.timeout_seconds', '30'), 30);
  assert.equal(coerceValue('exec.bash_enabled', 'false'), false);
  assert.deepEqual(coerceValue('exec.allow_env', 'A, B'), ['A', 'B']);
});

// A config that does not parse is a policy nobody is enforcing — and unlike an
// absent one, it looks present.
test('a malformed file is reported, never silently skipped', () => {
  const s = scopes();
  writeProjectConfig(s, 'version: 1\nexec.timeout_seconds: not-a-number\n');
  const { errors, values } = resolveConfig(s);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /exec\.timeout_seconds/);
  assert.equal(values['exec.timeout_seconds'], 600, 'the unparseable value must not become the effective one');

  const res = run(['config', 'validate'], s);
  assert.equal(res.status, 1, 'validate must exit non-zero so CI can gate on it');
});

test('an unknown key in a file is an error rather than a silent no-op', () => {
  const s = scopes();
  writeProjectConfig(s, 'version: 1\nexec.turbo: true\n');
  assert.match(resolveConfig(s).errors[0], /unknown key exec\.turbo/);
});

test('set refuses to overwrite a file it could not fully parse', () => {
  const s = scopes();
  writeProjectConfig(s, 'version: 1\nexec.timeout_seconds: not-a-number\n');
  assert.throws(
    () => setConfigValue({ scope: 'project', key: 'exec.bash_enabled', value: 'false', ...s }),
    (e) => e.code === 'E_TARGET' && /refusing to write/.test(e.message),
  );
});

test('set preserves the keys it is not changing', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.timeout_seconds', value: '120', ...s });
  setConfigValue({ scope: 'user', key: 'exec.bash_enabled', value: 'false', ...s });
  const { values } = resolveConfig(s);
  assert.equal(values['exec.timeout_seconds'], 120);
  assert.equal(values['exec.bash_enabled'], false);
});

test('set requires an explicit scope — guessing writes the wrong file', () => {
  const s = scopes();
  const res = run(['config', 'set', 'exec.timeout_seconds', '30'], s);
  assert.equal(res.status, EXIT.usage);
  assert.match(res.stdout + res.stderr, /--scope/);
});

test('set reports the effective value after the write, not just what it wrote', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.timeout_seconds', value: '60', ...s });
  const res = run(['config', 'set', 'exec.timeout_seconds', '900', '--scope', 'project', '--json'], s);
  const result = JSON.parse(res.stdout);
  assert.equal(result.written, 900, 'the file got what was asked for');
  assert.equal(result.value, 60, 'but the effective value is still the user ceiling');
  assert.equal(result.effectiveChanged, false,
    'an operator who walks away believing the limit changed is the failure this field prevents');
});

test('an unknown key is a not-found, and an unknown verb is a usage error', () => {
  const s = scopes();
  const badKey = run(['config', 'get', 'exec.nope'], s);
  assert.equal(badKey.status, EXIT.notFound);
  const badVerb = run(['config', 'frobnicate'], s);
  assert.equal(badVerb.status, EXIT.usage);
});

// --- the policy actually reaching the execution surface ---

test('exec takes its default timeout from configuration', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.timeout_seconds', value: '1', ...s });
  const res = run(['exec', '--', process.execPath, '-e', 'setTimeout(() => {}, 60000)'], s);
  assert.equal(res.status, EXIT.timedOut, 'the configured ceiling must apply without an explicit --timeout');
});

test('exec unions the configured allowlist with the flag', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.allow_env', value: 'FROM_CONFIG', ...s });
  const res = spawnSync(
    process.execPath,
    [binPath, 'exec', '--allow-env', 'FROM_FLAG', '--workspace', s.workspace, '--copilot-home', s.copilotHome, '--no-events',
      '--', process.execPath, '-e', 'console.log(JSON.stringify([process.env.FROM_CONFIG, process.env.FROM_FLAG]))'],
    { cwd: packageRoot, encoding: 'utf8', env: { ...process.env, FROM_CONFIG: 'a', FROM_FLAG: 'b' } },
  );
  assert.match(res.stdout, /\["a","b"\]/, 'both sources of allowlist entries must reach the child');
});

// P3AC2: "bash is separately allowed or denied by policy".
test('bash is denied by policy while exec keeps working', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.bash_enabled', value: 'false', ...s });

  const denied = run(['bash', '--', 'echo ran'], s);
  assert.equal(denied.status, EXIT.needsApproval, 'a denied shell is an approval problem, not a usage or internal error');
  assert.match(denied.stdout + denied.stderr, /E_DENIED/);
  assert.equal((denied.stdout + denied.stderr).includes('ran'), false, 'the script must never have run');

  const allowed = run(['exec', '--', process.execPath, '-e', 'console.log("exec-ok")'], s);
  assert.equal(allowed.status, EXIT.ok, 'denying bash must not deny exec — they are separately gated');
  assert.match(allowed.stdout, /exec-ok/);
});

test('a denied bash reports the denial rather than a syntax complaint about the script', () => {
  const s = scopes();
  setConfigValue({ scope: 'user', key: 'exec.bash_enabled', value: 'false', ...s });
  // No `--` at all: the denial must still be the error the user sees, because
  // the command was never going to run whatever they typed.
  const res = run(['bash'], s);
  assert.equal(res.status, EXIT.needsApproval);
  assert.match(res.stdout + res.stderr, /disabled by configuration/);
});
