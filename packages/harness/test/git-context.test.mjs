import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  branchSlug,
  branchKeyFor,
  detachedKeyFor,
  isDetachedKey,
  resolveDefaultBranch,
  deriveGitContext,
} from '../lib/git-context.mjs';
import { storeDir } from '../lib/knowledge/store.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/**
 * Canonicalize a path before comparing it to another spelling of the same
 * directory. `fs.realpathSync` (the JS walker) resolves symlinks — enough for
 * macOS `/var` → `/private/var` — but on Windows it does NOT expand 8.3 short
 * names, so `os.tmpdir()`'s `C:\Users\RUNNER~1\...` and git's
 * `C:\Users\runneradmin\...` stay two spellings of one directory and compare
 * unequal. `fs.realpathSync.native` goes through the OS canonicalizer
 * (GetFinalPathNameByHandle on win32), which expands the short form. Degrades
 * to the JS walker, then to the raw path, so a not-yet-created path never
 * throws out of an assertion.
 */
function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  }
}

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function gitWorkspace({ branch = 'main', commit = true } = {}) {
  const ws = tempDir('gitctx-ws-');
  git(ws, ['init', '-q', '-b', branch]);
  git(ws, ['config', 'user.email', 'test@example.test']);
  git(ws, ['config', 'user.name', 'Test']);
  if (commit) {
    fs.writeFileSync(path.join(ws, 'file.txt'), 'x\n');
    git(ws, ['add', '.']);
    git(ws, ['commit', '-qm', 'init']);
  }
  return ws;
}

function head(ws) {
  return git(ws, ['rev-parse', 'HEAD']).stdout.trim();
}

test('branchKey is <slug>-<8hex of raw name>, deterministic and platform-independent', () => {
  const expectedHash = crypto.createHash('sha256').update('feature/foo').digest('hex').slice(0, 8);
  assert.equal(branchKeyFor('feature/foo'), `feature-foo-${expectedHash}`);
  assert.equal(branchKeyFor('feature/foo'), branchKeyFor('feature/foo'));
});

test('branch slug lowercases, collapses runs, trims, and caps at 64 chars', () => {
  assert.equal(branchSlug('Feature//My_Thing.v2'), 'feature-my_thing.v2');
  assert.equal(branchSlug('--weird--'), 'weird');
  const long = 'users/First.Last/JIRA-1234-' + 'a'.repeat(200);
  const slug = branchSlug(long);
  assert.equal(slug.length, 64);
  assert.match(slug, /^[a-z0-9._-]+$/);
});

test('colliding slugs stay distinct keys via the raw-name hash', () => {
  const a = branchKeyFor('Feature/Foo');
  const b = branchKeyFor('feature/foo');
  assert.equal(a.replace(/-[0-9a-f]{8}$/, ''), b.replace(/-[0-9a-f]{8}$/, ''));
  assert.notEqual(a, b);
  // Two 200-char names sharing a 64-char prefix truncate to the same slug.
  const base = 'release/' + 'x'.repeat(120);
  assert.notEqual(branchKeyFor(`${base}-one`), branchKeyFor(`${base}-two`));
});

test('unicode branch names derive a safe, deterministic, Windows-path-shaped key', () => {
  const key = branchKeyFor('функция/тест');
  assert.match(key, /^branch-[0-9a-f]{8}$/); // fully non-latin slug falls back, hash disambiguates
  assert.equal(key, branchKeyFor('функция/тест'));
  const mixed = branchKeyFor('fix/ünïcode-Ω-path');
  assert.match(mixed, /^[a-z0-9._-]+-[0-9a-f]{8}$/);
  assert.ok(mixed.length <= 64 + 1 + 8, 'key stays within slug cap + hash');
  assert.ok(!/[<>:"/\\|?*\s]/.test(mixed), 'no Windows-reserved path chars in the key');
});

test('200-char branch name yields a bounded key usable as one path segment', () => {
  const name = 'feature/' + 'very-long-segment-'.repeat(12); // > 200 chars
  const key = branchKeyFor(name);
  assert.ok(key.length <= 73, `key too long: ${key.length}`);
  assert.match(key, /^[a-z0-9._-]+-[0-9a-f]{8}$/);
});

test('deriveGitContext reports branch, key, worktree, and head on a normal branch', () => {
  const ws = gitWorkspace({ branch: 'feature/slash-branch' });
  const ctx = deriveGitContext({ workspace: ws });
  assert.equal(ctx.branch, 'feature/slash-branch');
  assert.equal(ctx.branchKey, branchKeyFor('feature/slash-branch'));
  assert.equal(ctx.detached, false);
  assert.equal(ctx.headSha, head(ws));
  assert.equal(realPath(ctx.worktree), realPath(ws));
  assert.equal(ctx.baseSha, null); // no default branch resolvable — never guessed
  // Deterministic across runs.
  assert.deepEqual(deriveGitContext({ workspace: ws }), ctx);
});

test('detached HEAD (and rebase-shaped states) derive detached-<12hex>', () => {
  const ws = gitWorkspace();
  git(ws, ['checkout', '-q', '--detach']);
  const ctx = deriveGitContext({ workspace: ws });
  assert.equal(ctx.branch, null);
  assert.equal(ctx.detached, true);
  assert.equal(ctx.branchKey, detachedKeyFor(head(ws)));
  assert.match(ctx.branchKey, /^detached-[0-9a-f]{12}$/);
  assert.ok(isDetachedKey(ctx.branchKey));
  assert.ok(!isDetachedKey(branchKeyFor('feature/foo')));
});

test('unborn branch (fresh init, no commits) still names the branch, no shas', () => {
  const ws = gitWorkspace({ branch: 'main', commit: false });
  const ctx = deriveGitContext({ workspace: ws });
  assert.equal(ctx.branch, 'main');
  assert.equal(ctx.branchKey, branchKeyFor('main'));
  assert.equal(ctx.headSha, null);
  assert.equal(ctx.baseSha, null);
  assert.equal(ctx.detached, false);
});

test('non-git workspace degrades to all-null context', () => {
  const ws = tempDir('gitctx-plain-');
  assert.deepEqual(deriveGitContext({ workspace: ws }), {
    branch: null,
    branchKey: null,
    worktree: null,
    detached: false,
    headSha: null,
    baseSha: null,
  });
});

test('baseSha is the merge-base with origin/HEAD when resolvable', () => {
  // "Remote" repo with main.
  const origin = gitWorkspace({ branch: 'main' });
  const clone = tempDir('gitctx-clone-');
  git(clone, ['clone', '-q', origin, '.']);
  git(clone, ['config', 'user.email', 'test@example.test']);
  git(clone, ['config', 'user.name', 'Test']);
  const mainTip = head(clone);
  git(clone, ['checkout', '-qb', 'feature/work']);
  fs.writeFileSync(path.join(clone, 'work.txt'), 'w\n');
  git(clone, ['add', '.']);
  git(clone, ['commit', '-qm', 'work']);

  const resolved = resolveDefaultBranch(clone, {});
  assert.deepEqual(resolved, { name: 'main', source: 'origin-head' });
  const ctx = deriveGitContext({ workspace: clone });
  assert.equal(ctx.branch, 'feature/work');
  assert.equal(ctx.baseSha, mainTip);
  assert.notEqual(ctx.headSha, ctx.baseSha);
});

test('store config.json defaultBranch overrides origin/HEAD', () => {
  const origin = gitWorkspace({ branch: 'main' });
  const clone = tempDir('gitctx-clone2-');
  git(clone, ['clone', '-q', origin, '.']);
  git(clone, ['config', 'user.email', 'test@example.test']);
  git(clone, ['config', 'user.name', 'Test']);
  const home = tempDir('gitctx-home-');
  const dir = storeDir(clone, { home });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'on', defaultBranch: 'trunk' }) + '\n');
  assert.deepEqual(resolveDefaultBranch(clone, { home }), { name: 'trunk', source: 'config' });
  // trunk does not exist as a ref — baseSha stays null rather than guessing.
  const ctx = deriveGitContext({ workspace: clone, home });
  assert.equal(ctx.baseSha, null);
});
