/**
 * Multi-file CAS apply + lint-on-edit (AC17–AC18).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runApply, preflightApply } from '../lib/apply-cmd.mjs';
import { runEdit, runWrite, syntaxCheckContent, sha256 } from '../lib/edit-cmd.mjs';
import { hasCommand } from '../lib/registry.mjs';
import { dispatchToolCall } from '../lib/agent-loop.mjs';

const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

test('apply is a registered mutate command', () => {
  assert.ok(hasCommand('apply'));
});

test('multi-file apply succeeds all-or-nothing', () => {
  const ws = tempDir('apply-ok-');
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(ws, 'b.txt'), 'beta\n');
  const result = runApply({
    workspace: ws,
    changes: [
      { path: 'a.txt', old: 'alpha', new: 'ALPHA' },
      { path: 'b.txt', old: 'beta', new: 'BETA' },
    ],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.applied.length, 2);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'ALPHA\n');
  assert.equal(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8'), 'BETA\n');
});

test('apply refuses on conflict without writing any file', () => {
  const ws = tempDir('apply-conflict-');
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(ws, 'b.txt'), 'two\n');
  const result = runApply({
    workspace: ws,
    changes: [
      { path: 'a.txt', old: 'one', new: 'ONE' },
      { path: 'b.txt', old: 'missing', new: 'TWO' },
    ],
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'preflight');
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'one\n', 'no partial apply');
});

test('apply write path requires expect for existing files', () => {
  const ws = tempDir('apply-expect-');
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'c.txt'), 'content\n');
  const bad = preflightApply(ws, [{ path: 'c.txt', content: 'new\n' }]);
  assert.equal(bad.ok, false);
  const dig = sha256('content\n');
  const good = runApply({
    workspace: ws,
    changes: [{ path: 'c.txt', content: 'new\n', expect: dig.slice(0, 12) }],
  });
  assert.equal(good.status, 'ok');
});

test('agent apply tool dispatches to kernel apply', async () => {
  const ws = tempDir('apply-agent-');
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'x.txt'), 'old\n');
  const outcome = await dispatchToolCall(
    {
      id: '1',
      name: 'apply',
      input: { changes: [{ path: 'x.txt', old: 'old', new: 'new' }] },
    },
    { workspace: ws },
  );
  assert.equal(outcome.dispatched, true);
  assert.equal(outcome.result.status, 'ok');
  assert.equal(fs.readFileSync(path.join(ws, 'x.txt'), 'utf8'), 'new\n');
});

test('lint-on-edit refuses invalid JSON and skips markdown (AC18)', () => {
  assert.match(syntaxCheckContent('cfg.json', '{not json'), /JSON syntax/);
  assert.equal(syntaxCheckContent('cfg.json', '{"ok":true}'), null);
  assert.equal(syntaxCheckContent('README.md', 'not # balanced {{{'), null);

  const ws = tempDir('lint-edit-');
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'pkg.json'), '{"a":1}\n');
  const bad = runEdit({ workspace: ws, path: 'pkg.json', old: '{"a":1}', next: '{bad' });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.reason, 'syntax');
  assert.equal(fs.readFileSync(path.join(ws, 'pkg.json'), 'utf8'), '{"a":1}\n');

  const md = runWrite({ workspace: ws, path: 'note.md', content: 'hello {' });
  assert.equal(md.status, 'ok', 'non-code must not be blocked by lint');
});
