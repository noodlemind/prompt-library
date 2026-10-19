import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeScopes, writeVersionedPlan, initGit } from './helpers/index.mjs';
import { writeSession } from '../lib/session.mjs';
import { runGet } from '../lib/get-cmd.mjs';
import { compactMessages } from '../lib/agent-loop.mjs';
import { buildTaskHandoff, validateContextSnapshot } from '../lib/task-handoff.mjs';
import { policyDigest } from '../lib/trust.mjs';

test('handoff reloads the plan and marks changed evidence for refresh', (t) => {
  const { workspace, copilotHome } = makeScopes();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(copilotHome, { recursive: true, force: true }));
  const plan = writeVersionedPlan(workspace, { intent: 'Preserve accepted records' });
  fs.appendFileSync(path.join(workspace, plan), '\n## Constraints\n- Never delete rows.\n\n## Research Notes\n- Open question: Which consumer owns retry?\n');
  fs.writeFileSync(path.join(workspace, 'a.mjs'), 'export const item = 1;');
  initGit(workspace);
  const sha256 = runGet({ workspace, copilotHome, flags: { path: 'a.mjs' } }).sha256;
  writeSession(workspace, { activePlan: plan, files: ['a.mjs'], contextSnapshot: { version: 2, evidence: [{ location: 'a.mjs', state: 'readable', sha256 }] } });
  const first = buildTaskHandoff({ workspace, task: 'Continue the accepted task' });
  assert.equal(first.contract.intent, 'Preserve accepted records');
  assert.deepEqual(first.contract.constraints, ['Never delete rows.']);
  assert.match(first.notes, /Which consumer owns retry/);
  assert.equal(first.evidence[0].state, 'current');
  fs.writeFileSync(path.join(workspace, 'a.mjs'), 'export const item = 2;');
  const changed = buildTaskHandoff({ workspace, task: 'Continue the accepted task' });
  assert.equal(changed.evidence[0].state, 'changed');
  assert.equal(changed.requiresRead, true);
  fs.writeFileSync(path.join(workspace, plan), fs.readFileSync(path.join(workspace, plan), 'utf8').replace('Never delete rows.', 'Never delete rows or columns.'));
  const resumed = buildTaskHandoff({ workspace, task: 'Continue the accepted task' });
  assert.deepEqual(resumed.contract.constraints, ['Never delete rows or columns.']);
  assert.notEqual(resumed.contractDigest, first.contractDigest);
});

test('structured compaction retains the task, unresolved failures and mutation receipts', () => {
  const hash = 'a'.repeat(64);
  const messages = [
    { role: 'user', text: 'Keep the accepted constraint.' },
    { role: 'user', toolResults: [{ id: 'read-old', output: 'stale body', source: { path: 'a.mjs', sha256: hash } }] },
    { role: 'user', toolResults: [{ id: 'failure', output: 'check failed for a real reason', isError: true }] },
    { role: 'user', toolResults: [{ id: 'mutation', output: 'edited a.mjs successfully' }] },
    { role: 'user', toolResults: [{ id: 'recent', output: 'current source' }] },
  ];
  const result = compactMessages(messages, { mode: 'structured', keepTurns: 1, handoff: { contract: { constraints: ['Keep the accepted constraint.'] }, notes: 'Open question remains unresolved.' } });
  assert.equal(result[0].text, 'Keep the accepted constraint.');
  assert.match(result.find(message => message.contextCategory === 'handoff').text, /Open question remains unresolved/);
  const outputs = result.flatMap(message => message.toolResults || []);
  assert.match(outputs.find(item => item.id === 'read-old').output, new RegExp(`a.mjs@sha256:${hash}`));
  assert.doesNotMatch(outputs.find(item => item.id === 'read-old').output, /stale body/);
  assert.equal(outputs.find(item => item.id === 'failure').output, 'check failed for a real reason');
  assert.equal(outputs.find(item => item.id === 'mutation').output, 'edited a.mjs successfully');
  assert.equal(outputs.find(item => item.id === 'recent').output, 'current source');
});

test('a version two edit requires evidence for each target and rejects changed bytes', (t) => {
  const { workspace, copilotHome } = makeScopes();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(copilotHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'a.mjs'), 'export const item = 1;');
  const sha256 = runGet({ workspace, copilotHome, flags: { path: 'a.mjs' } }).sha256;
  const snapshot = { version: 2, state: 'validated', policyDigest: policyDigest(workspace), evidence: [{ location: 'a.mjs', state: 'readable', sha256 }] };
  assert.equal(validateContextSnapshot({ workspace, snapshot, targets: ['a.mjs'] }).pass, true);
  assert.equal(validateContextSnapshot({ workspace, snapshot, targets: ['other.mjs'] }).pass, false);
  fs.writeFileSync(path.join(workspace, 'a.mjs'), 'export const item = 2;');
  assert.equal(validateContextSnapshot({ workspace, snapshot, targets: ['a.mjs'] }).pass, false);
});

test('a large task produces an explicit bounded handoff barrier', (t) => {
  const { workspace, copilotHome } = makeScopes();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(copilotHome, { recursive: true, force: true }));
  const result = buildTaskHandoff({ workspace, task: 'Long task instruction. '.repeat(1000) });
  assert.equal(result.requiresRead, true);
  assert.equal(result.taskInput, null);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8000);
});

test('a changed dependency invalidates a target whose own bytes are unchanged', (t) => {
  const { workspace, copilotHome } = makeScopes();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(copilotHome, { recursive: true, force: true }));
  for (const file of ['a.mjs', 'b.mjs']) fs.writeFileSync(path.join(workspace, file), 'export const item = 1;');
  const evidence = ['a.mjs', 'b.mjs'].map(location => ({ location, state: 'readable', sha256: runGet({ workspace, copilotHome, flags: { path: location } }).sha256 }));
  const snapshot = { version: 2, state: 'validated', policyDigest: policyDigest(workspace), evidence };
  assert.equal(validateContextSnapshot({ workspace, snapshot, targets: ['a.mjs'] }).pass, true);
  fs.writeFileSync(path.join(workspace, 'b.mjs'), 'export const item = 2;');
  assert.equal(validateContextSnapshot({ workspace, snapshot, targets: ['a.mjs'] }).pass, false);
});

test('domain recovery cannot substitute a local plan for the selected coordinator contract', (t) => {
  const { workspace, copilotHome } = makeScopes();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(copilotHome, { recursive: true, force: true }));
  const result = buildTaskHandoff({ workspace, task: 'Continue domain delivery', domainPlan: { name: 'example', path: 'coordinator.hplan' } });
  assert.equal(result.contract, null);
  assert.equal(result.requiresRead, true);
  assert.deepEqual(result.next.slice(0, 3), ['harness', 'domain', 'status']);
});
