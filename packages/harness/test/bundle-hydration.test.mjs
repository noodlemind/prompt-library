import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { approvedBundleNames, placedFiles, readPlacements, syncBundles } from '../lib/bundle-sync.mjs';
import { localPrimitiveStatus } from '../lib/local-primitives.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function harness(args, home) {
  return spawnSync(process.execPath, [binPath, ...args, '--copilot-home', home, '--no-events'], {
    cwd: packageRoot, encoding: 'utf8',
  });
}

function installedHome() {
  const home = tempDir('bh-home-');
  assert.equal(harness(['install'], home).status, EXIT.ok);
  return home;
}

/** A bundle directory on disk, ready to be added. */
function bundleDir(name, { contributes = { skills: ['team-tool/SKILL.md'] }, files = null, version = '1.0.0', priority } = {}) {
  const dir = path.join(tempDir('bh-src-'), name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`schema: 1`, `name: ${name}`, `version: ${version}`];
  if (priority !== undefined) lines.push(`priority: ${priority}`);
  lines.push('contributes:');
  for (const [kind, list] of Object.entries(contributes)) lines.push(`  ${kind}: ${JSON.stringify(list)}`);
  fs.writeFileSync(path.join(dir, 'harness-resource.yaml'), `${lines.join('\n')}\n`);
  const contents = files || Object.fromEntries(
    Object.entries(contributes).flatMap(([kind, list]) => list.map((rel) => [`${kind}/${rel}`, `---\nname: ${path.basename(path.dirname(rel)) || 'x'}\n---\n# from ${name}\n`])),
  );
  for (const [rel, body] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function approve(home, name) {
  fs.writeFileSync(path.join(home, 'resources', name, '.enabled'), 'x');
}

test('P5AC1: an approved bundle’s contribution lands in the Copilot home on upgrade', () => {
  const home = installedHome();
  harness(['resources', 'add', bundleDir('demo')], home);
  approve(home, 'demo');
  assert.equal(harness(['upgrade'], home).status, EXIT.ok);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'team-tool', 'SKILL.md')), true,
    'a bundle whose contributions never arrive is a governance layer governing nothing');
});

test('P5AC1: an UNapproved bundle contributes nothing, however many upgrades run', () => {
  const home = installedHome();
  harness(['resources', 'add', bundleDir('demo')], home);
  harness(['upgrade'], home);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'team-tool', 'SKILL.md')), false);
  assert.deepEqual([...approvedBundleNames(home)], []);
});

/** The half a parallel pipeline always gets wrong. */
test('P5AC1: removing a bundle withdraws exactly what it placed', () => {
  const home = installedHome();
  harness(['resources', 'add', bundleDir('demo')], home);
  approve(home, 'demo');
  harness(['upgrade'], home);
  const placed = path.join(home, 'skills', 'team-tool', 'SKILL.md');
  assert.equal(fs.existsSync(placed), true);

  assert.equal(harness(['resources', 'remove', 'demo'], home).status, EXIT.ok);
  assert.equal(fs.existsSync(placed), false, 'retirement is the half nobody notices until a file that should have vanished is still loading');
  assert.deepEqual([...placedFiles(home)], []);
});

test('P5AC1: disabling a bundle withdraws its files without deleting the bundle', () => {
  const home = installedHome();
  harness(['resources', 'add', bundleDir('demo')], home);
  approve(home, 'demo');
  harness(['upgrade'], home);
  fs.rmSync(path.join(home, 'resources', 'demo', '.enabled'));
  harness(['upgrade'], home);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'team-tool', 'SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(home, 'resources', 'demo', 'harness-resource.yaml')), true,
    'withdrawing contributions is not the same as uninstalling');
});

test('P5AC1: a bundle may not replace a path the package ships', () => {
  const home = installedHome();
  harness(['resources', 'add', bundleDir('overreach', { contributes: { skills: ['engineer/SKILL.md'] } })], home);
  approve(home, 'overreach');
  const result = syncBundles({
    copilotHome: home,
    shippedFiles: new Set(['skills/engineer/SKILL.md']),
    trustedNames: approvedBundleNames(home),
  });
  assert.deepEqual(result.placed, []);
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].reason, /the harness ships this path/);
});

test('P5AC2: when two bundles contribute the same path, priority decides and the loser is reported', () => {
  const home = installedHome();
  harness(['resources', 'add', bundleDir('alpha')], home);
  harness(['resources', 'add', bundleDir('bravo', { priority: 10 })], home);
  approve(home, 'alpha');
  approve(home, 'bravo');
  const result = syncBundles({ copilotHome: home, trustedNames: approvedBundleNames(home) });
  assert.deepEqual(result.placed.map((p) => p.bundle), ['bravo']);
  assert.deepEqual(result.shadowed.map((s) => s.bundle), ['alpha'],
    'the useful question is not what won but why mine did not');
  assert.match(fs.readFileSync(path.join(home, 'skills', 'team-tool', 'SKILL.md'), 'utf8'), /from bravo/);
});

test('a contribution the manifest declares but the bundle does not contain is refused, not silently skipped', () => {
  const home = installedHome();
  harness(['resources', 'add', bundleDir('liar', { contributes: { skills: ['ghost/SKILL.md'] }, files: {} })], home);
  approve(home, 'liar');
  const result = syncBundles({ copilotHome: home, trustedNames: approvedBundleNames(home) });
  assert.equal(result.placed.length, 0);
  assert.match(result.refused[0].reason, /declared but missing from the bundle/);
});

test('adding a bundle never carries its own approval across', () => {
  const home = installedHome();
  const src = bundleDir('presumptuous');
  fs.writeFileSync(path.join(src, '.enabled'), 'x'); // the bundle tries to arrive approved
  harness(['resources', 'add', src], home);
  assert.deepEqual([...approvedBundleNames(home)], [],
    'installing something and approving it must not be the same act');
});

test('a bundle-placed file is not mistaken for a hand-added one', () => {
  const home = installedHome();
  harness(['resources', 'add', bundleDir('demo')], home);
  approve(home, 'demo');
  harness(['upgrade'], home);
  const listed = JSON.parse(harness(['resources', 'list', '--json'], home).stdout);
  assert.equal(listed.primitives.length, 0,
    'asking an operator to register something a bundle already accounts for is asking twice');
  assert.equal(readPlacements(home).bundles.demo.files.length, 1);
});

test('an invalid bundle is refused at add time rather than failing later', () => {
  const home = installedHome();
  const src = bundleDir('bad');
  fs.writeFileSync(path.join(src, 'harness-resource.yaml'), 'schema: 99\nname: bad\nversion: 1.0.0\n');
  const res = harness(['resources', 'add', src], home);
  assert.equal(res.status, EXIT.usage);
  assert.match(res.stdout + res.stderr, /invalid bundle/);
});
