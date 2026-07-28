import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, listLearnings } from '../lib/knowledge/store.mjs';

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

  // Hand-plant a foreign file (another machine's commit, or a stray edit) —
  // never imported, and never touched by the sweep.
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
