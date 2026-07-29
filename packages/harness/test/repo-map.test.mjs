import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tokenize } from '../lib/tokenize.mjs';
import { extract } from '../lib/repo-map/lexical-extractor.mjs';
import { buildRepoMap, writeCodebaseMap } from '../lib/repo-map/index.mjs';
import { indexStatus } from '../lib/index-status.mjs';
import { resolveIndexDir } from '../lib/recall-config.mjs';
import { runBuildPostingsIndex, loadPostingsIndex } from '../lib/postings-index.mjs';

function gitRepo(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repomap-'));
  const git = (args) =>
    spawnSync('git', args, {
      cwd: ws,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(ws, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return { ws, git };
}

test('tokenizer collapses identifier formats and morphology symmetrically', () => {
  const forms = ['SYSTEM-OVERRIDE', 'SYSTEM_OVERRIDE', 'systemOverride'].map((f) => new Set(tokenize(f)));
  for (const s of forms) {
    assert.ok(s.has('system') && s.has('override'), 'each identifier form yields system + override');
  }
  // A query term hits a doc that writes the identifier differently.
  const q = new Set(tokenize('add an override header for SYSTEM-OVERRIDE role'));
  const doc = new Set(tokenize('PaymentController checks the SYSTEM_OVERRIDE role'));
  assert.ok([...q].filter((t) => doc.has(t)).includes('override'));
});

test('lexical extractor pulls symbols and imports per language', () => {
  const java = extract('src/PaymentController.java', 'package a;\nimport a.b.Role;\npublic class PaymentController {\n public void handle(){}\n}');
  assert.ok(java.symbols.includes('PaymentController'));
  assert.ok(java.imports.includes('a.b.Role'));
  const py = extract('svc.py', 'from auth import Role\nclass PaymentService:\n def handle(self): pass');
  assert.ok(py.symbols.includes('PaymentService'));
  assert.ok(py.imports.includes('auth'));
  const sql = extract('schema.sql', 'CREATE TABLE payments (id int);');
  assert.ok(sql.symbols.includes('payments'));
});

test('repo map is query-ranked, budgeted, and code-relevant', () => {
  const { ws } = gitRepo({
    'src/PaymentController.java': 'import a.Role;\npublic class PaymentController { public void handle(){} }',
    'src/SecurityConfig.java': 'public class SecurityConfig { public void filterChain(){} }',
    'src/Role.java': 'public enum Role { SYSTEM_OVERRIDE, USER }',
    'src/NotificationHandler.java': 'public class NotificationHandler { public void retry(){} }',
    'README.md': 'docs',
  });
  const map = buildRepoMap({ workspace: ws, query: 'payment override SYSTEM-OVERRIDE role', maxTokens: 400 });
  assert.equal(map.empty, false);
  assert.ok(map.tokens <= 400, `map ${map.tokens} tokens over budget`);
  // Query-relevant files rank above the unrelated notification file.
  const paymentRank = map.files.indexOf('src/PaymentController.java');
  const roleRank = map.files.indexOf('src/Role.java');
  const notifRank = map.files.indexOf('src/NotificationHandler.java');
  assert.ok(paymentRank !== -1 && roleRank !== -1);
  assert.ok(paymentRank < notifRank || notifRank === -1, 'payment ranks above notification');
  assert.ok(!map.files.includes('README.md'), 'non-source files are excluded');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('index --status reports drift deterministically', () => {
  const { ws, git } = gitRepo({ 'a.js': 'export const a = 1;' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-idx-'));
  const indexDir = resolveIndexDir(home, ws);
  fs.mkdirSync(indexDir, { recursive: true });
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(indexDir, 'meta.json'), JSON.stringify({ version: 1, headSha: head, updated: '2026-01-01' }));

  const fresh = indexStatus({ workspace: ws, copilotHome: home });
  assert.equal(fresh.indexed, true);
  assert.equal(fresh.stale, false);

  fs.writeFileSync(path.join(ws, 'b.js'), 'export const b = 2;');
  git(['add', '.']);
  git(['commit', '-qm', 'second']);
  const stale = indexStatus({ workspace: ws, copilotHome: home });
  assert.equal(stale.stale, true);
  assert.equal(stale.commitsSince, 1);
  assert.ok(stale.filesChanged >= 1);
  assert.match(stale.recommendation, /harness index/);

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('writeCodebaseMap refuses to write through a symlinked docs/ directory', () => {
  const { ws } = gitRepo({ 'a.js': 'export const a = 1;' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repomap-outside-'));
  // A symlinked `docs/` pointing outside the workspace — a naive
  // mkdir(recursive)+write would follow it and write the map there instead.
  fs.symlinkSync(outside, path.join(ws, 'docs'));

  const result = writeCodebaseMap({ workspace: ws });
  assert.equal(result, null, 'a symlinked docs/ must refuse the write, not follow it');
  assert.ok(!fs.existsSync(path.join(outside, 'codebase-map.md')), 'nothing written through the symlink');

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('writeCodebaseMap refuses to write when the target itself is a pre-existing symlink', () => {
  const { ws } = gitRepo({ 'a.js': 'export const a = 1;' });
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repomap-target-')), 'elsewhere.md');
  fs.writeFileSync(outsideFile, 'pre-existing content\n');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outsideFile, path.join(ws, 'docs', 'codebase-map.md'));

  const result = writeCodebaseMap({ workspace: ws });
  assert.equal(result, null, 'a pre-existing symlink at the target must refuse the write, not follow it');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'pre-existing content\n', 'the symlink target is untouched');

  fs.rmSync(ws, { recursive: true, force: true });
});

test('writeCodebaseMap writes normally when docs/ is a plain directory', () => {
  const { ws } = gitRepo({ 'a.js': 'export const a = 1;' });
  const result = writeCodebaseMap({ workspace: ws });
  assert.ok(result);
  assert.equal(result.path, 'docs/codebase-map.md');
  assert.ok(fs.existsSync(path.join(ws, 'docs', 'codebase-map.md')));
  fs.rmSync(ws, { recursive: true, force: true });
});

test('maintenance refresh: deterministic index rebuild works with no provider (AC63)', () => {
  // The core of the maintenance refresh is a rebuild that needs no model/network.
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rebuild-'));
  const entries = [
    { id: 'k1', path: 'knowledge/a.md', title: 'Payment override role', summary: 'SYSTEM_OVERRIDE handling', kind: 'solution', scope: 'global' },
    { id: 'k2', path: 'knowledge/b.md', title: 'Notification retry', summary: 'retry backoff', kind: 'solution', scope: 'global' },
  ];
  const result = runBuildPostingsIndex({ entries, indexDir, manifestUpdated: '2026-07-23', flags: {} });
  assert.equal(result.entryCount, 2);
  const loaded = loadPostingsIndex(indexDir);
  assert.ok(loaded && loaded.terms.override, 'rebuilt index has postings for tokenized terms');
  assert.equal(loaded.meta.algorithm, 'bm25');
  fs.rmSync(indexDir, { recursive: true, force: true });
});
