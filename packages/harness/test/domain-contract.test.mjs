import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { readDomain, inspectDomain } from '../lib/domain-contract.mjs';
import { domainResultOf, cmdDomain, DOMAIN_VERBS } from '../lib/domain-cmd.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 4000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'domain-view-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'harness');
  const root = path.join(dir, 'product');
  fs.mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Domain Test']);
  git(root, ['config', 'user.email', 'domain@example.invalid']);
  git(root, ['remote', 'add', 'origin', 'https://example.invalid/team/product.git']);
  fs.mkdirSync(path.join(root, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/harness/checks.yaml'), 'checks: []\n');
  fs.writeFileSync(path.join(root, 'spec.md'), '# Shared intent\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initial product']);
  const config = { domain_version: 1, name: 'catalog', repos: [{ id: 'product', origin: 'https://example.invalid/team/product.git', root }], shared_specs: [{ repo: 'product', path: 'spec.md' }], shared_conventions: [] };
  const file = path.join(home, 'domains/catalog.yaml');
  const write = (value = config) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : YAML.stringify(value));
  };
  const show = () => inspectDomain(readDomain('catalog', { home }));
  return { dir, home, root, config, file, write, show };
}

test('domain show observes membership, advisory references and Git identity without writes', t => {
  const f = fixture(t);
  f.write();
  const configBytes = fs.readFileSync(f.file);
  const index = fs.readFileSync(path.join(f.root, '.git/index'));
  const before = git(f.root, ['status', '--porcelain=v1']);
  const result = f.show();
  assert.equal(result.status, 'ok');
  assert.equal(result.executionSupported, false);
  assert.equal(result.domainVersion, 1);
  assert.equal(result.configPath, f.file);
  assert.deepEqual(result.sharedSpecs, [{ repo: 'product', path: 'spec.md', authority: 'advisory' }]);
  const repo = result.repos[0];
  assert.equal(repo.id, 'product');
  assert.equal(repo.status, 'available');
  assert.equal(repo.expected.origin, f.config.repos[0].origin);
  assert.equal(repo.observed.origin, repo.expected.origin);
  assert.equal(repo.observed.root, f.root);
  assert.equal(repo.observed.head, git(f.root, ['rev-parse', 'HEAD']));
  assert.equal(repo.observed.commonDir, path.join(f.root, '.git'));
  assert.equal(repo.observed.isLinkedWorktree, false);
  assert.equal(repo.observed.dirty, false);
  assert.equal(repo.checks.present, true);
  assert.equal(fs.existsSync(path.join(f.root, '.harness')), false);
  assert.deepEqual(fs.readFileSync(f.file), configBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
  assert.equal(git(f.root, ['status', '--porcelain=v1']), before);
  assert.deepEqual(fs.readdirSync(f.home), ['domains']);
});

test('show flags and explicit Harness home work outside any product workspace', t => {
  const f = fixture(t);
  f.write();
  const result = domainResultOf(['show', '--name', 'catalog', '--harness-home', f.home, '--workspace', path.join(f.dir, 'does-not-exist'), '--json'], { harnessHome: path.join(f.dir, 'wrong-home') });
  assert.equal(result.name, 'catalog');
  assert.equal(result.configPath, f.file);
  assert.deepEqual(DOMAIN_VERBS, ['show']);
  assert.equal(domainResultOf(['show', '--name=catalog'], { harnessHome: f.home }).configPath, f.file);
});

test('a missing home/config is an error and creates no directories', t => {
  const f = fixture(t);
  assert.throws(() => readDomain('catalog', { home: f.home }), /missing|unreadable/i);
  assert.equal(fs.existsSync(f.home), false);
});

test('missing local repositories remain explicit unavailable observations', t => {
  const f = fixture(t);
  f.config.repos.push({ id: 'consumer', origin: 'https://example.invalid/consumer.git', root: path.join(f.dir, 'missing') });
  f.write();
  const result = f.show();
  assert.equal(result.repos[1].status, 'unavailable');
  assert.equal(result.repos[1].observed.root, null);
  assert.match(result.repos[1].warnings.join(' '), /missing|unavailable/i);
  assert.equal(fs.existsSync(f.config.repos[1].root), false);
});

test('origin drift, dirty state and missing checks are reported separately', t => {
  const f = fixture(t);
  f.write();
  git(f.root, ['remote', 'set-url', 'origin', 'https://example.invalid/new-product.git']);
  fs.unlinkSync(path.join(f.root, '.github/harness/checks.yaml'));
  const result = f.show();
  assert.equal(result.repos[0].status, 'available');
  assert.equal(result.repos[0].expected.origin, f.config.repos[0].origin);
  assert.equal(result.repos[0].observed.origin, 'https://example.invalid/new-product.git');
  assert.equal(result.repos[0].observed.dirty, true);
  assert.equal(result.repos[0].checks.present, false);
  assert.match(result.repos[0].warnings.join(' '), /origin.*differs/i);
  assert.match(result.repos[0].warnings.join(' '), /checks/i);
});

test('linked worktrees report canonical checkout and common repository identity', t => {
  const f = fixture(t);
  const linked = path.join(f.dir, 'linked');
  git(f.root, ['worktree', 'add', '-b', 'feature/domain', linked]);
  f.config.repos[0].root = linked;
  f.write();
  const repo = f.show().repos[0];
  assert.equal(repo.observed.root, linked);
  assert.equal(repo.observed.commonDir, path.join(f.root, '.git'));
  assert.equal(repo.observed.isLinkedWorktree, true);
  assert.equal(repo.observed.branch, 'feature/domain');
  assert.equal(repo.observed.dirty, false);
});

test('a nested directory and a non-Git directory cannot masquerade as the expected checkout', t => {
  const f = fixture(t);
  const nested = path.join(f.root, 'nested');
  fs.mkdirSync(nested);
  f.config.repos[0].root = nested;
  f.write();
  let repo = f.show().repos[0];
  assert.equal(repo.status, 'unavailable');
  assert.match(repo.warnings.join(' '), /checkout root/i);
  const plain = path.join(f.dir, 'plain');
  fs.mkdirSync(plain);
  fs.mkdirSync(path.join(plain, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(plain, '.github/harness/checks.yaml'), 'checks: []\n');
  f.config.repos[0].root = plain;
  f.write();
  repo = f.show().repos[0];
  assert.equal(repo.status, 'unavailable');
  assert.match(repo.warnings.join(' '), /Git|metadata/i);
  assert.equal(repo.checks.present, true);
});

test('Git helpers are disabled and filesystem metadata calls do not refresh the index', t => {
  const f = fixture(t);
  const marker = path.join(f.dir, 'helper-ran');
  const helper = path.join(f.dir, 'helper.sh');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
  git(f.root, ['config', 'core.fsmonitor', helper]);
  git(f.root, ['config', 'filter.fixture.clean', helper]);
  git(f.root, ['config', 'filter.fixture.smudge', helper]);
  git(f.root, ['config', 'filter.fixture.process', helper]);
  git(f.root, ['config', 'filter.fixture.required', 'true']);
  fs.writeFileSync(path.join(f.root, '.gitattributes'), '* filter=fixture\n');
  f.write();
  const index = fs.readFileSync(path.join(f.root, '.git/index'));
  assert.equal(f.show().repos[0].status, 'available');
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
});

test('ambient Git tracing and repository overrides cannot write into or redirect domain observations', t => {
  const f = fixture(t);
  f.write();
  const marker = path.join(f.root, 'git-trace.log');
  const saved = { GIT_TRACE: process.env.GIT_TRACE, GIT_DIR: process.env.GIT_DIR };
  try {
    process.env.GIT_TRACE = marker;
    process.env.GIT_DIR = path.join(f.dir, 'not-a-repo');
    assert.equal(f.show().repos[0].status, 'available');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('malformed Git identity and bounded working-tree status stay explicit', t => {
  const f = fixture(t);
  f.write();
  fs.writeFileSync(path.join(f.root, '.git/HEAD'), 'malformed Git HEAD\n');
  const before = fs.readFileSync(path.join(f.root, '.git/HEAD'));
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'unavailable');
  assert.match(repo.warnings.join(' '), /Git|metadata/i);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/HEAD')), before);
});

test('oversized working-tree metadata is unknown instead of clean', t => {
  const f = fixture(t);
  f.write();
  for (let index = 0; index < 1000; index++) fs.writeFileSync(path.join(f.root, `${String(index).padStart(4, '0')}-${'a'.repeat(70)}`), 'x');
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.dirty, null);
  assert.equal(repo.observed.statusEntries, null);
  assert.match(repo.warnings.join(' '), /status.*bound|status.*unavailable/i);
});

test('display masks embedded remote credentials in JSON and plain output', async t => {
  const f = fixture(t);
  const origin = 'https://remote-user:private-credential@example.invalid/team/product.git';
  f.config.repos[0].origin = origin;
  f.write();
  git(f.root, ['remote', 'set-url', 'origin', origin]);
  const oldLog = console.log;
  for (const extra of [['--json'], []]) {
    const output = [];
    try {
      console.log = line => output.push(String(line));
      assert.equal(await cmdDomain(['show', '--name', 'catalog', '--harness-home', f.home, ...extra]), 0);
    } finally { console.log = oldLog; }
    assert.doesNotMatch(output.join('\n'), /remote-user|private-credential/);
    assert.match(output.join('\n'), /redacted/);
  }
});

test('unsafe and unsupported names fail before reading a config', t => {
  const f = fixture(t);
  for (const name of ['', '../catalog', 'catalog/other', 'Catalog', 'with space', 'a'.repeat(65), '-catalog', 'catalog-', 'catalog--other', 'catalog\n']) {
    assert.throws(() => readDomain(name, { home: f.home }), /name/i, name);
  }
  assert.equal(fs.existsSync(f.home), false);
});

test('malformed versions, duplicate keys/IDs, aliases and unknown fields are rejected', async t => {
  const cases = [
    f => ({ ...f.config, domain_version: 2 }),
    f => ({ ...f.config, name: 'other' }),
    f => ({ ...f.config, extra: 'not supported' }),
    f => ({ ...f.config, repos: [...f.config.repos, { ...f.config.repos[0] }] }),
    f => ({ ...f.config, repos: Array.from({ length: 33 }, (_, index) => ({ ...f.config.repos[0], id: `repo-${index}` })) }),
    f => ({ ...f.config, repos: [{ ...f.config.repos[0], root: 'relative' }] }),
    f => ({ ...f.config, repos: [{ ...f.config.repos[0], origin: '' }] }),
    f => ({ ...f.config, repos: [{ ...f.config.repos[0], enabled: true }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'unknown', path: 'spec.md' }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'product', path: '../spec.md' }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'product', path: '/spec.md' }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'product', path: 'sub\\spec.md' }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'product', path: 'spec.md', authoritative: true }] }),
    f => ({ ...f.config, shared_specs: [...f.config.shared_specs, ...f.config.shared_specs] }),
    () => 'domain_version: 1\ndomain_version: 1\nname: catalog\nrepos: []\n',
    f => `domain_version: 1\nname: catalog\nrepos:\n  - &repo\n    id: product\n    origin: https://example.invalid/team/product.git\n    root: ${JSON.stringify(f.root)}\n  - *repo\n`,
    () => 'x'.repeat(64 * 1024 + 1),
  ];
  for (let index = 0; index < cases.length; index++) {
    await t.test(`invalid case ${index + 1}`, child => {
      const f = fixture(child);
      f.write(cases[index](f));
      const before = fs.readFileSync(f.file);
      assert.throws(() => readDomain('catalog', { home: f.home }), /domain|version|repo|field|YAML|config|reference/i);
      assert.deepEqual(fs.readFileSync(f.file), before);
      assert.equal(fs.existsSync(path.join(f.root, '.harness')), false);
    });
  }
});

test('config/home/root symlinks and nonregular files fail safely', async t => {
  const cases = [
    f => { f.write(); fs.renameSync(f.file, `${f.file}.real`); fs.symlinkSync(`${f.file}.real`, f.file); },
    f => { f.write(); fs.renameSync(f.home, `${f.home}.real`); fs.symlinkSync(`${f.home}.real`, f.home); },
    f => { f.write(); const domains = path.dirname(f.file); fs.renameSync(domains, `${domains}.real`); fs.symlinkSync(`${domains}.real`, domains); },
    f => { f.write(); fs.unlinkSync(f.file); fs.mkdirSync(f.file); },
    f => { const link = path.join(f.dir, 'root-link'); fs.symlinkSync(f.root, link); f.config.repos[0].root = link; f.write(); },
    f => { f.config.repos[0].root = path.join(f.dir, 'root-file'); fs.writeFileSync(f.config.repos[0].root, 'not a directory'); f.write(); },
  ];
  for (let index = 0; index < cases.length; index++) {
    await t.test(`unsafe case ${index + 1}`, child => {
      const f = fixture(child);
      cases[index](f);
      assert.throws(() => f.show(), /unsafe|symlink|regular|directory|unreadable/i);
    });
  }
});

test('FIFO domain configs are rejected without blocking', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  f.write();
  fs.unlinkSync(f.file);
  const made = spawnSync('mkfifo', [f.file], { timeout: 4000 });
  assert.equal(made.status, 0);
  assert.throws(() => readDomain('catalog', { home: f.home }), /regular|unreadable|config/i);
});

test('only explicit supported show syntax is accepted', t => {
  const f = fixture(t);
  f.write();
  for (const args of [['show'], ['create', '--name', 'catalog'], ['show', '--name', 'catalog', '--name', 'catalog'], ['show', '--name', '--json'], ['show', 'catalog'], ['show', '--name', 'catalog', 'extra']]) {
    assert.throws(() => domainResultOf(args, { harnessHome: f.home }), /name|usage|verb|argument|show/i);
  }
});
