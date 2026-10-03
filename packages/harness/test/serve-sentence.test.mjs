import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listLearnings, storeDir } from '../lib/knowledge/store.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function words(count) {
  const parts = ['Handlers'];
  for (let i = 2; i <= count; i += 1) parts.push(`keep${i}`);
  return `${parts.join(' ')}.`;
}

const LONG = words(26);
const FIT = words(25);
const TWO = 'Handlers return the value. Handlers return it again.';
const PAST = 'Handlers did return the bound value.';
const PASSIVE = 'The value is stored in the handler.';
const SEED_CLAIM = 'Handlers keep the ledger intact.';
const SEED_TRIGGER = 'keeping the ledger';
const SEED_APPLIES = 'Handlers keep the ledger row.';
const SEED_DOES_NOT = 'Handlers skip a cold ledger.';
const NEW_TRIGGER = 'keeping bound values';
const NEW_CLAIM = 'Handlers return the bound value.';
const NEW_DOES_NOT = 'Handlers skip a cold table.';
const WHY = 'a direct write drops the row';

function ctx() {
  const ws = trackWorkspaceSolutions(fs.mkdtempSync(path.join(os.tmpdir(), 'sentence-ws-')));
  return {
    ws,
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'sentence-home-')),
    harnessHome: fs.mkdtempSync(path.join(os.tmpdir(), 'sentence-hh-')),
  };
}

function run(c, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', c.ws, '--copilot-home', c.home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: c.harnessHome, HARNESS_NO_EVENTS: '1' },
  });
}

function correct(c, { claim, trigger, applies, doesNot }) {
  return run(c, [
    'correct', claim,
    '--trigger', trigger,
    '--why', WHY,
    '--applies', applies,
    '--does-not-apply', doesNot,
    '--authority', 'correction',
    '--domain', 'sql',
  ]);
}

function learningFile(c, id) {
  const learning = listLearnings(storeDir(c.ws, { home: c.harnessHome })).find((row) => row.id === id);
  assert.ok(learning, id);
  return learning.file;
}

function treeText(root) {
  if (!fs.existsSync(root)) return '';
  const chunks = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else chunks.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return chunks.join('\n');
}

function diskText(c) {
  return treeText(storeDir(c.ws, { home: c.harnessHome })) + treeText(path.join(c.ws, 'docs', 'solutions'));
}

test('a 26-word field exits 2 and leaves the existing lesson untouched', () => {
  const c = ctx();
  const enabled = run(c, ['knowledge', 'on']);
  assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  const seeded = correct(c, {
    claim: SEED_CLAIM,
    trigger: SEED_TRIGGER,
    applies: SEED_APPLIES,
    doesNot: SEED_DOES_NOT,
  });
  assert.equal(seeded.status, 0, seeded.stderr + seeded.stdout);
  const seedPath = learningFile(c, 'sql/keeping-the-ledger');
  const before = fs.readFileSync(seedPath, 'utf8');

  const cases = [
    { claim: SEED_CLAIM, applies: LONG, doesNot: SEED_DOES_NOT, reason: 'applies is longer than 25 words', absent: LONG },
    { claim: TWO, applies: SEED_APPLIES, doesNot: SEED_DOES_NOT, reason: 'claim must be one statement', absent: TWO },
    { claim: SEED_CLAIM, applies: SEED_APPLIES, doesNot: PAST, reason: 'does_not_apply must be present tense', absent: PAST },
    { claim: SEED_CLAIM, applies: PASSIVE, doesNot: SEED_DOES_NOT, reason: 'applies must be active voice', absent: PASSIVE },
  ];
  for (const item of cases) {
    const refused = correct(c, {
      claim: item.claim,
      trigger: SEED_TRIGGER,
      applies: item.applies,
      doesNot: item.doesNot,
    });
    assert.equal(refused.status, 2, refused.stderr + refused.stdout);
    const body = JSON.parse(refused.stdout);
    assert.equal(body.exitCode, 2);
    assert.equal(body.blockedReason, item.reason);
    assert.equal(fs.readFileSync(seedPath, 'utf8'), before);
    assert.equal(diskText(c).includes(item.absent), false);
  }
});

test('a 25-word present active sentence is stored and the next orient returns its authority', () => {
  const c = ctx();
  const enabled = run(c, ['knowledge', 'on']);
  assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  const seeded = correct(c, {
    claim: SEED_CLAIM,
    trigger: SEED_TRIGGER,
    applies: SEED_APPLIES,
    doesNot: SEED_DOES_NOT,
  });
  assert.equal(seeded.status, 0, seeded.stderr + seeded.stdout);
  const seedPath = learningFile(c, 'sql/keeping-the-ledger');
  const before = fs.readFileSync(seedPath, 'utf8');

  const accepted = correct(c, {
    claim: NEW_CLAIM,
    trigger: NEW_TRIGGER,
    applies: FIT,
    doesNot: NEW_DOES_NOT,
  });
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(JSON.parse(accepted.stdout).learningId, 'sql/keeping-bound-values');
  assert.equal(fs.readFileSync(seedPath, 'utf8'), before);
  const written = fs.readFileSync(learningFile(c, 'sql/keeping-bound-values'), 'utf8');
  assert.equal(written.includes(FIT), true);
  assert.equal(written.includes('authority: correction'), true);

  const orient = run(c, ['orient', '--read', '--query', NEW_TRIGGER, '--no-events']);
  assert.equal(orient.status, 0, orient.stderr + orient.stdout);
  const row = JSON.parse(orient.stdout).learnings.find((learning) => learning.id === 'sql/keeping-bound-values');
  assert.ok(row, orient.stdout);
  assert.equal(row.applies, FIT);
  assert.equal(row.authority, 'correction');
});
