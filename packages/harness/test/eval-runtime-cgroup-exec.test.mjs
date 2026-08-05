import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const nativeRoot = path.join(repoRoot, 'evals/runtime/native');
const source = path.join(nativeRoot, 'engineer-cgroup-exec.c');
const provenancePath = path.join(nativeRoot, 'engineer-cgroup-exec.provenance.json');
const makefilePath = path.join(nativeRoot, 'Makefile');

const INVALID_INVOCATION = 'engineer-cgroup-exec: invalid invocation\n';

function compile(t) {
  const compiler = spawnSync('cc', ['--version'], { encoding: 'utf8' });
  if (compiler.error?.code === 'ENOENT' || compiler.status !== 0) {
    t.skip('a C11 compiler is unavailable');
    return null;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engineer-cgroup-exec-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'engineer-cgroup-exec');
  const result = spawnSync('cc', [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-Wpedantic',
    source,
    '-o',
    output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `native helper did not compile:\n${result.stderr}`);
  return output;
}

test('native helper source and pinned Alpine provenance are complete and binary-free', () => {
  const text = fs.readFileSync(source, 'utf8');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  const makefile = fs.readFileSync(makefilePath, 'utf8');

  assert.deepEqual(Object.keys(provenance).sort(), [
    'artifactPath',
    'baseImage',
    'buildTarget',
    'schema',
    'source',
    'sourceSha256',
  ]);
  assert.equal(provenance.schema, 'engineer-native-helper-provenance.v1');
  assert.equal(
    provenance.baseImage,
    'docker:28.3.3-dind@sha256:a56b3bdde89315ed2cc0e4906e582b5033d93bf20d9cb9510c2cdd4e7f7690b1',
  );
  assert.equal(provenance.source, 'evals/runtime/native/engineer-cgroup-exec.c');
  assert.equal(provenance.artifactPath, '/opt/engineer/bin/engineer-cgroup-exec');
  assert.equal(provenance.buildTarget, 'alpine-static');
  assert.equal(provenance.sourceSha256, crypto.createHash('sha256').update(text).digest('hex'));
  assert.match(makefile, /^alpine-static:/m);
  assert.match(makefile, /-static/);
  assert.match(makefile, /--build-id=none/);
  assert.equal(fs.existsSync(path.join(nativeRoot, 'engineer-cgroup-exec')), false);
});

test('native helper statically preserves the cgroup, identity, capability, and execve contract', () => {
  const text = fs.readFileSync(source, 'utf8');

  for (const required of [
    'O_NOFOLLOW',
    'openat(',
    'fstatfs(',
    'CGROUP2_SUPER_MAGIC',
    'cgroup.procs',
    'setgroups(',
    'setresgid(',
    'setresuid(',
    'PR_SET_NO_NEW_PRIVS',
    'PR_CAPBSET_DROP',
    'PR_CAP_AMBIENT_CLEAR_ALL',
    'SYS_capset',
    'SYS_capget',
    'execve(',
  ]) {
    assert.ok(text.includes(required), `missing native security primitive: ${required}`);
  }
  for (const forbidden of [/\bsystem\s*\(/, /\bpopen\s*\(/, /\bexec[lv]p\s*\(/]) {
    assert.doesNotMatch(text, forbidden);
  }
  assert.match(text, /MAX_EXEC_ARGS\s+1024U/);
  assert.match(text, /MAX_TOTAL_ARG_BYTES\s+1048576U/);
  assert.match(text, /MAX_SUPPLEMENTARY_GROUPS\s+64U/);
});

test('native helper compiles portably and rejects non-canonical invocations with one fixed error', (t) => {
  const executable = compile(t);
  if (!executable) return;

  const malformed = [
    [],
    ['--gid', '2001', '--uid', '2001', '--groups', '', '--no-new-privileges', '--clear-capabilities', '--', '/usr/bin/true'],
    ['--uid', '02001', '--gid', '2001', '--groups', '', '--no-new-privileges', '--clear-capabilities', '--', '/usr/bin/true'],
    ['--uid', '2001', '--gid', '2001', '--groups', '2003,2003', '--no-new-privileges', '--clear-capabilities', '--', '/usr/bin/true'],
    ['--uid', '2001', '--gid', '2001', '--groups', '', '--no-new-privileges', '--', '/usr/bin/true'],
    ['--uid', '2001', '--gid', '2001', '--groups', '', '--no-new-privileges', '--clear-capabilities', '--', 'usr/bin/true'],
    ['--uid', '2001', '--gid', '2001', '--groups', '', '--cgroup', '/sys/fs/cgroup/../escape', '--no-new-privileges', '--clear-capabilities', '--', '/usr/bin/true'],
  ];

  for (const args of malformed) {
    const result = spawnSync(executable, args, { encoding: 'utf8' });
    assert.equal(result.status, 64, `unexpected status for ${JSON.stringify(args)}`);
    assert.equal(result.stderr, INVALID_INVOCATION);
    assert.equal(result.stdout, '');
  }
});

test('Linux integration permanently drops identity and every capability before execve', {
  skip: process.platform !== 'linux',
}, (t) => {
  if (process.geteuid?.() !== 0) return t.skip('Linux integration requires a disposable root test process');
  const executable = compile(t);
  if (!executable) return;

  const probe = [
    "const fs=require('node:fs');",
    "const s=fs.readFileSync('/proc/self/status','utf8');",
    "const get=(n)=>s.match(new RegExp('^'+n+':\\\\s+(.+)$','m'))?.[1];",
    "process.stdout.write(JSON.stringify({uid:get('Uid'),gid:get('Gid'),inh:get('CapInh'),prm:get('CapPrm'),eff:get('CapEff'),bnd:get('CapBnd'),amb:get('CapAmb'),nnp:get('NoNewPrivs')}));",
  ].join('');
  const result = spawnSync(executable, [
    '--uid', '65534',
    '--gid', '65534',
    '--groups', '',
    '--no-new-privileges',
    '--clear-capabilities',
    '--',
    process.execPath,
    '-e',
    probe,
  ], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });

  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.uid, '65534\t65534\t65534\t65534');
  assert.equal(observed.gid, '65534\t65534\t65534\t65534');
  assert.deepEqual(
    [observed.inh, observed.prm, observed.eff, observed.bnd, observed.amb],
    Array(5).fill('0000000000000000'),
  );
  assert.equal(observed.nnp, '1');
});
