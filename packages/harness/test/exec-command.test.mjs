/**
 * Phase 3 — `harness exec` and `harness bash`, the governed execution surface.
 *
 * `exec-policy.test.mjs` pins the policy module in isolation. This file pins
 * the properties that only exist once the policy is wired to a real child
 * process through the registry: that `exec` genuinely never reaches a shell,
 * that the two commands stay distinguishable in the audit log, that an
 * execution is recorded no matter which output lane the caller picked, and that
 * the exit code tells the truth on all of them.
 *
 * The lane coverage is the part worth stating plainly: the audit event and the
 * child's exit code both used to come from the handler alone, so
 * `--output json-envelope` spawned a process that left no execution record and
 * reported exit 0 next to `"status":"failed"`. An audit a caller can skip by
 * choosing an output format is not an audit, and an exit code that disagrees
 * with the envelope beside it is worse than no exit code.
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

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * `--workspace` is a HARNESS flag, so it has to land before the `--` boundary —
 * appended after it, it would be handed to the child, which is exactly the
 * confusion the mandatory boundary exists to prevent.
 */
function run(argv, ws, { env = {} } = {}) {
  const boundary = argv.indexOf('--');
  const full = boundary === -1
    ? [...argv, '--workspace', ws]
    : [...argv.slice(0, boundary), '--workspace', ws, ...argv.slice(boundary)];
  return spawnSync(process.execPath, [binPath, ...full], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** Every audit event of the two execution types, in write order. */
function auditEvents(ws) {
  const file = path.join(ws, '.harness', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'exec' || event.type === 'bash');
}

// The single property that justifies `exec` existing next to `bash`. If a shell
// were reachable here, the argv the operator reviewed would not be the argv that
// runs, and every other control in this phase would be enforcing policy on the
// wrong command.
test('exec never reaches a shell — metacharacters arrive at the child verbatim', () => {
  const ws = tempDir('exec-noshell-');
  const marker = path.join(ws, 'substitution-ran');
  const seenFile = path.join(ws, 'seen.json');
  // The child records what it received to a FILE rather than to stdout: the
  // streamed output lane is budgeted and clips long rows, and this assertion is
  // about argv fidelity, not about rendering.
  const script = path.join(ws, 'record-args.js');
  fs.writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify(process.argv.slice(2)));\n`);

  const tokens = [`$(touch ${marker})`, '*', '`id`', 'a;b', 'a|b', '$HOME', '>out.txt'];
  const res = run(['exec', '--no-events', '--', process.execPath, script, ...tokens], ws);

  assert.equal(res.status, EXIT.ok, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(seenFile, 'utf8')), tokens,
    'every token must reach the child exactly as written — no expansion, no splitting');
  assert.equal(fs.existsSync(marker), false, 'command substitution must never have been evaluated');
  assert.equal(fs.existsSync(path.join(ws, 'out.txt')), false, 'redirection must never have been interpreted');
});

test('bash does reach a shell — the reason it is a separate, separately gated command', () => {
  const ws = tempDir('exec-shell-');
  const res = run(['bash', '--no-events', '--', 'echo one; echo two'], ws);
  assert.equal(res.status, EXIT.ok, res.stderr);
  assert.match(res.stdout, /one/);
  assert.match(res.stdout, /two/, 'the `;` must have been interpreted, or this is not a shell');
});

// AC2: "both are identified distinctly in events and evidence." A boolean
// inside a payload would mean an auditor filtering for shell invocations has to
// trust the payload; separate types mean the filter is the type.
test('exec and bash are distinct event types, not one type with a flag', () => {
  const ws = tempDir('exec-types-');
  run(['exec', '--', process.execPath, '-e', '0'], ws);
  run(['bash', '--', 'true'], ws);

  const types = auditEvents(ws).map((e) => e.type);
  assert.deepEqual(types, ['exec', 'bash']);
  const [execEvent, bashEvent] = auditEvents(ws);
  assert.equal(execEvent.exec.shell, false);
  assert.equal(bashEvent.exec.shell, true);
});

// AC5: an audit entry for EVERY execution. The lane is the caller's choice of
// output format; it must not be a choice about whether the execution is
// recorded.
for (const lane of [null, 'json-envelope', 'agent']) {
  test(`an execution is audited on the ${lane || 'ledger'} lane`, () => {
    const ws = tempDir('exec-audit-lane-');
    const argv = ['exec'];
    if (lane) argv.push('--output', lane);
    argv.push('--', process.execPath, '-e', 'process.exit(0)');
    run(argv, ws);

    const events = auditEvents(ws);
    assert.equal(events.length, 1, `the ${lane || 'ledger'} lane must write exactly one execution audit event`);
    assert.equal(events[0].type, 'exec');
  });
}

// An execution log carrying only an exit code cannot answer the question it
// exists for.
test('the audit entry records what ran, where, and under what policy', () => {
  const ws = tempDir('exec-audit-body-');
  fs.mkdirSync(path.join(ws, 'sub'));
  run(['exec', '--cwd', 'sub', '--timeout', '42', '--', process.execPath, '-e', 'process.exit(3)'], ws);

  const [event] = auditEvents(ws);
  assert.ok(event, 'an execution must be audited');
  assert.deepEqual(event.exec.argv, [process.execPath, '-e', 'process.exit(3)']);
  assert.equal(event.exec.cwd, path.join(ws, 'sub'));
  assert.equal(event.exec.timeoutSeconds, 42);
  assert.ok(Array.isArray(event.exec.env.allowed) && event.exec.env.allowed.includes('PATH'));
  assert.equal(typeof event.exec.env.droppedCount, 'number');
  // Outcome scalars stay top-level so the existing events tooling reads them.
  assert.equal(event.status, 'failed');
  assert.equal(event.exitCode, 3);
  assert.equal(event.result, 'fail');
});

// The allowlist withheld those credentials on purpose; writing them into the
// audit would hand them straight back.
test('the audit entry carries environment NAMES, never values', () => {
  const ws = tempDir('exec-audit-envnames-');
  run(['exec', '--allow-env', 'MY_BUILD_TOKEN', '--', process.execPath, '-e', '0'], ws, {
    env: { MY_BUILD_TOKEN: 'value-that-must-not-be-persisted' },
  });

  const raw = fs.readFileSync(path.join(ws, '.harness', 'events.jsonl'), 'utf8');
  assert.equal(raw.includes('value-that-must-not-be-persisted'), false,
    'an allowlisted variable is still a credential — the record names it, never quotes it');
  const [event] = auditEvents(ws);
  assert.ok(event.exec.env.allowed.includes('MY_BUILD_TOKEN'));
});

test('a secret typed into the argv is redacted before the audit entry is persisted', () => {
  const ws = tempDir('exec-audit-redact-');
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  run(['exec', '--', process.execPath, '-e', '0', `--token=${secret}`], ws);

  const raw = fs.readFileSync(path.join(ws, '.harness', 'events.jsonl'), 'utf8');
  assert.equal(raw.includes(secret), false, 'the argv is caller free-text and passes the same redaction boundary as any other');
  const [event] = auditEvents(ws);
  assert.match(event.exec.argv.at(-1), /redacted/);
});

// The defect this pins: the envelope said "failed" and the process exited 0.
for (const lane of [null, 'json-envelope', 'agent']) {
  test(`the child's exit code is the command's exit code on the ${lane || 'ledger'} lane`, () => {
    const ws = tempDir('exec-exit-lane-');
    const argv = ['exec', '--no-events'];
    if (lane) argv.push('--output', lane);
    argv.push('--', process.execPath, '-e', 'process.exit(7)');
    const res = run(argv, ws);
    assert.equal(res.status, 7, `a scripted caller must see the child's own code, not a lane-dependent one (${res.stdout}${res.stderr})`);
  });
}

test('the envelope lane never reports a status its exit code contradicts', () => {
  const ws = tempDir('exec-envelope-agree-');
  const res = run(['exec', '--no-events', '--output', 'json-envelope', '--', process.execPath, '-e', 'process.exit(7)'], ws);
  const envelope = JSON.parse(res.stdout);
  assert.equal(envelope.status, 'failed');
  assert.equal(envelope.exitCode, 7);
  assert.equal(res.status, 7, 'the process exit and the envelope must describe the same outcome');
});

// A `--` that is merely conventional gets omitted, and then the harness eats a
// flag meant for the child. Requiring it means every invocation has one reading.
test('the -- boundary is required, and a flag after it belongs to the child', () => {
  const ws = tempDir('exec-boundary-');
  const missing = run(['exec', '--no-events'], ws);
  assert.equal(missing.status, EXIT.usage);
  assert.match(missing.stderr + missing.stdout, /E_USAGE/);

  // `--json` after the boundary must be a child argument, not a harness flag:
  // if the harness had claimed it, stdout would be its own JSON envelope and
  // the child would never see the token. A script FILE rather than `-e`,
  // because node parses flag-shaped tokens after `-e <script>` as its own.
  const script = path.join(ws, 'echo-args.js');
  fs.writeFileSync(script, 'console.log("ARGV:" + JSON.stringify(process.argv.slice(2)));\n');
  const passthrough = run(['exec', '--no-events', '--', process.execPath, script, '--json', '--workspace', '/etc'], ws);
  assert.equal(passthrough.status, EXIT.ok, passthrough.stderr);
  const seen = JSON.parse(passthrough.stdout.split('\n').find((l) => l.includes('ARGV:')).split('ARGV:')[1]);
  assert.deepEqual(seen, ['--json', '--workspace', '/etc'],
    'the harness must not consume a flag after the boundary, even one it recognizes');

});

test('a cwd outside the workspace is refused at the CLI boundary, not just in the policy module', () => {
  const ws = tempDir('exec-cwd-cli-');
  const outside = tempDir('exec-cwd-out-');
  const res = run(['exec', '--no-events', '--cwd', outside, '--', process.execPath, '-e', '0'], ws);
  assert.equal(res.status, EXIT.usage);
  assert.match(res.stderr + res.stdout, /escapes the workspace/);
});

// AC3: the timeout is enforced, and a timed-out run is its own terminal state —
// never a generic failure. Exit 8 is the reserved code.
test('a run that exceeds its timeout is terminated and reported as timed-out, exit 8', () => {
  const ws = tempDir('exec-timeout-');
  const res = run(['exec', '--no-events', '--timeout', '1', '--', process.execPath, '-e', 'setTimeout(() => {}, 60000)'], ws);
  assert.equal(res.status, EXIT.timedOut, `expected the reserved timed-out code (${res.stdout}${res.stderr})`);
  assert.match(res.stdout + res.stderr, /timed-out/);
});

test('a secret in the child output is redacted before it is printed', () => {
  const ws = tempDir('exec-output-redact-');
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  const res = run(['exec', '--no-events', '--', process.execPath, '-e', `console.log("leak=${secret}")`], ws);
  assert.equal(res.stdout.includes(secret), false, 'child output is untrusted text and passes the same redactor as everything else');
  assert.match(res.stdout, /leak=/);
});

// Registry-declared metadata is what the palette and the later phases read; a
// wrong side-effect class here mislabels the command everywhere it appears.
test('both commands declare the execute side-effect class and carry all three lanes', () => {
  for (const name of ['exec', 'bash']) {
    const entry = getCommand(name);
    assert.ok(entry, `${name} must be registered`);
    assert.equal(entry.sideEffect, 'execute');
    assert.equal(typeof entry.resultOf, 'function', `${name} must be lane-bearing`);
    assert.equal(typeof entry.exitOf, 'function', `${name} must map its native non-zero outcome onto an exit code`);
  }
});
