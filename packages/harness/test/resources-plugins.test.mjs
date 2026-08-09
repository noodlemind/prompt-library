/**
 * Phase 5 — resource bundles and the plugin protocol.
 *
 * The assertions that matter are the trust-boundary ones. This is the largest
 * expansion of what the harness will load and run, and the Grok Build telemetry
 * incident is the cautionary case the delivery doc names: a plugin surface that
 * defaults open is one that ships something nobody asked for.
 *
 * So the fixture plugin here is a REAL child process speaking the real
 * protocol, not a stub. A crash-isolation claim tested against a mock proves
 * only that the mock behaves.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import {
  CONTRIBUTION_KINDS,
  bundleDigest,
  discoverBundles,
  parseManifest,
  resolvePrecedence,
} from '../lib/resources.mjs';
import { FORBIDDEN_WRITE_SURFACES, MAX_LOG_ENTRIES, PROTOCOL_VERSION, startPlugin } from '../lib/plugin-host.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function makeBundle(home, name, { manifest = {}, files = {}, enabled = false } = {}) {
  const dir = path.join(home, 'resources', name);
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    schema: 1, name, version: '1.0.0', contributes: {}, capabilities: [], ...manifest,
  };
  const lines = [
    `schema: ${full.schema}`,
    `name: ${full.name}`,
    `version: ${full.version}`,
    ...(full.priority !== undefined ? [`priority: ${full.priority}`] : []),
    ...(full.plugin ? [`plugin: ${full.plugin}`] : []),
    'contributes:',
    ...CONTRIBUTION_KINDS.flatMap((k) => (full.contributes[k] ? [`  ${k}: ${JSON.stringify(full.contributes[k])}`] : [])),
    `capabilities: ${JSON.stringify(full.capabilities)}`,
  ];
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  if (full.integrity === true) lines.push(`integrity: ${bundleDigest(dir)}`);
  else if (typeof full.integrity === 'string') lines.push(`integrity: ${full.integrity}`);
  fs.writeFileSync(path.join(dir, 'harness-resource.yaml'), `${lines.join('\n')}\n`);
  if (enabled) fs.writeFileSync(path.join(dir, '.enabled'), 'x');
  return dir;
}

const trusted = (home) => new Set(
  fs.existsSync(path.join(home, 'resources'))
    ? fs.readdirSync(path.join(home, 'resources')).filter((n) => fs.existsSync(path.join(home, 'resources', n, '.enabled')))
    : [],
);

// --- P5AC1 / P5AC2: manifests and precedence -------------------------------

test('a malformed manifest is reported and its bundle disabled, never silently skipped', () => {
  const home = tempDir('res-bad-');
  makeBundle(home, 'broken', { manifest: { schema: 99 } });
  const [bundle] = discoverBundles(home);
  assert.equal(bundle.state, 'invalid');
  assert.match(bundle.reason, /schema must be 1/,
    'a bundle whose author believes it is contributing while it does nothing is the worst outcome for both sides');
});

test('an unknown contribution kind or capability is refused by name', () => {
  const bad = parseManifest('schema: 1\nname: x\nversion: 1.0.0\ncontributes:\n  telepathy: ["a"]\n');
  assert.match(bad.errors[0], /unknown contribution kind telepathy/);
  const badCap = parseManifest('schema: 1\nname: x\nversion: 1.0.0\ncapabilities: ["root"]\n');
  assert.match(badCap.errors[0], /unknown capability root/);
});

test('P5AC2: precedence is deterministic and does not depend on directory order', () => {
  const home = tempDir('res-prec-');
  makeBundle(home, 'bravo', { manifest: { contributes: { skills: ['shared.md'] } }, enabled: true });
  makeBundle(home, 'alpha', { manifest: { contributes: { skills: ['shared.md'] } }, enabled: true });
  const rows = resolvePrecedence(discoverBundles(home, { trustedNames: trusted(home) }));
  const shared = rows.find((r) => r.path === 'shared.md');
  assert.equal(shared.winner, 'alpha', 'name is the tie-break — install order and readdir order vary by machine');
  assert.deepEqual(shared.shadowed, ['bravo'],
    'the useful question is not what won but why mine did not, so the losers are retained');
});

test('P5AC2: an explicit priority outranks the name tie-break', () => {
  const home = tempDir('res-prio-');
  makeBundle(home, 'alpha', { manifest: { contributes: { skills: ['shared.md'] } }, enabled: true });
  makeBundle(home, 'bravo', { manifest: { contributes: { skills: ['shared.md'] }, priority: 10 }, enabled: true });
  const rows = resolvePrecedence(discoverBundles(home, { trustedNames: trusted(home) }));
  assert.equal(rows.find((r) => r.path === 'shared.md').winner, 'bravo');
});

// --- P5AC3: integrity and trust --------------------------------------------

test('P5AC3: a bundle is untrusted until explicitly enabled', () => {
  const home = tempDir('res-trust-');
  makeBundle(home, 'demo', { manifest: { contributes: { skills: ['a.md'] } }, files: { 'skills/a.md': 'x' } });
  const [bundle] = discoverBundles(home, { trustedNames: trusted(home) });
  assert.equal(bundle.state, 'untrusted');
  assert.equal(resolvePrecedence([bundle]).length, 0, 'an unapproved bundle contributes nothing');
});

test('P5AC3: a bundle whose contents no longer match its pin is tampered, and cannot be enabled', () => {
  const home = tempDir('res-pin-');
  const dir = makeBundle(home, 'pinned', {
    manifest: { contributes: { skills: ['a.md'] }, integrity: true },
    files: { 'skills/a.md': 'original' },
    enabled: true,
  });
  assert.equal(discoverBundles(home, { trustedNames: trusted(home) })[0].state, 'enabled');

  fs.writeFileSync(path.join(dir, 'skills', 'a.md'), 'swapped after approval');
  const [after] = discoverBundles(home, { trustedNames: trusted(home) });
  assert.equal(after.state, 'tampered', 'a pin exists precisely so content changing under an approval is loud');

  // The CLI no longer surfaces bundles — `resources` serves locally-added
  // primitives now — so the guarantee is asserted where it lives: a tampered
  // bundle contributes nothing, whatever a caller does with it.
  assert.equal(resolvePrecedence([after]).length, 0,
    'a bundle whose contents changed under its pin must not contribute');
});

test('P5AC3: a mismatched pin is reported as tampered with the reason', () => {
  const home = tempDir('res-ci-');
  makeBundle(home, 'pinned', { manifest: { integrity: 'sha256-not-the-real-one' }, files: { 'skills/a.md': 'x' } });
  const [bundle] = discoverBundles(home, { trustedNames: new Set(['pinned']) });
  assert.equal(bundle.state, 'tampered');
  assert.match(bundle.reason, /integrity pin does not match/);
});

// --- P5AC4 / P5AC6: the plugin protocol, against a real child process -------

/** A fixture plugin that speaks the real protocol over stdin/stdout. */
function writePlugin(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'plugin.mjs');
  fs.writeFileSync(file, body);
  return file;
}

const ECHO_PLUGIN = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  let i = buf.indexOf('\\n');
  while (i !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); i = buf.indexOf('\\n');
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'hello') {
      process.stdout.write(JSON.stringify({ type: 'hello', protocol: msg.protocol, capabilities: msg.capabilities }) + '\\n');
    } else if (msg.type === 'request') {
      if (msg.method === 'boom') { process.exit(7); }
      if (msg.method === 'hang') { return; }
      process.stdout.write(JSON.stringify({ type: 'result', id: msg.id, result: { echoed: msg.params } }) + '\\n');
    } else if (msg.type === 'shutdown') { process.exit(0); }
  }
});
`;

test('P5AC4: a plugin runs out of process and answers a versioned request', async () => {
  const dir = tempDir('plug-ok-');
  const file = writePlugin(dir, ECHO_PLUGIN);
  const plugin = startPlugin({
    command: process.execPath,
    args: [file],
    granted: ['read-workspace'],
    requested: ['read-workspace'],
    env: { PATH: process.env.PATH },
  });
  assert.deepEqual(plugin.capabilities, ['read-workspace']);
  const result = await plugin.request('echo', { a: 1 });
  assert.deepEqual(result, { echoed: { a: 1 } });
  plugin.close();
  assert.equal(PROTOCOL_VERSION, 1);
});

test('P5AC4: capabilities are the intersection of requested and granted, and the difference is reported', async () => {
  const dir = tempDir('plug-caps-');
  const file = writePlugin(dir, ECHO_PLUGIN);
  const plugin = startPlugin({
    command: process.execPath,
    args: [file],
    granted: ['read-workspace'],
    requested: ['read-workspace', 'network', 'execute'],
    env: { PATH: process.env.PATH },
  });
  assert.deepEqual(plugin.capabilities, ['read-workspace']);
  assert.deepEqual(plugin.refused, ['network', 'execute'],
    'a plugin that silently does not get what it asked for leaves "why can it not see X" unanswerable');
  plugin.close();
});

// P5AC6 — the claim the whole out-of-process design exists to make.
test('P5AC6: a crashing plugin fails its in-flight request and cannot take the host down', async () => {
  const dir = tempDir('plug-crash-');
  const file = writePlugin(dir, ECHO_PLUGIN);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH } });

  await assert.rejects(
    plugin.request('boom', {}),
    (error) => error.code === 'E_PLUGIN_CRASH',
    'an awaiting caller must be settled, not left hanging — a hung host is what crash isolation is supposed to prevent',
  );
  assert.equal(plugin.alive, false);
  // The host is still here to make this assertion, which is the point.
  assert.equal(typeof startPlugin, 'function');
});

test('P5AC4: a plugin that never answers is bounded by a timeout rather than hanging the harness', async () => {
  const dir = tempDir('plug-hang-');
  const file = writePlugin(dir, ECHO_PLUGIN);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH } });
  await assert.rejects(
    plugin.request('hang', {}, { timeout: 250 }),
    (error) => error.code === 'E_PLUGIN_TIMEOUT',
    'a third party must not get to decide how long the harness waits',
  );
  plugin.close();
});

test('a plugin that fails to start is reported, not thrown into the host', async () => {
  const plugin = startPlugin({ command: path.join(tempDir('plug-missing-'), 'nope'), args: [], env: {} });
  await assert.rejects(plugin.request('echo', {}), (error) => /E_PLUGIN/.test(error.code));
});

test('a stray non-protocol line does not desync the stream', async () => {
  const dir = tempDir('plug-noise-');
  const file = writePlugin(dir, `
    process.stdout.write('this is not json\\n');
    ${ECHO_PLUGIN}
  `);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH } });
  const result = await plugin.request('echo', { ok: true });
  assert.deepEqual(result, { echoed: { ok: true } },
    'line framing is what keeps one bad line from being the rest of the session’s problem');
  plugin.close();
});

// --- P5AC5: the write boundary ---------------------------------------------

test('P5AC5: the protocol defines no message that writes policy, the journal, evidence, or the store', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'lib', 'plugin-host.mjs'), 'utf8');
  for (const surface of FORBIDDEN_WRITE_SURFACES) {
    assert.ok(surface, 'the forbidden surfaces are named as data, not left to prose');
  }
  // The host imports nothing that can write those surfaces — enforcement is
  // structural rather than a rule the plugin is asked to respect.
  for (const forbidden of ['evidence.mjs', 'run-journal.mjs', 'policy.mjs', 'knowledge/store.mjs']) {
    assert.equal(source.includes(forbidden), false,
      `plugin-host must not import ${forbidden}: a plugin cannot be denied a write the host is able to broker`);
  }
});

// --- self-review findings, verified before the phase review returned --------

/**
 * A contributed path is a path INSIDE the bundle. A manifest is a third-party
 * file describing what the harness should load, which makes it the least
 * trustworthy input in the system — and it was previously accepted with a
 * traversal in it.
 */
test('a manifest cannot contribute a path outside its own bundle', () => {
  for (const bad of ['../../../etc/passwd', '/etc/passwd', 'a/../../b', '..']) {
    const { errors } = parseManifest(`schema: 1\nname: x\nversion: 1.0.0\ncontributes:\n  skills: [${JSON.stringify(bad)}]\n`);
    assert.ok(errors.length, `${bad} must be refused`);
    assert.match(errors[0], /escapes the bundle|must be relative/);
  }
  for (const ok of ['skill.md', 'nested/deep/skill.md']) {
    const { errors } = parseManifest(`schema: 1\nname: x\nversion: 1.0.0\ncontributes:\n  skills: [${JSON.stringify(ok)}]\n`);
    assert.deepEqual(errors, [], `${ok} is an ordinary in-bundle path`);
  }
});

/**
 * Crash isolation is not only about a plugin that dies. A chatty one writing
 * megabytes with no newline grew the host's line buffer to 438 MB in two
 * seconds — exhausting the process it was supposed to be insulated from,
 * without ever crashing itself.
 */
test('P5AC6: a plugin flooding stdout without a newline cannot exhaust the host', async () => {
  const dir = tempDir('plug-flood-');
  const file = writePlugin(dir, 'setInterval(() => process.stdout.write("x".repeat(1024 * 512)), 1);');
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH } });

  const before = process.memoryUsage().heapUsed;
  await new Promise((r) => setTimeout(r, 1200));
  const grown = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  plugin.close();

  assert.ok(grown < 100, `host heap grew ${grown.toFixed(0)}MB — third-party output must be bounded on arrival`);
  assert.ok(plugin.logs.some((l) => /unterminated output/.test(l.text)),
    'discarding it silently would leave the operator with no explanation for missing messages');
});

test('a plugin cannot make the host retain unbounded log text either', async () => {
  const dir = tempDir('plug-logs-');
  const file = writePlugin(dir, `
    let i = 0;
    const t = setInterval(() => {
      if (i++ > 2000) { clearInterval(t); return; }
      process.stdout.write(JSON.stringify({ type: 'log', text: 'entry ' + i }) + '\\n');
    }, 0);
  `);
  const plugin = startPlugin({ command: process.execPath, args: [file], env: { PATH: process.env.PATH } });
  await new Promise((r) => setTimeout(r, 800));
  plugin.close();
  assert.ok(plugin.logs.length <= MAX_LOG_ENTRIES, `logs grew to ${plugin.logs.length}`);
});
