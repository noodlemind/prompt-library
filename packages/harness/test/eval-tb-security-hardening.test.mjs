import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_MANIFEST_FILE,
  materializePrebuiltBundle,
  prepareHarnessBundle,
  validatePrebuiltBundle,
} from '../../../evals/external/terminal_bench/provision.mjs';
import { runStdioAgent } from '../../../evals/external/terminal_bench/agent.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const SOURCE_IDENTITY = { releaseSha: 'a'.repeat(40), harnessVersion: '1.2.3-test' };

function tmpdir(prefix = 'tb-security-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function snapshotFixtureSource({ repoRoot: sourceRoot, destination }) {
  fs.mkdirSync(path.join(destination, '.github', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(destination, '.github', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRoot, '.github', 'agents', 'engineer.agent.md'),
    path.join(destination, '.github', 'agents', 'engineer.agent.md')
  );
  fs.cpSync(
    path.join(sourceRoot, '.github', 'skills', 'ensure-plan'),
    path.join(destination, '.github', 'skills', 'ensure-plan'),
    { recursive: true }
  );
  fs.cpSync(path.join(sourceRoot, 'packages', 'harness'), path.join(destination, 'packages', 'harness'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  fs.copyFileSync(path.join(sourceRoot, 'evals', '__init__.py'), path.join(destination, 'evals', '__init__.py'));
  for (const directory of ['config', 'hosts', 'lib']) {
    fs.cpSync(path.join(sourceRoot, 'evals', directory), path.join(destination, 'evals', directory), { recursive: true });
  }
  fs.copyFileSync(path.join(sourceRoot, 'evals', 'external', '__init__.py'), path.join(destination, 'evals', 'external', '__init__.py'));
  for (const file of ['__init__.py', 'agent.mjs', 'harbor_agent.py', 'evidence-probe.mjs', 'bounded-exec.mjs']) {
    fs.copyFileSync(
      path.join(sourceRoot, 'evals', 'external', 'terminal_bench', file),
      path.join(destination, 'evals', 'external', 'terminal_bench', file)
    );
  }
}

function writeBridgeFixture(root, { probe = 'process.stdout.write("{}\\n")', bounded = 'process.stdout.write("{}\\n")' } = {}) {
  fs.mkdirSync(path.join(root, '.github', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.github', 'skills', 'ensure-plan'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.github', 'agents', 'engineer.agent.md'),
    '---\nname: engineer\n---\n# Fixture Engineer\nFollow the verified delivery contract.\n'
  );
  fs.writeFileSync(
    path.join(root, '.github', 'skills', 'ensure-plan', 'SKILL.md'),
    '---\ndescription: Fixture planning guidance\n---\n# Ensure Plan\nRetain a bounded plan.\n'
  );
  for (const directory of ['config', 'hosts', 'lib']) {
    fs.mkdirSync(path.join(root, 'evals', directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'evals', directory, 'fixture.mjs'), 'export default null;\n');
  }
  fs.mkdirSync(path.join(root, 'evals', 'external', 'terminal_bench'), { recursive: true });
  for (const relative of ['evals/__init__.py', 'evals/external/__init__.py', 'evals/external/terminal_bench/__init__.py']) {
    fs.writeFileSync(path.join(root, relative), '');
  }
  fs.writeFileSync(path.join(root, 'evals', 'external', 'terminal_bench', 'agent.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(root, 'evals', 'external', 'terminal_bench', 'harbor_agent.py'), 'class StdioBridgeAgent: pass\n');
  fs.writeFileSync(path.join(root, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'), probe);
  fs.writeFileSync(path.join(root, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'), bounded);
}

function preparedFixture() {
  const fixtureRoot = tmpdir('tb-bundle-fixture-');
  const bundleDir = path.join(tmpdir('tb-bundle-output-'), 'bundle');
  fs.mkdirSync(path.join(fixtureRoot, 'packages', 'harness', 'bin'), { recursive: true });
  writeBridgeFixture(fixtureRoot);
  fs.writeFileSync(path.join(fixtureRoot, 'packages', 'harness', 'package.json'), JSON.stringify({ name: '@fixture/harness' }));
  fs.symlinkSync('package.json', path.join(fixtureRoot, 'packages', 'harness', 'package-link.json'));
  fs.writeFileSync(path.join(fixtureRoot, 'packages', 'harness', 'bin', 'harness.mjs'), 'process.stdout.write("ok\\n")');
  const nodeTarball = path.join(fixtureRoot, 'node-v-test-linux-x64.tar.gz');
  fs.writeFileSync(nodeTarball, 'pinned fixture archive bytes');

  const prepared = prepareHarnessBundle({
    bundleDir,
    repoRoot: fixtureRoot,
    sourceIdentity: SOURCE_IDENTITY,
    nodeTarballs: { x64: nodeTarball, arm64: null },
    nodeTarballHashes: { x64: sha256(fs.readFileSync(nodeTarball)), arm64: null },
    snapshotSource: snapshotFixtureSource,
    spawnImpl: (command, args) => {
      if (command === 'cp') fs.cpSync(args[1], args[2], { recursive: true, verbatimSymlinks: true });
      if (command === 'tar') {
        const destination = args[args.indexOf('-C') + 1];
        fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(destination, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
      }
      return { status: 0, stderr: '' };
    },
  });
  return { fixtureRoot, bundleDir, prepared, nodeTarball };
}

const trustBundle = (prepared, extras = {}) => ({
  expectedManifestHash: prepared.manifestHash,
  expectedSourceIdentity: SOURCE_IDENTITY,
  ...extras,
});

test('prepared bundles require an out-of-bundle digest and validate exact content', () => {
  const { bundleDir, prepared } = preparedFixture();
  assert.match(prepared.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(bundleDir, BUNDLE_MANIFEST_FILE)), true);
  const recorded = JSON.parse(fs.readFileSync(path.join(bundleDir, BUNDLE_MANIFEST_FILE), 'utf8'));
  assert.deepEqual(recorded.sourceIdentity, SOURCE_IDENTITY);
  assert.match(recorded.nodeTarballHashes.x64, /^[a-f0-9]{64}$/);
  assert.equal(validatePrebuiltBundle(bundleDir, trustBundle(prepared)).manifestHash, prepared.manifestHash);
  assert.throws(() => validatePrebuiltBundle(bundleDir), /expected manifest digest/i);
  assert.throws(
    () => validatePrebuiltBundle(bundleDir, trustBundle(prepared, {
      expectedSourceIdentity: { ...SOURCE_IDENTITY, releaseSha: 'b'.repeat(40) },
    })),
    /source identity.*evaluated release/i
  );

  fs.writeFileSync(path.join(bundleDir, 'harness', 'unexpected-secret.txt'), 'do not mount me');
  assert.throws(
    () => validatePrebuiltBundle(bundleDir, trustBundle(prepared)),
    /contents|manifest|unexpected/i
  );
});

test('prebuilt validation rejects group- or other-writable files and directories', () => {
  {
    const { bundleDir, prepared } = preparedFixture();
    fs.chmodSync(path.join(bundleDir, 'harness', 'package.json'), 0o666);
    assert.throws(
      () => validatePrebuiltBundle(bundleDir, trustBundle(prepared)),
      /group- or other-writable/i
    );
  }
  {
    const { bundleDir, prepared } = preparedFixture();
    fs.chmodSync(path.join(bundleDir, 'harness'), 0o777);
    assert.throws(
      () => validatePrebuiltBundle(bundleDir, trustBundle(prepared)),
      /group- or other-writable/i
    );
  }
});

test('Node runtime archives require an exact SHA-256 pin and reject symlink inputs', () => {
  const fixtureRoot = tmpdir('tb-runtime-pin-fixture-');
  fs.mkdirSync(path.join(fixtureRoot, 'packages', 'harness'), { recursive: true });
  writeBridgeFixture(fixtureRoot, { probe: '', bounded: '' });
  const archive = path.join(fixtureRoot, 'node-v-test-linux-x64.tar.gz');
  fs.writeFileSync(archive, 'trusted runtime archive');
  const link = path.join(fixtureRoot, 'linked-node-v-test-linux-x64.tar.gz');
  fs.symlinkSync(archive, link);
  const spawnImpl = (command, args) => {
    if (command === 'cp') fs.cpSync(args[1], args[2], { recursive: true });
    if (command === 'tar') assert.fail('an untrusted runtime archive must never reach tar');
    return { status: 0, stderr: '' };
  };
  const prepare = (tarball, digest) => prepareHarnessBundle({
    bundleDir: path.join(tmpdir('tb-runtime-pin-output-'), 'bundle'),
    repoRoot: fixtureRoot,
    sourceIdentity: SOURCE_IDENTITY,
    nodeTarballs: { x64: tarball, arm64: null },
    nodeTarballHashes: { x64: digest, arm64: null },
    snapshotSource: snapshotFixtureSource,
    spawnImpl,
  });

  assert.throws(() => prepare(archive, null), /SHA-256 pin is required/i);
  assert.throws(() => prepare(archive, '0'.repeat(64)), /digest mismatch/i);
  assert.throws(() => prepare(link, sha256(fs.readFileSync(archive))), /non-symlink/i);
});

test('automatic bundle preparation snapshots tracked bytes from the claimed commit', () => {
  const sourceRoot = tmpdir('tb-commit-source-');
  fs.mkdirSync(path.join(sourceRoot, 'packages', 'harness'), { recursive: true });
  writeBridgeFixture(sourceRoot, { probe: 'committed probe\n', bounded: 'committed exec\n' });
  fs.writeFileSync(path.join(sourceRoot, 'packages', 'harness', 'package.json'), '{"name":"committed-harness"}\n');
  fs.writeFileSync(path.join(sourceRoot, 'packages', 'harness', 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  const git = (args) => spawnSync('git', args, { cwd: sourceRoot, encoding: 'utf8' });
  assert.equal(git(['init']).status, 0);
  assert.equal(git(['add', '-A']).status, 0);
  assert.equal(git(['-c', 'user.name=Eval Test', '-c', 'user.email=eval-test@example.invalid', 'commit', '-m', 'source']).status, 0);
  const releaseSha = git(['rev-parse', '--verify', 'HEAD']).stdout.trim();

  fs.writeFileSync(path.join(sourceRoot, 'packages', 'harness', 'package.json'), '{"name":"dirty-harness"}\n');
  fs.mkdirSync(path.join(sourceRoot, 'packages', 'harness', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'packages', 'harness', 'node_modules', 'ignored-secret'), 'must not be bundled');
  const nodeTarball = path.join(sourceRoot, 'node-v-test-linux-x64.tar.gz');
  fs.writeFileSync(nodeTarball, 'pinned runtime bytes');
  const bundleDir = path.join(tmpdir('tb-commit-bundle-'), 'bundle');
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push([command, args, options]);
    if (command === 'git' || (command === 'tar' && args[0] === '-xf')) {
      return spawnSync(command, args, { ...options, encoding: 'utf8' });
    }
    if (command === 'tar') {
      const destination = args[args.indexOf('-C') + 1];
      fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(destination, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
    }
    return { status: 0, stderr: '' };
  };

  const hostileGit = {
    GIT_DIR: path.join(tmpdir('tb-attacker-git-'), '.git'),
    GIT_WORK_TREE: tmpdir('tb-attacker-worktree-'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: tmpdir('tb-attacker-config-'),
  };
  const hostileAmbient = {
    ...hostileGit,
    HOME: tmpdir('tb-attacker-home-'),
    OPENROUTER_API_KEY: 'sentinel-openrouter-secret',
    DAYTONA_API_KEY: 'sentinel-daytona-secret',
    GITHUB_TOKEN: 'sentinel-github-secret',
    SOME_TOKEN: 'sentinel-other-secret',
    npm_config_userconfig: path.join(tmpdir('tb-attacker-npm-'), '.npmrc'),
  };
  const priorGit = Object.fromEntries(Object.keys(hostileAmbient).map((key) => [key, process.env[key]]));
  Object.assign(process.env, hostileAmbient);
  try {
    prepareHarnessBundle({
      bundleDir,
      repoRoot: sourceRoot,
      sourceIdentity: { releaseSha, harnessVersion: '1.2.3-test' },
      nodeTarballs: { x64: nodeTarball, arm64: null },
      nodeTarballHashes: { x64: sha256(fs.readFileSync(nodeTarball)), arm64: null },
      spawnImpl,
    });
  } finally {
    for (const [key, value] of Object.entries(priorGit)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(fs.readFileSync(path.join(bundleDir, 'harness', 'package.json'), 'utf8'), '{"name":"committed-harness"}\n');
  assert.equal(fs.existsSync(path.join(bundleDir, 'harness', 'node_modules', 'ignored-secret')), false);
  assert.equal(fs.readFileSync(path.join(bundleDir, 'evidence-probe.mjs'), 'utf8'), 'committed probe\n');
  const gitCall = calls.find(([command, args]) => command === 'git' && args.includes('archive'));
  assert.ok(gitCall && gitCall[1].includes(releaseSha));
  assert.ok(gitCall[1].some((arg) => arg.startsWith('--git-dir=')));
  assert.ok(gitCall[1].some((arg) => arg.startsWith('--work-tree=')));
  for (const key of Object.keys(hostileGit)) {
    assert.equal(gitCall[2].env[key], undefined, `ambient ${key} never reaches bundle provenance`);
  }
  assert.equal(gitCall[2].env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(gitCall[2].env.GIT_CONFIG_SYSTEM, '/dev/null');
  assert.equal(gitCall[2].env.GIT_OPTIONAL_LOCKS, '0');
  for (const [, , options] of calls) {
    assert.equal(options.env.OPENROUTER_API_KEY, undefined);
    assert.equal(options.env.DAYTONA_API_KEY, undefined);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    assert.equal(options.env.SOME_TOKEN, undefined);
    assert.equal(options.env.npm_config_userconfig, '/dev/null');
    assert.notEqual(options.env.HOME, hostileAmbient.HOME);
    assert.ok(
      options.env.HOME.startsWith(fs.realpathSync.native(bundleDir)),
      'every build subprocess receives the fresh bundle-scoped HOME'
    );
  }
  assert.ok(calls.some(([command, args]) => command === 'npm' && args[0] === 'ci'));
});

test('prebuilt bundles are mounted from a separately validated runner-owned snapshot', () => {
  const { bundleDir, prepared } = preparedFixture();
  const destination = path.join(tmpdir('tb-materialized-parent-'), 'materialized');
  const materialized = materializePrebuiltBundle(bundleDir, {
    destination,
    ...trustBundle(prepared),
  });
  assert.equal(materialized.bundleDir, fs.realpathSync(destination));
  const mountedSources = [
    ...materialized.mountPolicy.generic,
    ...materialized.mountPolicy.harness,
  ].map((mount) => mount.source);
  assert.ok(mountedSources.every((source) => source.startsWith(`${fs.realpathSync(destination)}${path.sep}`)));
  assert.ok(mountedSources.every((source) => !source.startsWith(`${fs.realpathSync(bundleDir)}${path.sep}`)));
  assert.equal(fs.readlinkSync(path.join(destination, 'harness', 'package-link.json')), 'package.json');
  fs.writeFileSync(path.join(bundleDir, 'harness', 'post-validation-mutation'), 'source changed');
  assert.equal(fs.existsSync(path.join(destination, 'harness', 'post-validation-mutation')), false);
  assert.equal(validatePrebuiltBundle(destination, trustBundle(prepared)).manifestHash, prepared.manifestHash);
});

test('prebuilt validation stops at a caller-tightened entry cap before accepting the inventory', () => {
  const { bundleDir, prepared } = preparedFixture();
  assert.throws(
    () => validatePrebuiltBundle(bundleDir, {
      ...trustBundle(prepared),
      maximumEntries: 2,
    }),
    /maximum entry count 2/i
  );
});

test('materialization copies only attested entries added after validation', () => {
  const { bundleDir, prepared } = preparedFixture();
  const destination = path.join(tmpdir('tb-materialized-attested-'), 'materialized');
  const materialized = materializePrebuiltBundle(bundleDir, {
    destination,
    ...trustBundle(prepared),
    onSourceValidated: ({ bundleDir: validatedSource }) => {
      fs.writeFileSync(path.join(validatedSource, 'unattested-after-validation'), 'must not be copied');
    },
  });

  assert.equal(fs.existsSync(path.join(destination, 'unattested-after-validation')), false);
  assert.equal(materialized.manifestHash, prepared.manifestHash);
});

test('materialization detects an attested-file mutation and removes its partial destination', () => {
  const { bundleDir, prepared } = preparedFixture();
  const destination = path.join(tmpdir('tb-materialized-mutated-'), 'materialized');

  assert.throws(
    () => materializePrebuiltBundle(bundleDir, {
      destination,
      ...trustBundle(prepared),
      onSourceValidated: ({ bundleDir: validatedSource }) => {
        fs.writeFileSync(path.join(validatedSource, 'harness', 'package.json'), '{"changed":true}\n');
      },
    }),
    /attested bundle file (?:size|digest) changed after validation/i
  );
  assert.equal(fs.existsSync(destination), false, 'a failed snapshot must not leave mountable partial content');
});

test('a forged bundle and rewritten local manifest cannot replace the trusted digest', () => {
  const { bundleDir, prepared } = preparedFixture();
  const target = path.join(bundleDir, 'harness', 'package.json');
  fs.writeFileSync(target, JSON.stringify({ name: '@forged/harness', credential: 'stolen' }));
  const manifestPath = path.join(bundleDir, BUNDLE_MANIFEST_FILE);
  const forged = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = forged.entries.find((candidate) => candidate.path === 'harness/package.json');
  entry.size = fs.statSync(target).size;
  entry.sha256 = sha256(fs.readFileSync(target));
  fs.writeFileSync(manifestPath, `${JSON.stringify(forged, null, 2)}\n`);
  const attackerChosenDigest = sha256(fs.readFileSync(manifestPath));

  assert.notEqual(attackerChosenDigest, prepared.manifestHash);
  assert.throws(
    () => validatePrebuiltBundle(bundleDir, trustBundle(prepared)),
    /manifest digest/i
  );
});

test('bundle validation rejects broad paths, symlink roots, and escaping symlinks', () => {
  const { bundleDir, prepared } = preparedFixture();
  for (const broad of ['/', os.homedir(), repoRoot]) {
    assert.throws(
      () => validatePrebuiltBundle(broad, trustBundle(prepared, { repoRoot })),
      /broad|root|ancestor|home|repository/i,
      broad
    );
  }

  const linked = path.join(tmpdir(), 'linked-bundle');
  fs.symlinkSync(bundleDir, linked, 'dir');
  assert.throws(
    () => validatePrebuiltBundle(linked, trustBundle(prepared)),
    /symlink|canonical/i
  );

  const wrapper = path.join(bundleDir, 'harness-cli');
  fs.unlinkSync(wrapper);
  fs.symlinkSync('/etc/passwd', wrapper);
  assert.throws(
    () => validatePrebuiltBundle(bundleDir, trustBundle(prepared)),
    /symlink|escape|contents|manifest/i
  );
});

function protocolPump() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  return { input, output, lines };
}

test('Node redacts provider-reflected secrets from return, stdout, telemetry, and disk', async () => {
  const secret = 'sentinel-openrouter-key-123456';
  const doneFilePath = path.join(tmpdir(), 'done.json');
  const driver = {
    next: async () => ({ type: 'finish', answer: `provider reflected ${secret}`, stopReason: 'model_finish' }),
  };
  const telemetry = { snapshot: () => ({ events: [{ generationId: `gen-${secret}` }], totals: { provider: secret } }) };
  const { input, output, lines } = protocolPump();
  const done = await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 'safe',
    instruction: 'safe',
    telemetry,
    doneFilePath,
    redactValues: [secret],
  });
  const persisted = fs.readFileSync(doneFilePath, 'utf8');
  assert.doesNotMatch(JSON.stringify(done), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(secret));
  assert.doesNotMatch(persisted, new RegExp(secret));
  assert.match(persisted, /REDACTED_SECRET/);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].doneFilePersisted, true, 'stdout carries only the bounded persisted-artifact reference');
  assert.equal(lines[0].doneBytes, Buffer.byteLength(persisted));
  assert.equal(lines[0].doneHash, sha256(persisted));
  assert.equal(Object.hasOwn(lines[0], 'telemetry'), false, 'the full ledger is not duplicated into line framing');
});

test('Node top-level failures redact credential variables with suffixes', () => {
  const secret = 'sentinel-suffixed-token-123456';
  const missingCondition = path.join(tmpdir(), `${secret}-missing-condition.json`);
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'agent.mjs'),
    '--condition',
    missingCondition,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_EVAL_TB_CONDITION: missingCondition,
      SERVICE_TOKEN_BACKUP: secret,
    },
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
  assert.match(result.stdout, /REDACTED_SECRET/);
});

test('Node refuses a provider-supplied command containing an active secret before Harbor sees it', async () => {
  const secret = 'sentinel-command-secret-654321';
  const driver = {
    next: async () => ({ type: 'tool', name: 'bash', input: { command: `printf %s ${secret}` } }),
  };
  const { input, output, lines } = protocolPump();
  const done = await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 'safe',
    instruction: 'safe',
    redactValues: [secret],
  });
  assert.equal(done.stopReason, 'secret_reflection_blocked');
  assert.equal(lines.some((line) => line.type === 'exec'), false);
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(secret));
});

test('Node emits a small fail-closed frame when the large done artifact cannot be persisted', async () => {
  const unavailableDonePath = path.join(tmpdir(), 'missing-parent', 'done.json');
  const driver = {
    next: async () => ({ type: 'finish', answer: 'x'.repeat(700_000), stopReason: 'model_finish' }),
  };
  const telemetry = { snapshot: () => ({ events: [{ detail: 'y'.repeat(700_000) }], totals: {} }) };
  const { input, output, lines } = protocolPump();

  const done = await runStdioAgent({
    driver,
    input,
    output,
    systemPrompt: 'safe',
    instruction: 'safe',
    telemetry,
    doneFilePath: unavailableDonePath,
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].stopReason, 'done_persistence_failed');
  assert.ok(Buffer.byteLength(JSON.stringify(lines[0])) < 4096, 'stdout fallback stays far below the protocol line cap');
  assert.equal(done.stopReason, 'done_persistence_failed');
});

function runPython(source, env = {}, { timeout } = {}) {
  const result = spawnSync('python3', ['-c', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_EVAL_HOST_NODE: process.execPath,
      HARNESS_EVAL_HOST_NODE_SHA256: sha256(fs.readFileSync(process.execPath)),
      ...env,
      PYTHONPATH: process.env.PYTHONPATH ? `${repoRoot}${path.delimiter}${process.env.PYTHONPATH}` : repoRoot,
    },
    timeout,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('Python refuses to spawn a host Node executable whose digest is not the runner attestation', () => {
  const result = runPython(`
import asyncio, json, pathlib, tempfile
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

root = pathlib.Path(tempfile.mkdtemp())
condition = root / "condition.json"
condition.write_text("{}")

async def main():
    agent = StdioBridgeAgent()
    agent._extra_env = {"HARNESS_EVAL_TB_CONDITION": str(condition)}
    try:
        await agent.run("instruction", None, object())
    except RuntimeError as error:
        print(json.dumps({"error": str(error)}))
        return
    raise AssertionError("mismatched Node digest was accepted")

asyncio.run(main())
  `, { HARNESS_EVAL_HOST_NODE_SHA256: '0'.repeat(64) });
  assert.match(result.error, /digest mismatch/);
});

test('Python rejects a FIFO host Node candidate promptly instead of blocking on open', (t) => {
  if (process.platform === 'win32') return t.skip('mkfifo is not portable to Windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-python-node-fifo-'));
  const fifo = path.join(root, 'node');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (created.error || created.status !== 0) return t.skip(`mkfifo unavailable: ${created.error?.code ?? created.stderr}`);
  const result = runPython(`
import asyncio, json, pathlib, tempfile
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

condition = pathlib.Path(tempfile.mkdtemp()) / "condition.json"
condition.write_text("{}")

async def main():
    agent = StdioBridgeAgent()
    agent._extra_env = {"HARNESS_EVAL_TB_CONDITION": str(condition)}
    try:
        await agent.run("instruction", None, object())
    except RuntimeError as error:
        print(json.dumps({"error": str(error)}))
        return
    raise AssertionError("FIFO host Node candidate was accepted")

asyncio.run(main())
  `, {
    HARNESS_EVAL_HOST_NODE: fifo,
    HARNESS_EVAL_HOST_NODE_SHA256: '0'.repeat(64),
  }, { timeout: 15_000 });
  assert.match(result.error, /protected executable regular file/);
});

test('Python requires no-follow support and a Linux descriptor execution target', () => {
  const result = runPython(`
import json, os, sys
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

agent = StdioBridgeAgent()
original_platform = sys.platform
original_isdir = os.path.isdir
sys.platform = "linux"
os.path.isdir = lambda value: True if value == "/proc/self/fd" else original_isdir(value)
try:
    linux_target = agent._node_descriptor_path(7)
finally:
    sys.platform = original_platform
    os.path.isdir = original_isdir

unsupported = None
try:
    agent._node_descriptor_path(7)
except RuntimeError as error:
    unsupported = str(error)

original_no_follow = os.O_NOFOLLOW
del os.O_NOFOLLOW
try:
    try:
        agent._open_attested_node(os.environ["HARNESS_EVAL_HOST_NODE"], os.environ["HARNESS_EVAL_HOST_NODE_SHA256"])
    except RuntimeError as error:
        missing_no_follow = str(error)
finally:
    os.O_NOFOLLOW = original_no_follow

print(json.dumps({"linuxTarget": linux_target, "unsupported": unsupported, "missingNoFollow": missing_no_follow}))
`);
  assert.equal(result.linuxTarget, '/proc/self/fd/7');
  assert.match(result.unsupported, /Linux.*descriptor/i);
  assert.match(result.missingNoFollow, /O_NOFOLLOW/i);
});

test('Python redacts active secrets again before host persistence and Harbor context', () => {
  const secret = 'sentinel-python-secret-789012';
  const result = runPython(`
import asyncio, json, pathlib, tempfile
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

root = pathlib.Path(tempfile.mkdtemp())
done_file = root / "done.json"

class Context:
    metadata = {}

class Agent(StdioBridgeAgent):
    async def _collect_evidence(self, environment):
        return {
            "workspaceEvidence": {"available": False, "reason": "evidence-probe-collect-unavailable"},
            "harnessEvents": [{"type": "provider-${secret}"}],
            "harnessEventEvidence": {"available": False, "reason": "provider-${secret}"},
            "enforcement": {"hooksActive": False, "source": "provider-${secret}"},
        }

async def main():
    agent = Agent()
    agent._extra_env = {"HARNESS_EVAL_TB_TELEMETRY_FILE": str(done_file)}
    done = {
        "answer": "provider-${secret}",
        "telemetry": {"events": [{"generationId": "provider-${secret}"}], "totals": {}},
    }
    await agent._enrich_done(None, done)
    context = Context()
    agent._populate_context(context, done)
    print(json.dumps({"done": done, "persisted": json.loads(done_file.read_text()), "context": context.metadata}))

asyncio.run(main())
`, { OPENROUTER_API_KEY: secret });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.match(JSON.stringify(result), /REDACTED_SECRET/);
});

test('Python redaction recognizes common credential variable-name families', () => {
  const secrets = {
    SERVICE_KEY: 'sentinel-service-key-123',
    DB_PASSWD: 'sentinel-db-passwd-123',
    LOGIN_PASS: 'sentinel-login-pass-123',
    CLOUD_CREDENTIAL: 'sentinel-credential-123',
    CLOUD_CREDENTIALS: 'sentinel-credentials-123',
    GITHUB_PAT: 'sentinel-github-pat-123',
  };
  const result = runPython(`
import json, os
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

agent = StdioBridgeAgent()
values = [os.environ[name] for name in ${JSON.stringify(Object.keys(secrets))}]
print(json.dumps({"redacted": agent._redact("|".join(values)), "count": len(agent._active_secrets())}))
`, secrets);
  assert.doesNotMatch(result.redacted, /sentinel-/);
  assert.ok(result.count >= Object.keys(secrets).length);
});

test('Python timeout capability detection never retries a command-side TypeError', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Environment:
    def __init__(self): self.calls = 0
    async def exec(self, command=None, timeout_sec=None):
        self.calls += 1
        raise TypeError("command implementation failed")

async def main():
    environment = Environment()
    try:
        await StdioBridgeAgent()._exec(environment, "printf safe", timeout_ms=100)
    except TypeError as error:
        print(json.dumps({"calls": environment.calls, "message": str(error)}))

asyncio.run(main())
`);
  assert.equal(result.calls, 1);
  assert.match(result.message, /command implementation failed/);
});

test('Python retries once when an inspected Harbor callable rejects timeout_sec at invocation', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Result:
    return_code = 0
    output = "not-an-envelope"
    stderr = ""

class Environment:
    def __init__(self): self.calls = []
    def exec(self, command=None, **kwargs):
        self.calls.append(sorted(kwargs.keys()))
        if "timeout_sec" in kwargs:
            raise TypeError("exec() got an unexpected keyword argument 'timeout_sec'")
        async def completed():
            return Result()
        return completed()

async def main():
    environment = Environment()
    result = await StdioBridgeAgent()._exec(environment, "printf safe", timeout_ms=100)
    print(json.dumps({"calls": environment.calls, "result": result}))

asyncio.run(main())
`);
  assert.deepEqual(result.calls, [['timeout_sec'], []]);
  assert.equal(result.result.code, 125, 'the fallback result continues through the normal bounded-envelope path');
});

test('Python applies an outer timeout even when Harbor accepts timeout_sec', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Result:
    return_code = 0
    output = "not-an-envelope"
    stderr = ""

class Environment:
    async def exec(self, command=None, timeout_sec=None):
        return Result()

async def main():
    original = asyncio.wait_for
    observed = []
    async def fail_fast(awaitable, timeout):
        observed.append(timeout)
        awaitable.close()
        raise asyncio.TimeoutError()
    asyncio.wait_for = fail_fast
    try:
        result = await StdioBridgeAgent()._exec(Environment(), "printf safe", timeout_ms=100)
    finally:
        asyncio.wait_for = original
    print(json.dumps({"result": result, "timeouts": observed}))

asyncio.run(main())
`);
  assert.equal(result.result.code, 124);
  assert.equal(result.result.timedOut, true);
  assert.equal(result.result.containmentMode, 'harbor-outer-timeout');
  assert.equal(result.result.containmentComplete, false);
  assert.deepEqual(result.timeouts, [11]);
});

test('Python gives Harbor implementations without timeout_sec the same containment grace', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Environment:
    async def exec(self, command=None):
        return object()

async def main():
    original = asyncio.wait_for
    observed = []
    async def fail_fast(awaitable, timeout):
        observed.append(timeout)
        awaitable.close()
        raise asyncio.TimeoutError()
    asyncio.wait_for = fail_fast
    try:
        result = await StdioBridgeAgent()._exec(Environment(), "printf safe", timeout_ms=100)
    finally:
        asyncio.wait_for = original
    print(json.dumps({"result": result, "timeouts": observed}))

asyncio.run(main())
  `);
  assert.equal(result.result.code, 124);
  assert.equal(result.result.containmentComplete, false);
  assert.deepEqual(result.timeouts, [11]);
});

test('Python applies a finite default deadline when callers omit timeout_ms', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Result:
    return_code = 0
    stderr = ""
    output = json.dumps({
        "version": 1,
        "code": 0,
        "stdoutB64": "",
        "stderrB64": "",
        "stdoutTruncated": False,
        "stderrTruncated": False,
        "timedOut": False,
        "containmentMode": "linux-process-census",
        "containmentComplete": True,
    })

class Environment:
    def __init__(self): self.command = None; self.timeout = None
    async def exec(self, command=None, timeout_sec=None):
        self.command = command
        self.timeout = timeout_sec
        return Result()

async def main():
    environment = Environment()
    result = await StdioBridgeAgent()._exec(environment, "printf safe")
    print(json.dumps({
        "code": result["code"],
        "command": environment.command,
        "timeout": environment.timeout,
    }))

asyncio.run(main())
`);
  assert.equal(result.code, 0);
  assert.equal(result.timeout, 125, '120-second command deadline plus five-second containment grace');
  assert.match(result.command, /\s120000$/);
});

test('Python trusted verification executes only the immutable bridge-owned command', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Agent(StdioBridgeAgent):
    def __init__(self):
        self.calls = []
        self.complete = True
    async def _exec(self, environment, command, **kwargs):
        self.calls.append({"command": command, **kwargs})
        return {
            "code": 0,
            "stdout": "bounded",
            "stderr": "",
            "stdoutTruncated": False,
            "stderrTruncated": False,
            "timedOut": False,
            "containmentMode": "linux-process-census",
            "containmentComplete": self.complete,
            "_parsedJson": {
                "outcome": "passed",
                "plan": "docs/plans/task.md",
                "evidencePath": ".harness/evidence/task.json",
                "unverifiedCriteria": [],
                "scopeViolations": [],
                "openHardGaps": [],
                "requiredReviews": [],
            },
        }

async def main():
    agent = Agent()
    passed = await agent._trusted_verify(None)
    agent.complete = False
    incomplete = await agent._trusted_verify(None)
    agent.complete = True
    agent.calls[-1:] = []
    original_exec = agent._exec
    async def malformed(*args, **kwargs):
        result = await original_exec(*args, **kwargs)
        result["_parsedJson"]["unverifiedCriteria"] = "not-a-list"
        return result
    agent._exec = malformed
    malformed_result = await agent._trusted_verify(None)
    print(json.dumps({"passed": passed, "incomplete": incomplete, "malformed": malformed_result, "calls": agent.calls}))

asyncio.run(main())
`);
  assert.equal(result.passed.passed, true);
  assert.equal(result.passed.trustedVerification, true);
  assert.equal(result.passed.containmentComplete, true);
  assert.equal(result.incomplete.passed, false, 'valid verifier JSON cannot override incomplete process containment');
  assert.equal(result.malformed.passed, false, 'malformed verifier collections fail closed instead of being sliced as strings');
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].command, '/opt/harness-bundle/harness-cli verify --workspace . --json');
  assert.equal(result.calls[0].parse_json, true);
});

test('Python bridge preserves every bounded workspace probe failure reason', () => {
  const result = runPython(`
import json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent
print(json.dumps(sorted(StdioBridgeAgent._EVIDENCE_REASONS)))
`);
  for (const reason of [
    'workspace-ancestor-identity-ambiguous',
    'workspace-depth-limit-exceeded',
    'workspace-directory-limit-exceeded',
    'workspace-entry-changed-during-read',
    'workspace-entry-not-regular-file',
    'workspace-node-limit-exceeded',
    'workspace-root-unreadable',
    'workspace-unsupported-node',
  ]) assert.ok(result.includes(reason), reason);
  assert.equal(result.includes('workspace-entry-unreadable'), false);
});

test('Python bridge resolves a small authenticated frame to a bounded large done ledger', () => {
  const result = runPython(`
import asyncio, hashlib, json, os, pathlib, tempfile
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

root = pathlib.Path(tempfile.mkdtemp())
condition = root / "condition.json"
condition.write_text("{}")
done_file = root / "done.json"
done = {"type": "done", "answer": "x" * 120000, "stopReason": "model_finish", "telemetry": {"events": [], "totals": {}}}
done_bytes = json.dumps(done).encode()
done_file.write_bytes(done_bytes)
reference = {"type": "done", "doneFilePersisted": True, "doneBytes": len(done_bytes), "doneHash": hashlib.sha256(done_bytes).hexdigest()}
line = (json.dumps(reference) + "\\n").encode()
captured = {}

class Proc:
    def __init__(self, reader):
        self.stdout = reader
        self.returncode = None
        self.stdin = None
    def terminate(self): self.returncode = 0
    async def wait(self):
        if self.returncode is None: self.returncode = 0
        return self.returncode

async def fake_subprocess(*args, **kwargs):
    inherited = list(kwargs.get("pass_fds", ()))
    captured["executable"] = args[0]
    captured["passFds"] = inherited
    captured["descriptorOpenAtSpawn"] = bool(inherited)
    if inherited:
        os.fstat(inherited[0])
    captured["limitPresent"] = "limit" in kwargs
    captured["limit"] = kwargs.get("limit")
    captured["expectedLimit"] = StdioBridgeAgent._MAX_PROTOCOL_LINE_BYTES
    captured["frameBytes"] = len(line)
    reader = asyncio.StreamReader(limit=captured["limit"])
    reader.feed_data(line)
    reader.feed_eof()
    return Proc(reader)

class Agent(StdioBridgeAgent):
    async def _enrich_done(self, environment, message): pass
    def _populate_context(self, context, message): captured["answerLength"] = len(message["answer"])
    def _node_descriptor_path(self, descriptor):
        captured["descriptor"] = descriptor
        return f"/attested-node-fd/{descriptor}"

async def main():
    original = asyncio.create_subprocess_exec
    asyncio.create_subprocess_exec = fake_subprocess
    try:
        agent = Agent()
        agent._extra_env = {"HARNESS_EVAL_TB_CONDITION": str(condition), "HARNESS_EVAL_TB_TELEMETRY_FILE": str(done_file)}
        await agent.run("instruction", None, object())
        try:
            os.fstat(captured["descriptor"])
            captured["descriptorClosedAfterSpawn"] = False
        except OSError:
            captured["descriptorClosedAfterSpawn"] = True
    finally:
        asyncio.create_subprocess_exec = original
    print(json.dumps(captured))

asyncio.run(main())
`);
  assert.ok(result.frameBytes < 1024, 'the protocol frame stays small regardless of ledger size');
  assert.equal(result.answerLength, 120_000);
  assert.equal(result.executable, `/attested-node-fd/${result.descriptor}`);
  assert.deepEqual(result.passFds, [result.descriptor]);
  assert.equal(result.descriptorOpenAtSpawn, true);
  assert.equal(result.descriptorClosedAfterSpawn, true);
  assert.equal(result.limitPresent, true, 'the subprocess call must set an explicit framing bound');
  assert.equal(result.limit, result.expectedLimit, 'the subprocess reader uses the production protocol limit');
  assert.ok(result.limit <= 512 * 1024, 'the protocol line remains explicitly bounded');
});

test('Python command wrapping bounds streams before Harbor buffers them and preserves status', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Result:
    def __init__(self, code, output, stderr):
        self.return_code = code
        self.output = output
        self.stderr = stderr

class Environment:
    def __init__(self): self.buffered = []
    async def exec(self, command=None, **kwargs):
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        self.buffered.append((len(stdout), len(stderr)))
        return Result(proc.returncode, stdout, stderr)

class Agent(StdioBridgeAgent):
    _CAPTURE_RUNNER = ${JSON.stringify(`${process.execPath} ${path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs')}`)}

async def main():
    environment = Environment()
    agent = Agent()
    command = "python3 -c 'import sys; print(chr(65) * 2000000); print(chr(66) * 2000000, file=sys.stderr); sys.exit(7)'"
    result = await agent._exec(environment, command)
    print(json.dumps({"result": result, "buffered": environment.buffered}))

asyncio.run(main())
`);
  assert.equal(result.result.code, 7);
  assert.equal(result.result.stdout.length, 6000);
  assert.equal(result.result.stderr.length, 2000);
  assert.equal(result.result.stdoutTruncated, true);
  assert.equal(result.result.stderrTruncated, true);
  assert.equal(result.result.timedOut, false);
  assert.match(result.result.containmentMode, /^(linux-process-census|process-group-nonlinux)$/);
  assert.equal(result.result.containmentComplete, true);
  assert.ok(result.buffered[0][0] < 200_000, 'Harbor sees only a finite encoded envelope, not the multi-megabyte child stream');
  assert.equal(result.buffered[0][1], 0);
});

test('Python exposes parsed JSON only to explicitly trusted bridge probes', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Result:
    def __init__(self, code, output, stderr):
        self.return_code = code
        self.output = output
        self.stderr = stderr

class Environment:
    async def exec(self, command=None, **kwargs):
        proc = await asyncio.create_subprocess_shell(command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await proc.communicate()
        return Result(proc.returncode, stdout, stderr)

class Agent(StdioBridgeAgent):
    _CAPTURE_RUNNER = ${JSON.stringify(`${process.execPath} ${path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs')}`)}

async def main():
    agent = Agent()
    command = "python3 -c 'import json; print(json.dumps(dict(payload=chr(120) * 9000)))'"
    ordinary = await agent._exec(Environment(), command)
    trusted = await agent._exec(Environment(), command, parse_json=True)
    print(json.dumps({
        "ordinaryParsed": "parsedStdout" in ordinary or "_parsedJson" in ordinary,
        "trustedLength": len(trusted["_parsedJson"]["payload"]),
        "visibleLength": len(trusted["stdout"]),
    }))

asyncio.run(main())
`);
  assert.equal(result.ordinaryParsed, false);
  assert.equal(result.trustedLength, 9000);
  assert.equal(result.visibleLength, 6000);
});
