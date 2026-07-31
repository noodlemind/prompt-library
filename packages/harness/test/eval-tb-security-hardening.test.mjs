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
  fs.mkdirSync(path.join(destination, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.cpSync(path.join(sourceRoot, 'packages', 'harness'), path.join(destination, 'packages', 'harness'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  for (const file of ['evidence-probe.mjs', 'bounded-exec.mjs']) {
    fs.copyFileSync(
      path.join(sourceRoot, 'evals', 'external', 'terminal_bench', file),
      path.join(destination, 'evals', 'external', 'terminal_bench', file)
    );
  }
}

function preparedFixture() {
  const fixtureRoot = tmpdir('tb-bundle-fixture-');
  const bundleDir = path.join(tmpdir('tb-bundle-output-'), 'bundle');
  fs.mkdirSync(path.join(fixtureRoot, 'packages', 'harness', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'packages', 'harness', 'package.json'), JSON.stringify({ name: '@fixture/harness' }));
  fs.symlinkSync('package.json', path.join(fixtureRoot, 'packages', 'harness', 'package-link.json'));
  fs.writeFileSync(path.join(fixtureRoot, 'packages', 'harness', 'bin', 'harness.mjs'), 'process.stdout.write("ok\\n")');
  fs.writeFileSync(path.join(fixtureRoot, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'), 'process.stdout.write("{}\\n")');
  fs.writeFileSync(path.join(fixtureRoot, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'), 'process.stdout.write("{}\\n")');
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

test('Node runtime archives require an exact SHA-256 pin and reject symlink inputs', () => {
  const fixtureRoot = tmpdir('tb-runtime-pin-fixture-');
  fs.mkdirSync(path.join(fixtureRoot, 'packages', 'harness'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'), '');
  fs.writeFileSync(path.join(fixtureRoot, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'), '');
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
  fs.mkdirSync(path.join(sourceRoot, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'packages', 'harness', 'package.json'), '{"name":"committed-harness"}\n');
  fs.writeFileSync(path.join(sourceRoot, 'packages', 'harness', 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  fs.writeFileSync(path.join(sourceRoot, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'), 'committed probe\n');
  fs.writeFileSync(path.join(sourceRoot, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'), 'committed exec\n');
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
    calls.push([command, args]);
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

  prepareHarnessBundle({
    bundleDir,
    repoRoot: sourceRoot,
    sourceIdentity: { releaseSha, harnessVersion: '1.2.3-test' },
    nodeTarballs: { x64: nodeTarball, arm64: null },
    nodeTarballHashes: { x64: sha256(fs.readFileSync(nodeTarball)), arm64: null },
    spawnImpl,
  });

  assert.equal(fs.readFileSync(path.join(bundleDir, 'harness', 'package.json'), 'utf8'), '{"name":"committed-harness"}\n');
  assert.equal(fs.existsSync(path.join(bundleDir, 'harness', 'node_modules', 'ignored-secret')), false);
  assert.equal(fs.readFileSync(path.join(bundleDir, 'evidence-probe.mjs'), 'utf8'), 'committed probe\n');
  assert.ok(calls.some(([command, args]) => command === 'git' && args[0] === 'archive' && args.includes(releaseSha)));
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
  assert.equal(materialized.mount.source, fs.realpathSync(destination));
  assert.notEqual(materialized.mount.source, fs.realpathSync(bundleDir));
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
    /changed|digest|size|manifest/i
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

function runPython(source, env = {}) {
  const result = spawnSync('python3', ['-c', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      PYTHONPATH: process.env.PYTHONPATH ? `${repoRoot}${path.delimiter}${process.env.PYTHONPATH}` : repoRoot,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

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

test('Python trusted verification executes only the immutable bridge-owned command', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Agent(StdioBridgeAgent):
    def __init__(self): self.calls = []
    async def _exec(self, environment, command, **kwargs):
        self.calls.append({"command": command, **kwargs})
        return {
            "code": 0,
            "stdout": "bounded",
            "stderr": "",
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
    print(json.dumps({"passed": passed, "calls": agent.calls}))

asyncio.run(main())
`);
  assert.equal(result.passed.passed, true);
  assert.equal(result.passed.trustedVerification, true);
  assert.equal(result.calls.length, 1);
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
  ]) assert.ok(result.includes(reason), reason);
  assert.equal(result.includes('workspace-entry-unreadable'), false);
});

test('Python bridge resolves a small authenticated frame to a bounded large done ledger', () => {
  const result = runPython(`
import asyncio, hashlib, json, pathlib, tempfile
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

async def main():
    original = asyncio.create_subprocess_exec
    asyncio.create_subprocess_exec = fake_subprocess
    try:
        agent = Agent()
        agent._extra_env = {"HARNESS_EVAL_TB_CONDITION": str(condition), "HARNESS_EVAL_TB_TELEMETRY_FILE": str(done_file)}
        await agent.run("instruction", None, object())
    finally:
        asyncio.create_subprocess_exec = original
    print(json.dumps(captured))

asyncio.run(main())
`);
  assert.ok(result.frameBytes < 1024, 'the protocol frame stays small regardless of ledger size');
  assert.equal(result.answerLength, 120_000);
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
