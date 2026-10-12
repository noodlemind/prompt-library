import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readProductDiff } from '../corpus/hooks/lib/product-diff.mjs';
import { collectChangedFiles } from '../lib/plan-scope.mjs';

const helperOptions = { skip: process.platform === 'win32' && 'Synthetic helper execution requires POSIX executable scripts' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-git-read-effects-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  const environment = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: '0',
    GIT_EXTERNAL_DIFF: undefined,
  };
  const prior = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '-b', 'feature/fixture');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'before\n');
  git('add', 'sample.txt');
  git('commit', '-qm', 'fixture baseline');
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'after\n');
  const helper = (name, output) => {
    const executable = path.join(root, name);
    const marker = path.join(root, `${name}.marker`);
    const program = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n')`;
    const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(executable, `#!/bin/sh\n${shellQuote(process.execPath)} -e ${shellQuote(program)}\n${output}\n`);
    fs.chmodSync(executable, 0o755);
    return { executable, marker };
  };
  return { workspace, git, helper };
}

test('product diff reads raw file bytes without invoking configured fsmonitor', helperOptions, (t) => {
  const f = fixture(t);
  const helper = f.helper('fsmonitor', "printf '\\0'");
  f.git('config', 'core.fsmonitor', helper.executable);
  f.git('diff', '--no-ext-diff', '--no-textconv', 'HEAD');
  assert.equal(fs.existsSync(helper.marker), true, 'control query must actually execute the configured helper');
  fs.rmSync(helper.marker);
  const diff = readProductDiff(f.workspace);
  assert.equal(fs.existsSync(helper.marker), false, 'authoritative product diff must not execute fsmonitor');
  assert.match(diff, /^-before\n\+after$/m);
});

test('product diff bypasses configured text conversion and preserves the raw diff', helperOptions, (t) => {
  const f = fixture(t);
  const helper = f.helper('textconv', "printf 'converted:'\ncat \"$1\"");
  fs.writeFileSync(path.join(f.workspace, '.gitattributes'), 'sample.txt diff=synthetic\n');
  f.git('config', 'diff.synthetic.textconv', helper.executable);
  const control = f.git('-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', 'HEAD');
  assert.equal(fs.existsSync(helper.marker), true, 'control query must actually execute the configured helper');
  assert.match(control, /-converted:before\n\+converted:after/);
  fs.rmSync(helper.marker);
  const diff = readProductDiff(f.workspace);
  assert.equal(fs.existsSync(helper.marker), false, 'authoritative product diff must not execute text conversion');
  assert.match(diff, /^-before\n\+after$/m);
  assert.doesNotMatch(diff, /converted:/);
});

test('changed file collection preserves tracked and untracked paths without invoking fsmonitor', helperOptions, (t) => {
  const f = fixture(t);
  const helper = f.helper('fsmonitor', "printf '\\0'");
  fs.writeFileSync(path.join(f.workspace, 'new.txt'), 'untracked\n');
  fs.mkdirSync(path.join(f.workspace, '.harness'));
  fs.writeFileSync(path.join(f.workspace, '.harness/state.json'), '{}');
  f.git('config', 'core.fsmonitor', helper.executable);
  f.git('diff', '--name-only', 'HEAD');
  assert.equal(fs.existsSync(helper.marker), true, 'control query must actually execute the configured helper');
  fs.rmSync(helper.marker);
  const changed = collectChangedFiles(f.workspace, 'HEAD');
  assert.equal(fs.existsSync(helper.marker), false, 'authoritative changed-file collection must not execute fsmonitor');
  assert.deepEqual(changed, { files: ['new.txt', 'sample.txt'], error: null });
});

for (const reader of ['product diff', 'changed file collection']) {
  test(`${reader} reads raw bytes without invoking a configured clean filter`, (t) => {
    const f = fixture(t);
    const root = path.dirname(f.workspace);
    const marker = path.join(root, 'filter.marker');
    const executable = path.join(root, 'filter.cjs');
    fs.writeFileSync(executable, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(marker)}, 'called\\n'); process.stdout.write(fs.readFileSync(0));\n`);
    const shellQuote = (value) => `'${value.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(path.join(f.workspace, '.gitattributes'), 'sample.txt filter=Fixture\n');
    f.git('add', '.gitattributes');
    f.git('commit', '-qm', 'filter attribute fixture');
    f.git('config', 'filter.Fixture.clean', `${shellQuote(process.execPath)} ${shellQuote(executable)}`);
    f.git('-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD');
    assert.equal(fs.existsSync(marker), true, 'control query must actually execute the configured filter');
    fs.rmSync(marker);
    const output = reader === 'product diff' ? readProductDiff(f.workspace) : collectChangedFiles(f.workspace, 'HEAD');
    assert.equal(fs.existsSync(marker), false, 'authoritative Git read must not execute a clean filter');
    if (reader === 'product diff') assert.match(output, /^-before\n\+after$/m);
    else assert.deepEqual(output, { files: ['sample.txt'], error: null });
  });
}

for (const configuration of ['malformed', 'oversized']) {
  test(`authoritative Git readers fail closed when helper metadata is ${configuration}`, (t) => {
    const f = fixture(t);
    const config = path.join(f.workspace, '.git', 'config');
    fs.appendFileSync(config, configuration === 'malformed'
      ? '\ninvalid configuration\n'
      : `\n[filter "fixture"]\n\tclean = ${'x'.repeat(70_000)}\n`);
    assert.equal(readProductDiff(f.workspace), null);
    const changed = collectChangedFiles(f.workspace, 'HEAD');
    assert.deepEqual(changed.files, []);
    assert.equal(typeof changed.error, 'string');
    assert.notEqual(changed.error, '');
  });
}
