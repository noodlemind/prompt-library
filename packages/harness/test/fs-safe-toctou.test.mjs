import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readFileNoFollow, writeFileContained, assertRealpathContained, realpathParentContained } from '../lib/fs-safe.mjs';

/**
 * Canonicalize-after-acquire: proof that the symlink-ANCESTOR TOCTOU window
 * is closed for reads, writes, and delete/rename targets.
 *
 * The residual this closes: assertNoSymlinkAncestors is a SCAN-TIME ancestor
 * walk, and O_NOFOLLOW guards only the LEAF, so a local attacker could swap an
 * ancestor directory for a symlink pointing outside the root in the window
 * between the walk and the open/write/delete. Node has no portable openat, so
 * the fix VERIFIES AFTER ACQUIRING the handle: realpath (which follows every
 * symlink, including a swapped ancestor) must land inside the canonical root,
 * and the opened inode must match that canonical path.
 *
 * A pre-planted symlinked ancestor is a deterministic stand-in for "the swap
 * already happened": readFileNoFollow performs NO pre-open ancestor walk of
 * its own, so its ONLY ancestor defense is the post-acquire realpath verify —
 * which is exactly why calling it WITHOUT a root is a faithful fail-before
 * that leaks, and WITH a root refuses.
 */

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SENTINEL = 'OUTSIDE_SECRET_SENTINEL must never be read through a swapped ancestor.\n';

test('read: a symlinked ANCESTOR redirecting outside the root refuses the read — and the no-root call is the fail-before that leaks', () => {
  const ws = tmp('toctou-read-ws-');
  const outside = tmp('toctou-read-outside-');
  fs.writeFileSync(path.join(outside, 'x.md'), SENTINEL, 'utf8');
  // docs/solutions is a symlink pointing OUTSIDE the workspace — the ancestor
  // an attacker swaps in. Its leaf (x.md) is a real file, so O_NOFOLLOW's
  // leaf-only guard does NOT catch it; the kernel follows the symlinked
  // ancestor on open.
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));
  const full = path.join(ws, 'docs', 'solutions', 'x.md');

  // FAIL-BEFORE: without a root only the O_NOFOLLOW leaf guard runs; the read
  // follows the symlinked ancestor and the outside content leaks. This is the
  // exact pre-fix behavior the containment verify closes.
  assert.equal(readFileNoFollow(full), SENTINEL, 'no-root read leaks outside content (documents the window)');

  // FAIL-AFTER: with the trusted root, realpath resolves through the symlinked
  // ancestor to OUTSIDE the root → containment fails → null, no leak.
  const refused = readFileNoFollow(full, { root: ws });
  assert.equal(refused, null, 'canonicalize-after-acquire refuses the ancestor-swap read');
});

test('read: a symlinked LEAF pointing outside is refused with or without a root (O_NOFOLLOW leaf guard)', () => {
  const ws = tmp('toctou-leaf-ws-');
  const outside = tmp('toctou-leaf-outside-');
  fs.writeFileSync(path.join(outside, 'secret.md'), SENTINEL, 'utf8');
  fs.mkdirSync(path.join(ws, 'docs', 'solutions'), { recursive: true });
  const full = path.join(ws, 'docs', 'solutions', 'evil.md');
  fs.symlinkSync(path.join(outside, 'secret.md'), full);

  assert.equal(readFileNoFollow(full, { root: ws }), null, 'symlinked leaf refused (with root)');
  assert.equal(readFileNoFollow(full), null, 'symlinked leaf refused (without root — O_NOFOLLOW/lstat leaf guard)');
});

test('read: a legitimately deep all-real path (no symlinks) still reads — no false refusal', () => {
  const ws = tmp('toctou-ok-ws-');
  const rel = path.join('a', 'b', 'c', 'd', 'deep.md');
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'legit deep content\n', 'utf8');
  assert.equal(readFileNoFollow(full, { root: ws }), 'legit deep content\n');
});

test('read: a root reached through a symlink (e.g. symlinked temp dir) still reads its own files — canonical-vs-canonical, no false refusal', () => {
  // Both root and file are resolved with realpath, so a root that is itself
  // legitimately reached through a symlink is contained against its own
  // canonical form rather than rejected.
  const base = tmp('toctou-symroot-');
  const realWs = path.join(base, 'real-ws');
  fs.mkdirSync(realWs, { recursive: true });
  const linkedWs = path.join(base, 'linked-ws');
  fs.symlinkSync(realWs, linkedWs);
  const full = path.join(realWs, 'note.md');
  fs.writeFileSync(full, 'contained via symlinked root\n', 'utf8');
  assert.equal(readFileNoFollow(path.join(linkedWs, 'note.md'), { root: linkedWs }), 'contained via symlinked root\n');
});

test('write: writeFileContained refuses a symlinked ancestor redirecting outside and publishes nothing outside; writes a legit nested path normally', () => {
  const ws = tmp('toctou-write-ws-');
  const outside = tmp('toctou-write-outside-');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const refused = writeFileContained(ws, path.join('docs', 'solutions', 'new.md'), 'WRITE_CONTENT must never publish outside\n');
  assert.equal(refused, null, 'write refused through the symlinked ancestor');
  assert.ok(!fs.existsSync(path.join(outside, 'new.md')), 'no final file published outside');
  assert.equal(
    fs.readdirSync(outside).filter((f) => !f.startsWith('.tmp-')).length,
    0,
    'no published (non-temp) file landed outside'
  );

  // No false refusal on a genuinely contained nested path.
  const ok = writeFileContained(ws, path.join('docs', 'real', 'good.md'), 'good\n');
  assert.equal(ok, path.join(ws, 'docs', 'real', 'good.md'));
  assert.equal(fs.readFileSync(ok, 'utf8'), 'good\n');
});

test('delete/rename guard: assertRealpathContained refuses a symlinked-ancestor target, accepts a real contained target, and refuses a missing one', () => {
  const ws = tmp('toctou-del-ws-');
  const outside = tmp('toctou-del-outside-');
  fs.writeFileSync(path.join(outside, 'x.md'), 'outside survivor\n', 'utf8');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  // Ancestor docs/solutions → outside: the delete target resolves outside → refused.
  assert.equal(assertRealpathContained(ws, path.join('docs', 'solutions', 'x.md')), null);
  assert.ok(fs.existsSync(path.join(outside, 'x.md')), 'nothing was acted on outside');

  // A genuinely contained, existing target is accepted (returns its lexical path).
  const okRel = path.join('docs', 'real', 'y.md');
  const okFull = path.join(ws, okRel);
  fs.mkdirSync(path.dirname(okFull), { recursive: true });
  fs.writeFileSync(okFull, 'inside\n', 'utf8');
  assert.equal(assertRealpathContained(ws, okRel), okFull);

  // A non-existent target has nothing safe to act on → null (realpath refuses).
  assert.equal(assertRealpathContained(ws, path.join('docs', 'real', 'missing.md')), null);
});

test('symmetry: realpathParentContained refuses a file whose parent resolves OUTSIDE the root (the post-create verify reserveEpisodePath and writeFileContained now share), and passes a genuinely contained one', () => {
  const ws = tmp('rpc-ws-');
  const outside = tmp('rpc-outside-');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  // docs/solutions is a symlink OUT of the workspace — the ancestor an attacker
  // swaps in after a scan-time walk. A file created "under" it physically lands
  // in `outside`, so its realpath-parent is outside ws. This is the same
  // deterministic stand-in for "the swap already happened" the read/write tests
  // above use: reserveEpisodePath's O_EXCL create + pre-create walk cannot see
  // it, so the post-create realpath verify is the load-bearing guard.
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));
  const escaped = path.join(ws, 'docs', 'solutions', 'ep.md');
  fs.writeFileSync(escaped, 'landed outside via the symlinked ancestor\n');

  // FAIL-BEFORE (no post-create check): the exclusive create alone accepts this
  // just-created file. PASS-AFTER: the shared containment verify refuses it.
  assert.equal(realpathParentContained(ws, escaped), false, 'a parent resolving outside the root is refused');
  assert.ok(fs.existsSync(path.join(outside, 'ep.md')), 'precondition: the file really did land outside via the symlink');

  const inside = path.join(ws, 'docs', 'real', 'ep.md');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, 'contained\n');
  assert.equal(realpathParentContained(ws, inside), true, 'a genuinely contained parent passes — no false refusal');
});

test('Windows posture: O_NOFOLLOW is feature-detected — POSIX takes the atomic leaf-open branch, win32 falls back to lstat+realpath+inode (inspection-verified only)', () => {
  // On this CI host (darwin/linux) O_NOFOLLOW is a real flag, so the atomic
  // leaf-open branch is exercised by every read test above. On win32 the flag
  // is undefined and readFileNoFollow selects the lstat-leaf + realpath
  // containment fallback, which shares the SAME containment guard; that branch
  // is inspection-verified only (no Windows runner here).
  if (process.platform === 'win32') {
    assert.equal(fs.constants.O_NOFOLLOW, undefined, 'win32 exposes no O_NOFOLLOW → fallback branch is active');
  } else {
    assert.equal(typeof fs.constants.O_NOFOLLOW, 'number', 'POSIX exposes O_NOFOLLOW → atomic branch is active');
  }
});
