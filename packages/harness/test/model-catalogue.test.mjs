import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { writeModelCache, readModelCache, cacheAge } from '../lib/model-cache.mjs';
import { startProvider, isAutoModel } from '../lib/provider.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** A child the plugin host can wire up without a process existing. Only the
 * streams `startPlugin` attaches to are needed — nothing is ever written. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdin = Object.assign(new EventEmitter(), { write() {}, end() {} });
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.kill = () => {};
  return child;
}

function show(copilotHome) {
  return spawnSync(process.execPath, [binPath, 'model', 'show', '--no-color', '--copilot-home', copilotHome], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

test('model show says a fetched catalogue was fetched, and when', () => {
  const home = tempDir('model-cat-fetched-');
  writeModelCache(home, {
    provider: 'github-copilot',
    models: ['gpt-4.1', 'claude-haiku-4.5'],
    labels: {},
    fetchedAt: new Date().toISOString(),
  });

  const out = show(home).stdout;
  assert.match(out, /catalog/, 'the provenance line must exist at all');
  assert.match(out, /fetched/, 'a fetched list has to say it was fetched');
  assert.match(out, /just now/, 'and when — an age the reader can act on');
});

test('an older catalogue reports its real age rather than implying freshness', () => {
  const home = tempDir('model-cat-old-');
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  writeModelCache(home, { provider: 'github-copilot', models: ['gpt-4.1'], labels: {}, fetchedAt: threeDaysAgo });

  const out = show(home).stdout;
  assert.match(out, /3d ago/, 'a three-day-old list must not read the same as one taken minutes ago');
});

test('with no cache the surface warns it is guessing, and names the fix', () => {
  const home = tempDir('model-cat-builtin-');
  const out = show(home).stdout;

  assert.match(out, /built-in list/, 'a built-in list can be wrong in both directions and must say so');
  assert.match(out, /model refresh/, 'a warning with no next step is half an answer');
});

test('every provenance field the status computes reaches the rendered output', () => {
  const home = tempDir('model-cat-render-');
  writeModelCache(home, { provider: 'github-copilot', models: ['gpt-4.1'], labels: {}, fetchedAt: new Date().toISOString() });

  const json = JSON.parse(spawnSync(process.execPath, [binPath, 'model', 'show', '--json', '--copilot-home', home], {
    cwd: packageRoot, encoding: 'utf8', env: { ...process.env },
  }).stdout);
  const rendered = show(home).stdout;

  assert.equal(json.catalogSource, 'fetched');
  assert.ok(json.catalogAge, 'the status object computes an age');
  assert.match(rendered, new RegExp(json.catalogSource), 'and the source appears on screen');
  assert.match(rendered, new RegExp(json.catalogAge), 'and so does the age');
});

test('auto is resolved to the provider default, never sent as a model id', () => {
  const spawned = [];
  const handle = startProvider({
    provider: 'github-copilot',
    model: 'auto',
    spawnFn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return fakeChild();
    },
  });
  assert.equal(handle.model, 'gpt-4.1', 'auto means the provider chooses, and it chose its default');
  assert.notEqual(handle.model, 'auto', 'the literal word must not survive into a request');
  handle.close();
});

test('auto is recognised however it is typed', () => {
  for (const spelling of ['auto', 'AUTO', ' Auto ']) assert.equal(isAutoModel(spelling), true, spelling);
  for (const other of ['gpt-4o', '', null, undefined, 'automatic']) assert.equal(isAutoModel(other), false, String(other));
});

test('an explicit model is still passed through untouched', () => {
  const handle = startProvider({
    provider: 'github-copilot',
    model: 'gpt-4.1',
    spawnFn: () => fakeChild(),
  });
  assert.equal(handle.model, 'gpt-4.1');
  handle.close();
});

test('the cache round-trips what was written, and dates it', () => {
  const home = tempDir('model-cat-io-');
  const at = new Date().toISOString();
  writeModelCache(home, { provider: 'github-copilot', models: ['a', 'b'], labels: { a: 'A' }, fetchedAt: at });
  writeModelCache(home, { provider: 'ollama', models: ['c'], labels: {}, fetchedAt: at });

  const cache = readModelCache(home);
  assert.deepEqual(cache['github-copilot'].models, ['a', 'b']);
  assert.deepEqual(cache.ollama.models, ['c'], 'refreshing one provider must not discard another');
  assert.equal(cacheAge(at), 'just now');
  assert.equal(cacheAge(null), null, 'never fetched is not an age');
});
