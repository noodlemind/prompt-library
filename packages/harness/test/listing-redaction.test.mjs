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

test('listing and why redact secrets in trigger, claim, and episode refs', async (t) => {
  const { home, workspace } = makeStore(t);
  const { storeDir } = await import('../lib/knowledge/store.mjs');
  const dir = storeDir(workspace, { home });
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });

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

test('listing and why never emit a raw control char in status, source, kind, id, or the pointer fields', async (t) => {
  const { home, workspace } = makeStore(t);
  const { storeDir } = await import('../lib/knowledge/store.mjs');
  const dir = storeDir(workspace, { home });
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });

    fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'hostile-code-set.md'),
    [
      '---',
      'schema: 1',
      'trigger: "a trigger"',
      'status: "active\\n- [sql/fake] injected row"',
      'source: "human\\nFORGED AUTHORITY"',
      'episodes:',
      '  - path: docs/solutions/perf/a.md',
      '    kind: "fix\\nmore"',
      '    plan: docs/plans/p1.md',
      'origin: test',
      '---',
      '',
      'The claim body.',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'hostile-pointers.md'),
    [
      '---',
      'schema: 1',
      'trigger: "another trigger"',
      'status: active',
      'source: auto',
      'episodes:',
      'superseded_by: "sql/other\\ninjected"',
      'last_confirmed: "2026-01-01\\ninjected"',
      'merged_from: [sql/a\\ninjected, sql/b]',
      'origin: test',
      '---',
      '',
      'Another claim body.',
      '',
    ].join('\n'),
    'utf8'
  );

  const control = /[\x00-\x1f\x7f]/;
  const assertInert = (obj, label) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        assert.equal(control.test(value), false, `${label}.${key} carries a control char: ${JSON.stringify(value)}`);
      }
    }
  };

  const listing = listingView({ workspace, home });
  const codeSetRow = listing.learnings.find((l) => l.id === 'sql/hostile-code-set');
  assert.ok(codeSetRow, 'the learning is listed');
  assert.equal(codeSetRow.status, 'unknown', 'an out-of-set status renders as unknown, never as itself-plus-a-newline');
  assert.equal(codeSetRow.source, 'unknown', 'and so does an out-of-set source');
  for (const row of listing.learnings) assertInert(row, 'listing row');

  const why = whyView({ workspace, id: 'sql/hostile-code-set', home });
  assert.equal(why.status, 'unknown');
  assert.equal(why.source, 'unknown');
  assert.equal(why.episodes[0].kind, 'unknown', 'an out-of-set episode kind renders as unknown');
  assertInert(why, '--why');
  assertInert(why.episodes[0], '--why episode');

  const whyPointers = whyView({ workspace, id: 'sql/hostile-pointers', home });
  assertInert(whyPointers, '--why pointers');
  for (const id of whyPointers.mergedFrom || []) {
    assert.equal(control.test(id), false, `--why mergedFrom carries a control char: ${JSON.stringify(id)}`);
  }
  assert.ok(whyPointers.supersededBy && !control.test(whyPointers.supersededBy));
  assert.ok(whyPointers.lastConfirmed && !control.test(whyPointers.lastConfirmed));
});
