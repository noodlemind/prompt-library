import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runStructuralStudy, structuralCases, captureStructuralProducer } from '../eval/context/structural-study.mjs';

test('producer identity detects a helper-only change outside the top-level query modules', t => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-producer-closure-'));
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }));
  const write = (relative, content) => {
    const full = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content);
  };
  write('lib/change-impact.mjs', 'export const packet = 1;\n');
  write('lib/repo-map/resolver-config.mjs', 'export const resolver = 1;\n');
  write('lib/repo-map/occurrences.mjs', 'export const occurrence = 1;\n');
  write('lib/repo-map/vendor/manifest.json', '{"assets":[]}\n');
  write('lib/repo-map/vendor/grammar.wasm', 'grammar-v1');
  write('corpus/skills/codebase-context/SKILL.md', '# Context\n');
  write('eval/context/protocol.json', '{"schema":1}\n');
  const before = captureStructuralProducer({ packageRoot });
  assert.equal(captureStructuralProducer({ packageRoot, expected: before.digest }).current, true);
  assert.ok(before.files.some(row => row.path === 'lib/repo-map/occurrences.mjs'));
  assert.ok(before.files.some(row => row.path === 'lib/repo-map/vendor/grammar.wasm'));
  assert.ok(before.files.some(row => row.path === 'eval/context/protocol.json'));
  write('lib/repo-map/resolver-config.mjs', 'export const resolver = 2;\n');
  const changed = captureStructuralProducer({ packageRoot, expected: before.digest });
  assert.equal(changed.current, false);
  assert.notEqual(changed.digest, before.digest);
  const afterHelper = changed.digest;
  write('lib/new-helper.mjs', 'export const added = true;\n');
  assert.equal(captureStructuralProducer({ packageRoot, expected: afterHelper }).current, false);
  for (const [relative, content] of [
    ['lib/repo-map/vendor/grammar.wasm', 'grammar-v2'],
    ['eval/context/protocol.json', '{"schema":2}\n'],
    ['corpus/skills/codebase-context/SKILL.md', '# Updated context\n'],
  ]) {
    const previous = captureStructuralProducer({ packageRoot }).digest;
    write(relative, content);
    assert.equal(captureStructuralProducer({ packageRoot, expected: previous }).current, false, relative);
  }
});

test('structural qualification freezes separate multi-language adversarial and held-out fixtures', () => {
  assert.deepEqual([...new Set(structuralCases.map(row => row.language))].sort(), ['java', 'python', 'typescript']);
  assert.ok(structuralCases.filter(row => row.split === 'held-out').length >= 12);
  assert.equal(new Set(structuralCases.map(row => row.id)).size, structuralCases.length);
  assert.ok(structuralCases.some(row => row.forbiddenEdges?.length));
  assert.ok(structuralCases.some(row => row.mutations?.length));
  assert.ok(structuralCases.some(row => row.family === 'runtime-unknown'));
});

test('mechanical qualification executes assertions and retains no model-quality or promotion claim', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-structural-eval-'));
  const output = path.join(root, 'study');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const picked = structuralCases.filter(row => row.split === 'development');
  const result = await runStructuralStudy({ root: output, cases: picked });
  assert.equal(result.summary.total, picked.length);
  assert.equal(result.summary.failed, 0, JSON.stringify(result.attempts.filter(row => !row.pass)));
  assert.equal(result.kind, 'mechanical');
  assert.equal(result.summary.promotionEligible, false);
  assert.equal(result.model, null);
  assert.equal(result.usage, null);
  assert.match(result.provenance.fixtureHash, /^[a-f0-9]{64}$/);
  assert.ok(result.attempts.every(row => row.assertions > 0 && row.packetReference));
  assert.ok(fs.existsSync(path.join(output, 'results.json')));
});

test('a wrong expected relationship makes mechanical qualification fail rather than silently reporting coverage', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-structural-eval-negative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = structuralCases.find(row => row.questionKind === 'dependency-path');
  const wrong = { ...source, id: 'negative-control', expectedEdges: [['does-not-exist.mjs', 'wrong.mjs']] };
  const result = await runStructuralStudy({ root: path.join(root, 'study'), cases: [wrong] });
  assert.equal(result.summary.failed, 1);
  assert.equal(result.attempts[0].pass, false);
  assert.match(result.attempts[0].error, /expected relationship/);
});
