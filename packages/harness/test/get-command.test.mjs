import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runGet } from '../lib/get-cmd.mjs';
import { getResultOf } from '../lib/retrieval/compat-results.mjs';
import { externalPlansDir } from '../lib/project-layout.mjs';
import { tempDir } from './helpers/temp.mjs';

test('read resolves emitted absolute primitive and selected project-plan pointers only', async t => {
  const root = tempDir('get-pointers-'), workspace = path.join(root, 'workspace'), copilotHome = path.join(root, 'copilot'), home = path.join(root, 'home');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(workspace);
  const primitive = path.join(copilotHome, 'skills/caffeinated/SKILL.md');
  const plan = path.join(externalPlansDir(workspace, { home }), '2026-10-12-feat-pointer-plan.md');
  for (const file of [primitive, plan]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '# Read this pointer.\n'); }
  assert.equal(runGet({ workspace, copilotHome, home, flags: { path: primitive } }).truncated, false);
  const result = await getResultOf(['--workspace', workspace, '--copilot-home', copilotHome, '--harness-home', home, '--path', plan]);
  assert.match(result.excerpt, /Read this pointer/);
  const secret = path.join(copilotHome, 'auth.json'); fs.writeFileSync(secret, 'private');
  for (const outside of [secret, path.join(root, 'outside.md'), path.join(home, 'domains/other/plans/task.md')]) {
    assert.throws(() => runGet({ workspace, copilotHome, home, flags: { path: outside } }), /escapes workspace/);
  }
  for (const relative of ['skills/../auth.json', 'agents/../auth.json', 'instructions/../auth.json']) {
    assert.throws(() => runGet({ workspace, copilotHome, home, flags: { path: relative } }), /file not found/);
  }
  const linked = path.join(copilotHome, 'skills/linked/SKILL.md'); fs.mkdirSync(path.dirname(linked)); fs.symlinkSync(primitive, linked);
  assert.throws(() => runGet({ workspace, copilotHome, home, flags: { path: linked } }));
});
