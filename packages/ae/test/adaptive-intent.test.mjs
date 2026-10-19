import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { bindLockedIntentSources, discoverIntent, intentPage, intentSourcesCheck, obligationLine, resolveObligation, selectIntent } from '../lib/intent-sources.mjs';

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-intent-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-q', workspace], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const write = (rel, body = '# Intent\n') => {
    const file = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return rel;
  };
  return { workspace, write };
}

test('compact intent discovery reports the ninth omitted source', t => {
  const { workspace, write } = fixture(t);
  const paths = Array.from({ length: 9 }, (_, index) => write(`docs/specs/${index + 1}.md`));
  const result = discoverIntent(workspace, '');
  assert.deepEqual(result.paths.map(source => source.path), paths.slice(0, 8));
  assert.deepEqual(result.metadata, {
    candidateCount: 9, selectedCount: 8, omittedCount: 1,
    bytes: Buffer.byteLength(paths.slice(0, 8).join(', '), 'utf8'), truncated: true,
  });
  assert.deepEqual(selectIntent(workspace, ''), result.paths);
  const second = intentPage(workspace, '', { page: 2 });
  assert.deepEqual(second.paths, [{ path: paths[8], kind: 'spec' }]);
  assert.equal(second.pageCount, 2);
  assert.equal(second.hasMore, false);
});

test('compact discovery applies the byte bound to multibyte paths', t => {
  const { workspace, write } = fixture(t);
  const paths = ['a', 'b', 'c'].map(letter => write(`docs/specs/${'é'.repeat(100)}/${letter}.md`));
  const result = discoverIntent(workspace, '');
  assert.deepEqual(result.paths.map(source => source.path), paths.slice(0, 2));
  assert.equal(result.metadata.candidateCount, 3);
  assert.equal(result.metadata.omittedCount, 1);
  assert.equal(result.metadata.bytes, Buffer.byteLength(obligationLine(result.paths), 'utf8'));
  assert.ok(result.metadata.bytes <= 512);
});

test('an oversized first candidate is omitted and remains readable through a detail page', t => {
  const { workspace, write } = fixture(t);
  const configured = spawnSync('git', ['-C', workspace, 'config', 'core.longpaths', 'false'], { encoding: 'utf8' });
  assert.equal(configured.status, 0, configured.stderr);
  const configPath = path.join(workspace, '.git/config'), config = fs.readFileSync(configPath);
  const oversized = write(`docs/specs/${'a'.repeat(180)}/${'b'.repeat(180)}/${'c'.repeat(160)}.md`);
  assert.ok(Buffer.byteLength(oversized, 'utf8') > 512);
  const result = discoverIntent(workspace, '');
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.metadata, { candidateCount: 1, selectedCount: 0, omittedCount: 1, bytes: 0, truncated: true });
  const page = intentPage(workspace, '', { page: 1, pageSize: 1 });
  assert.deepEqual(page.paths, [{ path: oversized, kind: 'spec' }]);
  assert.equal(page.metadata.bytes, Buffer.byteLength(oversized, 'utf8'));
  assert.equal(page.pageCount, 1);
  assert.equal(page.hasMore, false);
  const accepted = bindLockedIntentSources(workspace, [oversized]);
  assert.deepEqual(accepted.map(source => source.path), [oversized]);
  assert.equal(intentSourcesCheck({ fm: { intent_source_policy: 'content-v1', intent_sources: accepted } }, workspace).pass, true);
  assert.deepEqual(fs.readFileSync(configPath), config, 'long-path enumeration must not change repository configuration');
});

test('an empty bounded selection is omitted intent and fails an unbound plan gate', t => {
  const { workspace, write } = fixture(t);
  write(`docs/specs/${'a'.repeat(180)}/${'b'.repeat(180)}/${'c'.repeat(160)}.md`);
  assert.equal(resolveObligation(workspace, null).reason, 'omitted');
  const plan = { fm: { intent: 'Read the long specification', intent_source_policy: 'content-v1', intent_sources: [] } };
  const obligation = resolveObligation(workspace, plan);
  assert.equal(obligation.reason, 'omitted');
  assert.equal(obligation.metadata.candidateCount, 1);
  const check = intentSourcesCheck(plan, workspace);
  assert.equal(check.pass, false);
  assert.match(check.message, /omitted|detail page/i);
});

test('intent detail pages reject unbounded or nonpositive page arguments', t => {
  const { workspace, write } = fixture(t);
  write('docs/specs/payment.md');
  for (const options of [
    { page: 0 }, { page: -1 }, { page: 1.5 }, { page: Number.MAX_SAFE_INTEGER + 1 },
    { pageSize: 0 }, { pageSize: 33 }, { pageSize: 1.5 },
  ]) assert.throws(() => intentPage(workspace, '', options), /page/i);
  assert.deepEqual(intentPage(workspace, '', { page: 3 }).paths, []);
});

test('explicit reviewed selections bind exactly, including selections over the compact cap', t => {
  const { workspace, write } = fixture(t);
  const paths = Array.from({ length: 10 }, (_, index) => write(`docs/specs/${String(index).padStart(2, '0')}.md`));
  const reviewed = paths.slice(1).reverse();
  const accepted = bindLockedIntentSources(workspace, reviewed, { query: '' });
  assert.deepEqual(accepted.map(source => source.path), reviewed);
  assert.ok(accepted.every(source => /^[0-9a-f]{64}$/.test(source.sha256)));
  assert.deepEqual(bindLockedIntentSources(workspace, [paths[9]], { query: '' }).map(source => source.path), [paths[9]]);
  assert.deepEqual(bindLockedIntentSources(workspace, [], { query: '' }).map(source => source.path), paths.slice(0, 8));
});

test('accepted intent remains frozen when a new sibling ranks first', t => {
  const { workspace, write } = fixture(t);
  const acceptedPath = write('docs/specs/accepted.md', '# Original accepted behavior\n');
  const accepted = bindLockedIntentSources(workspace, [acceptedPath]);
  const plan = { fm: { intent: 'refund', intent_source_policy: 'content-v1', intent_sources: accepted } };
  const sibling = write('docs/specs/new.md', '# Refund behavior\n');
  assert.equal(selectIntent(workspace, 'refund')[0].path, sibling);
  const obligation = resolveObligation(workspace, plan, 'refund');
  assert.equal(obligation.reason, 'frozen');
  assert.deepEqual(obligation.paths, [{ path: acceptedPath, kind: 'spec' }]);
  assert.equal(obligation.metadata.candidateCount, 2);
  assert.equal(obligation.metadata.omittedCount, 1);
  assert.equal(intentSourcesCheck(plan, workspace).pass, true);
  assert.deepEqual(plan.fm.intent_sources, accepted);
  write(acceptedPath, '# Changed accepted behavior\n');
  const changed = intentSourcesCheck(plan, workspace);
  assert.equal(changed.pass, false);
  assert.deepEqual(changed.stale.map(source => source.path), [acceptedPath]);
});

test('an absent intent repository retains the no-intent result', t => {
  const { workspace, write } = fixture(t);
  write('docs/notes/ordinary.md');
  assert.deepEqual(discoverIntent(workspace, ''), { paths: [], metadata: { candidateCount: 0, selectedCount: 0, omittedCount: 0, bytes: 0, truncated: false } });
  assert.equal(resolveObligation(workspace, null).reason, 'none');
  const check = intentSourcesCheck({ fm: { intent_sources: [] } }, workspace);
  assert.equal(check.pass, true);
  assert.equal(check.guarantee, 'legacy-paths-only');
});

test('failed Git source enumeration cannot claim absent intent', t => {
  const { workspace } = fixture(t);
  const moduleUrl = new URL('../lib/intent-sources.mjs', import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const child = createRequire(import.meta.url)('node:child_process');
    let result;
    child.spawnSync = () => result;
    syncBuiltinESMExports();
    const { discoverIntent } = await import(process.argv[2]);
    for (const code of ['ENOBUFS', 'ETIMEDOUT', 'ENOENT']) {
      result = { status: null, error: { code }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      assert.throws(() => discoverIntent(process.argv[1], ''), { code: 'E_INTENT_CATALOG' });
    }
    result = { status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: detected dubious ownership in repository') };
    assert.throws(() => discoverIntent(process.argv[1], ''), { code: 'E_INTENT_CATALOG' });
    result = { status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: not a git repository (or any of the parent directories): .git') };
    assert.equal(discoverIntent(process.argv[1], '').metadata.candidateCount, 0);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, workspace, moduleUrl], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});
