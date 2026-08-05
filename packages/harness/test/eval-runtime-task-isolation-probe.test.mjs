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
const source = path.join(nativeRoot, 'engineer-task-isolation-probe.c');
const provenancePath = path.join(nativeRoot, 'engineer-task-isolation-probe.provenance.json');
const makefilePath = path.join(nativeRoot, 'Makefile');

function compile(t) {
  const compiler = spawnSync('cc', ['--version'], { encoding: 'utf8' });
  if (compiler.error?.code === 'ENOENT' || compiler.status !== 0) {
    t.skip('a C11 compiler is unavailable');
    return null;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engineer-task-isolation-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'engineer-task-isolation-probe');
  const result = spawnSync('cc', [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wpedantic', source, '-o', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `task isolation probe did not compile:\n${result.stderr}`);
  return output;
}

test('task isolation probe source and provenance bind one static linux/amd64 artifact', () => {
  const text = fs.readFileSync(source, 'utf8');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  const makefile = fs.readFileSync(makefilePath, 'utf8');

  assert.deepEqual(Object.keys(provenance).sort(), [
    'artifactPath', 'baseImage', 'buildTarget', 'platform', 'schema', 'source', 'sourceSha256',
  ]);
  assert.equal(provenance.schema, 'engineer-task-isolation-probe-provenance.v1');
  assert.equal(provenance.source, 'evals/runtime/native/engineer-task-isolation-probe.c');
  assert.equal(provenance.sourceSha256, crypto.createHash('sha256').update(text).digest('hex'));
  assert.equal(provenance.artifactPath, '/opt/engineer/bin/engineer-task-isolation-probe');
  assert.equal(provenance.platform, 'linux/amd64');
  assert.equal(provenance.buildTarget, 'task-isolation-probe-static');
  assert.match(makefile, /^task-isolation-probe-static:/m);
  assert.match(makefile, /-static-pie/);
  assert.equal(fs.existsSync(path.join(nativeRoot, 'engineer-task-isolation-probe')), false);
});

test('task isolation probe is bounded metadata-only code with no shell or file-content reads', () => {
  const text = fs.readFileSync(source, 'utf8');
  for (const required of [
    'engineer-task-isolation-observation.v1',
    'stat("/proc/self/ns/net"',
    'stat("/proc/self/ns/mnt"',
    'if_nameindex(',
    'SYS_capget',
    'PR_GET_NO_NEW_PRIVS',
    'socket(AF_INET, SOCK_RAW',
    'MAX_INTERFACES',
    '\\"networkNamespaceIdentity\\"',
    '\\"mountNamespaceIdentity\\"',
    '\\"interfaceInventory\\"',
    '\\"effectiveCapabilities\\"',
    '\\"noNewPrivileges\\"',
    '\\"rawSocketDenied\\"',
  ]) assert.ok(text.includes(required), `missing isolation observation primitive: ${required}`);

  for (const forbidden of [
    /\bsystem\s*\(/,
    /\bpopen\s*\(/,
    /\bexec(?:ve|vp|v|lp|l)\s*\(/,
    /\bfopen\s*\(/,
    /\bfread\s*\(/,
    /\bread\s*\(/,
    /\breadlink\s*\(/,
    /\bgetenv\s*\(/,
  ]) assert.doesNotMatch(text, forbidden);
});

test('task isolation probe compiles portably and accepts no arguments', (t) => {
  const executable = compile(t);
  if (!executable) return;
  const rejected = spawnSync(executable, ['unexpected'], { encoding: 'utf8' });
  assert.equal(rejected.status, 64);
  assert.equal(rejected.stdout, '');
  assert.equal(rejected.stderr, 'engineer-task-isolation-probe: invalid invocation\n');
});

test('Linux integration emits one exact, bounded, deterministic observation document', {
  skip: process.platform !== 'linux',
}, (t) => {
  const executable = compile(t);
  if (!executable) return;
  const result = spawnSync(executable, [], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(Buffer.byteLength(result.stdout) <= 8192);
  assert.equal(result.stdout.endsWith('\n'), true);

  const observed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(observed), [
    'schema', 'networkNamespaceIdentity', 'mountNamespaceIdentity', 'interfaceInventory',
    'effectiveCapabilities', 'noNewPrivileges', 'rawSocketDenied',
  ]);
  assert.equal(observed.schema, 'engineer-task-isolation-observation.v1');
  assert.match(observed.networkNamespaceIdentity, /^dev:[0-9]+:ino:[0-9]+$/);
  assert.match(observed.mountNamespaceIdentity, /^dev:[0-9]+:ino:[0-9]+$/);
  assert.ok(observed.interfaceInventory.length >= 1 && observed.interfaceInventory.length <= 64);
  assert.deepEqual(observed.interfaceInventory, [...observed.interfaceInventory].sort((left, right) => {
    const leftIndex = Number.parseInt(left, 10);
    const rightIndex = Number.parseInt(right, 10);
    return leftIndex - rightIndex || left.localeCompare(right);
  }));
  for (const entry of observed.interfaceInventory) assert.match(entry, /^[1-9][0-9]*:[^\u0000-\u001f]{1,15}$/);
  assert.ok(Number.isSafeInteger(observed.effectiveCapabilities));
  assert.ok(observed.effectiveCapabilities >= 0);
  assert.equal(typeof observed.noNewPrivileges, 'boolean');
  assert.equal(typeof observed.rawSocketDenied, 'boolean');
});
