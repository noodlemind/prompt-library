import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { VALUE_FLAGS, positionalsOf, verbOf } from '../lib/positionals.mjs';
import { GLOBAL_FLAGS, getCommand, listCommands } from '../lib/registry.mjs';
import { parseFlags } from '../lib/flags.mjs';
import { CONFIG_SCHEMA, coerceValue, resolveConfig } from '../lib/config.mjs';
import { loadPolicy } from '../lib/policy.mjs';
import { resourcesExitFor } from '../lib/resources-cmd.mjs';
import { discoverBundles, resolvePrecedence } from '../lib/resources.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

// --- the shared scan, and the three commands that got it wrong ------------

test('the value-flag set covers every non-boolean flag the registry declares', () => {
  const declared = new Set();
  for (const f of GLOBAL_FLAGS) if (f.type !== 'boolean') { declared.add(f.name); (f.aliases || []).forEach((a) => declared.add(a)); }
  for (const n of listCommands()) {
    for (const f of getCommand(n).args?.flags || []) {
      if (f.type !== 'boolean') { declared.add(f.name); (f.aliases || []).forEach((a) => declared.add(a)); }
    }
  }
  const missing = [...declared].filter((n) => !VALUE_FLAGS.has(n));
  assert.deepEqual(missing, [], 'a value flag missing from the set means its value is read as a positional');
});

test('the value-flag set covers every flag parseFlags reads a value for', () => {
    const consumes = (name) => ['SENTINEL', '7'].some((v) => {
    try { return JSON.stringify(parseFlags([name, v]) ?? {}).includes(v); } catch { return true; }
  });
  const candidates = ['--target', '--since', '--until', '--ids', '--branch', '--why', '--query', '--plan', '--host', '--limit', '--collection'];
  const missing = candidates.filter((n) => consumes(n) && !VALUE_FLAGS.has(n));
  assert.deepEqual(missing, []);
});

test('a boolean flag never consumes the token after it', () => {
  assert.deepEqual(positionalsOf(['--json', 'list']), ['list']);
  assert.deepEqual(positionalsOf(['--verbose', 'run', 'slow']), ['run', 'slow']);
  assert.deepEqual(positionalsOf(['-v', 'list']), ['list'], 'short flags too — `-v` does not start with `--`');
  assert.deepEqual(positionalsOf(['--no-events', 'approve']), ['approve']);
  // …while a value flag still does, and `=` carries its own value.
  assert.deepEqual(positionalsOf(['--status', 'succeeded', 'list']), ['list']);
  assert.deepEqual(positionalsOf(['--limit=5', 'list']), ['list']);
  assert.deepEqual(positionalsOf(['show', 'abc', '--', '--json']), ['show', 'abc'], 'nothing after `--` belongs to us');
});

test('`harness trust --json approve` no longer reports success while approving nothing', () => {
  const ws = tempDir('cr-trust-ws-');
  const home = tempDir('cr-trust-home-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 1\nenforcement: warn\n');

  const res = spawnSync(process.execPath, [binPath, 'trust', '--json', 'approve', '--workspace', ws, '--copilot-home', home], { encoding: 'utf8' });
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.verb, 'approve',
    '`approve` was read as the value of `--json`, so the command fell back to `status`, printed the state and exited 0');
  assert.equal(fs.existsSync(path.join(home, 'harness', 'trust.yaml')), true, 'and no approval was ever recorded');
});

test('verbOf matches a known verb wherever it appears, rather than guessing by position', () => {
  assert.equal(verbOf(['--json', 'approve'], ['status', 'approve', 'revoke'], { fallback: 'status' }), 'approve');
  assert.equal(verbOf(['--verbose', 'revoke'], ['status', 'approve', 'revoke'], { fallback: 'status' }), 'revoke');
  assert.equal(verbOf([], ['status', 'approve'], { fallback: 'status' }), 'status');
    assert.equal(verbOf(['frobnicate'], ['status'], { fallback: 'status' }), 'frobnicate');
});

test('`harness checks --json list` finds its verb', () => {
  const ws = tempDir('cr-checks-ws-');
  const res = spawnSync(process.execPath, [binPath, 'checks', '--json', 'list', '--workspace', ws], { encoding: 'utf8' });
  assert.equal(/requires a verb/.test(res.stdout + res.stderr), false, 'the verb was eaten by `--json`');
});

test('`harness run --status succeeded list` is not refused as an unknown verb', () => {
  const ws = tempDir('cr-run-ws-');
  const res = spawnSync(process.execPath, [binPath, 'run', '--status', 'succeeded', 'list', '--workspace', ws], { encoding: 'utf8' });
  assert.equal(/unknown run verb/.test(res.stdout + res.stderr), false,
    'the gate refused an invocation the handler understood — the two scans disagreed');
});

// --- fail-closed and validation ------------------------------------------

test('a named check refuses to run when the configuration will not parse', async () => {
  const { runNamedCheck } = await import('../lib/checks.mjs');
  const ws = tempDir('cr-checks2-ws-');
  const home = tempDir('cr-checks2-home-');
  fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(home, 'harness', 'config.yaml'), '"exec.bash_enabled": definitely-not-false\n');

  const result = await runNamedCheck(ws, 'x', { command: [process.execPath, '-e', '0'] }, { copilotHome: home });
  assert.equal(result.status, 'unavailable',
    'a dropped key can be a control — checks.env_allowlist defaults false and exec.network defaults allow');
  assert.match(result.reason, /configuration has errors/);
});

test('inherited Object.prototype keys are rejected by the config schema, not silently accepted', () => {
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(Object.hasOwn(CONFIG_SCHEMA, key), false, `${key} must not be an own key`);
    assert.throws(() => coerceValue(key, 'anything'), (e) => e.code === 'E_USAGE',
      `${key} resolved to an inherited member, so spec.type was undefined and the value skipped every validation branch`);
  }
});

test('a config file naming a prototype key reports it as unknown instead of storing it', () => {
  const home = tempDir('cr-cfg-home-');
  const ws = tempDir('cr-cfg-ws-');
  fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(home, 'harness', 'config.yaml'), 'toString: 1\nconstructor: 2\n');
  const cfg = resolveConfig({ copilotHome: home, workspace: ws });
  assert.equal(cfg.errors.length, 2, 'the documented rule is that an unknown key is reported, never silently accepted');
  for (const e of cfg.errors) assert.match(e, /unknown key/);
});

// --- an unapproved repository cannot stop the harness --------------------

test('a broken policy in an UNTRUSTED project is reported, not thrown', () => {
  const ws = tempDir('cr-pol-ws-');
  const home = tempDir('cr-pol-home-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 99\n');

  const policy = loadPolicy(ws, null, { copilotHome: home });
  assert.ok(policy, 'an unapproved repository could abort every verify and gate run by committing `version: 99`');
  assert.equal(policy.enforcement, 'enforce', 'and the run continues on the built-in default');
  assert.match(policy.projectPolicyError, /version 1 or 2/, 'the complaint still reaches the operator');
  assert.equal(policy.projectPolicyIgnored, true);
});

test('a broken policy in a TRUSTED project still throws — there the file is in force', () => {
  const ws = tempDir('cr-pol2-ws-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 99\n');
  // No copilotHome ⇒ the trust gate is not engaged ⇒ treated as trusted.
  assert.throws(() => loadPolicy(ws), /version 1 or 2/);
});

test('unparseable YAML in an untrusted project is reported rather than fatal', () => {
  const ws = tempDir('cr-pol3-ws-');
  const home = tempDir('cr-pol3-home-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 1\n\tbad: [unclosed\n');
  const policy = loadPolicy(ws, null, { copilotHome: home });
  assert.ok(policy.projectPolicyError);
  assert.equal(policy.enforcement, 'enforce');
});

// --- exit codes and identity ---------------------------------------------

test('a refused placement makes add/update/remove exit non-zero', () => {
  assert.equal(resourcesExitFor({ verb: 'add', status: 'ok', sync: { refused: [] } }), 0);
  assert.notEqual(resourcesExitFor({ verb: 'add', status: 'ok', sync: { refused: [{ target: 'skills/x' }] } }), 0,
    'CI could not tell "installed" from "installed and silently placed nothing"');
  assert.notEqual(resourcesExitFor({ verb: 'remove', status: 'ok', sync: { refused: [{ target: 'skills/x' }] } }), 0);
});

test('two enabled bundles claiming one manifest name are a reported conflict, not a coin flip', () => {
  const home = tempDir('cr-dup-home-');
  for (const dirName of ['alpha', 'beta']) {
    const dir = path.join(home, 'resources', dirName);
    fs.mkdirSync(path.join(dir, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'demo', 'SKILL.md'), `from ${dirName}\n`);
    fs.writeFileSync(path.join(dir, 'harness-resource.yaml'),
      'schema: 1\nname: shared-name\nversion: 1.0.0\ncontributes:\n  skills: ["demo/SKILL.md"]\n');
    fs.writeFileSync(path.join(dir, '.enabled'), '');
  }
  const bundles = discoverBundles(home, { trustedNames: new Set(['alpha', 'beta']) });
  assert.equal(bundles.every((b) => b.state === 'conflicted'), true,
    'a winning contribution could otherwise be read out of whichever directory came first');
  for (const b of bundles) assert.match(b.reason, /also declares the name/);
  assert.deepEqual(resolvePrecedence(bundles), [], 'and nothing is placed while the conflict stands');
});

test('every bundle carries a unique directory id alongside its manifest name', () => {
  const home = tempDir('cr-id-home-');
  const dir = path.join(home, 'resources', 'my-dir');
  fs.mkdirSync(path.join(dir, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'demo', 'SKILL.md'), 'x\n');
  fs.writeFileSync(path.join(dir, 'harness-resource.yaml'),
    'schema: 1\nname: different-name\nversion: 1.0.0\ncontributes:\n  skills: ["demo/SKILL.md"]\n');
  fs.writeFileSync(path.join(dir, '.enabled'), '');

  const [bundle] = discoverBundles(home, { trustedNames: new Set(['my-dir']) });
  assert.equal(bundle.id, 'my-dir', 'the directory is the unique identity');
  assert.equal(bundle.name, 'different-name', 'the manifest name is what an operator reads');
  assert.equal(resolvePrecedence([bundle])[0].winnerId, 'my-dir', 'and placement resolves against the id');
});

// --- hygiene --------------------------------------------------------------

test('the vscode hook probe removes BOTH of its fixture directories', () => {
    const jail = tempDir('cr-doc-jail-');
  const hooks = path.join(tempDir('cr-doc-hooks-'), 'hooks');
  const res = spawnSync(process.execPath, ['-e', `
    const { runVSCodeHookProbe } = await import(${JSON.stringify(path.join(packageRoot, 'lib', 'doctor.mjs'))});
    await runVSCodeHookProbe(${JSON.stringify(hooks)});
  `.trim()], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, TMPDIR: jail, TMP: jail, TEMP: jail },
  });

  const left = fs.readdirSync(jail).filter((n) => n.startsWith('harness-doctor-'));
  assert.deepEqual(left, [],
    `only \`workspace\` was removed, so every probe left a harness-doctor-home-* directory — with a trust store inside it${res.stderr ? `\n${res.stderr.slice(0, 300)}` : ''}`);
});

test('the prune pass builds its drop set once instead of rescanning per entry', () => {
    const source = fs.readFileSync(path.join(packageRoot, 'lib', 'retention.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/keep\.includes\(/.test(source), false,
    'a linear scan per entry is O(n²), run while holding the prune lock and blocking every appender');
});

test('every declared flag name is a single flag, not a comma-joined string', () => {
  const bad = [];
  for (const n of listCommands()) {
    for (const f of getCommand(n).args?.flags || []) {
      if (/[,\s]/.test(f.name)) bad.push(`${n}: ${JSON.stringify(f.name)}`);
    }
  }
  assert.deepEqual(bad, [],
    'a name like "-c, --collection" registers one flag with a comma in it, so the short form was never an alias at all');
});
