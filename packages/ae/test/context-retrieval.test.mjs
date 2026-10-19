import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { makeScopes, initGit } from './helpers/index.mjs';
import { runGet } from '../lib/get-cmd.mjs';
import { lookupEntity } from '../lib/retrieval/lookup.mjs';
import { runSearch } from '../lib/retrieval/search.mjs';
import { createRetrievalResult, federate } from '../lib/retrieval/kernel.mjs';
import { dispatchToolCall, renderToolResult } from '../lib/agent-loop.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';

function fixture(t) {
  const f = makeScopes();
  t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(f.copilotHome, { recursive: true, force: true }));
  const write = (rel, text) => fs.writeFileSync(path.join(f.workspace, rel), text);
  write('a.mjs', "import { item } from './b.mjs';\nexport function alpha() {\n  return item;\n}\n");
  write('b.mjs', 'export const item = 1;\n');
  write('c.mjs', 'export const itemTwo = 2;\n');
  initGit(f.workspace);
  return { ...f, write, get: flags => runGet({ workspace: f.workspace, copilotHome: f.copilotHome, flags }), search: options => runSearch({ workspace: f.workspace, copilotHome: f.copilotHome, sources: ['code'], ...options }) };
}

test('get and lookup validate the exact source reference before returning evidence', (t) => {
  const f = fixture(t);
  const initial = f.get({ path: 'a.mjs' });
  const ref = `a.mjs@sha256:${initial.sha256}`;
  assert.equal(f.get({ path: ref }).path, 'a.mjs');
  assert.equal(lookupEntity({ workspace: f.workspace, copilotHome: f.copilotHome, kind: 'file', identifier: ref }).metadata.sha256, initial.sha256);
  f.write('a.mjs', 'export const changed = 1;\n');
  assert.throws(() => f.get({ path: ref }), error => error.code === 'E_SOURCE_CHANGED');
  assert.throws(() => lookupEntity({ workspace: f.workspace, kind: 'file', identifier: ref }), error => error.code === 'E_SOURCE_CHANGED');
});

test('version two reads retain declaration and import context with source-bound ranges', (t) => {
  const f = fixture(t);
  const result = f.get({ path: 'a.mjs', offset: 3, lines: 1, contextVersion: 2 });
  assert.equal(result.excerpt, '  return item;');
  assert.equal(result.context.declaration.text, 'export function alpha() {');
  assert.equal(result.context.imports[0].text, "import { item } from './b.mjs';");
  assert.equal(result.evidence.range.startLine, 3);
  assert.equal(result.evidence.range.endLine, 3);
  assert.equal(result.evidence.representationSha256, createHash('sha256').update(result.excerpt).digest('hex'));
});

test('a Unicode excerpt respects the byte ceiling including its truncation marker', (t) => {
  const f = fixture(t);
  f.write('unicode.txt', '界'.repeat(30));
  const result = f.get({ path: 'unicode.txt', maxBytes: 16 });
  assert.ok(result.bytes <= 16);
  assert.equal(result.excerpt.includes('\uFFFD'), false);
});

test('secret screening precedes excerpt truncation', (t) => {
  const f = fixture(t);
  f.write('secret.txt', `prefix ghp_${'a'.repeat(36)}`);
  const result = f.get({ path: 'secret.txt', maxBytes: 40, contextVersion: 2 });
  assert.doesNotMatch(result.excerpt, /ghp_a/);
  assert.equal(result.evidence.redacted, true);
  assert.ok(result.bytes <= 40);
});

test('version two cursors reject another query and a changed dirty source generation', (t) => {
  const f = fixture(t);
  const first = f.search({ query: 'item', mode: 'literal', limit: 1, contextVersion: 2 });
  assert.ok(first.nextCursor);
  assert.ok(first.results[0].evidence.reference.includes('@sha256:'));
  assert.throws(() => f.search({ query: 'alpha', mode: 'literal', cursor: first.nextCursor, contextVersion: 2 }), error => error.code === 'E_CURSOR_CONTEXT');
  f.write('b.mjs', 'export const item = 9;\n');
  assert.throws(() => f.search({ query: 'item', mode: 'literal', cursor: first.nextCursor, contextVersion: 2 }), error => error.code === 'E_CURSOR_STALE');
});

test('search supplies the exact excerpt whose representation hash it reports', (t) => {
  const f = fixture(t);
  const result = f.search({ query: 'item', mode: 'literal', contextVersion: 2 });
  const row = result.results.find(row => row.location.startsWith('a.mjs:'));
  assert.equal(typeof row.excerpt, 'string');
  assert.equal(row.evidence.representationField, 'excerpt');
  assert.equal(createHash('sha256').update(row.excerpt).digest('hex'), row.evidence.representationSha256);
});

test('legacy cursors also refuse a different source generation', () => {
  const source = generation => [{ source: 'code', generation, results: ['a','b'].map(id => createRetrievalResult({ source: 'code', id, score: 1 })) }];
  const first = federate({ sources: source('old'), limit: 1 });
  assert.throws(() => federate({ sources: source('new'), cursor: first.nextCursor }), error => error.code === 'E_CURSOR_STALE');
});

test('the read tool exposes the same source-bound context to the model', async (t) => {
  const f = fixture(t);
  const initial = f.get({ path: 'a.mjs' });
  const outcome = await dispatchToolCall({ id: 'read-context', name: 'read', input: { path: `a.mjs@sha256:${initial.sha256}`, offset: 3, lines: 1, contextVersion: 2 } }, { workspace: f.workspace, copilotHome: f.copilotHome });
  assert.equal(outcome.dispatched, true);
  assert.equal(outcome.result.evidence.sha256, initial.sha256);
  assert.equal(outcome.result.context.declaration.text, 'export function alpha() {');
  assert.match(renderToolResult(outcome.result), /export function alpha/);
});

for (const contextVersion of [1, 2]) {
  test(`agent search pages visit every match once with context version ${contextVersion}`, async (t) => {
    const f = fixture(t);
    for (let index = 0; index < 25; index++) f.write(`page-${index}.mjs`, 'export const paginationMarker = 1;\n');
    initGit(f.workspace);
    const expected = Array.from({ length: 25 }, (_, index) => `page-${index}.mjs`).sort();
    const seen = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const outcome = await dispatchToolCall({ id: `search-${page}`, name: 'search', input: { query: 'paginationMarker', contextVersion, cursor, limit: 20 } }, { workspace: f.workspace, copilotHome: f.copilotHome });
      assert.equal(outcome.dispatched, true, outcome.reason);
      assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result));
      seen.push(...outcome.result.search.results.map(row => row.id));
      cursor = outcome.result.search.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null);
    assert.deepEqual(seen.sort(), expected);
  });
}

for (const scope of ['product', 'global', 'product-user']) {
  test(`knowledge references expand through path readers for ${scope} documents`, async (t) => {
    const f = fixture(t);
    f.write('lesson-id', 'A workspace file with the same name as the document ID.\n');
    const home = path.join(f.copilotHome, 'control');
    const root = scope === 'global' ? path.join(f.copilotHome, 'knowledge') : scope === 'product-user' ? projectStoreDir(f.workspace, { home }) : f.workspace;
    const document = path.join(root, 'docs/solutions/lesson.md');
    fs.mkdirSync(path.dirname(document), { recursive: true });
    fs.writeFileSync(document, '# Reference lesson\n\nA scope-specific body.\n');
    fs.mkdirSync(path.join(f.copilotHome, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(f.copilotHome, 'knowledge/manifest.yaml'), `entries:\n  - id: lesson-id\n    path: docs/solutions/lesson.md\n    title: reference lesson\n    scope: ${scope}\n`);
    const result = runSearch({ workspace: f.workspace, copilotHome: f.copilotHome, home, query: 'reference lesson', sources: ['knowledge'], contextVersion: 2 });
    assert.equal(result.results.length, 1);
    const reference = result.results[0].evidence.reference;
    assert.equal(typeof reference, 'string');
    const expanded = runGet({ workspace: f.workspace, copilotHome: f.copilotHome, home, flags: { path: reference, contextVersion: 2 } });
    assert.equal(expanded.excerpt, '# Reference lesson\n\nA scope-specific body.\n');
    const read = () => dispatchToolCall({ id: 'knowledge-read', name: 'read', input: { path: reference, contextVersion: 2 } }, { workspace: f.workspace, copilotHome: f.copilotHome, harnessHome: home });
    const outcome = await read();
    assert.equal(outcome.dispatched, true, outcome.reason);
    assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result));
    assert.equal(outcome.result.evidence.sha256, expanded.sha256);
    assert.match(renderToolResult(outcome.result), /A scope-specific body/);
    fs.writeFileSync(document, '# Changed lesson\n');
    assert.throws(() => runGet({ workspace: f.workspace, copilotHome: f.copilotHome, home, flags: { path: reference } }), error => error.code === 'E_SOURCE_CHANGED');
    const stale = await read();
    assert.match(stale.reason, /source changed/);
  });
}
