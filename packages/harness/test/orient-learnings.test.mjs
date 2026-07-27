import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { ensureStore } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function seededContext() {
  const ws = tempDir('ol-ws-');
  const home = tempDir('ol-home-');
  const harnessHome = tempDir('ol-hh-');
  const opsPath = path.join(ws, 'ops.json');
  fs.writeFileSync(
    opsPath,
    JSON.stringify({
      schema: 1,
      ops: [
        {
          op: 'ADD',
          domain: 'sql',
          slug: 'not-null-large-tables',
          trigger: 'adding NOT NULL columns to large hot tables',
          body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
          episodes: [{ path: 'docs/solutions/perf/x.md', sha256: 'a'.repeat(64), kind: 'fix', plan: 'docs/plans/p1.md' }],
        },
        {
          op: 'ADD',
          domain: 'api',
          slug: 'retry-jitter',
          trigger: 'retrying rate limited requests',
          body: 'Retry storms amplify rate limiting when jitter is missing from backoff.',
          episodes: [{ path: 'docs/solutions/debugging/h.md', sha256: 'b'.repeat(64), kind: 'insight', plan: '' }],
        },
      ],
    })
  );
  const res = applyOps({ workspace: ws, opsPath, home: harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  return { ws, home, harnessHome };
}

function orient({ ws, home, harnessHome }, query) {
  return spawnSync(
    process.execPath,
    [binPath, 'orient', '--query', query, '--workspace', ws, '--copilot-home', home, '--json'],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome } }
  );
}

test('orient surfaces matching learnings with attribution and advisory fencing', () => {
  const c = seededContext();
  const res = orient(c, 'adding NOT NULL columns to large tables');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(Array.isArray(out.learnings), 'orient JSON gains learnings');
  assert.equal(out.learnings[0].id, 'sql/not-null-large-tables');

  const pack = fs.readFileSync(path.join(c.ws, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /## Learnings \(memory\)/);
  assert.match(pack, /Applied learnings: sql\/not-null-large-tables/);
  assert.match(pack, /two-step default\+backfill/);
});

test('insight-only learnings render the advisory fence; retired ones never appear', () => {
  const c = seededContext();
  const res = orient(c, 'retrying rate limited requests jitter');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const pack = fs.readFileSync(path.join(c.ws, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /\[unverified memory — advisory\]/);

  // Retire the sql learning by hand; it must vanish from the next orient.
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const f = path.join(dir, 'learnings', 'sql', 'not-null-large-tables.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('status: provisional', 'status: retired'));
  const res2 = orient(c, 'adding NOT NULL columns to large tables');
  const out2 = JSON.parse(res2.stdout);
  assert.ok(!out2.learnings.some((l) => l.id === 'sql/not-null-large-tables'));
});

test('orient without any knowledge store still works and reports no learnings', () => {
  const ws = tempDir('ol-empty-');
  const res = spawnSync(
    process.execPath,
    [binPath, 'orient', '--query', 'anything at all', '--workspace', ws, '--copilot-home', tempDir('ol-eh-'), '--json'],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: tempDir('ol-ehh-') } }
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.learnings, []);
  const pack = fs.readFileSync(path.join(ws, '.harness', 'context-pack.md'), 'utf8');
  assert.doesNotMatch(pack, /## Learnings/);
});
