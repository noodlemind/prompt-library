/**
 * Kernel todo worklist (AC14).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runTodo, todoResultOf, TODO_REL } from '../lib/todo-cmd.mjs';
import { hasCommand, getCommand } from '../lib/registry.mjs';
import { dispatchToolCall } from '../lib/agent-loop.mjs';

const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

test('todo is a registered kernel command', () => {
  assert.ok(hasCommand('todo'));
  assert.equal(getCommand('todo').sideEffect, 'mutate');
  assert.ok(getCommand('todo').surfaces.includes('agent'));
});

test('todo list/add/complete/clear persists under .harness/todo.json', () => {
  const ws = tempDir('todo-store-');
  let r = runTodo({ workspace: ws, verb: 'list' });
  assert.equal(r.status, 'ok');
  assert.equal(r.items.length, 0);

  r = runTodo({ workspace: ws, verb: 'add', text: 'reproduce failure' });
  assert.equal(r.status, 'ok');
  assert.equal(r.item.text, 'reproduce failure');
  assert.ok(fs.existsSync(path.join(ws, TODO_REL)));

  r = runTodo({ workspace: ws, verb: 'add', text: 'edit and re-verify' });
  assert.equal(r.items.length, 2);

  const id = r.items[0].id;
  r = runTodo({ workspace: ws, verb: 'complete', id });
  assert.equal(r.status, 'ok');
  assert.equal(r.items.find((i) => i.id === id).status, 'done');

  r = runTodo({ workspace: ws, verb: 'list' });
  assert.equal(r.doneCount, 1);
  assert.equal(r.openCount, 1);

  r = runTodo({ workspace: ws, verb: 'clear' });
  assert.equal(r.status, 'ok');
  assert.equal(runTodo({ workspace: ws, verb: 'list' }).items.length, 0);
});

test('todo agent tool maps to the command', async () => {
  const ws = tempDir('todo-agent-');
  const outcome = await dispatchToolCall(
    { id: '1', name: 'todo', input: { verb: 'add', text: 'step one' } },
    { workspace: ws },
  );
  assert.equal(outcome.dispatched, true);
  assert.equal(outcome.result.status, 'ok');
  const listed = await todoResultOf(['list', '--workspace', ws]);
  assert.equal(listed.items.length, 1);
});
