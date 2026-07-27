import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (args, env = {}) =>
  spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

test('compound --insight writes a kind: insight doc without any plan or evidence', () => {
  const ws = tempDir('insight-ws-');
  const home = tempDir('insight-home-');
  const res = run([
    'compound', '--insight', '--title', 'Orders pool exhaustion under bulk load',
    '--category', 'debugging', '--tags', 'orders,timeout',
    '--body', 'Connection pool exhausts under N+1 on /orders/bulk. Suspect missing batch fetch.',
    '--workspace', ws, '--copilot-home', home, '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kind, 'insight');
  assert.match(out.path, /^docs\/solutions\/debugging\/\d{4}-\d{2}-\d{2}-orders-pool-exhaustion/);
  const doc = fs.readFileSync(path.join(ws, out.path), 'utf8');
  assert.match(doc, /kind: insight/);
  assert.match(doc, /title: "Orders pool exhaustion under bulk load"/);
  assert.match(doc, /Connection pool exhausts/);
});

test('compound --insight refuses to write when the body contains a secret', () => {
  const ws = tempDir('insight-sec-');
  const res = run([
    'compound', '--insight', '--title', 'leak', '--body', 'key=AKIAIOSFODNN7EXAMPLE',
    '--workspace', ws, '--copilot-home', tempDir('insight-sech-'), '--json',
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /secret/i);
  assert.ok(!fs.existsSync(path.join(ws, 'docs', 'solutions')));
});

test('compound --insight requires --title and body', () => {
  const res = run([
    'compound', '--insight', '--workspace', tempDir('insight-req-'),
    '--copilot-home', tempDir('insight-reqh-'), '--json',
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /--title/);
});

test('compound --insight reads body from --body-file and indexes the doc', () => {
  const ws = tempDir('insight-bf-');
  const home = tempDir('insight-bfh-');
  const bodyFile = path.join(ws, 'note.md');
  fs.writeFileSync(bodyFile, 'Retry storms amplify 429s when jitter is missing.\n');
  const res = run([
    'compound', '--insight', '--title', 'Retry storms need jitter',
    '--body-file', bodyFile, '--workspace', ws, '--copilot-home', home, '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kind, 'insight');
  assert.ok(out.indexed.entries >= 1);
  const manifest = fs.readFileSync(path.join(ws, 'knowledge', 'manifest.yaml'), 'utf8');
  assert.match(manifest, /retry-storms-need-jitter/);
});

test('verified compound lane still requires a plan (unchanged)', () => {
  const ws = tempDir('insight-vl-');
  const res = run([
    'compound', '--workspace', ws, '--copilot-home', tempDir('insight-vlh-'), '--json',
  ]);
  assert.equal(res.status, 2);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason, /plan/i);
});
