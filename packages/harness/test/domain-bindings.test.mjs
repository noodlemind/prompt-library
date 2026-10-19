import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { readDomain } from '../lib/domain-contract.mjs';
import { snapshotDomain, domainAuthorityBinding, sharedIntentCheck } from '../lib/domain-bindings.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 4000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'domain-binding-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'harness');
  const root = path.join(dir, 'product');
  fs.mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Domain Binding']);
  git(root, ['config', 'user.email', 'domain@example.invalid']);
  git(root, ['remote', 'add', 'origin', 'https://example.invalid/team/product.git']);
  fs.writeFileSync(path.join(root, 'spec.md'), '# Shared intent\n');
  fs.writeFileSync(path.join(root, 'conventions.md'), '# Shared conventions\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initial product']);
  const config = { domain_version: 2, name: 'catalog', repos: [{ id: 'product', origin: 'https://example.invalid/team/product.git' }], sources: [{ id: 'specs', origin: 'https://example.invalid/team/product.git' }], bindings: { repos: { product: root }, sources: { specs: root } }, shared_specs: [{ source: 'specs', path: 'spec.md' }], shared_conventions: [{ source: 'specs', path: 'conventions.md', authority: 'authoritative' }] };
  const file = path.join(home, 'domains/catalog.yaml');
  const write = (value = config) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, YAML.stringify(value)); };
  const read = () => readDomain('catalog', { home });
  write();
  const binding = snapshotDomain(read());
  const plan = { fm: { plan_schema: 3, domain_binding: binding } };
  const current = (workspace = root) => domainAuthorityBinding(workspace, plan, { home });
  return { dir, root, home, config, file, write, read, binding, plan, current };
}

function replacementCheckout(root, { origin = 'https://example.invalid/team/product.git' } = {}) {
  const displaced = `${root}-displaced`;
  fs.renameSync(root, displaced);
  fs.mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Replacement Checkout']);
  git(root, ['config', 'user.email', 'replacement@example.invalid']);
  if (origin) git(root, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(root, 'spec.md'), '# Shared intent\n');
  fs.writeFileSync(path.join(root, 'conventions.md'), '# Shared conventions\n');
  fs.writeFileSync(path.join(root, 'replacement.txt'), 'Unrelated Git history\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Unrelated replacement']);
  return displaced;
}

test('accepted domain authority binds logical membership, canonical identity and shared bytes independently', t => {
  const f = fixture(t);
  assert.equal(f.binding.version, 1);
  assert.match(f.binding.logicalDigest, /^[a-f0-9]{64}$/);
  assert.match(f.binding.executionDigest, /^[a-f0-9]{64}$/);
  assert.equal(f.binding.bindings.repos[0].primaryRoot, f.root);
  assert.equal(f.binding.bindings.repos[0].root, f.root);
  assert.equal(f.binding.bindings.repos[0].commonDir, path.join(f.root, '.git'));
  assert.equal(JSON.stringify(f.binding.logical).includes(f.root), false);
  assert.deepEqual(f.binding.sharedSources.map(s => [s.source, s.path, s.authority]), [['specs', 'conventions.md', 'authoritative'], ['specs', 'spec.md', 'spec']]);
  assert.equal(f.current().pass, true);
  assert.equal(sharedIntentCheck(f.root, f.plan, { home: f.home }).pass, true);
  assert.equal(sharedIntentCheck(f.root, { fm: {} }, { home: f.home }).pass, true);
  assert.equal(fs.existsSync(path.join(f.root, '.harness')), false);
});

test('a symlinked child workspace cannot inherit the accepted physical binding', t => {
  const f = fixture(t);
  f.plan.fm.domain_child = { name: f.config.name, repoId: 'product' };
  const alias = path.join(f.dir, 'symlink-product');
  fs.symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.current(alias);
  assert.equal(result.pass, false);
  assert.match(result.diagnostics.join(' '), /workspace.*differs|unsafe|symlink/);
  assert.equal(f.current().pass, true);
});

test('edited or removed shared bytes fail against the accepted snapshot', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'spec.md'), '# Modified intent\n');
  assert.equal(f.current().pass, false);
  assert.match(f.current().diagnostics.join(' '), /shared|changed/i);
  fs.unlinkSync(path.join(f.root, 'spec.md'));
  assert.equal(f.current().pass, false);
});

test('removing a member and its references cannot erase accepted shared obligations', t => {
  const f = fixture(t);
  f.config.sources = [];
  f.config.bindings.sources = {};
  f.config.shared_specs = [];
  f.config.shared_conventions = [];
  f.write();
  const checked = f.current();
  assert.equal(checked.pass, false);
  assert.match(checked.diagnostics.join(' '), /logical|membership|contract/i);
  assert.equal(checked.accepted.sharedSources.length, 2);
});

test('changed source identity and changed machine binding require fresh accepted authority', t => {
  const f = fixture(t);
  git(f.root, ['remote', 'set-url', 'origin', 'https://example.invalid/different.git']);
  assert.equal(f.current().pass, false);
  git(f.root, ['remote', 'set-url', 'origin', f.config.repos[0].origin]);
  const linked = path.join(f.dir, 'linked');
  git(f.root, ['worktree', 'add', '-b', 'feature/domain', linked]);
  f.config.bindings.sources.specs = linked;
  f.write();
  assert.equal(f.current().pass, false);
});

test('only an explicit linked execution override belonging to the accepted primary is allowed', t => {
  const f = fixture(t);
  const linked = path.join(f.dir, 'linked');
  git(f.root, ['worktree', 'add', '-b', 'feature/domain', linked]);
  const overridden = snapshotDomain(f.read(), { executionRoots: { repos: { product: linked } } });
  assert.equal(overridden.logicalDigest, f.binding.logicalDigest);
  assert.notEqual(overridden.executionDigest, f.binding.executionDigest);
  assert.equal(overridden.bindings.repos[0].primaryRoot, f.root);
  assert.equal(overridden.bindings.repos[0].root, linked);
  f.plan.fm.domain_binding = overridden;
  f.plan.fm.domain_child = { repoId: 'product' };
  assert.equal(f.current(linked).pass, true);
  assert.equal(f.current(f.root).pass, false);
  assert.deepEqual(f.read().config.bindings.repos, { product: f.root });
  const clone = path.join(f.dir, 'clone');
  git(f.dir, ['clone', f.root, clone]);
  git(clone, ['remote', 'set-url', 'origin', f.config.repos[0].origin]);
  assert.throws(() => snapshotDomain(f.read(), { executionRoots: { repos: { product: clone } } }), /linked|identity|common/i);
  assert.throws(() => snapshotDomain(f.read(), { executionRoots: { repos: { unknown: linked } } }), /unknown|override/i);
});

test('unavailable identities and symlink/FIFO shared sources reject acceptance without blocking', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'spec.md'));
  fs.symlinkSync(path.join(f.root, 'conventions.md'), path.join(f.root, 'spec.md'));
  assert.throws(() => snapshotDomain(f.read()), /shared|unreadable|unsafe/i);
  fs.unlinkSync(path.join(f.root, 'spec.md'));
  assert.equal(spawnSync('mkfifo', [path.join(f.root, 'spec.md')], { timeout: 4000 }).status, 0);
  assert.throws(() => snapshotDomain(f.read()), /shared|unreadable|unsafe/i);
  fs.unlinkSync(path.join(f.root, 'spec.md'));
  fs.writeFileSync(path.join(f.root, 'spec.md'), '# Restored\n');
  fs.writeFileSync(path.join(f.root, '.git/HEAD'), 'invalid HEAD\n');
  assert.throws(() => snapshotDomain(f.read()), /identity|unavailable|HEAD/i);
});

test('version 1 cannot create executable authority and unapproved local identities cannot substitute for origins', t => {
  const f = fixture(t);
  f.write({ domain_version: 1, name: 'catalog', repos: [{ id: 'product', origin: f.config.repos[0].origin, root: f.root }] });
  assert.throws(() => snapshotDomain(f.read()), /version 2|advisory|execution/i);
  f.write();
  git(f.root, ['remote', 'remove', 'origin']);
  delete f.config.repos[0].origin;
  delete f.config.sources[0].origin;
  f.config.repos[0].local_identity = { id: 'local-product', approved: true };
  f.config.sources[0].local_identity = { id: 'local-product', approved: true };
  f.write();
  assert.equal(snapshotDomain(f.read()).logical.repos[0].local_identity.approved, true);
});

test('forged digests, duplicate accepted bindings and unrelated child execution roots fail closed', t => {
  const f = fixture(t);
  f.plan.fm.domain_binding.logicalDigest = '0'.repeat(64);
  assert.equal(f.current().pass, false);
  f.plan.fm.domain_binding = snapshotDomain(f.read());
  f.plan.fm.domain_binding.bindings.repos.push({ ...f.plan.fm.domain_binding.bindings.repos[0] });
  assert.equal(f.current().pass, false);
  f.plan.fm.domain_binding = snapshotDomain(f.read());
  f.plan.fm.domain_child = { repoId: 'unknown' };
  assert.equal(f.current().pass, false);
});

test('execution overrides require registered linked metadata, not merely a borrowed common directory', t => {
  const f = fixture(t);
  const fake = path.join(f.dir, 'fake');
  const fakeGit = path.join(f.dir, 'fake-git');
  fs.mkdirSync(fake);
  fs.mkdirSync(fakeGit);
  fs.writeFileSync(path.join(fake, '.git'), `gitdir: ${fakeGit}\n`);
  fs.writeFileSync(path.join(fakeGit, 'commondir'), `${path.join(f.root, '.git')}\n`);
  fs.writeFileSync(path.join(fakeGit, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(fakeGit, 'gitdir'), `${path.join(fake, '.git')}\n`);
  fs.copyFileSync(path.join(f.root, '.git/index'), path.join(fakeGit, 'index'));
  assert.equal(fs.realpathSync.native(git(fake, ['rev-parse', '--git-common-dir'])), fs.realpathSync.native(path.join(f.root, '.git')));
  assert.throws(() => snapshotDomain(f.read(), { executionRoots: { repos: { product: fake } } }), /registered|linked|identity/i);
});

test('a child cannot omit its shared binding or select a domain with another name', t => {
  const f = fixture(t);
  assert.equal(domainAuthorityBinding(f.root, { fm: { domain_child: { name: 'catalog', repoId: 'product' } } }, { home: f.home }).pass, false);
  f.plan.fm.domain_child = { name: 'other', repoId: 'product' };
  assert.equal(f.current().pass, false);
});

test('valid member names cannot inherit execution overrides from Object prototypes', t => {
  const f = fixture(t);
  f.config.repos[0].id = 'constructor';
  f.config.bindings.repos = { constructor: f.root };
  f.write();
  const accepted = snapshotDomain(f.read());
  assert.equal(accepted.bindings.repos[0].id, 'constructor');
  assert.equal(accepted.bindings.repos[0].root, f.root);
});

test('ordinary working edits and HEAD progression preserve filesystem execution authority', t => {
  const f = fixture(t);
  const member = f.binding.bindings.repos[0];
  assert.deepEqual(Object.keys(member.filesystemIdentity).sort(), ['commonDir', 'executionRoot', 'gitDir', 'primaryRoot']);
  for (const identity of Object.values(member.filesystemIdentity)) {
    assert.deepEqual(Object.keys(identity).sort(), ['birthtimeNs', 'dev', 'ino']);
    for (const value of Object.values(identity)) assert.match(value, /^[1-9][0-9]{0,19}$/);
  }
  fs.writeFileSync(path.join(f.root, 'implementation.mjs'), 'export const shipped = true;\n');
  assert.equal(f.current().pass, true);
  git(f.root, ['add', 'implementation.mjs']);
  git(f.root, ['commit', '-m', 'Implement accepted work']);
  assert.equal(f.current().pass, true);
  assert.equal(snapshotDomain(f.read()).executionDigest, f.binding.executionDigest);
});

for (const local of [false, true]) {
  test(`a replaced primary checkout cannot inherit accepted ${local ? 'local' : 'origin'} authority`, t => {
    const f = fixture(t);
    if (local) {
      git(f.root, ['remote', 'remove', 'origin']);
      for (const member of [...f.config.repos, ...f.config.sources]) {
        delete member.origin;
        member.local_identity = { id: 'local-product', approved: true };
      }
      f.write();
      f.plan.fm.domain_binding = snapshotDomain(f.read());
    }
    const accepted = f.plan.fm.domain_binding;
    replacementCheckout(f.root, { origin: local ? null : f.config.repos[0].origin });
    const checked = f.current();
    assert.equal(checked.pass, false);
    assert.match(checked.diagnostics.join(' '), /execution|identity|refresh/i);
    assert.notEqual(checked.current.executionDigest, accepted.executionDigest);
  });
}

test('replacing an independent shared source checkout requires refreshed execution authority', t => {
  const f = fixture(t);
  const source = path.join(f.dir, 'specs');
  git(f.dir, ['clone', f.root, source]);
  git(source, ['remote', 'set-url', 'origin', f.config.sources[0].origin]);
  f.config.bindings.sources.specs = source;
  f.write();
  f.plan.fm.domain_binding = snapshotDomain(f.read());
  replacementCheckout(source, { origin: f.config.sources[0].origin });
  assert.equal(f.current().pass, false);
});

test('recreated linked execution directories cannot reuse their registered Git authority', t => {
  const f = fixture(t);
  const linked = path.join(f.dir, 'linked');
  git(f.root, ['worktree', 'add', '-b', 'feature/domain', linked]);
  f.plan.fm.domain_binding = snapshotDomain(f.read(), { executionRoots: { repos: { product: linked } } });
  const displaced = `${linked}-displaced`;
  fs.renameSync(linked, displaced);
  fs.cpSync(displaced, linked, { recursive: true });
  assert.equal(f.current(linked).pass, false);
});

test('recreated Git directories require refreshed authority even when checkout and metadata bytes match', t => {
  const f = fixture(t);
  const gitDir = path.join(f.root, '.git');
  const displaced = path.join(f.dir, 'git-displaced');
  fs.renameSync(gitDir, displaced);
  fs.cpSync(displaced, gitDir, { recursive: true });
  assert.equal(f.current().pass, false);
});

test('two repository IDs cannot own one physical checkout while source overlap remains valid', t => {
  const f = fixture(t);
  f.config.repos.push({ id: 'duplicate', origin: f.config.repos[0].origin });
  f.config.bindings.repos.duplicate = f.root;
  f.write();
  assert.throws(() => snapshotDomain(f.read()), /duplicate|distinct|physical|identity/i);
});

test('distinct linked roots sharing one common Git identity cannot be separate repository members', t => {
  const f = fixture(t);
  const linked = path.join(f.dir, 'linked');
  git(f.root, ['worktree', 'add', '-b', 'feature/domain', linked]);
  f.config.repos.push({ id: 'duplicate', origin: f.config.repos[0].origin });
  f.config.bindings.repos.duplicate = linked;
  f.write();
  assert.throws(() => snapshotDomain(f.read()), /duplicate|distinct|physical|identity/i);
});

test('unavailable stable filesystem identity cannot be accepted as zero', t => {
  const f = fixture(t);
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, options) => {
    const stat = original(file, options);
    return file === f.root && options?.bigint ? new Proxy(stat, { get: (target, key) => key === 'birthtimeNs' ? 0n : typeof target[key] === 'function' ? target[key].bind(target) : target[key] }) : stat;
  });
  assert.throws(() => snapshotDomain(f.read()), /filesystem|identity|unavailable/i);
});

test('accepted filesystem identity rejects missing, malformed, zero and oversized fields', t => {
  const f = fixture(t);
  const accepted = f.plan.fm.domain_binding;
  for (const invalid of [undefined, {}, { dev: '1', ino: '2', birthtimeNs: '0' }, { dev: '1', ino: '2', birthtimeNs: '18446744073709551616' }, { dev: 1, ino: '2', birthtimeNs: '3' }, { dev: '1', ino: '2', birthtimeNs: '3', mtimeNs: '4' }]) {
    f.plan.fm.domain_binding = structuredClone(accepted);
    f.plan.fm.domain_binding.bindings.repos[0].filesystemIdentity = { primaryRoot: invalid, executionRoot: invalid, commonDir: invalid, gitDir: invalid };
    assert.equal(f.current().pass, false);
    assert.match(f.current().diagnostics.join(' '), /filesystem|identity|shape/i);
  }
});
