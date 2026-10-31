import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { makeScopes, tempDir, initGit, runHarness, writeKnowledgeSolution } from './helpers/index.mjs';

function fixture(t) {
  const f = { ...makeScopes(), aeHome: tempDir('knowledge-freshness-') };
  for (const dir of [f.workspace, f.copilotHome, f.aeHome]) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initGit(f.workspace);
  writeKnowledgeSolution(f.copilotHome);
  const invoke = (...args) => {
    const r = runHarness([...args, '--workspace', f.workspace, '--copilot-home', f.copilotHome, '--ae-home', f.aeHome, '--no-events', '--json'], { trust: false });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return JSON.parse(r.stdout);
  };
  invoke('index');
  const replaceManifest = () => {
    const file = path.join(f.copilotHome, 'knowledge', 'manifest.yaml');
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    const date = doc.updated;
    for (const key of ['symptom', 'title', 'summary', 'excerpt', 'module']) doc.entries[0][key] = 'inventory reconciliation';
    doc.entries[0].tags = ['inventory', 'reconciliation'];
    fs.writeFileSync(file, YAML.stringify(doc));
    assert.equal(YAML.parse(fs.readFileSync(file, 'utf8')).updated, date, 'the manifest date deliberately stays unchanged');
  };
  return { ...f, invoke, replaceManifest };
}

test('recall falls back to current manifest content when same-day edits invalidate BM25 postings', (t) => {
  const f = fixture(t);
  assert.equal(f.invoke('recall', 'checkout').recall[0].ranker, 'bm25');
  f.replaceManifest();
  const rows = f.invoke('recall', 'inventory reconciliation').recall;
  assert.equal(rows.length, 1, 'new manifest terms must remain discoverable');
  assert.equal(rows[0].ranker, 'overlap');
  assert.equal(rows[0].title, 'inventory reconciliation');
});

test('index status and ranked search report same-date manifest drift instead of fresh BM25 evidence', (t) => {
  const f = fixture(t);
  assert.equal(f.invoke('index', '--status').knowledge.stale, false);
  f.replaceManifest();
  const status = f.invoke('index', '--status').knowledge;
  assert.equal(status.stale, true);
  assert.match(status.recommendation, /manifest|content/i);
  const search = f.invoke('search', 'inventory reconciliation', '--source', 'knowledge');
  const source = search.sources.find(row => row.source === 'knowledge');
  assert.match(source.generation, /^overlap@/);
  assert.equal(source.count, 1);
  const doctor = runHarness(['doctor', '--workspace', f.workspace, '--copilot-home', f.copilotHome, '--ae-home', f.aeHome, '--no-events', '--json'], { trust: false });
  const h11 = JSON.parse(doctor.stdout).checks.find(row => row.id === 'H11');
  assert.equal(h11.pass, false, 'doctor must agree that the same-date index is stale');
});
