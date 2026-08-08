/**
 * Phase 3 — `harness checks list|show|run`.
 *
 * The named checks were previously reachable only through `verify`, which runs
 * the whole plan-gated pipeline, so "what does this repo run, and does that one
 * check pass" had no answer short of reading the YAML by hand. That is how the
 * file came to have four independent parsers.
 *
 * What is pinned here: the per-verb side-effect split (a palette must not paint
 * an execute glyph on a listing), the exit-code contract (`run` reports the
 * check's own verdict so CI can gate on one check), and that an unknown check
 * is a not-found rather than a usage error or a crash.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getCommand } from '../lib/registry.mjs';
import { EXIT } from '../lib/style.mjs';
import { loadNamedChecks, validateCommand } from '../lib/checks.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function workspaceWithChecks(body) {
  const ws = tempDir('checks-ws-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'checks.yaml'), body);
  return ws;
}

function run(argv, ws) {
  return spawnSync(process.execPath, [binPath, ...argv, '--workspace', ws, '--copilot-home', tempDir('checks-home-')], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
}

const PASSING = `version: 1
checks:
  ok-check:
    command: ["node", "-e", "process.exit(0)"]
    timeout_seconds: 30
  bad-check:
    command: ["node", "-e", "process.exit(3)"]
`;

test('the shared check surface is importable — the whole point of the extraction', () => {
  assert.equal(typeof loadNamedChecks, 'function');
  assert.equal(typeof validateCommand, 'function');
  const ws = workspaceWithChecks(PASSING);
  const { checks, error } = loadNamedChecks(ws);
  assert.equal(error, null);
  assert.deepEqual(Object.keys(checks).sort(), ['bad-check', 'ok-check']);
});

// The entry's sideEffect is the policy-facing maximum; a palette that painted
// every verb with it would warn about a listing as loudly as an execution.
test('checks declares execute as its maximum, with list and show overriding down to read', () => {
  const entry = getCommand('checks');
  assert.equal(entry.sideEffect, 'execute', 'run executes a repo-authored argv, so the maximum is execute');
  const byVerb = Object.fromEntries(entry.verbs.map((v) => [v.verb, v.sideEffect ?? entry.sideEffect]));
  assert.equal(byVerb.list, 'read');
  assert.equal(byVerb.show, 'read');
  assert.equal(byVerb.run, 'execute', 'run inherits the maximum rather than overriding it');
});

test('checks list reports every declared check with its argv and timeout', () => {
  const ws = workspaceWithChecks(PASSING);
  const res = run(['checks', 'list', '--json'], ws);
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  assert.equal(body.checks.length, 2);
  const ok = body.checks.find((c) => c.name === 'ok-check');
  assert.deepEqual(ok.command, ['node', '-e', 'process.exit(0)']);
  assert.equal(ok.timeoutSeconds, 30);
  assert.equal(ok.valid, true);
  // The default is applied on read, not left undefined for the caller to guess.
  assert.equal(body.checks.find((c) => c.name === 'bad-check').timeoutSeconds, 600);
});

test('checks run exits 0 on pass and non-zero on failure, so CI can gate one check', () => {
  const ws = workspaceWithChecks(PASSING);
  const pass = run(['checks', 'run', 'ok-check', '--json'], ws);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).outcome.status, 'passed');

  const fail = run(['checks', 'run', 'bad-check', '--json'], ws);
  assert.notEqual(fail.status, 0, 'a failing check must not report success');
  assert.equal(JSON.parse(fail.stdout).outcome.status, 'failed');
});

test('an unknown check is a not-found that names the checks that exist', () => {
  const ws = workspaceWithChecks(PASSING);
  const res = run(['checks', 'show', 'nope'], ws);
  assert.equal(res.status, EXIT.notFound, res.stderr);
  assert.match(res.stderr, /E_NOT_FOUND/);
  assert.match(res.stderr, /bad-check, ok-check/, 'a typo is recoverable without a second command');
});

test('an unknown verb is a usage error, distinct from an absent check', () => {
  const ws = workspaceWithChecks(PASSING);
  const res = run(['checks', 'teleport'], ws);
  assert.equal(res.status, EXIT.usage, res.stderr);
  assert.match(res.stderr, /E_USAGE/);
});

test('a workspace with no check config reports that, rather than an empty list', () => {
  const ws = tempDir('checks-none-');
  const res = run(['checks', 'list'], ws);
  assert.equal(res.status, EXIT.notFound, res.stderr);
  assert.match(res.stderr, /Trusted check config not found/);
});

// An invalid entry must be visible rather than silently omitted: a check that
// cannot run is a broken gate, and a listing that hides it reads as healthy.
test('a malformed check entry is listed and marked invalid, not dropped', () => {
  const ws = workspaceWithChecks(`version: 1
checks:
  broken:
    command: []
`);
  const res = run(['checks', 'list', '--json'], ws);
  assert.equal(res.status, 0, res.stderr);
  const entry = JSON.parse(res.stdout).checks[0];
  assert.equal(entry.name, 'broken');
  assert.equal(entry.valid, false);
  assert.match(entry.invalidReason, /non-empty argv array/);
});

test('checks answers the envelope lane', () => {
  const ws = workspaceWithChecks(PASSING);
  const res = run(['checks', 'list', '--output', 'json-envelope'], ws);
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  assert.equal(body.command, 'checks');
  assert.equal(body.status, 'ok');
});
