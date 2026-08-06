// The listing surfaces (`harness learnings`, `harness learnings --why`) render
// learning frontmatter and body straight to a human and to `--json`. Learning
// content is hand-editable and human authority deliberately overrides the
// secret scan for hand edits (see hand-edits.test.mjs), so a credential CAN be
// sitting in a learning on disk. These surfaces must therefore redact — the
// same doctrine retrieve.mjs and context-pack.mjs already apply.
//
// The subtle case, and the reason redaction must happen BEFORE the 140-char
// cap: a credential that straddles the cap boundary gets sliced into a fragment
// the scanner no longer matches, so a slice-then-redact order leaks the head of
// the key while looking correct in every test that keeps secrets short.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { listingView, whyView } from '../lib/knowledge/listing.mjs';

const SECRET = 'AKIAIOSFODNN7EXAMPLE';

function makeStore(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-listing-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-listing-ws-'));
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  execFileSync('git', ['init', '-q'], { cwd: workspace, env: { ...process.env, ...env } });
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { home, workspace };
}

function writeLearning({ home, workspace }, { trigger, body, episodePath }) {
  // Mirror the on-disk store layout directly: this test is about the RENDER
  // path, so it must not depend on the writer's own validation refusing the
  // content (which is exactly what a hand edit bypasses).
  const { repoId } = { repoId: null };
  void repoId;
  const storeRoot = path.join(home, 'knowledge');
  const dirs = fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot) : [];
  let dir = dirs.length ? path.join(storeRoot, dirs[0]) : null;
  if (!dir) {
    // Let the store module derive its own id by asking it for the path.
    dir = null;
  }
  return { dir, trigger, body, episodePath };
}

test('listing and why redact secrets in trigger, claim, and episode refs', async (t) => {
  const { home, workspace } = makeStore(t);
  const { storeDir } = await import('../lib/knowledge/store.mjs');
  const dir = storeDir(workspace, { home });
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });

  // A claim line whose credential STRADDLES the 140-char cap — the case a
  // slice-then-redact implementation leaks.
  const filler = 'x'.repeat(130);
  const claim = `${filler} ${SECRET} trailing words`;
  assert.ok(claim.indexOf(SECRET) < 140 && claim.indexOf(SECRET) + SECRET.length > 140, 'fixture must straddle the cap');

  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'leaky.md'),
    [
      '---',
      'schema: 1',
      `trigger: "timeout with ${SECRET}"`,
      'status: active',
      'source: human',
      'episodes:',
      `  - path: docs/solutions/${SECRET}.md`,
      '    kind: fix',
      `    plan: docs/plans/${SECRET}-plan.md`,
      'origin: test',
      '---',
      '',
      claim,
      '',
    ].join('\n'),
    'utf8'
  );

  const listing = listingView({ workspace, home });
  const row = listing.learnings.find((l) => l.id === 'sql/leaky');
  assert.ok(row, 'learning is listed');
  assert.ok(!row.trigger.includes(SECRET), `listing trigger leaked the key: ${row.trigger}`);

  const why = whyView({ workspace, id: 'sql/leaky', home });
  assert.ok(why, 'why view resolves');
  assert.ok(!why.trigger.includes(SECRET), 'why trigger leaked the key');
  assert.ok(!why.claimLine.includes(SECRET), `why claimLine leaked the key: ${why.claimLine}`);
  // The straddling case: no PREFIX of the key may survive either. With this
  // fixture exactly 9 characters of the key fall inside the cap, so assert on
  // that length — a longer prefix would vacuously pass against the
  // slice-then-redact bug this test exists to catch.
  const survivingPrefix = SECRET.slice(0, 140 - claim.indexOf(SECRET));
  assert.equal(survivingPrefix.length, 9, 'fixture arithmetic: 9 chars of the key fall inside the cap');
  assert.ok(
    !why.claimLine.includes(survivingPrefix),
    `why claimLine leaked a credential fragment across the cap: ${why.claimLine}`
  );
  assert.ok(why.claimLine.length <= 140, 'claim line still respects the cap');

  const ep = why.episodes[0];
  assert.ok(!ep.path.includes(SECRET), `episode path leaked the key: ${ep.path}`);
  assert.ok(!ep.plan.includes(SECRET), `episode plan leaked the key: ${ep.plan}`);
  assert.equal(ep.kind, 'fix', 'episode kind is a code-set token and is preserved');
});
