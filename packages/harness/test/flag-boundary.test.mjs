/**
 * Fix-wave regression C1 — the literal-argument boundary (`--`) must be
 * honored by EVERY flag parser, not just lib/registry.mjs#validateArgs and
 * bin/harness.mjs#extractOutputLane.
 *
 * Verified pre-fix leak: `harness status --no-events -- --json` emitted JSON
 * — lib/flags.mjs#parseFlags kept parsing past `--`, so the post-boundary
 * `--json` was re-interpreted as the real flag. Same class of bug for every
 * control flag (`--workspace`, `--dry-run`, `--no-events`, `--verbose`) and
 * for the bespoke `argv.includes('--x')` checks in lib/commands.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseFlags, hasFlag } from '../lib/flags.mjs';
import { eventPath } from '../lib/events.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHarness(args) {
  return spawnSync(process.execPath, [binPath, ...args], { cwd: packageRoot, encoding: 'utf8' });
}

// --- unit: parseFlags stops treating tokens as flags at `--` --------------

test('parseFlags: tokens after a literal `--` are never interpreted as flags', () => {
  const flags = parseFlags(['--no-events', '--', '--json', '--dry-run', '--verbose', '--workspace', '/somewhere/else']);
  assert.equal(flags.noEvents, true, 'pre-boundary flags still parse');
  assert.equal(flags.json, false, 'post-boundary --json must be inert');
  assert.equal(flags.dryRun, false, 'post-boundary --dry-run must be inert');
  assert.equal(flags.verbose, false, 'post-boundary --verbose must be inert');
  assert.equal(flags.workspace, process.cwd(), 'post-boundary --workspace must not move the workspace');
});

test('parseFlags: a value-flag immediately before `--` never swallows the boundary as its value', () => {
  const flags = parseFlags(['--query', 'find things', '--', '--json']);
  assert.equal(flags.query, 'find things');
  assert.equal(flags.json, false);
});

// Round-2 C1(a): a value-flag with a MISSING value sitting right before `--`
// used to consume the literal `--` as its value AND then keep parsing, so the
// post-boundary `--json` was re-interpreted. `parseFlags(['--workspace','--','--json'])`
// returned `{workspace:'--', json:true}` pre-fix.
test('parseFlags: a value-flag with a missing value never consumes `--`, and parsing stops there', () => {
  const flags = parseFlags(['--query', '--', '--json']);
  assert.notEqual(flags.query, '--', 'the boundary token must never become a flag value');
  assert.equal(flags.json, false, 'nothing after `--` is a flag, even when the value flag was empty');
});

// Codex P2: the boundary slice left `--workspace` as the LAST scanned token, so
// `scan[++i]` handed back undefined — which overwrote the process.cwd() default
// rather than being rejected. Workspace resolution then threw a raw
// ERR_INVALID_ARG_TYPE from inside path.resolve, an opaque crash where every
// other value flag reports a named error. `--workspace` now carries the same
// guard as `--since`/`--branch`/`--ids`.
test('parseFlags: --workspace with no value is a named error, never an undefined workspace', () => {
  assert.throws(() => parseFlags(['--workspace', '--', '--json']), /invalid --workspace/, 'missing value before the boundary');
  assert.throws(() => parseFlags(['--workspace']), /invalid --workspace/, 'missing value at the end of argv');
  assert.throws(() => parseFlags(['--workspace', '--json']), /invalid --workspace/, 'a flag-shaped next token is a missing value');
  assert.throws(() => parseFlags(['--workspace=']), /invalid --workspace/, 'the inline form with an empty value is the same missing value');
});

test('parseFlags: a workspace path containing `=` survives the inline form intact', () => {
  assert.equal(parseFlags(['--workspace=/tmp/a=b']).workspace, '/tmp/a=b', 'only the FIRST = separates flag from value');
});

test('hasFlag honors the boundary where argv.includes() did not', () => {
  assert.equal(hasFlag(['--status'], '--status'), true);
  assert.equal(hasFlag(['--', '--status'], '--status'), false);
  assert.equal(hasFlag(['x', '--', '--why'], '--why'), false);
  assert.equal(hasFlag(['--why', '--'], '--why'), true);
});

// --- e2e: the verified repro — `status --no-events -- --json` -------------

test('CLI: `status --no-events -- --json` renders the human ledger, never JSON (verified pre-fix leak)', () => {
  const workspace = tempDir('flag-boundary-status-ws-');
  const copilotHome = tempDir('flag-boundary-status-home-');
  const res = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--no-events', '--', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.throws(() => JSON.parse(res.stdout), 'post-boundary --json must not switch the output to JSON');
  assert.match(res.stdout, /harness/, 'the ordinary ledger rendering must appear');
});

test('CLI: control flags before `--` still work exactly as before (boundary is positional, not blanket)', () => {
  const workspace = tempDir('flag-boundary-json-ws-');
  const copilotHome = tempDir('flag-boundary-json-home-');
  const res = runHarness(['status', '--json', '--workspace', workspace, '--copilot-home', copilotHome, '--', 'literal']);
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  assert.equal(body.copilotHome, copilotHome);
});

// --- e2e: the TOP-LEVEL error path honors the boundary too ----------------
//
// Round-2 C1(b): bin/harness.mjs#emitError used `args.includes('--json')`, so
// an unknown-command error for `harness bogus -- --json` emitted a JSON
// envelope even though `--json` was post-boundary content. It now routes
// through the boundary-aware hasFlag and renders the human error block.

test('CLI: `bogus -- --json` renders the human error block on stderr, never a JSON envelope', () => {
  const res = runHarness(['bogus', '--', '--json']);
  assert.equal(res.status, 2, 'unknown command exits E_USAGE (2)');
  assert.throws(() => JSON.parse(res.stderr.trim()), 'the post-boundary --json must not switch the error surface to JSON');
  assert.match(res.stderr, /unknown command/i, 'the human error block must appear');
  assert.equal(res.stdout, '', 'no JSON on stdout either');
});

test('CLI: `bogus --json` (pre-boundary) still emits the JSON error envelope', () => {
  const res = runHarness(['bogus', '--json']);
  assert.equal(res.status, 2);
  const body = JSON.parse(res.stderr.trim());
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
});

// --- e2e: --no-events after `--` must not suppress event writing ----------

// `cmdKnowledge` resolves a copilot home on every path, so an un-isolated run
// resolves the developer's real `~/.copilot`. Pinning it to a temp dir keeps
// these two runs as hermetic as the `status` runs above, and keeps them that
// way if the bare-`knowledge` path ever starts reading from that home.
test('CLI: `knowledge -- --no-events` still writes events.jsonl (post-boundary --no-events is inert)', () => {
  const workspace = tempDir('flag-boundary-events-ws-');
  const copilotHome = tempDir('flag-boundary-events-home-');
  const res = runHarness(['knowledge', '--workspace', workspace, '--copilot-home', copilotHome, '--', '--no-events']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(eventPath(workspace)), 'events must still be written — the post-boundary flag is content, not a control');
});

test('CLI: `knowledge --no-events` (pre-boundary, control case) suppresses events as always', () => {
  const workspace = tempDir('flag-boundary-noevents-ws-');
  const copilotHome = tempDir('flag-boundary-noevents-home-');
  const res = runHarness(['knowledge', '--no-events', '--workspace', workspace, '--copilot-home', copilotHome]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(eventPath(workspace)), false);
});

// --- e2e: --dry-run after `--` must not suppress writes -------------------

// `runInitRepo` scans the copilot home for episodes (collectEpisodes,
// consolidateStatus), so an un-isolated run reads the developer's real
// `~/.copilot/knowledge` and the result varies by machine.
test('CLI: `init-repo -- --dry-run` performs real writes (post-boundary --dry-run is inert)', () => {
  const workspace = tempDir('flag-boundary-dryrun-ws-');
  const copilotHome = tempDir('flag-boundary-dryrun-home-');
  const res = runHarness(['init-repo', '--workspace', workspace, '--copilot-home', copilotHome, '--', '--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(workspace, '.harness')), 'init-repo must really initialize — post-boundary --dry-run is content');
});

// --- e2e: --workspace after `--` must not move the workspace --------------

test('CLI: `init-repo --workspace A -- --workspace B` initializes A, never B', () => {
  const wsA = tempDir('flag-boundary-wsa-');
  const wsB = tempDir('flag-boundary-wsb-');
  const copilotHome = tempDir('flag-boundary-wsab-home-');
  const res = runHarness(['init-repo', '--workspace', wsA, '--copilot-home', copilotHome, '--', '--workspace', wsB]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(wsA, '.harness')), 'the pre-boundary workspace is the real one');
  assert.equal(fs.existsSync(path.join(wsB, '.harness')), false, 'the post-boundary workspace token must be inert');
});

// --- e2e: bespoke argv.includes() sites (consolidate --rebuild) -----------

// `consolidate`'s debt count is computed over episodes collected from the
// copilot home as well as the workspace — isolated for the same reason.
test('CLI: `consolidate -- --rebuild --yes` treats the post-boundary tokens as content — the default status view runs', () => {
  const workspace = tempDir('flag-boundary-consolidate-ws-');
  const copilotHome = tempDir('flag-boundary-consolidate-home-');
  const res = runHarness(['consolidate', '--workspace', workspace, '--copilot-home', copilotHome, '--json', '--', '--rebuild', '--yes']);
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  // The default --status shape (debt/threshold), not the rebuild result
  // shape (archived/debt) — proving the post-boundary --rebuild was inert.
  assert.ok('debt' in body && 'threshold' in body, `expected the status view, got: ${res.stdout}`);
  assert.equal('archived' in body, false, 'the rebuild branch must not have run');
});
