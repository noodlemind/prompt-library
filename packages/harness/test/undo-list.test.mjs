/**
 * `harness undo list` — see what undo would revert, without reverting it.
 *
 * `harness undo` reverses the most recent mutation. There is no way to look
 * first. An operator who has run several edits and wants to know what is
 * outstanding has to either undo something to find out, or read
 * `.harness/undo.jsonl` by hand — which is exactly the internal detail the
 * command exists to hide.
 *
 * These tests are written against the COMMAND, not against any function, so the
 * implementation is free to take whatever shape fits the codebase.
 *
 * The contract:
 *   - `harness undo list` prints the outstanding entries, newest first
 *   - `--json` emits `{ entries: [{ id, mode, path }, …] }`, newest first
 *   - it changes nothing: no file is reverted and the stack is not consumed
 *   - an empty stack is exit 0 with a plain statement, not an error
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function run(argv, ws) {
  return spawnSync(process.execPath, [binPath, ...argv, '--workspace', ws], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

/** A workspace with two files already edited, so the stack has two entries. */
function seedTwoEdits() {
  const ws = tempDir('undo-list-');
  fs.writeFileSync(path.join(ws, 'first.txt'), 'alpha\n', 'utf8');
  fs.writeFileSync(path.join(ws, 'second.txt'), 'beta\n', 'utf8');
  const a = run(['edit', '--path', 'first.txt', '--old', 'alpha', '--new', 'ALPHA'], ws);
  assert.equal(a.status, 0, a.stderr);
  const b = run(['edit', '--path', 'second.txt', '--old', 'beta', '--new', 'BETA'], ws);
  assert.equal(b.status, 0, b.stderr);
  return ws;
}

test('undo list reports the outstanding entries, newest first', () => {
  const ws = seedTwoEdits();
  const result = run(['undo', 'list', '--json'], ws);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.entries), 'the json lane reports an `entries` array');
  assert.equal(payload.entries.length, 2);
  assert.equal(payload.entries[0].path, 'second.txt', 'newest first — undo reverts the head of this list');
  assert.equal(payload.entries[1].path, 'first.txt');
  for (const entry of payload.entries) {
    assert.equal(entry.mode, 'edit');
    assert.ok(entry.id, 'each entry carries the id its audit event recorded');
  }
});

test('undo list changes nothing — it is a read', () => {
  const ws = seedTwoEdits();
  run(['undo', 'list'], ws);

  assert.equal(fs.readFileSync(path.join(ws, 'first.txt'), 'utf8'), 'ALPHA\n', 'listing must not revert anything');
  assert.equal(fs.readFileSync(path.join(ws, 'second.txt'), 'utf8'), 'BETA\n');

  // …and the stack is not consumed: a later undo still reverts the newest.
  const undone = run(['undo'], ws);
  assert.equal(undone.status, 0, undone.stderr);
  assert.equal(fs.readFileSync(path.join(ws, 'second.txt'), 'utf8'), 'beta\n');
});

test('an empty stack is exit 0 and a plain statement, not an error', () => {
  const ws = tempDir('undo-list-empty-');
  const result = run(['undo', 'list'], ws);

  assert.equal(result.status, 0, 'nothing outstanding is a normal answer to a question, not a failure');
  const payload = JSON.parse(run(['undo', 'list', '--json'], ws).stdout);
  assert.deepEqual(payload.entries, []);
});

test('an entry that has been undone drops off the list', () => {
  const ws = seedTwoEdits();
  assert.equal(run(['undo'], ws).status, 0);

  const payload = JSON.parse(run(['undo', 'list', '--json'], ws).stdout);
  assert.equal(payload.entries.length, 1, 'what undo has already reverted is no longer outstanding');
  assert.equal(payload.entries[0].path, 'first.txt');
});

