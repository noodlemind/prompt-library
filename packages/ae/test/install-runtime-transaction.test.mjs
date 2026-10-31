import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-runtime-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'package'), home = path.join(root, 'home');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ae-harness', version: '1.0.0', dependencies: {} }));
  const write = version => {
    fs.writeFileSync(path.join(pkg, 'bin/ae.mjs'), `// ${version} bin\n`);
    fs.writeFileSync(path.join(pkg, 'lib/helper.mjs'), `// ${version} helper\n`);
  };
  const run = flags => installHarnessBin(pkg, home, flags || {}, () => {});
  const read = rel => fs.readFileSync(path.join(home, '.ae-bin', rel), 'utf8');
  write('old'); run(); write('new');
  return { root, pkg, home, run, read };
}

test('failed runtime staging preserves every byte of the previous installed runtime', t => {
  const f = fixture(t), copy = fs.copyFileSync;
  fs.copyFileSync = (source, target, ...rest) => {
    if (source === path.join(f.pkg, 'lib/helper.mjs')) throw Object.assign(new Error('selected disk exhaustion'), { code: 'ENOSPC' });
    return copy(source, target, ...rest);
  };
  try { assert.throws(() => f.run(), { code: 'ENOSPC' }); }
  finally { fs.copyFileSync = copy; }
  assert.equal(f.read('bin/ae.mjs'), '// old bin\n');
  assert.equal(f.read('lib/helper.mjs'), '// old helper\n');
  f.run();
  assert.equal(f.read('bin/ae.mjs'), '// new bin\n');
  assert.equal(f.read('lib/helper.mjs'), '// new helper\n');
});

test('failed runtime publication restores the old directory before returning failure', t => {
  const f = fixture(t), rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    if (target === path.join(f.home, '.ae-bin') && String(source).includes('.ae-bin-stage-')) {
      injected = true;
      throw Object.assign(new Error('selected publish refusal'), { code: 'EACCES' });
    }
    return rename(source, target);
  };
  try { assert.throws(() => f.run(), { code: 'EACCES' }); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  assert.equal(f.read('bin/ae.mjs'), '// old bin\n');
  assert.equal(f.read('lib/helper.mjs'), '// old helper\n');
});

test('a later install recovers an interrupted directory retirement without mixing versions', t => {
  const f = fixture(t), rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    if (target === path.join(f.home, '.ae-bin')) {
      injected = true;
      throw Object.assign(new Error('selected interruption before publish and rollback'), { code: 'EACCES' });
    }
    return rename(source, target);
  };
  try { assert.throws(() => f.run()); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(f.home, '.ae-bin')), false);
  f.run();
  assert.equal(f.read('bin/ae.mjs'), '// new bin\n');
  assert.equal(f.read('lib/helper.mjs'), '// new helper\n');
  assert.equal(fs.existsSync(path.join(f.home, '.ae-runtime-install.json')), false);
});

test('invalid or redirected recovery metadata cannot replace or delete installed bytes', t => {
  const f = fixture(t), journal = path.join(f.home, '.ae-runtime-install.json');
  fs.writeFileSync(journal, JSON.stringify({ version: 1, stage: '../outside', backup: '.ae-bin', old: null, new: { dev: '1', ino: '2' } }));
  assert.throws(() => f.run(), { code: 'E_TARGET' });
  assert.equal(f.read('bin/ae.mjs'), '// old bin\n');
  assert.equal(f.read('lib/helper.mjs'), '// old helper\n');
  assert.equal(fs.existsSync(journal), true, 'unknown journal must remain available for inspection');
});

test('runtime dry-run creates no staging, journal or lock and leaves installed bytes unchanged', t => {
  const f = fixture(t), before = fs.readdirSync(f.home).sort();
  const result = f.run({ dryRun: true });
  assert.ok(result.updated >= 2);
  assert.deepEqual(fs.readdirSync(f.home).sort(), before);
  assert.equal(f.read('bin/ae.mjs'), '// old bin\n');
  assert.equal(f.read('lib/helper.mjs'), '// old helper\n');
});
