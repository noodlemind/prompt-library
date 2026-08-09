/**
 * P5AC7/P5AC8 — the first-party provider seam.
 *
 * Two properties are load-bearing here and neither is enforceable by a comment,
 * so both are asserted at the source level in the style of the existing
 * `FORBIDDEN_WRITE_SURFACES` check.
 *
 *   1. Harness core links no model SDK and reads no provider key. The settled
 *      invariant is "CLI never calls an LLM; Harness never consumes a model",
 *      and out-of-process placement is what keeps it literally true rather than
 *      reinterpreted. Once a seam exists, the invariant stops being maintained
 *      by absence and starts being maintained by review — this test is what
 *      replaces the absence.
 *
 *   2. The seam is FIRST-PARTY ONLY. Phase 5 declined third-party executable
 *      extensions; the reversal that allowed a provider allowed exactly one
 *      caller. A bundle can still declare a `plugin:` field nobody reads, and
 *      that is precisely the route this test exists to keep shut.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  PROVIDERS,
  PROVIDER_TIMEOUT_MS,
  SANCTIONED_PLUGIN_CALLERS,
  providerEnv,
  resolveProvider,
  startProvider,
} from '../lib/provider.mjs';
import { MAX_COMPLETION_LINE_BYTES, PLUGIN_MESSAGES, startPlugin } from '../lib/plugin-host.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libDir = path.join(packageRoot, 'lib');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** Every `.mjs` under lib/, with its repo-relative path. */
function libSources({ includeProviders = false } = {}) {
  const out = [];
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!includeProviders && entry.name === 'providers') continue;
        walk(full, rel);
      } else if (entry.name.endsWith('.mjs')) {
        out.push({ rel: `lib/${rel}`, text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(libDir, '');
  return out;
}

// --- P5AC7: core links no model SDK and reads no key ----------------------

test('P5AC7: harness core imports no model SDK', () => {
  // The adapters directory is excluded on purpose — it is a separate PROCESS,
  // which is the entire mechanism by which the invariant survives.
  const forbidden = [
    '@anthropic-ai/sdk', 'anthropic', 'openai', '@google/generative-ai',
    '@azure/openai', 'cohere-ai', 'mistralai', 'ollama', 'langchain',
  ];
  const offenders = [];
  for (const { rel, text } of libSources()) {
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      if (forbidden.some((f) => spec === f || spec.startsWith(`${f}/`))) offenders.push(`${rel} imports ${spec}`);
    }
  }
  assert.deepEqual(offenders, [],
    'out-of-process placement is what keeps "Harness never consumes a model" literally true; an SDK in core collapses it');
});

test('P5AC7: no module in core except the seam names a provider key at all', () => {
  const keyVars = Object.values(PROVIDERS).map((p) => p.keyVar);
  const offenders = [];
  for (const { rel, text } of libSources()) {
    // `provider.mjs` is checked BY BEHAVIOR below rather than skipped here.
    // Excluding it is how the previous version of this test passed while the
    // property it claimed was false (Codex phase-5 review, F13).
    if (rel === 'lib/provider.mjs') continue;
    for (const keyVar of keyVars) {
      if (text.includes(keyVar)) offenders.push(`${rel} names ${keyVar}`);
    }
  }
  assert.deepEqual(offenders, [], 'the seam is the only module in core that should know a credential variable exists');
});

test('P5AC7: the credential is touched exactly once, and goes nowhere but the child environment', () => {
  // A getter counts every read, so this measures what the code DOES rather
  // than what its comment says. `spawn` takes an environment object, so one
  // read is unavoidable — the property worth asserting is that it is one, and
  // that the value appears nowhere else.
  let reads = 0;
  const parentEnv = { PATH: '/usr/bin' };
  Object.defineProperty(parentEnv, 'ANTHROPIC_API_KEY', {
    enumerable: true,
    get() { reads += 1; return 'sk-ant-SENTINEL'; },
  });

  const env = providerEnv(resolveProvider('anthropic'), { parentEnv });
  assert.equal(reads, 1, 'a second read is a second place the value can be captured');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-SENTINEL', 'the child does need it');

  // It must appear under its own name and nowhere else — not duplicated into a
  // diagnostic field, not echoed into the base URL, not in the provider id.
  const elsewhere = Object.entries(env).filter(([k, v]) => k !== 'ANTHROPIC_API_KEY' && String(v).includes('SENTINEL'));
  assert.deepEqual(elsewhere, [], 'the credential is in the environment, not in the report about it');
});

test('P5AC7: no core module outside the seam calls providerEnv, so the copy cannot spread', () => {
  const callers = [];
  for (const { rel, text } of libSources()) {
    if (rel === 'lib/provider.mjs') continue;
    if (/\bproviderEnv\s*\(/.test(text)) callers.push(rel);
  }
  assert.deepEqual(callers, [],
    'the transient copy is acceptable BECAUSE it is confined to one function; a second caller is what would make it a leak');
});

test('P5AC7: the adapter is a separate process — nothing in core imports it', () => {
  const offenders = [];
  for (const { rel, text } of libSources()) {
    if (rel.startsWith('lib/providers/')) continue;
    if (/from\s+['"]\.\.?\/providers\//.test(text) || /import\s*\(\s*['"]\.\.?\/providers\//.test(text)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [],
    'an import would collapse the boundary the separate process exists to create');
});

// --- P5AC7: first-party only ----------------------------------------------

test('P5AC7: startPlugin has exactly one production caller, and it is the provider seam', () => {
  const callers = [];
  for (const { rel, text } of libSources({ includeProviders: true })) {
    if (rel === 'lib/plugin-host.mjs') continue;
    if (/\bstartPlugin\s*\(/.test(text)) callers.push(rel);
  }
  assert.deepEqual(callers.sort(), [...SANCTIONED_PLUGIN_CALLERS].sort(),
    'the reversal that allowed this seam allowed ONE caller; a second is a decision about the third-party boundary and belongs in a plan');
});

test('P5AC7: no bundle path can reach the plugin host', () => {
  for (const file of ['lib/resources.mjs', 'lib/resources-cmd.mjs', 'lib/bundle-sync.mjs']) {
    // Comments are stripped first: these modules legitimately DISCUSS the
    // boundary, and a test that cannot tell prose from code would force the
    // explanation out of the files that most need it.
    const code = fs.readFileSync(path.join(packageRoot, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\bstartPlugin\s*\(|from\s+['"][^'"]*plugin-host/.test(code), false,
      `${file} must not reach the plugin host — a bundle manifest can declare a plugin field, and this is the route that stays shut`);
  }
});

test('P5AC7: no command registers a plugin surface', () => {
  const registry = fs.readFileSync(path.join(libDir, 'registry.mjs'), 'utf8');
  assert.equal(/name:\s*'plugins?'/.test(registry), false,
    'there is no operator-facing plugin install surface, which is half of what "first-party only" means');
});

// --- P5AC7: the provider environment --------------------------------------

test('P5AC7: the provider child gets a deny-all environment plus its credential', () => {
  const env = providerEnv(resolveProvider('anthropic'), {
    parentEnv: {
      PATH: '/usr/bin',
      HOME: '/home/dev',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      AWS_SECRET_ACCESS_KEY: 'must-not-pass',
      GITHUB_TOKEN: 'must-not-pass',
    },
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-secret', 'the provider is the one child that needs a secret');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false,
    'the child that holds one credential is the one whose environment deserves most scrutiny, not least');
  assert.equal('GITHUB_TOKEN' in env, false);
});

test('P5AC7: a missing key is a usage error naming the variable, not a crash mid-run', () => {
  assert.throws(
    () => providerEnv(resolveProvider('anthropic'), { parentEnv: { PATH: '/usr/bin' } }),
    (e) => e.code === 'E_USAGE' && /ANTHROPIC_API_KEY/.test(e.message),
  );
});

test('P5AC7: an unknown provider is refused by name', () => {
  assert.throws(
    () => resolveProvider('telepathy'),
    (e) => e.code === 'E_USAGE' && /telepathy/.test(e.message) && /known providers/.test(e.hint),
  );
});

// --- P5AC8: the protocol carries a model call -----------------------------

test('P5AC8: the protocol has a streamed response type that never settles a request', async () => {
  assert.ok(PLUGIN_MESSAGES.includes('chunk'));
  const dir = tempDir('prov-stream-');
  const file = path.join(dir, 'p.mjs');
  fs.writeFileSync(file, `
    let buf = '';
    process.stdin.on('data', (c) => {
      buf += c.toString();
      let i = buf.indexOf('\\n');
      while (i !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); i = buf.indexOf('\\n');
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'request') {
          process.stdout.write(JSON.stringify({ type: 'chunk', id: msg.id, text: 'par' }) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'chunk', id: msg.id, text: 'tial' }) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'result', id: msg.id, result: { text: 'partial' } }) + '\\n');
        }
      }
    });
  `);
  const chunks = [];
  const plugin = startPlugin({
    command: process.execPath, args: [file], env: { PATH: process.env.PATH },
    onChunk: (c) => chunks.push(c.text),
  });
  const result = await plugin.request('complete', {});
  plugin.close();
  assert.deepEqual(chunks, ['par', 'tial'], 'progress is observable');
  assert.deepEqual(result, { text: 'partial' }, 'and only `result` settles the request');
});

test('P5AC8: the completion bound is raised for a provider but still enforced', () => {
  assert.ok(MAX_COMPLETION_LINE_BYTES > 1024 * 1024, 'a long completion is a legitimately large single line');
  assert.ok(Number.isFinite(MAX_COMPLETION_LINE_BYTES), '"no limit" is how the host dies on a plugin’s behalf');
  assert.ok(PROVIDER_TIMEOUT_MS > 30_000, 'a provider that has not answered in 30s is usually still thinking');
});

// --- the seam end to end, against the real adapter -------------------------

test('the provider handle answers a completion through the real adapter process', async () => {
  // A stub API is out of scope; what is provable without network is that the
  // adapter speaks the protocol and reports a missing key as an error rather
  // than crashing the host.
  const provider = startProvider({ parentEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'not-a-real-key' } });
  await assert.rejects(
    provider.complete({ messages: [{ role: 'user', content: 'hi' }] }, { timeout: 15_000 }),
    (error) => /anthropic|request failed/i.test(error.message),
    'a provider failure is reported as data, never thrown into the host',
  );
  provider.close();
});

test('the provider handle exposes completion and close, and not the raw request channel', () => {
  const provider = startProvider({ parentEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'x' } });
  assert.equal(typeof provider.complete, 'function');
  assert.equal(typeof provider.close, 'function');
  assert.equal('request' in provider, false,
    'widening the surface should be a decision someone makes on purpose, not one that happens by having the object in hand');
  provider.close();
});
