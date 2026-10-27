import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { publicationTarget } from '../lib/learning-record.mjs';
import {
  ensureStore,
  localIdForAbsolutePath,
  readStoreConfig,
  repoId,
  storeDir,
  storeDirForId,
} from '../lib/knowledge/store.mjs';
import { migrateStrandedStore } from '../lib/knowledge/admin.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function checkout(prefix) {
  const parent = tempDir(prefix);
  const ws = path.join(parent, 'repo');
  fs.mkdirSync(ws);
  assert.equal(git(ws, ['init', '-q']).status, 0);
  git(ws, ['config', 'user.email', 'harness@example.test']);
  git(ws, ['config', 'user.name', 'Harness Test']);
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src', 'app.txt'), 'app\n');
  assert.equal(git(ws, ['add', '.']).status, 0);
  assert.equal(git(ws, ['commit', '-qm', 'baseline']).status, 0);
  return { parent, ws };
}

function stableId(ws) {
  return localIdForAbsolutePath(fs.realpathSync.native(ws));
}

test('one local id covers a subdirectory, a linked worktree, and a symlinked path', () => {
  const c = checkout('stable-id-');
  const root = stableId(c.ws);
  assert.equal(repoId(c.ws), root);
  assert.equal(repoId(path.join(c.ws, 'src')), root);
  const linked = path.join(c.parent, 'linked');
  const added = git(c.ws, ['worktree', 'add', '--detach', linked, 'HEAD']);
  assert.equal(added.status, 0, added.stderr);
  try {
    assert.equal(repoId(linked), root);
    assert.equal(repoId(path.join(linked, 'src')), root);
    const link = path.join(c.parent, 'via-link');
    fs.symlinkSync(c.ws, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(repoId(link), root);
    assert.equal(repoId(path.join(link, 'src')), root);
  } finally {
    git(c.ws, ['worktree', 'remove', '--force', linked]);
  }
  const other = checkout('stable-other-');
  assert.notEqual(repoId(other.ws), root);
});

test('an origin remote keeps one id from a subdirectory and a linked worktree', () => {
  const c = checkout('stable-remote-');
  assert.equal(git(c.ws, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']).status, 0);
  const id = repoId(c.ws);
  const suffix = crypto.createHash('sha256').update('github.com/acme/widgets').digest('hex').slice(0, 8);
  assert.equal(id, `github.com-acme-widgets-${suffix}`);
  const linked = path.join(c.parent, 'linked');
  assert.equal(git(c.ws, ['worktree', 'add', '--detach', linked, 'HEAD']).status, 0);
  try {
    assert.equal(repoId(path.join(c.ws, 'src')), id);
    assert.equal(repoId(linked), id);
    assert.equal(repoId(path.join(linked, 'src')), id);
  } finally {
    git(c.ws, ['worktree', 'remove', '--force', linked]);
  }
});

test('migrate-store merges same-repo stores into the stable id and can be repeated', () => {
  const c = checkout('stable-merge-');
  const home = tempDir('stable-merge-home-');
  const root = stableId(c.ws);
  const sub = path.join(c.ws, 'src');
  const subId = localIdForAbsolutePath(fs.realpathSync.native(sub));
  const linked = path.join(c.parent, 'linked');
  assert.equal(git(c.ws, ['worktree', 'add', '--detach', linked, 'HEAD']).status, 0);
  const linkedId = localIdForAbsolutePath(fs.realpathSync.native(linked));
  assert.notEqual(subId, root);
  assert.notEqual(linkedId, root);

  const learning = '---\nschema: 1\ntrigger: kept\nstatus: active\nsource: auto\nepisodes: []\nanchors: []\n---\n\nfrom the worktree id\n';
  const linkedKnowledge = path.join(home, 'knowledge', linkedId);
  const learningFile = path.join(linkedKnowledge, 'learnings', 'sql', 'kept.md');
  fs.mkdirSync(path.dirname(learningFile), { recursive: true });
  fs.writeFileSync(learningFile, learning);
  fs.writeFileSync(path.join(linkedKnowledge, 'config.json'), '{"mode":"on","commit":"none"}\n');

  const note = 'episode from the subdirectory id\n';
  const subProject = path.join(home, 'projects', subId, 'docs', 'solutions');
  fs.mkdirSync(subProject, { recursive: true });
  fs.writeFileSync(path.join(subProject, 'note.md'), note);
  fs.mkdirSync(path.join(home, 'knowledge', subId, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(home, 'knowledge', subId, 'config.json'), '{"mode":"on","commit":"none"}\n');

  const outsider = path.join(home, 'knowledge', 'local-abcdefabcdef');
  fs.mkdirSync(path.join(outsider, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(path.join(outsider, 'learnings', 'sql', 'other.md'), 'do not import\n');

  try {
    const dry = migrateStrandedStore({ workspace: c.ws, home, dryRun: true });
    assert.equal(dry.pass, true, dry.blockedReason);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.stableId, root);
    assert.equal(dry.repo, fs.realpathSync.native(c.ws));
    const fromIds = new Set(dry.merges.map((row) => row.fromId));
    assert.ok(fromIds.has(subId), [...fromIds].join(','));
    assert.ok(fromIds.has(linkedId), [...fromIds].join(','));
    assert.equal(fromIds.has('local-abcdefabcdef'), false);
    assert.ok(dry.merges.every((row) => row.toId === root));
    assert.equal(fs.existsSync(path.join(home, 'knowledge', root, 'learnings', 'sql', 'kept.md')), false);
    assert.equal(fs.existsSync(path.join(home, 'projects', root, 'docs', 'solutions', 'note.md')), false);
    assert.equal(fs.readFileSync(learningFile, 'utf8'), learning);
    assert.equal(fs.readFileSync(path.join(subProject, 'note.md'), 'utf8'), note);

    const copied = migrateStrandedStore({ workspace: c.ws, home });
    assert.equal(copied.pass, true, copied.blockedReason);
    assert.equal(copied.migrated, true);
    assert.equal(fs.readFileSync(path.join(home, 'knowledge', root, 'learnings', 'sql', 'kept.md'), 'utf8'), learning);
    assert.equal(fs.readFileSync(path.join(home, 'projects', root, 'docs', 'solutions', 'note.md'), 'utf8'), note);
    assert.equal(fs.readFileSync(learningFile, 'utf8'), learning);
    assert.equal(fs.readFileSync(path.join(subProject, 'note.md'), 'utf8'), note);
    assert.equal(fs.readFileSync(path.join(outsider, 'learnings', 'sql', 'other.md'), 'utf8'), 'do not import\n');
    assert.equal(storeDir(path.join(c.ws, 'src'), { home }), path.join(home, 'knowledge', root));

    const again = migrateStrandedStore({ workspace: path.join(linked, 'src'), home });
    assert.equal(again.pass, true, again.blockedReason);
    assert.equal(again.unchanged, true);
    assert.equal(again.stableId, root);
    assert.equal(fs.readFileSync(learningFile, 'utf8'), learning);
  } finally {
    git(c.ws, ['worktree', 'remove', '--force', linked]);
  }
});

test('migrate-store --dry-run --json lists merges and writes nothing', () => {
  const c = checkout('stable-cli-');
  const home = tempDir('stable-cli-home-');
  const subId = localIdForAbsolutePath(fs.realpathSync.native(path.join(c.ws, 'src')));
  const project = path.join(home, 'projects', subId);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'agent-context.md'), 'kept context\n');
  const res = spawnSync(process.execPath, [
    binPath, 'knowledge', 'migrate-store', '--dry-run', '--json',
    '--workspace', c.ws, '--ae-home', home,
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.stableId, stableId(c.ws));
  assert.ok(out.merges.some((row) => row.fromId === subId && row.toId === out.stableId && row.namespace === 'projects'));
  assert.equal(fs.existsSync(path.join(home, 'projects', out.stableId)), false);
  assert.equal(fs.readFileSync(path.join(project, 'agent-context.md'), 'utf8'), 'kept context\n');
});

test('schema 2 and commit none still accept a consolidated learning', () => {
  const c = checkout('stable-write-');
  const home = tempDir('stable-write-home-');
  const copilot = tempDir('stable-write-copilot-');
  const { dir } = ensureStore(c.ws, { home });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).schema, 2);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'on', commit: 'none' }) + '\n');
  assert.equal(readStoreConfig(c.ws, { home }).commit, 'none');
  const branch = git(c.ws, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'on', commit: 'none', defaultBranch: branch }) + '\n');
  const episode = path.join(c.ws, 'docs', 'solutions', 'sql', 'kept.md');
  fs.mkdirSync(path.dirname(episode), { recursive: true });
  const episodeText = 'fix evidence\n';
  fs.writeFileSync(episode, episodeText);
  const ops = path.join(c.ws, 'ops.json');
  fs.writeFileSync(ops, JSON.stringify({
    schema: 1,
    ops: [{
      op: 'ADD', domain: 'sql', slug: 'still-written',
      trigger: 'commit none must not drop the learning',
      body: 'The learning file is written into the knowledge store.',
      episodes: [{ path: 'docs/solutions/sql/kept.md', sha256: crypto.createHash('sha256').update(episodeText).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' }],
    }],
  }));
  const applied = spawnSync(process.execPath, [
    binPath, 'consolidate', '--apply', '--ops', ops, '--json',
    '--workspace', c.ws, '--ae-home', home, '--copilot-home', copilot,
  ], { encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(fs.existsSync(path.join(dir, 'learnings', 'sql', 'still-written.md')), true);
  const episodeTarget = publicationTarget({ workspace: c.ws, home, scope: 'private' });
  assert.equal(episodeTarget.dirRel, 'docs/solutions');
  assert.equal(episodeTarget.base, path.join(home, 'projects', repoId(c.ws)));
  const globalTarget = publicationTarget({ workspace: c.ws, copilotHome: copilot, scope: 'global' });
  assert.equal(globalTarget.base, path.join(copilot, 'knowledge'));
  assert.equal(globalTarget.dirRel, 'solutions');
});
