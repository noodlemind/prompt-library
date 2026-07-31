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

function tmpdir(prefix = 'tb-security-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function preparedFixture() {
  const fixtureRoot = tmpdir('tb-bundle-fixture-');
  const bundleDir = path.join(tmpdir('tb-bundle-output-'), 'bundle');
  fs.mkdirSync(path.join(fixtureRoot, 'packages', 'harness', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'packages', 'harness', 'package.json'), JSON.stringify({ name: '@fixture/harness' }));
  fs.writeFileSync(path.join(fixtureRoot, 'packages', 'harness', 'bin', 'harness.mjs'), 'process.stdout.write("ok\\n")');
  fs.writeFileSync(path.join(fixtureRoot, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'), 'process.stdout.write("{}\\n")');
  fs.writeFileSync(path.join(fixtureRoot, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'), 'process.stdout.write("{}\\n")');

  const prepared = prepareHarnessBundle({
    bundleDir,
    repoRoot: fixtureRoot,
    nodeTarballs: { x64: '/unused/node-x64.tar.gz', arm64: null },
    spawnImpl: (command, args) => {
      if (command === 'cp') fs.cpSync(args[1], args[2], { recursive: true });
      if (command === 'tar') {
        const destination = args[args.indexOf('-C') + 1];
        fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(destination, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
      }
      return { status: 0, stderr: '' };
    },
  });
  return { fixtureRoot, bundleDir, prepared };
}

test('prepared bundles require an out-of-bundle digest and validate exact content', () => {
  const { bundleDir, prepared } = preparedFixture();
  assert.match(prepared.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(bundleDir, BUNDLE_MANIFEST_FILE)), true);
  assert.equal(validatePrebuiltBundle(bundleDir, { expectedManifestHash: prepared.manifestHash }).manifestHash, prepared.manifestHash);
  assert.throws(() => validatePrebuiltBundle(bundleDir), /expected manifest digest/i);

  fs.writeFileSync(path.join(bundleDir, 'harness', 'unexpected-secret.txt'), 'do not mount me');
  assert.throws(
    () => validatePrebuiltBundle(bundleDir, { expectedManifestHash: prepared.manifestHash }),
    /contents|manifest|unexpected/i
  );
});

test('prebuilt bundles are mounted from a separately validated runner-owned snapshot', () => {
  const { bundleDir, prepared } = preparedFixture();
  const destination = path.join(tmpdir('tb-materialized-parent-'), 'materialized');
  const materialized = materializePrebuiltBundle(bundleDir, {
    destination,
    expectedManifestHash: prepared.manifestHash,
  });
  assert.equal(materialized.bundleDir, fs.realpathSync(destination));
  assert.equal(materialized.mount.source, fs.realpathSync(destination));
  assert.notEqual(materialized.mount.source, fs.realpathSync(bundleDir));
  fs.writeFileSync(path.join(bundleDir, 'harness', 'post-validation-mutation'), 'source changed');
  assert.equal(fs.existsSync(path.join(destination, 'harness', 'post-validation-mutation')), false);
  assert.equal(validatePrebuiltBundle(destination, { expectedManifestHash: prepared.manifestHash }).manifestHash, prepared.manifestHash);
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
    () => validatePrebuiltBundle(bundleDir, { expectedManifestHash: prepared.manifestHash }),
    /manifest digest/i
  );
});

test('bundle validation rejects broad paths, symlink roots, and escaping symlinks', () => {
  const { bundleDir, prepared } = preparedFixture();
  for (const broad of ['/', os.homedir(), repoRoot]) {
    assert.throws(
      () => validatePrebuiltBundle(broad, { expectedManifestHash: prepared.manifestHash, repoRoot }),
      /broad|root|ancestor|home|repository/i,
      broad
    );
  }

  const linked = path.join(tmpdir(), 'linked-bundle');
  fs.symlinkSync(bundleDir, linked, 'dir');
  assert.throws(
    () => validatePrebuiltBundle(linked, { expectedManifestHash: prepared.manifestHash }),
    /symlink|canonical/i
  );

  const wrapper = path.join(bundleDir, 'harness-cli');
  fs.unlinkSync(wrapper);
  fs.symlinkSync('/etc/passwd', wrapper);
  assert.throws(
    () => validatePrebuiltBundle(bundleDir, { expectedManifestHash: prepared.manifestHash }),
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
