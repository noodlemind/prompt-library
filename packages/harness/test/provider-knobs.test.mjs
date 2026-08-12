/**
 * The knobs and defaults the hardcoding review flagged, pinned.
 *
 * Every test here is a regression guard for a specific defect: a default
 * spelled in five places with two disagreeing, a `clear` that pinned the very
 * literal it claimed to forget, tuning variables the deny-all environment
 * silently stripped, `auto` answered from a hardcoded id while the fetched
 * catalogue sat on disk, and adapters that could only ever connect directly.
 * The shape of each test is "the property, not the spelling": what must hold
 * is that the values agree or the variable crosses, not what the value is.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  DEFAULT_PROVIDER, PROVIDERS, providerEnv, providerReadiness, resolveDefaultModel,
} from '../lib/provider.mjs';
import {
  AGENT_LIMITS, CONFIG_SCHEMA, coerceValue, loadConfigFile, resolveConfig, setConfigValue, unsetConfigValue,
} from '../lib/config.mjs';
import { writeModelCache } from '../lib/model-cache.mjs';
import { planAgent } from '../lib/agent-cmd.mjs';
import { getCommand } from '../lib/registry.mjs';
import { copilotConfigDir, findEditorOauthToken } from '../lib/copilot-credential.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

// --- one default provider, spelled once -------------------------------------

test('the default provider is one constant — config, registry and the flag help all read it', () => {
  assert.equal(CONFIG_SCHEMA['agent.provider'].default, DEFAULT_PROVIDER,
    'the config default and the seam constant were once two spellings, and they disagreed');
  const flag = getCommand('agent').args.flags.find((f) => f.name === '--provider');
  assert.equal(flag.default, DEFAULT_PROVIDER,
    'the registry declared anthropic while the runtime resolved github-copilot — the help lied');
  assert.match(flag.description, new RegExp(`default ${DEFAULT_PROVIDER}`),
    'the human-readable half of the declaration must agree with the machine half');
  assert.ok(DEFAULT_PROVIDER in PROVIDERS, 'the default must be a provider that exists');
});

test('planAgent falls back to the same default provider the config schema declares', () => {
  const home = tempDir('knobs-home-');
  const ws = tempDir('knobs-ws-');
  const plan = planAgent(['do', 'the', 'thing', '--workspace', ws, '--copilot-home', home]);
  assert.equal(plan.providerId, DEFAULT_PROVIDER);
});

test('agent.providers allowlist is the default product set; readiness can filter by it', () => {
  const home = tempDir('knobs-providers-home-');
  const ws = tempDir('knobs-providers-ws-');
  const resolved = resolveConfig({ copilotHome: home, workspace: ws });
  assert.deepEqual(resolved.values['agent.providers'], [DEFAULT_PROVIDER]);
  assert.equal(resolved.values['agent.enabled'], false, 'agent loop is off until enabled');

  const filtered = providerReadiness({ enabledIds: resolved.values['agent.providers'] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, DEFAULT_PROVIDER);

  setConfigValue({
    scope: 'user',
    key: 'agent.providers',
    value: 'github-copilot,openai',
    copilotHome: home,
    workspace: ws,
  });
  const after = resolveConfig({ copilotHome: home, workspace: ws });
  assert.deepEqual(after.values['agent.providers'], ['github-copilot', 'openai']);
});

// --- `model clear` forgets, it does not pin ---------------------------------

test('model clear REMOVES the keys — it must not write the current default into the file', () => {
  const home = tempDir('knobs-clear-home-');
  const ws = tempDir('knobs-clear-ws-');
  const run = (argv) => spawnSync(process.execPath, [binPath, ...argv, '--workspace', ws, '--copilot-home', home, '--no-color'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });

  assert.equal(run(['model', 'set', 'openai', 'gpt-5']).status, 0);
  const file = path.join(home, 'harness', 'config.yaml');
  assert.match(fs.readFileSync(file, 'utf8'), /agent\.provider/, 'set wrote the choice');

  assert.equal(run(['model', 'clear']).status, 0);
  const text = fs.readFileSync(file, 'utf8');
  // `agent.providers` (allowlist) may remain; `agent.provider` (active choice) must not.
  assert.doesNotMatch(text, /(?:^|\n)agent\.provider:/,
    'writing the default VALUE here pinned that day’s literal: a cleared user kept the old default forever after it changed');
  assert.doesNotMatch(text, /(?:^|\n)agent\.model:/);

  const resolved = resolveConfig({ copilotHome: home, workspace: ws });
  assert.equal(resolved.values['agent.provider'], DEFAULT_PROVIDER, 'absent key, shipped default');
  assert.equal(resolved.provenance['agent.provider'].source, 'default', 'and it reports as the default, not a choice');
});

test('unsetConfigValue removes only the named keys and refuses a file it cannot fully parse', () => {
  const home = tempDir('knobs-unset-home-');
  const ws = tempDir('knobs-unset-ws-');
  setConfigValue({ scope: 'user', key: 'exec.timeout_seconds', value: '120', copilotHome: home, workspace: ws });
  setConfigValue({ scope: 'user', key: 'agent.provider', value: 'openai', copilotHome: home, workspace: ws });

  const result = unsetConfigValue({ scope: 'user', keys: ['agent.provider', 'agent.model'], copilotHome: home, workspace: ws });
  assert.deepEqual(result.removed, ['agent.provider'], 'a key the file never set is already in the asked-for state');
  const after = loadConfigFile(path.join(home, 'harness', 'config.yaml'));
  assert.equal(after.values['exec.timeout_seconds'], 120, 'the neighbouring key survives');
  assert.equal('agent.provider' in after.values, false);

  fs.writeFileSync(path.join(home, 'harness', 'config.yaml'), 'exec.timeout_seconds: not-a-number\n');
  assert.throws(
    () => unsetConfigValue({ scope: 'user', keys: ['agent.provider'], copilotHome: home, workspace: ws }),
    (e) => /refusing to write over a config with errors/.test(e.message),
    'rewriting a half-parsed file would discard settings the operator believes are in effect',
  );
});

// --- `auto` resolves through the fetched catalogue --------------------------

test('an unset or auto model resolves through the fetched catalogue before the static table', () => {
  const home = tempDir('knobs-auto-home-');
  const ws = tempDir('knobs-auto-ws-');
  const base = ['do', 'a', 'thing', '--workspace', ws, '--copilot-home', home];

  assert.equal(planAgent(base).model, PROVIDERS[DEFAULT_PROVIDER].defaultModel,
    'a provider nobody has asked still answers from the table — the last resort works');

  // The static default is a QUALITY choice; the catalogue is a CALLABILITY
  // fact. The fetched list is sorted for a picker — alphabetical within a
  // preference tier — so `[0]` is an accident of spelling: on the measured
  // account it made `auto` mean `copilot-search-a`, a search utility. The
  // declared default wins whenever the catalogue confirms this account can
  // call it; the catalogue's own first entry answers only when it cannot.
  writeModelCache(home, {
    provider: DEFAULT_PROVIDER,
    models: ['claude-sonnet-5', 'gpt-4.1'],
    labels: {},
    fetchedAt: new Date().toISOString(),
  });
  assert.equal(planAgent(base).model, 'gpt-4.1',
    'the declared default, confirmed callable by the catalogue, beats whatever sorts first');
  assert.equal(planAgent([...base, '--model', 'auto']).model, 'gpt-4.1', 'typed auto resolves the same way');
  assert.equal(planAgent([...base, '--model', 'gpt-4.1']).model, 'gpt-4.1', 'an explicit model is never second-guessed');

  writeModelCache(home, {
    provider: DEFAULT_PROVIDER,
    models: ['claude-sonnet-5'],
    labels: {},
    fetchedAt: new Date().toISOString(),
  });
  assert.equal(planAgent(base).model, 'claude-sonnet-5',
    'a default this account cannot call yields to the catalogue — the original point of resolving through it');

  assert.equal(resolveDefaultModel('openai', {}), PROVIDERS.openai.defaultModel, 'no cache entry, table answer');
  assert.equal(resolveDefaultModel('telepathy', {}), null, 'an unknown provider has no default to offer');
});

// --- the budgets are configuration, with one set of bounds ------------------

test('agent budgets: flag beats config beats default, and the bounds are shared', () => {
  const home = tempDir('knobs-budget-home-');
  const ws = tempDir('knobs-budget-ws-');
  setConfigValue({ scope: 'user', key: 'agent.max_turns', value: '7', copilotHome: home, workspace: ws });
  setConfigValue({ scope: 'user', key: 'agent.max_seconds', value: '120', copilotHome: home, workspace: ws });
  const base = ['task', '--workspace', ws, '--copilot-home', home];

  assert.equal(planAgent(base).maxTurns, 7, 'the configured budget is the fallback');
  assert.equal(planAgent(base).maxSeconds, 120);
  assert.equal(planAgent([...base, '--max-turns', '3']).maxTurns, 3, 'the operator at the keyboard still wins');

  assert.equal(coerceValue('agent.max_turns', '25'), 25);
  assert.throws(() => coerceValue('agent.max_turns', String(AGENT_LIMITS.maxTurns.max + 1)), /agent\.max_turns/);
  assert.throws(() => coerceValue('agent.max_seconds', '0'), /agent\.max_seconds/);
});

test('a project may tighten a budget and never raise it', () => {
  const home = tempDir('knobs-restrict-home-');
  const ws = tempDir('knobs-restrict-ws-');
  setConfigValue({ scope: 'user', key: 'agent.max_turns', value: '10', copilotHome: home, workspace: ws });
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'config.yaml'), 'agent.max_turns: 400\n');
  assert.equal(resolveConfig({ copilotHome: home, workspace: ws, projectTrusted: true }).values['agent.max_turns'], 10,
    'a checked-in file must not be able to raise what the user bounded');
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'config.yaml'), 'agent.max_turns: 5\n');
  assert.equal(resolveConfig({ copilotHome: home, workspace: ws, projectTrusted: true }).values['agent.max_turns'], 5,
    'tightening is the direction a project is allowed to move');
});

// --- the seam forwards what the adapters actually read ----------------------

test('providerEnv forwards the adapter tuning variables — a knob only tests could reach is not a knob', () => {
  const tuned = providerEnv(PROVIDERS.ollama, {
    parentEnv: {
      PATH: '/usr/bin',
      HARNESS_PROVIDER_REQUEST_TIMEOUT_MS: '30000',
      HARNESS_PROVIDER_RETRIES: '5',
      HARNESS_PROVIDER_RETRY_BASE_MS: '250',
    },
  });
  assert.equal(tuned.HARNESS_PROVIDER_REQUEST_TIMEOUT_MS, '30000',
    'the adapters honoured this variable from day one; the deny-all environment silently stripped it');
  assert.equal(tuned.HARNESS_PROVIDER_RETRIES, '5');
  assert.equal(tuned.HARNESS_PROVIDER_RETRY_BASE_MS, '250');

  const untuned = providerEnv(PROVIDERS.ollama, { parentEnv: { PATH: '/usr/bin' } });
  for (const name of ['HARNESS_PROVIDER_REQUEST_TIMEOUT_MS', 'HARNESS_PROVIDER_RETRIES', 'HARNESS_PROVIDER_RETRY_BASE_MS']) {
    assert.equal(name in untuned, false, `${name} must not appear from nowhere`);
  }
});

test('providerEnv forwards the proxy contract to the child that opens the socket', () => {
  const env = providerEnv(PROVIDERS.ollama, {
    parentEnv: {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.corp:8080',
      no_proxy: 'internal.example',
      AWS_SECRET_ACCESS_KEY: 'must-not-pass',
    },
  });
  assert.equal(env.HTTPS_PROXY, 'http://proxy.corp:8080');
  assert.equal(env.no_proxy, 'internal.example');
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false, 'the deny-all default still stands for everything unnamed');
});

test('the Copilot exchange URL override crosses the seam validated; plaintext off-loopback is refused', () => {
  const copilot = PROVIDERS['github-copilot'];
  const env = providerEnv(copilot, {
    parentEnv: {
      PATH: '/usr/bin',
      GITHUB_COPILOT_TOKEN: 'tid=abc;exp=123',
      GITHUB_COPILOT_EXCHANGE_URL: 'https://api.ghe.example/copilot_internal/v2/token',
    },
  });
  assert.equal(env.HARNESS_COPILOT_EXCHANGE_URL, 'https://api.ghe.example/copilot_internal/v2/token',
    'a GHE account exchanges against its own host; a base URL that can move while auth cannot is half an override');

  assert.throws(
    () => providerEnv(copilot, {
      parentEnv: { PATH: '/usr/bin', GITHUB_COPILOT_EXCHANGE_URL: 'http://proxy.example/token' },
    }),
    (e) => e.code === 'E_USAGE' && /https/.test(e.message),
    'the OAuth grant crosses this connection — it gets the same transport rule as a base URL',
  );
});

// --- the editor credential scan lives once ----------------------------------

test('the seam and the adapter read the SAME editor-credential scan', () => {
  const home = tempDir('knobs-cred-home-');
  const dir = path.join(home, '.config', 'github-copilot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps.json'), JSON.stringify({ 'github.com:app': { oauth_token: 'gho_shared' } }));

  const env = { HOME: home };
  assert.equal(copilotConfigDir(env), dir);
  assert.equal(findEditorOauthToken(env), 'gho_shared');

  const xdg = tempDir('knobs-cred-xdg-');
  fs.mkdirSync(path.join(xdg, 'github-copilot'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'github-copilot', 'hosts.json'), JSON.stringify({ 'github.com': { oauth_token: 'gho_xdg' } }));
  assert.equal(findEditorOauthToken({ HOME: home, XDG_CONFIG_HOME: xdg }), 'gho_xdg', 'XDG wins when set');
});

// --- the proxy machinery, in the adapter that owns the socket ---------------

test('proxyFor proxies https targets only, and honours NO_PROXY, loopback, and the wildcard', async () => {
  const { proxyFor, noProxyMatches } = await import('../lib/providers/openai-compatible.mjs');
  const env = { HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: '.trusted.example, other.host:443' };

  assert.equal(proxyFor('https://api.example.com/v1', env)?.hostname, 'proxy.corp');
  assert.equal(proxyFor('https://svc.trusted.example/v1', env), null, 'NO_PROXY suffixes match');
  assert.equal(proxyFor('https://other.host/v1', env), null, 'a NO_PROXY port suffix is tolerated');
  assert.equal(proxyFor('http://127.0.0.1:11434/v1', env), null, 'plain http is loopback-only by the seam rule, and loopback is never proxied');
  assert.equal(proxyFor('https://api.example.com/v1', {}), null, 'no variable, no proxy');
  assert.equal(proxyFor('https://api.example.com/v1', { HTTPS_PROXY: '::not a url::' }), null, 'a malformed proxy URL degrades to direct');

  assert.equal(noProxyMatches('*', 'anything.example'), true);
  assert.equal(noProxyMatches('example.com', 'notexample.com'), false, 'suffix match respects the label boundary');
});

test('openTunnel performs a CONNECT through a local proxy and hands back the raw socket', async () => {
  const { openTunnel } = await import('../lib/providers/openai-compatible.mjs');
  const proxy = http.createServer();
  // A CONNECT-hijacked socket is half-open on the server side, so it must be
  // destroyed explicitly or proxy.close() waits on it forever.
  let serverSide = null;
  proxy.on('connect', (req, socket) => {
    serverSide = socket;
    assert.equal(req.url, 'target.example:443', 'the CONNECT names the real target');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data', (d) => socket.write(d)); // echo, standing in for the far side
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const { port } = proxy.address();

  const socket = await openTunnel(new URL(`http://127.0.0.1:${port}`), 'target.example', 443, { timeoutMs: 5000 });
  const echoed = await new Promise((resolve) => {
    socket.once('data', (d) => resolve(d.toString()));
    socket.write('ping');
  });
  assert.equal(echoed, 'ping', 'after the 200 the socket is a plain pipe to the target');
  socket.destroy();
  serverSide?.destroy();
  await new Promise((r) => proxy.close(r));
});

test('a proxy that refuses the CONNECT is a retriable failure that names the target', async () => {
  const { openTunnel } = await import('../lib/providers/openai-compatible.mjs');
  const proxy = http.createServer();
  let serverSide = null;
  proxy.on('connect', (req, socket) => {
    serverSide = socket;
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.end();
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const { port } = proxy.address();
  await assert.rejects(
    openTunnel(new URL(`http://127.0.0.1:${port}`), 'blocked.example', 443, { timeoutMs: 5000 }),
    (e) => e.retriable === true && /blocked\.example/.test(e.message) && /403/.test(e.message),
  );
  serverSide?.destroy();
  await new Promise((r) => proxy.close(r));
});
