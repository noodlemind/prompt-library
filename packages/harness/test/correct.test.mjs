import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { commitStore, ensureStore, listLearnings, parseLearningFrontmatter, serializeLearning, storeDir } from '../lib/knowledge/store.mjs';
import { applyOps, renderLearning } from '../lib/knowledge/apply.mjs';
import { explainLearnings, rankLearnings } from '../lib/knowledge/retrieve.mjs';
import { buildLearningsLines } from '../lib/context-pack.mjs';
import { buildPromotionOps, PROMOTE_OPS_REL } from '../lib/knowledge/promote.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const ctx = () => {
  const ws = trackWorkspaceSolutions(tempDir('correct-ws-'));
  return { ws, home: tempDir('correct-home-'), harnessHome: tempDir('correct-hh-') };
};

const run = ({ ws, home, harnessHome }, args) =>
  spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });

const CLAIM = 'Wait for the lock before altering a hot table.';
const WHY = 'a direct alter takes an exclusive lock';
const APPLIES = 'a hot table with live traffic';
const DOES_NOT = 'a cold table with no readers';

function enable(c) {
  const res = run(c, ['knowledge', 'on']);
  assert.equal(res.status, 0, res.stderr + res.stdout);
}

function correctArgs({ authority = 'correction', domain = null, omit = null, dryRun = false } = {}) {
  const args = ['correct', CLAIM, '--trigger', 'altering a hot table', '--why', WHY, '--applies', APPLIES];
  if (omit !== 'does-not-apply') args.push('--does-not-apply', DOES_NOT);
  if (domain) args.push('--domain', domain);
  if (authority) args.push('--authority', authority);
  if (dryRun) args.push('--dry-run');
  return args;
}

function learnings(c) {
  return listLearnings(storeDir(c.ws, { home: c.harnessHome }));
}

function assertRecord(text, fm, { authority, status }) {
  assert.equal(fm.authority, authority);
  assert.equal(fm.why, WHY);
  assert.equal(fm.applies, APPLIES);
  assert.equal(fm.does_not_apply, DOES_NOT);
  assert.equal(fm.status, status);
  assert.match(text, new RegExp(`^authority: ${authority}$`, 'm'));
  assert.match(text, new RegExp(`^why: "${WHY}"$`, 'm'));
  assert.match(text, new RegExp(`^applies: "${APPLIES}"$`, 'm'));
  assert.match(text, new RegExp(`^does_not_apply: "${DOES_NOT}"$`, 'm'));
  assert.match(text, new RegExp(`^status: ${status}$`, 'm'));
}

test('remember of the same trigger keeps correction fields the call did not set', () => {
  const c = ctx();
  enable(c);
  const written = run(c, correctArgs({ domain: 'sql' }));
  assert.equal(written.status, 0, written.stderr + written.stdout);
  const id = JSON.parse(written.stdout).learningId;
  const nextClaim = 'Queue the alter behind the existing lock.';
  const remembered = run(c, ['remember', nextClaim, '--trigger', 'altering a hot table', '--domain', 'sql']);
  assert.equal(remembered.status, 0, remembered.stderr + remembered.stdout);
  const learning = learnings(c).find((l) => l.id === id);
  assert.ok(learning, 'superseded learning still exists');
  const text = fs.readFileSync(learning.file, 'utf8');
  assert.match(text, /Queue the alter behind the existing lock/);
  assertRecord(text, learning.fm, { authority: 'correction', status: 'active' });
});

test('correct --authority correction writes an active learning with the four fields', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ authority: 'correction', domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const id = JSON.parse(res.stdout).learningId;
  assert.equal(id, 'sql/altering-a-hot-table');
  const learning = learnings(c).find((l) => l.id === id);
  assert.ok(learning, 'learning file exists');
  const text = fs.readFileSync(learning.file, 'utf8');
  assertRecord(text, learning.fm, { authority: 'correction', status: 'active' });
});

test('correct --authority inference writes status provisional', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ authority: 'inference', domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const learning = learnings(c).find((l) => l.id === JSON.parse(res.stdout).learningId);
  const text = fs.readFileSync(learning.file, 'utf8');
  assertRecord(text, learning.fm, { authority: 'inference', status: 'provisional' });
});

test('correct --authority instruction writes status active', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ authority: 'instruction', domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const learning = learnings(c).find((l) => l.id === JSON.parse(res.stdout).learningId);
  const text = fs.readFileSync(learning.file, 'utf8');
  assertRecord(text, learning.fm, { authority: 'instruction', status: 'active' });
});

test('correct defaults --domain to general', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs());
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(JSON.parse(res.stdout).learningId, 'general/altering-a-hot-table');
});

test('correct without --does-not-apply exits non-zero and writes no learning', () => {
  const c = ctx();
  enable(c);
  const before = learnings(c).length;
  const res = run(c, correctArgs({ omit: 'does-not-apply' }));
  assert.notEqual(res.status, 0, res.stdout);
  assert.equal(learnings(c).length, before);
});

test('correct --authority guess exits non-zero and writes no learning', () => {
  const c = ctx();
  enable(c);
  const before = learnings(c).length;
  const res = run(c, correctArgs({ authority: 'guess' }));
  assert.notEqual(res.status, 0, res.stdout);
  assert.equal(learnings(c).length, before);
});

test('correct --dry-run writes no learning', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ dryRun: true, domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(JSON.parse(res.stdout).dryRun, true);
  assert.equal(learnings(c).length, 0);
});

test('renderLearning and serializeLearning keep the four fields and omit empty ones', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const learning = learnings(c).find((l) => l.id === JSON.parse(res.stdout).learningId);
  const { fm, body } = parseLearningFrontmatter(fs.readFileSync(learning.file, 'utf8'));
  const serialized = serializeLearning(fm, body);
  const rendered = renderLearning({
    trigger: fm.trigger,
    body,
    episodes: fm.episodes,
    origin: fm.origin || 'unknown',
    status: fm.status,
    source: fm.source,
    authority: fm.authority,
    why: fm.why,
    applies: fm.applies,
    does_not_apply: fm.does_not_apply,
  });
  for (const text of [serialized, rendered]) {
    assertRecord(text, parseLearningFrontmatter(text).fm, { authority: 'correction', status: 'active' });
  }
  const bare = serializeLearning(
    { trigger: 't', status: 'active', source: 'human', episodes: [], authority: '', why: '', applies: '', does_not_apply: '' },
    'body',
  );
  assert.doesNotMatch(bare, /^authority:/m);
  assert.doesNotMatch(bare, /^why:/m);
  assert.doesNotMatch(bare, /^applies:/m);
  assert.doesNotMatch(bare, /^does_not_apply:/m);
});

function writeOps(ws, name, ops) {
  const opsPath = path.join(ws, name);
  fs.writeFileSync(opsPath, JSON.stringify({ schema: 1, ops }));
  return opsPath;
}

function episodeFile(ws, rel, kind) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = kind === 'human-teaching'
    ? `---\ntitle: "${rel}"\nkind: human-teaching\ndate: 2026-07-01\n---\n\nhuman teaching for ${rel}.\n`
    : `fix evidence for ${rel}.\n`;
  fs.writeFileSync(full, text);
  return {
    path: rel,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    kind,
    plan: kind === 'human-teaching' ? null : 'docs/plans/p1.md',
  };
}

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function featureWorkspace(branch) {
  const origin = tempDir('correct-origin-');
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 't@example.test']);
  git(origin, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(origin, 'seed.txt'), 'seed\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-qm', 'seed']);
  const ws = tempDir('correct-promo-ws-');
  git(ws, ['clone', '-q', origin, '.']);
  git(ws, ['config', 'user.email', 't@example.test']);
  git(ws, ['config', 'user.name', 'T']);
  git(ws, ['checkout', '-qb', branch]);
  return ws;
}

test('an ops file cannot activate instruction or correction without human-teaching episodes', () => {
  for (const authority of ['instruction', 'correction']) {
    const c = ctx();
    enable(c);
    const episode = episodeFile(c.ws, 'docs/solutions/perf/auto-fix.md', 'fix');
    const applied = applyOps({
      workspace: c.ws,
      opsPath: writeOps(c.ws, 'ops-authority.json', [{
        op: 'ADD',
        domain: 'sql',
        slug: 'forged-correction',
        trigger: 'altering a hot table',
        body: CLAIM,
        authority,
        why: WHY,
        applies: APPLIES,
        does_not_apply: DOES_NOT,
        episodes: [episode],
      }]),
      home: c.harnessHome,
      copilotHome: c.home,
    });
    assert.notEqual(applied.exitCode, 0, authority);
    assert.equal(applied.rejected[0].code, 'E_AUTHORITY', authority);
    assert.equal(learnings(c).length, 0, authority);
  }
});

test('a later fix episode leaves an inference provisional', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ authority: 'inference', domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const id = JSON.parse(res.stdout).learningId;
  const episode = episodeFile(c.ws, 'docs/solutions/perf/later-fix.md', 'fix');
  const applied = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, 'ops-strengthen.json', [{ op: 'STRENGTHEN', target: id, episodes: [episode] }]),
    home: c.harnessHome,
    copilotHome: c.home,
  });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const learning = learnings(c).find((l) => l.id === id);
  assert.equal(learning.fm.authority, 'inference');
  assert.equal(learning.fm.status, 'provisional');
  assert.equal(learning.fm.episodes.length, 2);
});

test('STRENGTHEN rejects a secret in does_not_apply and leaves the learning unchanged', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const id = JSON.parse(res.stdout).learningId;
  const learning = learnings(c).find((l) => l.id === id);
  const before = fs.readFileSync(learning.file, 'utf8');
  const episode = episodeFile(c.ws, 'docs/solutions/perf/secret-strengthen.md', 'fix');
  const applied = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, 'ops-secret-strengthen.json', [{
      op: 'STRENGTHEN',
      target: id,
      does_not_apply: 'AKIAIOSFODNN7EXAMPLE',
      episodes: [episode],
    }]),
    home: c.harnessHome,
    copilotHome: c.home,
  });
  assert.notEqual(applied.exitCode, 0);
  assert.equal(applied.rejected[0].code, 'E_SECRET');
  assert.equal(fs.readFileSync(learning.file, 'utf8'), before);
});

test('correct rejects AKIAIOSFODNN7EXAMPLE in why, applies, and does-not-apply', () => {
  for (const flag of ['--why', '--applies', '--does-not-apply']) {
    const c = ctx();
    enable(c);
    const before = learnings(c).length;
    const args = correctArgs();
    args[args.indexOf(flag) + 1] = 'AKIAIOSFODNN7EXAMPLE';
    const res = run(c, args);
    assert.notEqual(res.status, 0, `${flag}\n${res.stdout}\n${res.stderr}`);
    assert.equal(learnings(c).length, before, flag);
  }
});

test('retrieval drops out-of-scope learnings and shows redacted scope', () => {
  const c = ctx();
  enable(c);
  const res = run(c, correctArgs({ domain: 'sql' }));
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const id = JSON.parse(res.stdout).learningId;
  const excluded = rankLearnings({ workspace: c.ws, query: 'cold table with no readers', home: c.harnessHome });
  assert.ok(!excluded.some((l) => l.id === id));
  const explained = explainLearnings({ workspace: c.ws, query: 'cold table with no readers', home: c.harnessHome });
  assert.equal(explained.candidates.find((cand) => cand.id === id).excluded, 'out-of-scope');

  const equal = episodeFile(c.ws, 'docs/solutions/perf/equal-scope.md', 'fix');
  const equalApplied = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, 'ops-equal.json', [{
      op: 'ADD',
      domain: 'sql',
      slug: 'cache-stampede',
      trigger: 'cache stampede locks',
      body: 'Split the lock before retrying.',
      does_not_apply: 'cache stampede locks',
      episodes: [equal],
    }]),
    home: c.harnessHome,
    copilotHome: c.home,
  });
  assert.equal(equalApplied.exitCode, 0, JSON.stringify(equalApplied.rejected));
  const equalExplain = explainLearnings({ workspace: c.ws, query: 'cache stampede locks', home: c.harnessHome });
  assert.equal(equalExplain.candidates.find((cand) => cand.id === 'sql/cache-stampede').excluded, 'out-of-scope');

  const kept = rankLearnings({ workspace: c.ws, query: 'altering a hot table', home: c.harnessHome });
  const hit = kept.find((l) => l.id === id);
  assert.ok(hit);
  assert.equal(hit.applies, APPLIES);
  assert.equal(hit.does_not_apply, DOES_NOT);
  const lines = buildLearningsLines([hit]).join('\n');
  assert.match(lines, /Retrieved learnings:/);
  assert.doesNotMatch(lines, /Applied learnings/);
  assert.match(lines, new RegExp(`applies ${APPLIES}`));
  assert.match(lines, new RegExp(`does not apply ${DOES_NOT}`));

  const secretLines = buildLearningsLines([{
    id,
    trigger: 'altering a hot table',
    claimLine: CLAIM,
    applies: 'AKIAIOSFODNN7EXAMPLE',
    does_not_apply: DOES_NOT,
  }]).join('\n');
  assert.match(secretLines, /\[redacted: aws-access-key\]/);
  assert.doesNotMatch(secretLines, /AKIAIOSFODNN7EXAMPLE/);
  assert.match(secretLines, /Retrieved learnings:/);
  assert.match(secretLines, /does not apply/);
});

test('a branch correction does_not_apply survives the STRENGTHEN rewrite', () => {
  const ws = featureWorkspace('feature/correct-scope');
  const home = tempDir('correct-promo-home-');
  const { dir } = ensureStore(ws, { home });
  const goldenEp = episodeFile(ws, 'docs/solutions/perf/golden-scope.md', 'fix');
  const trigger = 'altering a hot table';
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'altering-a-hot-table.md'),
    [
      '---',
      'schema: 1',
      `trigger: "${trigger}"`,
      'status: active',
      'source: auto',
      'episodes:',
      `  - path: ${goldenEp.path}`,
      `    sha256: "${goldenEp.sha256}"`,
      '    kind: fix',
      `    plan: ${goldenEp.plan}`,
      'anchors: []',
      'superseded_by: null',
      'last_confirmed: null',
      'origin: t',
      'does_not_apply: "weekends only"',
      '---',
      '',
      CLAIM,
      '',
    ].join('\n'),
  );
  commitStore(dir, 'seed golden twin');
  const branchEp = episodeFile(ws, 'docs/solutions/teachings/branch-scope.md', 'human-teaching');
  const branchDoesNot = 'cold tables during a failover';
  const seeded = applyOps({
    workspace: ws,
    opsPath: writeOps(ws, 'branch-add.json', [{
      op: 'ADD',
      domain: 'sql',
      slug: 'altering-a-hot-table',
      trigger,
      body: CLAIM,
      authority: 'correction',
      why: WHY,
      applies: APPLIES,
      does_not_apply: branchDoesNot,
      episodes: [branchEp],
    }]),
    home,
  });
  assert.equal(seeded.exitCode, 0, JSON.stringify(seeded.rejected));
  assert.equal(seeded.layer, 'branch');
  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  const opset = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.equal(opset.ops[0].op, 'STRENGTHEN');
  assert.equal(opset.ops[0].does_not_apply, branchDoesNot);
  assert.equal(opset.ops[0].authority, 'correction');
  assert.equal(opset.ops[0].why, WHY);
  assert.equal(opset.ops[0].applies, APPLIES);
  const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const golden = listLearnings(dir).find((l) => l.id === 'sql/altering-a-hot-table');
  assert.equal(golden.fm.does_not_apply, branchDoesNot);
  assert.equal(golden.fm.authority, 'correction');
  const text = fs.readFileSync(golden.file, 'utf8');
  assert.match(text, /cold tables during a failover/);
  assert.doesNotMatch(text, /weekends only/);
});
