/**
 * Bundle placement, withdrawal, integrity, and resources-remove path safety.
 * (Folded from codex-phase5-findings / coderabbit-review-findings.)
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { approvedBundleNames, isContainedPlacement, readPlacements, syncBundles } from '../lib/bundle-sync.mjs';
import { bundleDigest, discoverBundles, resolvePrecedence } from '../lib/resources.mjs';
import { resourcesExitFor } from '../lib/resources-cmd.mjs';
import { packageRoot, binPath, tempDir } from './helpers/index.mjs';

const digestOf = (b) => `sha256-${crypto.createHash('sha256').update(b).digest('hex')}`;

/** A copilot home with one enabled bundle contributing one skill. */
function bundleHome(prefix, { contents = 'bundle bytes\n', rel = 'demo/SKILL.md' } = {}) {
  const home = tempDir(prefix);
  const dir = path.join(home, 'resources', 'demo-bundle');
  fs.mkdirSync(path.join(dir, 'skills', path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', rel), contents);
  fs.writeFileSync(path.join(dir, 'harness-resource.yaml'), YAML.stringify({
    schema: 1, name: 'demo-bundle', version: '1.0.0', contributes: { skills: [rel] },
  }));
  fs.writeFileSync(path.join(dir, '.enabled'), '');
  const sync = (extra = {}) => syncBundles({ copilotHome: home, trustedNames: approvedBundleNames(home), ...extra });
  return { home, dir, sync, target: `skills/${rel}` };
}

// --- placement containment ------------------------------------------------

test('a placement record naming a path outside the home deletes nothing', () => {
  const home = tempDir('bundle-escape-home-');
  const outside = path.join(home, '..', `bundle-victim-${process.pid}.txt`);
  fs.writeFileSync(outside, 'do not delete me');
  try {
    fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
    fs.writeFileSync(path.join(home, 'harness', 'bundles.yaml'), YAML.stringify({
      version: 1,
      bundles: { evil: { version: '1.0.0', files: [`../${path.basename(outside)}`] } },
    }));

    const result = syncBundles({ copilotHome: home });
    assert.equal(result.unreadable, true, 'a record with an escaping path is damaged, not authoritative');
    assert.equal(fs.existsSync(outside), true, 'withdrawal must not remove a file outside ~/.copilot');
    assert.deepEqual(result.withdrawn, []);
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('containment is decided lexically, before anything is opened', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', '', 'a\0b', '..']) {
    assert.equal(isContainedPlacement(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
  for (const good of ['skills/demo/SKILL.md', 'agents/x.agent.md', 'a/b/c.md']) {
    assert.equal(isContainedPlacement(good), true, good);
  }
});

// --- withdrawal ownership -------------------------------------------------

test('a path the harness now ships is never withdrawn as a bundle leftover', () => {
  const { home, dir, sync, target } = bundleHome('bundle-shipped-');
  sync();
  assert.equal(fs.existsSync(path.join(home, target)), true);

  fs.writeFileSync(path.join(home, target), 'package bytes\n');
  const result = sync({ shippedFiles: new Set([target]) });

  assert.equal(fs.readFileSync(path.join(home, target), 'utf8'), 'package bytes\n',
    'the package file must not be deleted by a bundle withdrawal');
  assert.ok(result.retained.some((r) => r.target === target), 'and the operator is told why it stayed');
  assert.equal(result.withdrawn.includes(target), false);
  assert.ok(fs.existsSync(dir));
});

test('a file the operator edited after placement is retained, not deleted', () => {
  const { home, dir, sync, target } = bundleHome('bundle-edited-');
  sync();
  fs.writeFileSync(path.join(home, target), 'my own edits\n');

  fs.rmSync(path.join(dir, '.enabled'));
  const result = sync();

  assert.equal(fs.readFileSync(path.join(home, target), 'utf8'), 'my own edits\n',
    'a path is not ownership — the bytes are');
  assert.ok(result.retained.some((r) => /changed/.test(r.reason)));
});

test('an untouched file the bundle placed is withdrawn on disable', () => {
  const { home, dir, sync, target } = bundleHome('bundle-retire-');
  sync();
  fs.rmSync(path.join(dir, '.enabled'));

  const result = sync();
  assert.equal(fs.existsSync(path.join(home, target)), false, 'retirement must remove untouched placements');
  assert.deepEqual(result.withdrawn, [target]);
});

// --- integrity ------------------------------------------------------------

test('a symlink in a bundle is refused rather than followed at placement', () => {
  const { home, dir, sync, target } = bundleHome('bundle-symlink-');
  const secret = path.join(home, 'secret.txt');
  fs.writeFileSync(secret, 'elsewhere on the filesystem');
  const source = path.join(dir, 'skills', 'demo', 'SKILL.md');
  fs.rmSync(source);
  fs.symlinkSync(secret, source);

  const result = sync();
  assert.equal(fs.existsSync(path.join(home, target)), false, 'must not follow the symlink into placement');
  assert.ok(result.refused.some((r) => /symlink/.test(r.reason)));
});

test('the integrity digest covers a symlink, so repointing it breaks the pin', () => {
  const { dir } = bundleHome('bundle-digest-link-');
  const link = path.join(dir, 'skills', 'demo', 'other.md');
  fs.symlinkSync('/tmp/a', link);
  const before = bundleDigest(dir);
  fs.rmSync(link);
  fs.symlinkSync('/tmp/b', link);
  assert.notEqual(bundleDigest(dir), before,
    'a symlink excluded from the digest is an entry the pin does not authorize');
});

test('the bytes written are the bytes hashed — one read, not two', () => {
  const { home, sync, target } = bundleHome('bundle-digest-match-', { contents: 'reviewed\n' });
  sync();
  const record = readPlacements(home).bundles['demo-bundle'];
  const entry = record.files.find((f) => f.path === target);
  assert.equal(entry.digest, digestOf(fs.readFileSync(path.join(home, target))),
    'the recorded digest must describe what actually landed');
});

test('a deletion that fails is not reported as withdrawn, and keeps its record', () => {
  const { home, dir, sync, target } = bundleHome('bundle-delete-fail-');
  sync();
  fs.rmSync(path.join(dir, '.enabled'));

  const parent = path.dirname(path.join(home, target));
  const mode = fs.statSync(parent).mode;
  fs.chmodSync(parent, 0o500);
  try {
    const result = sync();
    if (!fs.existsSync(path.join(home, target))) return;
    assert.equal(result.withdrawn.includes(target), false,
      'the file is still on disk and the run said it had been withdrawn');
    assert.ok(result.retained.some((r) => r.target === target), 'the operator must learn the file is still there');
    const record = readPlacements(home).bundles['demo-bundle'];
    assert.ok(record?.files?.some((f) => (typeof f === 'string' ? f : f.path) === target),
      'dropping it from the record leaves a stale file nothing claims ownership of');
  } finally {
    fs.chmodSync(parent, mode);
  }
});

// --- resources remove path safety -----------------------------------------

test('resources remove cannot delete anything outside the resources root', async () => {
  const { resolveBundleDir } = await import('../lib/resources-cmd.mjs');
  const home = tempDir('resources-remove-home-');
  fs.mkdirSync(path.join(home, 'resources'), { recursive: true });

  for (const escape of ['../skills', '../../outside', '..', '/etc', 'a/b', './x', '']) {
    assert.throws(
      () => resolveBundleDir(home, escape),
      (e) => e.code === 'E_USAGE',
      `${JSON.stringify(escape)} must not reach a recursive delete`,
    );
  }
  assert.equal(resolveBundleDir(home, 'demo-bundle'), path.join(fs.realpathSync(home), 'resources', 'demo-bundle'));
});

test('the hydrated skills tree survives a hostile bundle name', () => {
  const home = tempDir('resources-hostile-home-');
  fs.mkdirSync(path.join(home, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills', 'my-team-skill'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'my-team-skill', 'SKILL.md'), "our team's skill\n");

  const res = spawnSync(process.execPath, [
    binPath, 'resources', 'remove', '../skills', '--copilot-home', home,
  ], { cwd: packageRoot, encoding: 'utf8' });

  assert.notEqual(res.status, 0, 'escape must not report success');
  assert.equal(fs.existsSync(path.join(home, 'skills', 'my-team-skill', 'SKILL.md')), true,
    'a hydrated skill tree must not be removed by a bundle command');
});

// --- identity and exit codes ----------------------------------------------

test('a refused placement makes add/update/remove exit non-zero', () => {
  assert.equal(resourcesExitFor({ verb: 'add', status: 'ok', sync: { refused: [] } }), 0);
  assert.notEqual(resourcesExitFor({ verb: 'add', status: 'ok', sync: { refused: [{ target: 'skills/x' }] } }), 0,
    'CI must tell "installed" from "installed and silently placed nothing"');
  assert.notEqual(resourcesExitFor({ verb: 'remove', status: 'ok', sync: { refused: [{ target: 'skills/x' }] } }), 0);
});

test('two enabled bundles claiming one manifest name are a reported conflict, not a coin flip', () => {
  const home = tempDir('bundle-dup-home-');
  for (const dirName of ['alpha', 'beta']) {
    const dir = path.join(home, 'resources', dirName);
    fs.mkdirSync(path.join(dir, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'demo', 'SKILL.md'), `from ${dirName}\n`);
    fs.writeFileSync(path.join(dir, 'harness-resource.yaml'),
      'schema: 1\nname: shared-name\nversion: 1.0.0\ncontributes:\n  skills: ["demo/SKILL.md"]\n');
    fs.writeFileSync(path.join(dir, '.enabled'), '');
  }
  const bundles = discoverBundles(home, { trustedNames: new Set(['alpha', 'beta']) });
  assert.equal(bundles.every((b) => b.state === 'conflicted'), true,
    'a winning contribution must not depend on directory order');
  for (const b of bundles) assert.match(b.reason, /also declares the name/);
  assert.deepEqual(resolvePrecedence(bundles), [], 'and nothing is placed while the conflict stands');
});

test('every bundle carries a unique directory id alongside its manifest name', () => {
  const home = tempDir('bundle-id-home-');
  const dir = path.join(home, 'resources', 'my-dir');
  fs.mkdirSync(path.join(dir, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'demo', 'SKILL.md'), 'x\n');
  fs.writeFileSync(path.join(dir, 'harness-resource.yaml'),
    'schema: 1\nname: different-name\nversion: 1.0.0\ncontributes:\n  skills: ["demo/SKILL.md"]\n');
  fs.writeFileSync(path.join(dir, '.enabled'), '');

  const [bundle] = discoverBundles(home, { trustedNames: new Set(['my-dir']) });
  assert.equal(bundle.id, 'my-dir', 'the directory is the unique identity');
  assert.equal(bundle.name, 'different-name', 'the manifest name is what an operator reads');
  assert.equal(resolvePrecedence([bundle])[0].winnerId, 'my-dir', 'and placement resolves against the id');
});
