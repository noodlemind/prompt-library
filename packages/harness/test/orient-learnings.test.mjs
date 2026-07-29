import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

/** Writes a real episode file inside `ws` at `rel` and returns the op-JSON
 * episode object (path + real sha256) so `verifyAdmittedEpisodeKinds` admits
 * it — a fabricated hardcoded sha256 is rejected with E_SCHEMA. For
 * `kind: 'insight'` the body must carry real frontmatter `kind: insight`
 * matching the assertion; `fix` needs no frontmatter at all. */
function writeRealEpisode(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

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
          episodes: [{
            ...writeRealEpisode(ws, 'docs/solutions/perf/x.md', 'Two-step default+backfill episode for large hot tables.\n'),
            kind: 'fix', plan: 'docs/plans/p1.md',
          }],
        },
        {
          op: 'ADD',
          domain: 'api',
          slug: 'retry-jitter',
          trigger: 'retrying rate limited requests',
          body: 'Retry storms amplify rate limiting when jitter is missing from backoff.',
          episodes: [{
            ...writeRealEpisode(
              ws,
              'docs/solutions/debugging/h.md',
              '---\ntitle: "retry jitter insight"\nkind: insight\ndate: 2026-07-01\n---\n\nRetry storms amplify rate limiting when jitter is missing from backoff.\n'
            ),
            kind: 'insight', plan: '',
          }],
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
