import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeScopes, initGit, runHarness } from './helpers/index.mjs';
import { buildContextPack } from '../lib/context-pack.mjs';
import { parseFlags } from '../lib/flags.mjs';
import { collectOrientationFacts } from '../lib/orientation-facts.mjs';
import { buildContextRecord } from '../lib/context-record.mjs';

function fixture(t) {
  const f = makeScopes();
  t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(f.copilotHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.workspace, 'a.mjs'), 'export const alpha = 1;\n');
  initGit(f.workspace);
  const invoke = (...args) => {
    const r = runHarness(['orient', '--workspace', f.workspace, '--copilot-home', f.copilotHome, '--json', ...args], { trust: false, env: { CI: '1' } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return JSON.parse(r.stdout);
  };
  return { ...f, invoke };
}

test('version two is opt-in and a cold read writes no context artifacts', (t) => {
  const f = fixture(t);
  const result = f.invoke('--read', '--context-version', '2', '--file', 'a.mjs');
  assert.equal(result.schema, 'harness.context.v2');
  assert.equal(Object.keys(result.slice).length, 11);
  assert.equal(result.evidence[0].location, 'a.mjs');
  assert.match(result.evidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.coverage.semanticCompleteness, 'unverified');
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness', 'context-pack.md')), false);
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness', 'session.json')), false);
});

test('both orientation paths assemble the same facts and stable context identity', (t) => {
  const f = fixture(t);
  const read = f.invoke('--read', '--context-version', '2', '--file', 'a.mjs', '--dry-run');
  const normal = f.invoke('--context-version', '2', '--file', 'a.mjs', '--dry-run');
  assert.deepEqual(normal.context.slice, read.slice);
  assert.equal(normal.context.contextId, read.contextId);
  assert.equal(f.invoke('--read', '--context-version', '2', '--file', 'a.mjs', '--dry-run').contextId, read.contextId);
  fs.writeFileSync(path.join(f.workspace, 'a.mjs'), 'export const alpha = 2;\n');
  assert.notEqual(f.invoke('--read', '--context-version', '2', '--file', 'a.mjs', '--dry-run').contextId, read.contextId);
});

test('unknown context versions fail explicitly', (t) => {
  const f = fixture(t);
  const r = runHarness(['orient', '--read', '--context-version', '9', '--workspace', f.workspace, '--json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /context.version|version.*1.*2/i);
});

test('the shared parser rejects missing or unsupported context versions', () => {
  assert.throws(() => parseFlags(['--context-version']), /invalid --context-version/);
  assert.throws(() => parseFlags(['--context-version', '9']), /invalid --context-version/);
});

test('policy changes during context assembly invalidate the record', (t) => {
  const f = fixture(t);
  const facts = collectOrientationFacts({ workspace: f.workspace, copilotHome: f.copilotHome, flags: { contextVersion: 2 }, files: ['a.mjs'] });
  fs.mkdirSync(path.join(f.workspace, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, '.github/harness/policy.yaml'), 'version: 1\n');
  const result = buildContextRecord({ workspace: f.workspace, facts });
  assert.equal(result.coverage.sourceState, 'changed-or-unavailable');
});

test('bare version two expansion restores selected files and accepts the equals spelling', (t) => {
  const f = fixture(t);
  f.invoke('--file', path.join(f.workspace, 'a.mjs'), '--query', 'alpha');
  const expanded = f.invoke('--read', '--context-version=2');
  assert.equal(expanded.evidence[0].location, 'a.mjs');
  assert.equal(expanded.evidence[0].state, 'readable');
  assert.equal(expanded.evidence[0].reason, 'declared task file');
  assert.equal(expanded.coverage.sourceState, 'validated');
});

test('an explicit version two read records source identities for later edit checks', (t) => {
  const f = fixture(t);
  const record = f.invoke('--read', '--context-version', '2', '--query', 'alpha', '--file', 'a.mjs');
  const session = JSON.parse(fs.readFileSync(path.join(f.workspace, '.harness/session.json'), 'utf8'));
  assert.equal(session.contextSnapshot.version, 2);
  assert.equal(session.contextSnapshot.state, 'validated');
  assert.equal(session.contextSnapshot.evidence[0].sha256, record.evidence[0].sha256);
});

test('a crowded contract keeps a complete expansion reference or returns a barrier', () => {
  const body = buildContextPack({
    query: 'repair', recall: [], plans: [],
    planGoal: { intent: 'Repair the selected behavior', constraints: ['Keep all constraints. '.repeat(55)] },
    trust: { state: 'trusted', trusted: true, reason: 'approved' },
    gatePreview: { pass: true },
    repoMapRef: { path: '.harness/repo-map.md', files: 4, totalFiles: 50 },
    nextTools: ['harness verify'],
  });
  assert.ok(Buffer.byteLength(body) <= 2048);
  assert.match(body, /harness orient --read --context-version 2/);
  assert.ok(body.includes('Keep all constraints. '.repeat(55).trim()) || body.includes('Context blocked'));
});
