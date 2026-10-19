import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeScopes, initGit } from './helpers/index.mjs';
import { buildTaskContext } from '../lib/context-policy.mjs';
import { runAgentLoop, BENCHMARK_PROFILE } from '../lib/agent-loop.mjs';

function fixture(t) {
  const f = makeScopes();
  t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(f.copilotHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(f.workspace, 'src'));
  fs.writeFileSync(path.join(f.workspace, 'src/a.mjs'), "import { item } from './b.mjs';\nexport const value = item;\n");
  fs.writeFileSync(path.join(f.workspace, 'src/b.mjs'), 'export const item = 1;\n');
  fs.writeFileSync(path.join(f.workspace, 'src/c.mjs'), 'export const unrelated = 2;\n');
  initGit(f.workspace);
  return { ...f, build: options => buildTaskContext({ workspace: f.workspace, copilotHome: f.copilotHome, task: 'repair value', files: ['src/a.mjs'], ...options }) };
}

test('context policies are opt-in and retain their exact selection limits', (t) => {
  const f = fixture(t);
  assert.equal(f.build({ policy: 'legacy' }).body, '');
  const selective = f.build({ policy: 'selective' });
  assert.deepEqual(selective.files.map(file => file.location), ['src/a.mjs', 'src/b.mjs']);
  const broader = f.build({ policy: 'subsystem' });
  assert.deepEqual(broader.files.map(file => file.location), ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/example.js']);
  assert.equal(broader.coverage.semanticCompleteness, 'unverified');
  assert.ok(Buffer.byteLength(broader.body) <= 16000);
});

test('policy evidence refreshes changed bytes and reports omitted content', (t) => {
  const f = fixture(t);
  const before = f.build({ policy: 'selective' });
  fs.writeFileSync(path.join(f.workspace, 'src/b.mjs'), 'export const item = 99;\n');
  const after = f.build({ policy: 'selective' });
  assert.notEqual(after.contextId, before.contextId);
  assert.match(after.body, /item = 99/);
  const limited = f.build({ policy: 'subsystem', maxFiles: 1 });
  assert.equal(limited.files.length, 1);
  assert.equal(limited.coverage.omittedFiles, 3);
});

test('context preparation cannot start a model request after the deadline', async (t) => {
  const f = fixture(t);
  let clock = 0, calls = 0;
  const result = await runAgentLoop({ task: 'repair value', workspace: f.workspace, copilotHome: f.copilotHome, persona: { name: 'engineer', hydrated: false }, profile: BENCHMARK_PROFILE, maxSeconds: 1, now: () => clock,
    contextProvider: () => { clock = 2000; return { body: 'evidence', policy: 'selective', files: [], coverage: {} }; },
    startProviderFn: () => ({ provider: 'scripted', model: 'fixture', close() {}, async complete() { calls++; return { text: 'done', toolCalls: [] }; } }),
  });
  assert.equal(calls, 0);
  assert.equal(result.stopReason, 'time-budget');
});
