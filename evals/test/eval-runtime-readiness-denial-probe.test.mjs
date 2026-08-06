import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nativeRoot = path.join(repoRoot, 'evals/runtime/native');
const source = path.join(nativeRoot, 'engineer-readiness-denial-probe.c');
const linuxEffectsPath = path.join(repoRoot, 'evals/runtime/linux-effects.mjs');
const provenancePath = path.join(
  nativeRoot,
  'engineer-readiness-denial-probe.provenance.json',
);
const makefilePath = path.join(nativeRoot, 'Makefile');

function compile(t) {
  const compiler = spawnSync('cc', ['--version'], { encoding: 'utf8' });
  if (compiler.error?.code === 'ENOENT' || compiler.status !== 0) {
    t.skip('a C11 compiler is unavailable');
    return null;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engineer-readiness-denial-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'engineer-readiness-denial-probe');
  const result = spawnSync('cc', [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wpedantic', source, '-o', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `readiness denial probe did not compile:\n${result.stderr}`);
  return output;
}

test('readiness denial probe source and provenance bind one static linux/amd64 artifact', () => {
  const text = fs.readFileSync(source, 'utf8');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  const makefile = fs.readFileSync(makefilePath, 'utf8');

  assert.deepEqual(Object.keys(provenance).sort(), [
    'artifactPath', 'baseImage', 'buildTarget', 'platform', 'schema', 'source',
    'sourceSha256',
  ]);
  assert.equal(provenance.schema, 'engineer-readiness-denial-probe-provenance.v1');
  assert.equal(provenance.source, 'evals/runtime/native/engineer-readiness-denial-probe.c');
  assert.equal(provenance.sourceSha256, crypto.createHash('sha256').update(text).digest('hex'));
  assert.equal(
    provenance.artifactPath,
    '/opt/engineer/bin/engineer-readiness-denial-probe',
  );
  assert.equal(provenance.platform, 'linux/amd64');
  assert.equal(provenance.buildTarget, 'readiness-denial-probe-static');
  assert.match(makefile, /^readiness-denial-probe-static:/m);
  assert.equal(fs.existsSync(path.join(nativeRoot, 'engineer-readiness-denial-probe')), false);
});

test('native helper actively attempts every runner denial without a shell or credential value read', () => {
  const text = fs.readFileSync(source, 'utf8');
  for (const required of [
    'engineer-readiness-denial-observation.v1',
    'SYS_capget',
    'PR_GET_NO_NEW_PRIVS',
    'mount(',
    'PTRACE_ATTACH',
    'connect(',
    'AF_UNIX',
    'AF_INET',
    'AF_INET6',
    'poll(',
    '/run/engineer/private-docker.sock',
    '/var/run/docker.sock',
    '/run/docker.sock',
    '169.254.169.254',
    '100.100.100.200',
    'daytonaCredentialsAbsent',
    'providerCredentialsAbsent',
    'daytona_credential_names_absent',
    'provider_credential_names_absent',
    'MAX_PROVIDER_DESTINATIONS',
    'MAX_OUTPUT_BYTES',
  ]) assert.ok(text.includes(required), `missing denial primitive: ${required}`);

  assert.doesNotMatch(
    text,
    /\\"(?:credentialNamesAbsent|daytonaCredentialsAbsent|providerCredentialsAbsent)\\":true/,
  );

  for (const forbidden of [
    /\bsystem\s*\(/,
    /\bpopen\s*\(/,
    /\bexec(?:ve|vp|v|lp|l)\s*\(/,
    /\bfopen\s*\(/,
    /\bgetenv\s*\(/,
  ]) assert.doesNotMatch(text, forbidden);
});

test('Linux driver validates and forwards each native credential attestation', () => {
  const text = fs.readFileSync(linuxEffectsPath, 'utf8');
  const start = text.indexOf('async runReadinessDenialProbe(spec)');
  const end = text.indexOf('async runTaskIsolationCanary(spec)', start);
  assert.ok(start >= 0 && end > start, 'readiness denial probe driver is missing');
  const method = text.slice(start, end);

  assert.match(method, /observation\.daytonaCredentialsAbsent !== true/);
  assert.match(method, /observation\.providerCredentialsAbsent !== true/);
  assert.match(
    method,
    /daytonaCredentialsAbsent: observation\.daytonaCredentialsAbsent/,
  );
  assert.match(
    method,
    /providerCredentialsAbsent: observation\.providerCredentialsAbsent/,
  );
  assert.match(method, /proofHash: evidenceHash\(observation\)/);
  assert.doesNotMatch(method, /(?:daytona|provider)CredentialsAbsent: true/);
});

test('helper compiles portably, accepts only bounded exact arguments, and emits fixed failures', (t) => {
  const executable = compile(t);
  if (!executable) return;

  const invalid = spawnSync(executable, [], { encoding: 'utf8', env: {} });
  assert.equal(invalid.status, 64);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'engineer-readiness-denial-probe: invalid invocation\n');

  const malformed = spawnSync(executable, [
    '--target-pid', '1',
    '--target-start-ticks', '1',
    '--provider-v4', 'not-an-ip',
  ], { encoding: 'utf8', env: {} });
  assert.equal(malformed.status, 64);
  assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr, 'engineer-readiness-denial-probe: invalid invocation\n');
});
