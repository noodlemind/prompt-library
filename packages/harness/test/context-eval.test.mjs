import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareCase, runChecks, runStudy, summarizeStudy } from '../eval/context/study.mjs';

const simple = {
  id: 'example', split: 'development', family: 'known-file',
  prompt: 'Return 2 from value.', files: { 'src/value.mjs': 'export const value = 1;\n' },
  editable: ['src/value.mjs'], seeds: ['src/value.mjs'], requiredEvidence: ['src/value.mjs'],
  checks: [{ module: 'src/value.mjs', export: 'value', expected: 2 }],
};

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-study-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('independent checks reject baseline and accept repair outside the editable workspace', async (t) => {
  const root = directory(t);
  const fixture = await prepareCase({ task: simple, root, id: 'trial' });
  assert.equal((await runChecks(fixture)).pass, false);
  fs.writeFileSync(path.join(fixture.workspace, 'src/value.mjs'), 'export const value = 2;\n');
  assert.equal((await runChecks(fixture)).pass, true);
  assert.equal(path.relative(fixture.workspace, fixture.checkFile).startsWith('..'), true);
  fs.chmodSync(fixture.checkFile, 0o600);
  fs.writeFileSync(fixture.checkFile, JSON.stringify({ ...simple, checks: [] }));
  assert.equal((await runChecks(fixture)).integrity, false);
});

test('all frozen cases have failing acceptance baselines in every policy arm', async (t) => {
  const cases = JSON.parse(fs.readFileSync(new URL('../eval/context/cases.json', import.meta.url))).cases;
  const result = await runStudy({ root: directory(t), cases, repeats: 1, dryRun: true });
  assert.equal(result.attempts.length, 36);
  assert.ok(result.attempts.every(row => row.baseline.pass === false && row.baseline.integrity));
  assert.equal(result.summary.comparison, 'inconclusive');
});

test('study counts failures and scope violations across fresh arm workspaces', async (t) => {
  const root = directory(t);
  const workspaces = new Set();
  const result = await runStudy({ root, cases: [simple], repeats: 2, policies: ['legacy', 'selective'],
    model: 'scripted-test', host: 'scripted-test', execute: async ({ workspace, policy }) => {
      assert.equal(workspaces.has(workspace), false);
      workspaces.add(workspace);
      fs.writeFileSync(path.join(workspace, 'src/value.mjs'), 'export const value = 2;\n');
      if (policy === 'selective') fs.writeFileSync(path.join(workspace, 'extra.txt'), 'out of scope');
      return { status: 'ok', stopReason: 'end-turn', contextAccounting: [], turns: [] };
    },
  });
  assert.equal(result.attempts.length, 4);
  assert.equal(result.summary.arms.legacy.passed, 2);
  assert.equal(result.summary.arms.selective.passed, 0);
  assert.equal(result.attempts.filter(row => !row.scope.pass).length, 2);
  assert.equal(result.summary.comparison, 'inconclusive');
  assert.equal(result.summary.arms.legacy.inputTokens, null);
  assert.equal(result.summary.arms.legacy.cost, null);
  assert.ok(result.provenance.corpusHash);
  assert.ok(result.provenance.checkerHash);
  assert.ok(result.provenance.protocolHash);
});

test('dry run and unavailable model remain inconclusive and never count as accepted tasks', async (t) => {
  const dry = await runStudy({ root: directory(t), cases: [simple], policies: ['legacy'], repeats: 1, dryRun: true });
  assert.equal(dry.attempts[0].kind, 'dry-run');
  assert.equal(dry.summary.arms.legacy.passed, 0);
  assert.equal(dry.summary.comparison, 'inconclusive');
  const unavailable = await runStudy({ root: directory(t), cases: [simple], policies: ['legacy'], repeats: 1,
    model: 'unavailable-test', execute: async () => { throw new Error('no model'); },
  });
  assert.equal(unavailable.attempts[0].kind, 'runtime-error');
  assert.equal(unavailable.summary.arms.legacy.attempts, 1);
  assert.equal(unavailable.summary.arms.legacy.failed, 1);
});

test('usage aggregates all attempts while incomplete coverage and evidence stay explicit', () => {
  const usage = value => ({ boundary: 'headless-request', modelUsage: value });
  const result = summarizeStudy([
    { policy: 'legacy', kind: 'live', pass: false, split: 'held-out', evidenceBeforeEdit: null, accounting: [usage({ measurement: 'observed', inputTokens: 20, outputTokens: 5, cachedInputTokens: 2 })] },
    { policy: 'legacy', kind: 'runtime-error', pass: false, split: 'held-out', evidenceBeforeEdit: null, accounting: [usage({ measurement: 'unavailable', inputTokens: null, outputTokens: null })] },
  ], { repeats: 2, policies: ['legacy'], host: 'test', model: 'test' });
  assert.equal(result.arms.legacy.knownInputTokens, 20);
  assert.equal(result.arms.legacy.inputTokens, null);
  assert.equal(result.arms.legacy.usageCoverage, 'partial');
  assert.equal(result.arms.legacy.failed, 2);
  assert.equal(result.arms.legacy.evidenceCoverage, 'unavailable');
});

test('development improvements cannot conceal a held-out quality regression', () => {
  const attempts = [];
  for (const policy of ['legacy', 'selective', 'subsystem']) {
    for (let i = 0; i < 40; i++) attempts.push({ policy, kind: 'live', actualModel: 'exact', split: i < 30 ? 'held-out' : 'development',
      pass: policy === 'selective' ? i >= 3 : i >= 2 && i !== 30 && i !== 31,
      accounting: [{ boundary: 'headless-request', modelUsage: { measurement: 'observed', inputTokens: policy === 'selective' ? 50 : 100, outputTokens: 10 } }],
    });
  }
  const result = summarizeStudy(attempts, { policies: ['legacy', 'selective', 'subsystem'], model: 'exact' });
  assert.ok(result.arms.selective.failed < result.arms.legacy.failed);
  assert.ok(result.arms.selective.heldOutFailed > result.arms.legacy.heldOutFailed);
  assert.equal(result.comparison, 'no-candidate');
});
