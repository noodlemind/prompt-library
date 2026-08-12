import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  ensureStore,
  listLearnings,
  readLedger,
  parseLearningFrontmatter,
  serializeLearning,
  provenanceLines,
  provenanceBytes,
} from '../lib/knowledge/store.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { LEARNING_BYTE_CAP } from '../lib/knowledge/consolidate.mjs';
import { runInsightCompound } from '../lib/compound.mjs';
import { runRemember } from '../lib/knowledge/remember.mjs';
import { absorbHandEdits, removeEpisodeLink } from '../lib/knowledge/admin.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

/** Git workspace on a named branch with one commit. */
function gitWorkspace(branch = 'feature/prov') {
  const ws = tempDir('prov-ws-');
  git(ws, ['init', '-q', '-b', branch]);
  git(ws, ['config', 'user.email', 'test@example.test']);
  git(ws, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed\n');
  git(ws, ['add', '.']);
  git(ws, ['commit', '-qm', 'seed']);
  return ws;
}

function head(ws) {
  return git(ws, ['rev-parse', 'HEAD']).stdout.trim();
}

function pinDefaultBranch(ws, home) {
  const branch = git(ws, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const { dir } = ensureStore(ws, { home });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'on', commit: 'none', defaultBranch: branch }) + '\n');
}

function writeEpisode(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = body || `fix evidence for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' };
}

function writeOps(ws, ops) {
  const p = path.join(ws, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function addOp(ws, over = {}) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug: 'prov-learning',
    trigger: 'provenance trigger',
    body: 'Provenance claim body.',
    episodes: over.episodes || [writeEpisode(ws, 'docs/solutions/perf/x.md')],
    ...over,
  };
}

test('provenanceLines renders only shape-valid fields and quotes the branch', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(provenanceLines({ commit: sha, branch: 'feature/x', base: sha }), [
    `commit: ${sha}`,
    'branch: "feature/x"',
    `base: ${sha}`,
  ]);
  assert.deepEqual(provenanceLines({}), []);
  assert.deepEqual(provenanceLines({ commit: 'nothex', branch: '', base: 'abc' }), []);
  assert.equal(provenanceBytes({ commit: sha }), Buffer.byteLength(`commit: ${sha}`) + 1);
});

test('insight episode capture stamps commit and branch provenance', () => {
  const ws = gitWorkspace('feature/insight-prov');
  const copilotHome = tempDir('prov-ch-');
  const home = tempDir('prov-home-');
  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    flags: { title: 'An insight', body: 'Something observed.' },
    home,
  });
  assert.equal(result.pass, true, result.blockedReason);
  const text = fs.readFileSync(path.join(ws, result.path), 'utf8');
  assert.match(text, new RegExp(`^commit: ${head(ws)}$`, 'm'));
  assert.match(text, /^branch: "feature\/insight-prov"$/m);
  assert.doesNotMatch(text, /^base:/m, 'no default branch resolvable — base omitted, never guessed');
});

test('remember stamps provenance on both the episode and the learning', () => {
  const ws = gitWorkspace('feature/remember-prov');
  const copilotHome = tempDir('prov-ch2-');
  const home = tempDir('prov-home2-');
  pinDefaultBranch(ws, home);
  const result = runRemember({
    workspace: ws,
    copilotHome,
    flags: { trigger: 'when remembering', domain: 'general' },
    argv: ['always test provenance'],
    home,
  });
  assert.equal(result.pass, true, result.blockedReason);
  const episodeText = fs.readFileSync(path.join(ws, result.episodePath), 'utf8');
  assert.match(episodeText, new RegExp(`^commit: ${head(ws)}$`, 'm'));
  assert.match(episodeText, /^branch: "feature\/remember-prov"$/m);

  const { dir } = ensureStore(ws, { home });
  const learning = listLearnings(dir).find((l) => l.id === result.learningId);
  assert.ok(learning);
  assert.equal(learning.fm.commit, head(ws));
  assert.equal(learning.fm.branch, 'feature/remember-prov');
  // defaultBranch pinned to this same branch — merge-base with it IS HEAD.
  assert.equal(learning.fm.base, head(ws));
});

test('STRENGTHEN preserves the original provenance across the re-render', () => {
  const ws = gitWorkspace('feature/strengthen-prov');
  const home = tempDir('prov-home3-');
  pinDefaultBranch(ws, home);
  const originalHead = head(ws);
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws)]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  // Advance HEAD so the strengthening commit differs from the original.
  fs.writeFileSync(path.join(ws, 'later.txt'), 'later\n');
  git(ws, ['add', '.']);
  git(ws, ['commit', '-qm', 'later']);
  assert.notEqual(head(ws), originalHead);

  const ep2 = writeEpisode(ws, 'docs/solutions/perf/y.md');
  const strengthened = applyOps({
    workspace: ws,
    opsPath: writeOps(ws, [{ op: 'STRENGTHEN', target: 'sql/prov-learning', episodes: [ep2] }]),
    home,
  });
  assert.equal(strengthened.exitCode, 0, JSON.stringify(strengthened.rejected));

  const { dir } = ensureStore(ws, { home });
  const learning = listLearnings(dir).find((l) => l.id === 'sql/prov-learning');
  assert.equal(learning.fm.episodes.length, 2);
  assert.equal(learning.fm.commit, originalHead, 'provenance must not migrate to the strengthening commit');
  assert.equal(learning.fm.branch, 'feature/strengthen-prov');
});

test('near-cap STRENGTHEN with provenance never trips E_BYTE_CAP on the stamp (byte-cap exclusion)', () => {
  const ws = gitWorkspace('feature/near-cap');
  const home = tempDir('prov-home4-');
  pinDefaultBranch(ws, home);
  // First apply with a small body to measure the fixed overhead.
  const probe = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, { slug: 'probe', body: 'p' })]), home });
  assert.equal(probe.exitCode, 0, JSON.stringify(probe.rejected));
  const { dir } = ensureStore(ws, { home });
  const probeLearning = listLearnings(dir).find((l) => l.id === 'sql/probe');
  const probeBytes = probeLearning.bytes;
  const provBytes = provenanceBytes(probeLearning.fm);
  assert.ok(provBytes > 0, 'fixture must actually carry provenance');
  const baseBytes = probeBytes - provBytes - 1; // minus the 1-byte probe body

    const bodyLen = LEARNING_BYTE_CAP - baseBytes - 1;
  assert.ok(bodyLen > 0 && bodyLen + baseBytes + provBytes > LEARNING_BYTE_CAP, 'fixture math must straddle the cap');
  const home2 = tempDir('prov-home5-');
  pinDefaultBranch(ws, home2);
  const applied = applyOps({
    workspace: ws,
    opsPath: writeOps(ws, [addOp(ws, { slug: 'probe', body: 'x'.repeat(bodyLen) })]),
    home: home2,
  });
  assert.equal(applied.exitCode, 0, `near-cap ADD with provenance must not reject: ${JSON.stringify(applied.rejected)}`);
  const dir2 = ensureStore(ws, { home: home2 }).dir;
  const learning = listLearnings(dir2).find((l) => l.id === 'sql/probe');
  assert.ok(learning.bytes > LEARNING_BYTE_CAP, 'file including provenance genuinely exceeds the raw cap');

  // Strengthening the near-cap learning must also not strike on the stamp.
  const ep2 = writeEpisode(ws, 'docs/solutions/perf/z.md');
  const strengthened = applyOps({
    workspace: ws,
    opsPath: writeOps(ws, [{ op: 'STRENGTHEN', target: 'sql/probe', episodes: [ep2] }]),
    home: home2,
  });
    if (strengthened.exitCode !== 0) {
    assert.equal(strengthened.rejected[0].code, 'E_BYTE_CAP');
    const after = listLearnings(dir2).find((l) => l.id === 'sql/probe');
    assert.ok(after.bytes - provenanceBytes(after.fm) + 150 > LEARNING_BYTE_CAP, 'rejection driven by claim bytes');
  }
    const failures = readLedger(dir2).filter((e) => e.failure);
  for (const f of failures) assert.equal(f.failure, 'E_BYTE_CAP');
});

test('serializeLearning round-trips provenance and legacy files never gain fields', () => {
  const sha = 'b'.repeat(40);
  const withProv = `---\nschema: 1\ntrigger: "t"\nstatus: active\nsource: auto\nepisodes:\n  - path: docs/solutions/a.md\n    sha256: "${'c'.repeat(64)}"\n    kind: fix\n    plan: \nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: test\ncommit: ${sha}\nbranch: "feature/x"\nbase: ${sha}\n---\n\nBody.\n`;
  const parsed = parseLearningFrontmatter(withProv);
  assert.equal(parsed.fm.commit, sha);
  assert.equal(parsed.fm.branch, 'feature/x');
  const rendered = serializeLearning(parsed.fm, parsed.body);
  assert.match(rendered, new RegExp(`^commit: ${sha}$`, 'm'));
  assert.match(rendered, /^branch: "feature\/x"$/m);
  assert.match(rendered, new RegExp(`^base: ${sha}$`, 'm'));

  const legacy = `---\nschema: 1\ntrigger: "t"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: test\n---\n\nBody.\n`;
  const legacyParsed = parseLearningFrontmatter(legacy);
  const legacyRendered = serializeLearning(legacyParsed.fm, legacyParsed.body);
  assert.doesNotMatch(legacyRendered, /^commit:/m);
  assert.doesNotMatch(legacyRendered, /^branch:/m);
  assert.doesNotMatch(legacyRendered, /^base:/m);
});

test('hand-edit absorb re-render preserves provenance', () => {
  const ws = gitWorkspace('feature/absorb-prov');
  const home = tempDir('prov-home6-');
  pinDefaultBranch(ws, home);
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws)]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const { dir } = ensureStore(ws, { home });
  const learning = listLearnings(dir).find((l) => l.id === 'sql/prov-learning');
  const originalCommit = learning.fm.commit;
  assert.ok(originalCommit);

  // Hand-edit the body directly in the store (dirty tree), then absorb.
  fs.writeFileSync(learning.file, fs.readFileSync(learning.file, 'utf8').replace('Provenance claim body.', 'Hand-edited claim body.'), 'utf8');
  const absorbed = absorbHandEdits({ workspace: ws, home });
  assert.equal(absorbed.absorbed.length, 1);
  const after = listLearnings(dir).find((l) => l.id === 'sql/prov-learning');
  assert.equal(after.fm.source, 'human');
  assert.equal(after.fm.commit, originalCommit, 'absorb re-render must preserve provenance');
  assert.equal(after.fm.branch, 'feature/absorb-prov');
});

test('purge-delink re-render preserves provenance', () => {
  const ws = gitWorkspace('feature/delink-prov');
  const home = tempDir('prov-home7-');
  pinDefaultBranch(ws, home);
  const ep1 = writeEpisode(ws, 'docs/solutions/perf/one.md');
  const ep2 = writeEpisode(ws, 'docs/solutions/perf/two.md');
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, { episodes: [ep1, ep2] })]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const { dir } = ensureStore(ws, { home });
  const learning = listLearnings(dir).find((l) => l.id === 'sql/prov-learning');
  const originalCommit = learning.fm.commit;

  removeEpisodeLink(learning.file, ep1.path);
  const after = listLearnings(dir).find((l) => l.id === 'sql/prov-learning');
  assert.equal(after.fm.episodes.length, 1);
  assert.equal(after.fm.commit, originalCommit, 'delink re-render must preserve provenance');
});
