import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { findStaleOrphans } from '../lib/sync.mjs';
import {
  discardPrimitive,
  localPrimitiveStatus,
  registerPrimitive,
  registeredPath,
  unregisterPrimitive,
  validatePrimitive,
} from '../lib/local-primitives.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function harness(args, home) {
  return spawnSync(process.execPath, [binPath, ...args, '--copilot-home', home, '--no-events'], {
    cwd: packageRoot, encoding: 'utf8',
  });
}

/** A home with the package hydrated, so the lock reflects reality. */
function installedHome() {
  const home = tempDir('lp-home-');
  const res = harness(['install'], home);
  assert.equal(res.status, EXIT.ok, res.stderr);
  return home;
}

function addSkill(home, name, body = `---\nname: ${name}\n---\n# added by hand\n`) {
  const dir = path.join(home, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return `skills/${name}/SKILL.md`;
}

function addAgent(home, name, body = `---\nname: ${name}\n---\n# added by hand\n`) {
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', `${name}.agent.md`), body);
  return `agents/${name}.agent.md`;
}

// --- the dangerous defect -------------------------------------------------

test('doctor no longer calls a hand-added primitive a stale orphan', () => {
  const home = installedHome();
  addSkill(home, 'my-team-skill');
  addAgent(home, 'my-team-agent');

  const res = harness(['doctor', '--json'], home);
  const report = JSON.parse(res.stdout);
  const h17 = report.checks.find((c) => c.id === 'H17');
  assert.ok(h17, 'H17 must still exist — real orphans are still worth finding');
  assert.equal(h17.pass, true,
    'a file the harness never hydrated is not a leftover; telling someone to retire it would delete their own work');
});

test('a genuine orphan — hydrated once, no longer shipped — is still reported', () => {
  const home = tempDir('lp-orphan-');
  const assets = tempDir('lp-assets-');
  for (const dir of ['skills', 'agents', 'instructions', 'hooks', 'knowledge', 'enterprise']) {
    fs.mkdirSync(path.join(assets, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(home, 'skills', 'gone'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'gone', 'SKILL.md'), 'x');

  // In the lock (the harness put it there) but no longer shipped → orphan.
  assert.deepEqual(
    findStaleOrphans(home, assets, [], new Set(['skills/gone/SKILL.md'])),
    ['skills/gone/SKILL.md'],
  );
  // Never in the lock → someone added it → not an orphan.
  assert.deepEqual(findStaleOrphans(home, assets, [], new Set()), []);
});

// --- validation (a malformed primitive must fail loudly) -------------------

test('validation catches the ways a primitive silently never loads', () => {
  const home = tempDir('lp-valid-');
  const cases = [
    ['no-frontmatter', '# just a heading\n', /no YAML frontmatter/],
    ['bad-yaml', '---\nname: [unclosed\n---\n', /not valid YAML/],
    ['no-name', '---\ndescription: x\n---\n', /needs a name/],
    ['mismatched', '---\nname: something-else\n---\n', /does not match its path/],
  ];
  for (const [name, body, expected] of cases) {
    const rel = addSkill(home, name, body);
    const result = validatePrimitive(home, rel);
    assert.equal(result.valid, false, `${name} must be invalid`);
    assert.match(result.errors.join(' '), expected);
  }
  const good = addSkill(home, 'well-formed');
  assert.equal(validatePrimitive(home, good).valid, true);
});

test('a primitive in the wrong shape is refused — the host would never find it', () => {
  const home = tempDir('lp-shape-');
  fs.mkdirSync(path.join(home, 'skills', 'loose'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'loose', 'notes.md'), '---\nname: loose\n---\n');
  const result = validatePrimitive(home, 'skills/loose/notes.md');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /must be skills\/<name>\/SKILL\.md/);
});

// --- registration ----------------------------------------------------------

test('registration is validated first, and refuses a primitive that would never load', () => {
  const home = installedHome();
  addSkill(home, 'broken', '# no frontmatter\n');
  const res = harness(['resources', 'register', 'broken'], home);
  assert.equal(res.status, EXIT.usage);
  assert.match(res.stdout + res.stderr, /refusing to register an invalid primitive/);
  assert.match(res.stdout + res.stderr, /no YAML frontmatter/,
    'the reason must be the real one, not a misleading not-found');
});

test('register moves a primitive from pending to registered, and unregister does not delete it', () => {
  const home = installedHome();
  const rel = addSkill(home, 'keeper');
  const shipped = new Set();
  const lock = new Set();

  assert.equal(localPrimitiveStatus({ copilotHome: home, shippedFiles: shipped, lockFiles: lock })
    .find((p) => p.path === rel).state, 'pending');

  registerPrimitive({ copilotHome: home, rel, shippedFiles: shipped, lockFiles: lock });
  assert.equal(localPrimitiveStatus({ copilotHome: home, shippedFiles: shipped, lockFiles: lock })
    .find((p) => p.path === rel).state, 'registered');

  unregisterPrimitive({ copilotHome: home, rel });
  assert.equal(fs.existsSync(path.join(home, rel)), true,
    'withdrawing recognition must not delete someone’s work — that is a much larger action than they asked for');
  assert.equal(localPrimitiveStatus({ copilotHome: home, shippedFiles: shipped, lockFiles: lock })
    .find((p) => p.path === rel).state, 'pending');
});

test('editing a registered primitive makes it stale rather than silently still registered', () => {
  const home = installedHome();
  const rel = addSkill(home, 'edited');
  registerPrimitive({ copilotHome: home, rel });
  fs.writeFileSync(path.join(home, rel), '---\nname: edited\n---\n# changed after approval\n');
  const status = localPrimitiveStatus({ copilotHome: home }).find((p) => p.path === rel);
  assert.equal(status.state, 'stale');
  assert.match(status.reason, /changed since it was registered/);
});

test('a primitive cannot register itself', () => {
  const home = installedHome();
  const rel = addSkill(home, 'self-signing', '---\nname: self-signing\nregistered: true\ntrusted: true\n---\n');
  // Frontmatter claiming registration changes nothing…
  assert.equal(localPrimitiveStatus({ copilotHome: home }).find((p) => p.path === rel).state, 'pending');
  // …and the store the harness reads is outside the primitive entirely.
  assert.ok(registeredPath(home).startsWith(home));
  assert.equal(registeredPath(home).includes('skills'), false);
});

test('a damaged registration store denies rather than being overwritten', () => {
  const home = installedHome();
  const rel = addSkill(home, 'victim');
  registerPrimitive({ copilotHome: home, rel });
  fs.writeFileSync(registeredPath(home), 'primitives: [this is not a mapping\n');
  assert.equal(localPrimitiveStatus({ copilotHome: home }).find((p) => p.path === rel).state, 'pending');
  assert.throws(() => registerPrimitive({ copilotHome: home, rel }), (e) => e.code === 'E_TARGET',
    'overwriting it would discard every registration it holds');
});

// --- the lifecycle guarantees the workflow depends on ----------------------

test('a hand-added primitive survives upgrade', () => {
  const home = installedHome();
  const skill = addSkill(home, 'survivor-skill');
  const agent = addAgent(home, 'survivor-agent');
  assert.equal(harness(['upgrade'], home).status, EXIT.ok);
  assert.equal(fs.existsSync(path.join(home, skill)), true);
  assert.equal(fs.existsSync(path.join(home, agent)), true);
});

test('a hand-added primitive survives uninstall', () => {
  const home = installedHome();
  const skill = addSkill(home, 'persist-skill');
  const agent = addAgent(home, 'persist-agent');
  harness(['uninstall'], home);
  assert.equal(fs.existsSync(path.join(home, skill)), true,
    'uninstall removes what the harness installed, never what someone added');
  assert.equal(fs.existsSync(path.join(home, agent)), true);
});

test('resources list exits non-zero when something added will never load', () => {
  const home = installedHome();
  addSkill(home, 'fine');
  assert.equal(harness(['resources', 'list'], home).status, EXIT.ok);
  addSkill(home, 'broken', '# no frontmatter\n');
  const res = harness(['resources', 'list'], home);
  assert.equal(res.status, 1, 'an invalid primitive is a real problem someone should be told about');
  assert.match(res.stdout, /invalid/);
});

test('a companion file under a skill is stray, not invalid, and list still succeeds', () => {
  const home = installedHome();
  addSkill(home, 'fine');
  fs.writeFileSync(path.join(home, 'skills', 'fine', 'notes.md'), 'leftover\n');
  const res = harness(['resources', 'list', '--json'], home);
  assert.equal(res.status, EXIT.ok, res.stderr);
  const listed = JSON.parse(res.stdout);
  const stray = listed.primitives.find((p) => p.path === 'skills/fine/notes.md');
  assert.equal(stray?.state, 'stray');
  assert.equal(listed.counts.invalid, 0);
  assert.equal(listed.counts.stray, 1);
});

test('resources discard deletes a stray or invalid local file, including an empty skill dir', () => {
  const home = installedHome();
  addSkill(home, 'broken', '# no frontmatter\n');
  fs.writeFileSync(path.join(home, 'skills', 'broken', 'notes.md'), 'leftover\n');
  const discarded = harness(['resources', 'discard', 'notes.md'], home);
  assert.equal(discarded.status, EXIT.ok, discarded.stderr + discarded.stdout);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'broken', 'notes.md')), false);

  const gone = harness(['resources', 'discard', 'broken'], home);
  assert.equal(gone.status, EXIT.ok, gone.stderr + gone.stdout);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'broken')), false);
});

test('resources discard refuses harness-owned files and unregister of an invalid file points at discard', () => {
  const home = installedHome();
  addSkill(home, 'broken', '# no frontmatter\n');
  const unreg = harness(['resources', 'unregister', 'broken'], home);
  assert.notEqual(unreg.status, EXIT.ok);
  assert.match(unreg.stdout + unreg.stderr, /resources discard/);

  const remove = harness(['resources', 'remove', 'skills/broken/SKILL.md'], home);
  assert.notEqual(remove.status, EXIT.ok);
  assert.match(remove.stdout + remove.stderr, /resources discard/);

  const shipped = JSON.parse(harness(['resources', 'list', '--json'], home).stdout);
  assert.equal(shipped.primitives.some((p) => p.path === 'skills/engineer/SKILL.md'), false);
  assert.throws(
    () => discardPrimitive({
      copilotHome: home,
      rel: 'skills/engineer/SKILL.md',
      shippedFiles: new Set(['skills/engineer/SKILL.md']),
      lockFiles: new Set(['skills/engineer/SKILL.md']),
    }),
    (error) => error.code === 'E_TARGET',
  );
});

test('discard of a registered primitive unregisters it and deletes the file', () => {
  const home = installedHome();
  const rel = addSkill(home, 'keeper');
  registerPrimitive({ copilotHome: home, rel });
  const res = harness(['resources', 'discard', 'keeper'], home);
  assert.equal(res.status, EXIT.ok, res.stderr + res.stdout);
  assert.equal(fs.existsSync(path.join(home, rel)), false);
  assert.equal(localPrimitiveStatus({ copilotHome: home }).some((p) => p.path === rel), false);
});

test('shipped primitives are never listed as locally added', () => {
  const home = installedHome();
  const listed = JSON.parse(harness(['resources', 'list', '--json'], home).stdout);
  assert.equal(listed.primitives.length, 0,
    'a fresh install has added nothing by hand, so the list is empty rather than 500 shipped files');
});

// --- folded from review souvenirs -----------------------------------------

test('registration pins the digest of the bytes that were validated', async () => {
  const { readPrimitiveOnce, validatePrimitive } = await import('../lib/local-primitives.mjs');
  const home = tempDir('prim-digest-');
  const rel = 'skills/demo/SKILL.md';
  fs.mkdirSync(path.join(home, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(home, rel), '---\nname: demo\ndescription: a demo\n---\n\nbody\n');

  const snapshot = readPrimitiveOnce(home, rel);
  const validation = validatePrimitive(home, rel, snapshot);
  assert.equal(validation.valid, true);
  assert.equal(validation.digest, snapshot.digest,
    'validating one read and hashing another is how content swapped between them gets registered');

  fs.writeFileSync(path.join(home, rel), '---\nname: demo\ndescription: swapped\n---\n\nother\n');
  assert.equal(validatePrimitive(home, rel, snapshot).digest, snapshot.digest);
});

test('a symlinked primitive is refused, not followed', async () => {
  const { readPrimitiveOnce } = await import('../lib/local-primitives.mjs');
  const home = tempDir('prim-symlink-');
  const rel = 'skills/demo/SKILL.md';
  fs.mkdirSync(path.join(home, 'skills', 'demo'), { recursive: true });
  const elsewhere = path.join(home, 'elsewhere.md');
  fs.writeFileSync(elsewhere, '---\nname: demo\ndescription: d\n---\n');
  fs.symlinkSync(elsewhere, path.join(home, rel));
  assert.throws(() => readPrimitiveOnce(home, rel), (e) => /symlink/.test(e.message));
});
