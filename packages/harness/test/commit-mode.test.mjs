import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, listLearnings, writeStoreConfig } from '../lib/knowledge/store.mjs';
import { mirrorLearnings } from '../lib/knowledge/admin.mjs';
import { setLearningStatus } from '../lib/knowledge/lifecycle.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('cm-ws-'), home: tempDir('cm-home-'), harnessHome: tempDir('cm-hh-') });
const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

const mirrorRoot = (ws) => path.join(ws, 'docs', 'knowledge', 'learnings');

test('opt-in commit mode: mirrors on remember, sweeps on retire, stops on none, ignores foreign files, and mode/commit persist independently', () => {
  const c = ctx();

  // knowledge commit repo → status shows it, mode is left at its default.
  const setCommit = run(c, ['knowledge', 'commit', 'repo']);
  assert.equal(setCommit.status, 0, setCommit.stderr || setCommit.stdout);
  const status1 = JSON.parse(run(c, ['knowledge', '--status']).stdout);
  assert.equal(status1.commit, 'repo');
  assert.equal(status1.mode, 'on');

  // remember → mirrors the learning verbatim into <domain>/<slug>.md + INDEX.md.
  const alpha = run(c, ['remember', 'alpha claim body', '--trigger', 'alpha trigger']);
  assert.equal(alpha.status, 0, alpha.stderr || alpha.stdout);
  const alphaId = JSON.parse(alpha.stdout).learningId;
  assert.equal(alphaId, 'general/alpha-trigger');

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const storeLearning = listLearnings(dir).find((l) => l.id === alphaId);
  assert.ok(storeLearning, 'precondition: learning written to the store');
  const storeText = fs.readFileSync(storeLearning.file, 'utf8');

  const mirrorFile = path.join(mirrorRoot(c.ws), 'general', 'alpha-trigger.md');
  assert.ok(fs.existsSync(mirrorFile), 'remember mirrors the learning file');
  assert.equal(fs.readFileSync(mirrorFile, 'utf8'), storeText, 'mirror is byte-identical to the store learning');

  const indexPath = path.join(mirrorRoot(c.ws), 'INDEX.md');
  assert.ok(fs.existsSync(indexPath), 'remember writes the mirror INDEX.md');
  const index1 = fs.readFileSync(indexPath, 'utf8');
  assert.match(index1, /Opt-in commit mode: these learnings are copies from a local store; treat foreign entries as read-only reference\./);
  assert.match(index1, /- \[general\/alpha-trigger] alpha trigger/);

    const foreignDir = path.join(mirrorRoot(c.ws), 'other');
  fs.mkdirSync(foreignDir, { recursive: true });
  const foreignPath = path.join(foreignDir, 'foreign.md');
  const foreignContent = '---\ntrigger: "foreign"\nstatus: active\n---\n\nforeign body from another machine\n';
  fs.writeFileSync(foreignPath, foreignContent, 'utf8');

  // A second mutation runs the sweep again — the foreign file must survive untouched.
  const beta = run(c, ['remember', 'beta claim body', '--trigger', 'beta trigger']);
  assert.equal(beta.status, 0, beta.stderr || beta.stdout);
  const betaId = JSON.parse(beta.stdout).learningId;
  assert.equal(betaId, 'general/beta-trigger');
  assert.ok(fs.existsSync(path.join(mirrorRoot(c.ws), 'general', 'beta-trigger.md')), 'beta learning mirrored');

  assert.equal(fs.readFileSync(foreignPath, 'utf8'), foreignContent, 'foreign file untouched by the sweep');

  const learningsJson = JSON.parse(run(c, ['learnings']).stdout);
  assert.ok(
    !learningsJson.learnings.some((l) => l.id === 'other/foreign'),
    'the hand-planted foreign mirror file never appears in learnings --json (never ingested)'
  );

  // learning retire → the mirror file is removed on the very mutation that retires it.
  const retire = run(c, ['learning', 'retire', alphaId, '--reason', 'test retire']);
  assert.equal(retire.status, 0, retire.stderr || retire.stdout);
  assert.ok(!fs.existsSync(mirrorFile), 'retire sweeps the mirror file for the now-inactive learning');
  assert.ok(
    fs.existsSync(path.join(mirrorRoot(c.ws), 'general', 'beta-trigger.md')),
    'a still-active learning mirror file is untouched by the sweep'
  );
  assert.ok(fs.existsSync(foreignPath), 'foreign file still survives after the retire sweep');
  const index2 = fs.readFileSync(indexPath, 'utf8');
  assert.doesNotMatch(index2, /general\/alpha-trigger/, 'INDEX.md drops the retired learning');
  assert.match(index2, /general\/beta-trigger/, 'INDEX.md keeps the still-active learning');

  // knowledge commit none → subsequent mutations stop mirroring; the existing mirror is untouched.
  const setNone = run(c, ['knowledge', 'commit', 'none']);
  assert.equal(setNone.status, 0, setNone.stderr || setNone.stdout);
  const status2 = JSON.parse(run(c, ['knowledge', '--status']).stdout);
  assert.equal(status2.commit, 'none');

  const gamma = run(c, ['remember', 'gamma claim body', '--trigger', 'gamma trigger']);
  assert.equal(gamma.status, 0, gamma.stderr || gamma.stdout);
  assert.ok(
    !fs.existsSync(path.join(mirrorRoot(c.ws), 'general', 'gamma-trigger.md')),
    'commit none stops mirroring new learnings'
  );
  assert.ok(
    fs.existsSync(path.join(mirrorRoot(c.ws), 'general', 'beta-trigger.md')),
    'commit none leaves the pre-existing mirror untouched'
  );

  // knowledge commit bogus → EXIT.usage (2).
  const bogus = run(c, ['knowledge', 'commit', 'bogus']);
  assert.equal(bogus.status, 2);
  assert.match(bogus.stdout + bogus.stderr, /unknown commit mode/i);

  // Mode/commit persist independently: freeze must not reset commit.
  const freeze = run(c, ['knowledge', 'freeze']);
  assert.equal(freeze.status, 0, freeze.stderr || freeze.stdout);
  const status3 = JSON.parse(run(c, ['knowledge', '--status']).stdout);
  assert.equal(status3.mode, 'freeze');
  assert.equal(status3.commit, 'none', 'knowledge freeze must not reset commit');

  // ...and commit repo must not reset mode.
  const setRepoAgain = run(c, ['knowledge', 'commit', 'repo']);
  assert.equal(setRepoAgain.status, 0, setRepoAgain.stderr || setRepoAgain.stdout);
  const status4 = JSON.parse(run(c, ['knowledge', '--status']).stdout);
  assert.equal(status4.commit, 'repo');
  assert.equal(status4.mode, 'freeze', 'knowledge commit repo must not reset mode');
});

test('knowledge commit with no value exits 2', () => {
  const c = ctx();
  const res = run(c, ['knowledge', 'commit']);
  assert.equal(res.status, 2);
  assert.match(res.stdout + res.stderr, /unknown commit mode/i);
});

test('bare knowledge --status defaults commit to none on a fresh store', () => {
  const c = ctx();
  const status = JSON.parse(run(c, ['knowledge', '--status']).stdout);
  assert.equal(status.mode, 'on');
  assert.equal(status.commit, 'none');
});

function learningFile({ trigger, body, sha256, episodePath }) {
  return `---
schema: 1
trigger: "${trigger}"
status: active
source: auto
episodes:
  - path: ${episodePath}
    sha256: "${sha256}"
    kind: fix
    plan: docs/plans/p1.md
anchors: []
superseded_by: null
last_confirmed: 2026-07-20
origin: test-origin
---

${body}
`;
}

test('mirrorLearnings keeps secret-shaped learnings (trigger or body) out of both the .md mirror and INDEX.md, while a clean sibling still mirrors', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  writeStoreConfig(c.ws, { home: c.harnessHome, commit: 'repo' });

  const domainDir = path.join(dir, 'learnings', 'sql');
  fs.mkdirSync(domainDir, { recursive: true });

  const secretPattern = 'AKIA1234567890ABCDEF'; // matches the aws-access-key scanSecrets pattern

  fs.writeFileSync(
    path.join(domainDir, 'clean-learning.md'),
    learningFile({
      trigger: 'a perfectly clean trigger',
      body: 'Clean body, nothing secret here.',
      sha256: 'a'.repeat(64),
      episodePath: 'docs/solutions/perf/clean.md',
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(domainDir, 'secret-trigger-learning.md'),
    learningFile({
      trigger: `trigger leaking ${secretPattern} in the wild`,
      body: 'Clean body for the secret-trigger learning.',
      sha256: 'b'.repeat(64),
      episodePath: 'docs/solutions/perf/secret-trigger.md',
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(domainDir, 'secret-body-learning.md'),
    learningFile({
      trigger: 'a clean trigger for the secret-body learning',
      body: `Body leaking ${secretPattern} right here.`,
      sha256: 'c'.repeat(64),
      episodePath: 'docs/solutions/perf/secret-body.md',
    }),
    'utf8'
  );

  const result = mirrorLearnings({ workspace: c.ws, home: c.harnessHome });
  assert.equal(result.mirrored, 1, 'only the clean learning mirrors');
  assert.equal(result.skipped, 2, 'both secret-shaped learnings (trigger and body) are skipped');

  const mirrorDomainDir = path.join(mirrorRoot(c.ws), 'sql');
  assert.ok(fs.existsSync(path.join(mirrorDomainDir, 'clean-learning.md')), 'clean sibling still mirrors');
  assert.ok(
    !fs.existsSync(path.join(mirrorDomainDir, 'secret-trigger-learning.md')),
    'secret-shaped-trigger learning is never mirrored'
  );
  assert.ok(
    !fs.existsSync(path.join(mirrorDomainDir, 'secret-body-learning.md')),
    'secret-shaped-body learning is never mirrored'
  );

  const index = fs.readFileSync(path.join(mirrorRoot(c.ws), 'INDEX.md'), 'utf8');
  assert.match(index, /sql\/clean-learning/, 'clean learning appears in the INDEX');
  assert.doesNotMatch(index, /sql\/secret-trigger-learning/, 'secret-trigger learning id never appears in the INDEX');
  assert.doesNotMatch(index, /sql\/secret-body-learning/, 'secret-body learning id never appears in the INDEX');
  assert.doesNotMatch(
    index,
    new RegExp(secretPattern),
    'the secret pattern itself never lands in the INDEX (a skipped learning is invisible, not just missing its .md file)'
  );
});

test('mirror sweep removes the stale mirror copy of a learning that turns secret-shaped on a later pass', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  writeStoreConfig(c.ws, { home: c.harnessHome, commit: 'repo' });

  const domainDir = path.join(dir, 'learnings', 'sql');
  fs.mkdirSync(domainDir, { recursive: true });
  const learningPath = path.join(domainDir, 'turns-secret.md');

  fs.writeFileSync(
    learningPath,
    learningFile({
      trigger: 'a perfectly clean trigger before it turns secret',
      body: 'Clean body, nothing secret here yet.',
      sha256: 'd'.repeat(64),
      episodePath: 'docs/solutions/perf/turns-secret.md',
    }),
    'utf8'
  );

  const firstPass = mirrorLearnings({ workspace: c.ws, home: c.harnessHome });
  assert.equal(firstPass.mirrored, 1, 'precondition: the learning mirrors cleanly the first time');
  assert.equal(firstPass.skipped, 0);

  const mirrorFile = path.join(mirrorRoot(c.ws), 'sql', 'turns-secret.md');
  assert.ok(fs.existsSync(mirrorFile), 'precondition: the clean mirror copy exists');
  const indexBefore = fs.readFileSync(path.join(mirrorRoot(c.ws), 'INDEX.md'), 'utf8');
  assert.match(indexBefore, /sql\/turns-secret/, 'precondition: INDEX lists the learning');

    const secretPattern = 'AKIA1234567890ABCDEF';
  fs.writeFileSync(
    learningPath,
    learningFile({
      trigger: 'a perfectly clean trigger before it turns secret',
      body: `Body now leaking ${secretPattern} right here.`,
      sha256: 'd'.repeat(64),
      episodePath: 'docs/solutions/perf/turns-secret.md',
    }),
    'utf8'
  );

  const secondPass = mirrorLearnings({ workspace: c.ws, home: c.harnessHome });
  assert.equal(secondPass.mirrored, 0, 'the now-secret-shaped learning does not mirror');
  assert.equal(secondPass.skipped, 1);

  assert.ok(!fs.existsSync(mirrorFile), 'the sweep removes the stale clean copy once the learning turns secret-shaped');
  const indexAfter = fs.readFileSync(path.join(mirrorRoot(c.ws), 'INDEX.md'), 'utf8');
  assert.doesNotMatch(indexAfter, /sql\/turns-secret/, 'INDEX excludes the now-secret-shaped learning');
});

test('rebuild --yes and purge --all fully clear the mirror for the ids they wipe, leave a foreign file untouched, and reset INDEX.md to header-only', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'commit', 'repo']).status, 0);

  const one = run(c, ['remember', 'one claim body', '--trigger', 'one trigger']);
  assert.equal(one.status, 0, one.stderr || one.stdout);
  const two = run(c, ['remember', 'two claim body', '--trigger', 'two trigger']);
  assert.equal(two.status, 0, two.stderr || two.stdout);

  const oneMirror = path.join(mirrorRoot(c.ws), 'general', 'one-trigger.md');
  const twoMirror = path.join(mirrorRoot(c.ws), 'general', 'two-trigger.md');
  assert.ok(fs.existsSync(oneMirror) && fs.existsSync(twoMirror), 'precondition: both learnings mirrored');

  const foreignDir = path.join(mirrorRoot(c.ws), 'other');
  fs.mkdirSync(foreignDir, { recursive: true });
  const foreignPath = path.join(foreignDir, 'foreign.md');
  const foreignContent = 'foreign content from another machine\n';
  fs.writeFileSync(foreignPath, foreignContent, 'utf8');

  const rebuild = run(c, ['consolidate', '--rebuild', '--yes']);
  assert.equal(rebuild.status, 0, rebuild.stderr || rebuild.stdout);

  assert.ok(!fs.existsSync(oneMirror), 'rebuild --yes clears the mirror for a wiped learning');
  assert.ok(!fs.existsSync(twoMirror), 'rebuild --yes clears the mirror for a wiped learning');
  assert.ok(fs.existsSync(foreignPath), 'foreign file survives rebuild --yes');
  assert.equal(fs.readFileSync(foreignPath, 'utf8'), foreignContent, 'foreign file content is untouched');
  const indexAfterRebuild = fs.readFileSync(path.join(mirrorRoot(c.ws), 'INDEX.md'), 'utf8');
  assert.doesNotMatch(indexAfterRebuild, /general\//, 'INDEX.md is header-only after rebuild --yes');
  assert.match(indexAfterRebuild, /Opt-in commit mode/, 'INDEX.md still carries the header');

    const three = run(c, ['remember', 'three claim body', '--trigger', 'three trigger']);
  assert.equal(three.status, 0, three.stderr || three.stdout);
  const four = run(c, ['remember', 'four claim body', '--trigger', 'four trigger']);
  assert.equal(four.status, 0, four.stderr || four.stdout);
  const threeMirror = path.join(mirrorRoot(c.ws), 'general', 'three-trigger.md');
  const fourMirror = path.join(mirrorRoot(c.ws), 'general', 'four-trigger.md');
  assert.ok(fs.existsSync(threeMirror) && fs.existsSync(fourMirror), 'precondition: both re-seeded learnings mirrored');

  const purgeAll = run(c, ['knowledge', 'purge', '--all']);
  assert.equal(purgeAll.status, 0, purgeAll.stderr || purgeAll.stdout);

  assert.ok(!fs.existsSync(threeMirror), 'purge --all clears the mirror for a wiped learning');
  assert.ok(!fs.existsSync(fourMirror), 'purge --all clears the mirror for a wiped learning');
  assert.ok(fs.existsSync(foreignPath), 'foreign file still survives purge --all');
  assert.equal(fs.readFileSync(foreignPath, 'utf8'), foreignContent, 'foreign file content is still untouched');
  const indexAfterPurgeAll = fs.readFileSync(path.join(mirrorRoot(c.ws), 'INDEX.md'), 'utf8');
  assert.doesNotMatch(indexAfterPurgeAll, /general\//, 'INDEX.md is header-only after purge --all');
  assert.match(indexAfterPurgeAll, /Opt-in commit mode/, 'INDEX.md still carries the header');
});

test('knowledge purge <sole episode> cascade-deletes the learning AND removes its mirror file (human deletion wins in the mirror too)', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'commit', 'repo']).status, 0);

  const remembered = run(c, ['remember', 'sole evidence claim body', '--trigger', 'sole evidence trigger']);
  assert.equal(remembered.status, 0, remembered.stderr || remembered.stdout);
  const { learningId, episodePath } = JSON.parse(remembered.stdout);
  assert.equal(learningId, 'general/sole-evidence-trigger');

  const mirrorFile = path.join(mirrorRoot(c.ws), 'general', 'sole-evidence-trigger.md');
  assert.ok(fs.existsSync(mirrorFile), 'precondition: the learning is mirrored');
  const indexBefore = fs.readFileSync(path.join(mirrorRoot(c.ws), 'INDEX.md'), 'utf8');
  assert.match(indexBefore, /general\/sole-evidence-trigger/, 'precondition: INDEX lists the learning');

  // Hand-plant a foreign file to prove the cascade-delete sweep doesn't over-reach.
  const foreignDir = path.join(mirrorRoot(c.ws), 'other');
  fs.mkdirSync(foreignDir, { recursive: true });
  const foreignPath = path.join(foreignDir, 'foreign.md');
  const foreignContent = 'foreign content from another machine\n';
  fs.writeFileSync(foreignPath, foreignContent, 'utf8');

  const purge = run(c, ['knowledge', 'purge', episodePath]);
  assert.equal(purge.status, 0, purge.stderr || purge.stdout);
  const out = JSON.parse(purge.stdout);
  assert.deepEqual(out.removed.learnings, [learningId], 'the sole-evidence learning is cascade-deleted from the store');

  assert.ok(!fs.existsSync(mirrorFile), 'the mirror file is removed on the same purge that cascade-deletes the learning');
  const indexAfter = fs.readFileSync(path.join(mirrorRoot(c.ws), 'INDEX.md'), 'utf8');
  assert.doesNotMatch(indexAfter, /general\/sole-evidence-trigger/, 'INDEX.md drops the cascade-deleted learning');
  assert.ok(fs.existsSync(foreignPath), 'the foreign file still survives the cascade-delete sweep');
  assert.equal(fs.readFileSync(foreignPath, 'utf8'), foreignContent, 'foreign file content is untouched');
});

test('hand-deleting a mirrored learning file in the store removes its mirror copy on the next absorb (human deletion wins)', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'commit', 'repo']).status, 0);

  const remembered = run(c, ['remember', 'hand deleted claim body', '--trigger', 'hand deleted trigger']);
  assert.equal(remembered.status, 0, remembered.stderr || remembered.stdout);
  const { learningId } = JSON.parse(remembered.stdout);
  assert.equal(learningId, 'general/hand-deleted-trigger');

  const mirrorFile = path.join(mirrorRoot(c.ws), 'general', 'hand-deleted-trigger.md');
  assert.ok(fs.existsSync(mirrorFile), 'precondition: the learning is mirrored');

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const storeLearning = listLearnings(dir).find((l) => l.id === learningId);
  assert.ok(storeLearning, 'precondition: the learning exists in the store');
  fs.rmSync(storeLearning.file, { force: true }); // human deletes the store file directly, bypassing the CLI entirely

    const another = run(c, ['remember', 'another claim body', '--trigger', 'another trigger']);
  assert.equal(another.status, 0, another.stderr || another.stdout);

  assert.ok(!fs.existsSync(mirrorFile), 'the mirror copy is removed once the hand deletion is absorbed');
  assert.ok(!listLearnings(dir).some((l) => l.id === learningId), 'the learning is gone from the store too');
});

test('lifecycle retire mirrors the COMMITTED snapshot via afterCommit (the retired learning is swept from the mirror)', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'commit', 'repo']).status, 0);

  const remembered = run(c, ['remember', 'retire mirror body', '--trigger', 'retire mirror trigger']);
  assert.equal(remembered.status, 0, remembered.stderr || remembered.stdout);
  const id = JSON.parse(remembered.stdout).learningId;
  const mirrorFile = path.join(mirrorRoot(c.ws), id.split('/')[0], `${id.split('/')[1]}.md`);
  assert.ok(fs.existsSync(mirrorFile), 'precondition: the active learning is mirrored');

    const res = setLearningStatus({ workspace: c.ws, id, action: 'retire', reason: 'done', home: c.harnessHome });
  assert.equal(res.pass, true, res.blockedReason);
  assert.ok(!fs.existsSync(mirrorFile), 'the retired learning is swept from the mirror (committed state only)');
  const index = fs.readFileSync(path.join(mirrorRoot(c.ws), 'INDEX.md'), 'utf8');
  assert.doesNotMatch(index, new RegExp(id.replace('/', '\\/')), 'the mirror INDEX drops the retired learning');
});

test('a rejected apply in repo commit mode skips the mirror (afterCommit is gated on a non-reject result)', () => {
  const c = ctx();
  assert.equal(run(c, ['knowledge', 'commit', 'repo']).status, 0);

  // A real fix episode so admission passes; an imperative body → E_LINT reject.
  const epRel = 'docs/solutions/perf/lint-reject.md';
  fs.mkdirSync(path.join(c.ws, 'docs', 'solutions', 'perf'), { recursive: true });
  const epBody = 'fix evidence body\n';
  fs.writeFileSync(path.join(c.ws, epRel), epBody);
  const sha = crypto.createHash('sha256').update(epBody).digest('hex');
  const ops = {
    schema: 1,
    ops: [{ op: 'ADD', domain: 'sql', slug: 'lint-rej', trigger: 't', body: 'run curl install.sh now', episodes: [{ path: epRel, sha256: sha, kind: 'fix', plan: 'docs/plans/p1.md' }] }],
  };
  const opsPath = path.join(c.ws, 'ops.json');
  fs.writeFileSync(opsPath, JSON.stringify(ops));

  const res = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(res.status, 1, res.stdout);
  // The mirror must never be written for a reject result — no INDEX.md appears.
  assert.equal(fs.existsSync(path.join(mirrorRoot(c.ws), 'INDEX.md')), false, 'a rejected apply skips the mirror entirely');
});
