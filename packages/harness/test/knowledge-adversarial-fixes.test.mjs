import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { collectEpisodes, consolidateCandidates } from '../lib/knowledge/consolidate.mjs';
import { purgeEpisode, absorbHandEdits } from '../lib/knowledge/admin.mjs';
import { ensureStore, storeDir, listLearnings, readLedger, serializeLearning } from '../lib/knowledge/store.mjs';
import { assertNoSymlinkAncestors } from '../lib/fs-safe.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('kadv-ws-'), home: tempDir('kadv-home-'), harnessHome: tempDir('kadv-hh-') });

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function writeRealEpisode(ws, rel, content) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = content ?? `episode body for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

// Critical: symlinked ANCESTOR directories --------------------------------

test('Critical: a symlinked docs/solutions directory yields ZERO episodes from collectEpisodes — the containment check runs against the workspace base, not a realpath of the scanned subdir', () => {
  const c = ctx();
  const outsideDir = tempDir('kadv-outside-');
  const secretText = '---\ntitle: "stolen"\ndate: 2026-01-01\n---\n\nOUTSIDE_SECRET_SENTINEL private data outside the repo.\n';
  fs.mkdirSync(path.join(outsideDir, 'perf'), { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'perf', 'secret.md'), secretText, 'utf8');

  fs.mkdirSync(path.join(c.ws, 'docs'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(c.ws, 'docs', 'solutions'));

  const episodes = collectEpisodes({ workspace: c.ws, copilotHome: null });
  assert.equal(episodes.length, 0, 'a symlinked docs/solutions yields zero episodes, not the outside directory\'s contents');
  assert.ok(!JSON.stringify(episodes).includes('OUTSIDE_SECRET_SENTINEL'), 'no leaked content anywhere in the result');
});

test('Critical: collectEpisodes still works normally when docs/solutions is a plain directory (no false-positive rejection)', () => {
  const c = ctx();
  writeRealEpisode(c.ws, 'docs/solutions/perf/legit.md', '---\ntitle: "legit"\n---\n\nlegit fix body.\n');
  const episodes = collectEpisodes({ workspace: c.ws, copilotHome: null });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].path, 'docs/solutions/perf/legit.md');
});

test('Critical: an ADD citing evidence through a symlinked docs/solutions is rejected E_SCHEMA, writes no learning, and leaks no outside content into the rejection or ledger', () => {
  const c = ctx();
  const outsideDir = tempDir('kadv-outside2-');
  const secretText = '---\nkind: fix\ntitle: "stolen"\n---\n\nOUTSIDE_SECRET_SENTINEL laundered as verified evidence.\n';
  fs.mkdirSync(path.join(outsideDir, 'perf'), { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'perf', 'secret.md'), secretText, 'utf8');
  const sha256 = crypto.createHash('sha256').update(secretText).digest('hex');

  fs.mkdirSync(path.join(c.ws, 'docs'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(c.ws, 'docs', 'solutions'));

  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'laundered-ancestor',
    trigger: 'a trigger citing symlinked-ancestor evidence',
    body: 'a body',
    episodes: [{ path: 'docs/solutions/perf/secret.md', sha256, kind: 'fix', plan: null }],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.equal(res.rejected[0].code, 'E_SCHEMA');
  assert.match(res.rejected[0].reason, /does not verify/);
  assert.ok(!JSON.stringify(res).includes('OUTSIDE_SECRET_SENTINEL'), 'no outside content leaks into the rejection payload');

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(listLearnings(dir).length, 0, 'no learning written from evidence behind a symlinked ancestor');
  const ledger = readLedger(dir);
  assert.ok(
    !ledger.some((e) => JSON.stringify(e).includes('OUTSIDE_SECRET_SENTINEL')),
    'the content-failure strike (path+sha256 only) never carries the outside file\'s content'
  );
});

test('Critical: a symlinked copilotHome/knowledge root is rejected by assertNoSymlinkAncestors, and purge refuses through it', () => {
  const c = ctx();
  const outsideDir = tempDir('kadv-out3-');
  const victimDir = path.join(outsideDir, 'solutions', 'perf');
  fs.mkdirSync(victimDir, { recursive: true });
  const victim = path.join(victimDir, 'v.md');
  fs.writeFileSync(victim, 'OUTSIDE victim under symlinked knowledge root\n', 'utf8');
  fs.symlinkSync(outsideDir, path.join(c.home, 'knowledge'));

    assert.equal(assertNoSymlinkAncestors(path.join(c.home, 'knowledge'), 'solutions/perf/v.md'), null);

  const res = purgeEpisode({ workspace: c.ws, target: 'solutions/perf/v.md', copilotHome: c.home, home: c.harnessHome });
  assert.notEqual(res.exitCode, 0, JSON.stringify(res));
  assert.equal(res.pass, false);
  assert.ok(fs.existsSync(victim), 'the outside victim survives — nothing deleted through the symlinked root');
});

// Important #1: absorbHandEdits snapshot write ------------------------------

test('Important 1: absorbHandEdits refuses to write a snapshot through a symlinked docs/solutions/teachings/ — still absorbs, logs the skip, nothing lands outside', () => {
  const c = ctx();
  const outsideDir = tempDir('kadv-teach-outside-');

  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'absorb-symlink-teachings',
    trigger: 'a trigger for the absorb symlink test',
    body: 'a seed body',
    episodes: [{ ...writeRealEpisode(c.ws, 'docs/solutions/perf/seed.md'), kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const seedRes = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [op]), home: c.harnessHome });
  assert.equal(seedRes.exitCode, 0, JSON.stringify(seedRes));

  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === 'sql/absorb-symlink-teachings');
    const text = fs.readFileSync(learning.file, 'utf8');
  const edited = text.replace(/\n\n[\s\S]*$/, '\n\nA human edited this claim directly on disk.\n');
  assert.notEqual(edited, text, 'precondition: the hand edit actually changes the file');
  fs.writeFileSync(learning.file, edited, 'utf8');

    fs.mkdirSync(path.join(c.ws, 'docs', 'solutions'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(c.ws, 'docs', 'solutions', 'teachings'));

  const messages = [];
  const result = absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: (m) => messages.push(m) });
  assert.equal(result.absorbed.length, 1, 'the hand edit is still absorbed');
  assert.equal(result.absorbed[0].id, 'sql/absorb-symlink-teachings');
  assert.equal(result.absorbed[0].snapshot, null, 'the snapshot write was refused, not silently written outside');
  assert.ok(messages.some((m) => /symlinked destination/.test(m)), 'the refusal is logged');

  assert.equal(fs.readdirSync(outsideDir).length, 0, 'nothing was written through the symlinked teachings directory');

  const after = listLearnings(dir).find((l) => l.id === 'sql/absorb-symlink-teachings');
  assert.equal(after.fm.source, 'human', 'still absorbed as a human edit despite the refused snapshot');
  assert.ok(!after.fm.episodes.some((e) => e.path.includes('hand-edit')), 'no dangling snapshot episode reference');
});

// Important #2: candidates packet inertLine normalization ------------------

test('Important 2: the candidates packet normalizes both a legacy learning\'s trigger and an episode\'s excerpt — no raw C0/DEL survives in the JSON', () => {
  const c = ctx();
    const injectedBody = '---\ntitle: "ctrl"\ndate: 2026-01-01\n---\n\nline one\x00NUL_MARKER\x1bESC_MARKER line two\n';
  fs.mkdirSync(path.join(c.ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, 'docs', 'solutions', 'perf', 'ctrl.md'), injectedBody, 'utf8');

    const dir = storeDir(c.ws, { home: c.harnessHome });
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  const fm = {
    trigger: 'looks like one trigger\n## Fake Heading\nmalicious instructions',
    status: 'active',
    source: 'auto',
    episodes: [],
    anchors: [],
    superseded_by: null,
    last_confirmed: null,
    origin: 'test',
  };
  fs.writeFileSync(path.join(dir, 'learnings', 'sql', 'legacy.md'), serializeLearning(fm, 'a legacy claim body'), 'utf8');

  const packet = consolidateCandidates({ workspace: c.ws, copilotHome: null, home: c.harnessHome });
  const packetText = JSON.stringify(packet);
  for (const code of [0x00, 0x1b, 0x0a]) {
    assert.ok(!packetText.includes(String.fromCharCode(code)), `packet JSON must never carry raw 0x${code.toString(16)}`);
  }
  const legacyRow = packet.learnings.find((l) => l.id === 'sql/legacy');
  assert.ok(legacyRow, 'the legacy learning appears in the packet');
  assert.equal(legacyRow.trigger.split('\n').length, 1, 'the packet trigger renders as one line');

  const ctrlEpisode = packet.clusters.flatMap((cl) => cl.episodes).find((e) => e.path.endsWith('ctrl.md'));
  assert.ok(ctrlEpisode, 'the control-char episode is still collected');
  assert.ok(!ctrlEpisode.excerpt.includes('\x00'), 'the excerpt never carries a raw NUL byte');
  assert.ok(!ctrlEpisode.excerpt.includes('\x1b'), 'the excerpt never carries a raw ESC byte');
});

// Minor #5: fail-closed on a malformed governance timestamp -----------------

test('Minor 5: a governance record with an empty/malformed `at` fails CLOSED — the veto holds even against genuinely dated evidence', async () => {
  const { setLearningStatus } = await import('../lib/knowledge/lifecycle.mjs');
  const c = ctx();
  const ep = writeRealEpisode(c.ws, 'docs/solutions/teachings/reteach.md', '---\ntitle: "t"\nkind: human-teaching\ndate: 2026-07-01\n---\n\nbody\n');
  const seedOp = {
    op: 'ADD',
    domain: 'sql',
    slug: 'malformed-at',
    trigger: 'a trigger for the malformed-at scenario',
    body: 'a seed body',
    episodes: [{ ...ep, kind: 'human-teaching', plan: null }],
  };
  assert.equal(applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [seedOp]), home: c.harnessHome }).exitCode, 0);

  const dir = storeDir(c.ws, { home: c.harnessHome });
    const disputeRes = setLearningStatus({ workspace: c.ws, id: 'sql/malformed-at', action: 'dispute', reason: 'x', home: c.harnessHome });
  assert.equal(disputeRes.pass, true, JSON.stringify(disputeRes));

    const govPath = path.join(dir, 'governance.jsonl');
  const poisoned = fs
    .readFileSync(govPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line);
      if (entry.id === 'sql/malformed-at') entry.at = '';
      return JSON.stringify(entry);
    })
    .join('\n') + '\n';
  fs.writeFileSync(govPath, poisoned, 'utf8');

    const laterEp = writeRealEpisode(
    c.ws,
    'docs/solutions/teachings/reteach-later.md',
    '---\ntitle: "t2"\nkind: human-teaching\ndate: 2099-01-01\n---\n\nlater body\n'
  );
  const reteachOp = {
    op: 'SUPERSEDE',
    target: 'sql/malformed-at',
    domain: 'sql',
    slug: 'malformed-at', // in-place shape
    trigger: 'a trigger for the malformed-at scenario',
    body: 'a claim that must NOT override a poisoned-at dispute',
    episodes: [{ ...laterEp, kind: 'human-teaching', plan: null }],
  };
  const res = applyOps({ workspace: c.ws, opsPath: writeOps(c.ws, [reteachOp]), home: c.harnessHome });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.equal(res.rejected[0].code, 'E_TARGET');
  assert.match(res.rejected[0].reason, /is not active/);

  const learning = listLearnings(dir).find((l) => l.id === 'sql/malformed-at');
  assert.equal(learning.fm.status, 'disputed', 'the veto holds — a malformed governance timestamp never fails open');
  assert.doesNotMatch(learning.body, /must NOT override/, 'the reteach never actually landed');
});
