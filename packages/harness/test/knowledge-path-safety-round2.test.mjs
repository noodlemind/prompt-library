import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runGet } from '../lib/get-cmd.mjs';
import { runIndexKnowledge } from '../lib/index-knowledge.mjs';
import { findMatchingPlans } from '../lib/recall-rank.mjs';
import { safeResolveUnderRoot } from '../lib/path-safe.mjs';
import { resolveContainedPath } from '../lib/sync.mjs';
import { collectEpisodes, consolidateCandidates } from '../lib/knowledge/consolidate.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { storeDir, listLearnings, serializeLearning } from '../lib/knowledge/store.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

// Probe G scenario, verbatim -------------------------------------------

test('probe G: harness get --path through a symlinked docs/solutions throws instead of leaking outside content', () => {
  const ws = tempDir('probeG-ws-');
  const outside = tempDir('probeG-outside-');
  const copilotHome = tempDir('probeG-ch-');
  const secretPath = path.join(outside, 'perf');
  fs.mkdirSync(secretPath, { recursive: true });
  fs.writeFileSync(
    path.join(secretPath, 'secret.md'),
    '---\ntitle: "stolen"\n---\n\nOUTSIDE_SECRET_SENTINEL leaked via harness get.\n',
    'utf8'
  );

  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  assert.throws(
    () => runGet({ workspace: ws, copilotHome, flags: { path: 'docs/solutions/perf/secret.md', lines: 40, maxBytes: 2048 } }),
    /escapes workspace/
  );
});

test('safeResolveUnderRoot refuses a symlinked ancestor directly (unit-level), and still resolves a plain path normally', () => {
  const ws = tempDir('psafe-ws-');
  const outside = tempDir('psafe-outside-');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));
  assert.equal(safeResolveUnderRoot(ws, 'docs/solutions/x.md'), null);

  fs.mkdirSync(path.join(ws, 'plain'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'plain', 'a.md'), 'ok\n', 'utf8');
  assert.equal(safeResolveUnderRoot(ws, 'plain/a.md'), path.join(ws, 'plain', 'a.md'));
});

// A recall/manifest-resolved doc through a symlinked dir → excluded --------

test('a recall-manifest-resolved doc through a symlinked docs/solutions directory is excluded from the manifest, and harness get --docid cannot resolve it', () => {
  const ws = tempDir('probeG2-ws-');
  const copilotHome = tempDir('probeG2-ch-');
  const outside = tempDir('probeG2-outside-');
  fs.mkdirSync(path.join(outside, 'perf'), { recursive: true });
  fs.writeFileSync(
    path.join(outside, 'perf', 'secret.md'),
    '---\ntitle: "stolen"\n---\n\nOUTSIDE_SECRET_SENTINEL via manifest.\n',
    'utf8'
  );
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

    fs.mkdirSync(path.join(copilotHome, 'knowledge', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(
    path.join(copilotHome, 'knowledge', 'solutions', 'perf', 'legit.md'),
    '---\ntitle: "legit"\n---\n\nlegit content.\n',
    'utf8'
  );

  const result = runIndexKnowledge({ knowledgeRoot: path.join(copilotHome, 'knowledge'), workspace: ws, copilotHome, flags: {}, log: () => {} });
  const manifestText = fs.readFileSync(result.manifestPath, 'utf8');
  assert.ok(!manifestText.includes('OUTSIDE_SECRET_SENTINEL'), 'the symlinked product docs/solutions never enters the manifest');
  assert.match(manifestText, /legit/, 'the real global entry is still indexed');

    assert.throws(() => runGet({ workspace: ws, copilotHome, flags: { docid: 'product-perf-secret' } }), /docid not found/);
});

test('findMatchingPlans returns nothing through a symlinked docs/plans directory, and still ranks real plans normally', () => {
  const ws = tempDir('probeG3-ws-');
  const outside = tempDir('probeG3-outside-');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'evil.md'), '---\nstatus: open\nplan_lock: false\n---\n\nOUTSIDE_SECRET_SENTINEL plan content.\n', 'utf8');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'plans'));

  const results = findMatchingPlans(ws, 'OUTSIDE_SECRET_SENTINEL plan content', 3);
  assert.deepEqual(results, [], 'a symlinked docs/plans yields zero matches, never the outside content');
});

// title/tags control chars → packet clean -----------------------------------

test('the candidates packet normalizes an episode\'s title and tags — no raw control char survives', () => {
  const ws = tempDir('probeG4-ws-');
  const harnessHome = tempDir('probeG4-hh-');

    const episodeText = '---\ntitle: "injected\x1btitle\x00marker"\ntags: "a,b"\ndate: 2026-01-01\n---\n\nfix body.\n';
  fs.mkdirSync(path.join(ws, 'docs', 'solutions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'solutions', 'perf', 'ctrl-title.md'), episodeText, 'utf8');

  const episodes = collectEpisodes({ workspace: ws, copilotHome: null });
  const raw = episodes.find((e) => e.path.endsWith('ctrl-title.md'));
  assert.ok(raw, 'precondition: the episode is collected');
  assert.ok(raw.title.includes('\x1b') || raw.title.includes('\x00'), 'precondition: the RAW collected title still carries the control chars (collectEpisodes itself does not normalize title)');

  const packet = consolidateCandidates({ workspace: ws, copilotHome: null, home: harnessHome });
  const entry = packet.clusters.flatMap((cl) => cl.episodes).find((e) => e.path.endsWith('ctrl-title.md'));
  assert.ok(entry, 'the episode appears in the packet');
  assert.ok(!entry.title.includes('\x1b'), 'no raw ESC in the packet title');
  assert.ok(!entry.title.includes('\x00'), 'no raw NUL in the packet title');
  assert.ok(entry.tags.every((t) => !/[\x00-\x1f\x7f]/.test(t)), 'no raw control char in any packet tag');
});

test('the candidates packet normalizes a learning\'s multi-line body PER LINE — control chars neutralized, line structure preserved', () => {
  const ws = tempDir('probeG5-ws-');
  const harnessHome = tempDir('probeG5-hh-');

  const epText = 'fix evidence body.\n';
  const epFull = path.join(ws, 'docs', 'solutions', 'perf', 'seed.md');
  fs.mkdirSync(path.dirname(epFull), { recursive: true });
  fs.writeFileSync(epFull, epText, 'utf8');
  const sha256 = crypto.createHash('sha256').update(epText).digest('hex');
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'body-normalize',
    trigger: 'a normal trigger for body normalization',
    body: 'placeholder body',
    episodes: [{ path: 'docs/solutions/perf/seed.md', sha256, kind: 'fix', plan: null }],
  };
  const res = applyOps({ workspace: ws, opsPath: writeOps(ws, [op]), home: harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res));

    const dir = storeDir(ws, { home: harnessHome });
  const learning = listLearnings(dir).find((l) => l.id === 'sql/body-normalize');
  const poisonedBody = 'line one\x00NUL_MARKER\nline two\x1bESC_MARKER';
  fs.writeFileSync(learning.file, serializeLearning(learning.fm, poisonedBody), 'utf8');

  const packet = consolidateCandidates({ workspace: ws, copilotHome: null, home: harnessHome });
  const row = packet.learnings.find((l) => l.id === 'sql/body-normalize');
  assert.ok(row, 'the learning appears in the packet');
  assert.ok(row.body, 'body is included (under the byte budget)');
  assert.ok(!row.body.includes('\x00'), 'no raw NUL in the packet body');
  assert.ok(!row.body.includes('\x1b'), 'no raw ESC in the packet body');
  assert.equal(row.body.split('\n').length, 2, 'the multi-line body structure survives — inertLine ran per-line, not on the whole string');
});

// Proactive sweep fixes: sync.mjs / evidence.mjs -----------------------------

test('sync.mjs resolveContainedPath refuses a symlinked ancestor under copilotHome', () => {
  const home = tempDir('sync-home-');
  const outside = tempDir('sync-outside-');
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.symlinkSync(outside, path.join(home, 'skills', 'evil'));
  assert.equal(resolveContainedPath(home, 'skills/evil/x.md'), null);

  fs.mkdirSync(path.join(home, 'skills', 'real'), { recursive: true });
  assert.equal(resolveContainedPath(home, 'skills/real'), path.join(home, 'skills', 'real'));
});
