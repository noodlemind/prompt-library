import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { manifest, writeStateJson } from '../../../evals/external/terminal_bench/evidence-probe.mjs';
import {
  BUNDLE_MOUNT_TARGET,
  evidenceProbeWrapperScript,
  prepareHarnessBundle,
} from '../../../evals/external/terminal_bench/provision.mjs';

const probe = fileURLToPath(new URL('../../../evals/external/terminal_bench/evidence-probe.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-evidence-'));
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [probe, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runFailure(cwd, args) {
  const result = spawnSync(process.execPath, [probe, ...args], { cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stdout);
  return result;
}

function runPython(source) {
  const result = spawnSync('python3', ['-c', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH ? `${repoRoot}${path.delimiter}${process.env.PYTHONPATH}` : repoRoot },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('the sandbox probe records a deterministic manifest and a content-based changed-path diff', () => {
  const cwd = workspace();
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'a.c'), 'before\n');
  fs.writeFileSync(path.join(cwd, 'unchanged.txt'), 'same\n');

  const before = run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  assert.equal(before.available, true);
  assert.equal(before.fileCount, 2);
  assert.match(before.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(
    run(cwd, ['snapshot', '--output', '.harness/eval-before-copy.json']).manifestHash,
    before.manifestHash,
    'the same bytes produce the same manifest independently of probe state files'
  );

  fs.writeFileSync(path.join(cwd, 'src', 'a.c'), 'after\n');
  fs.writeFileSync(path.join(cwd, 'src', 'b.c'), 'new\n');
  fs.unlinkSync(path.join(cwd, 'unchanged.txt'));
  const collected = run(cwd, ['collect', '--before', '.harness/eval-before.json']);

  assert.equal(collected.workspaceEvidence.available, true);
  assert.notEqual(collected.workspaceEvidence.beforeManifestHash, collected.workspaceEvidence.afterManifestHash);
  assert.match(collected.workspaceEvidence.diffHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(collected.workspaceEvidence.changedPaths, ['src/a.c', 'src/b.c', 'unchanged.txt']);
  assert.equal(collected.workspaceEvidence.changedPathCount, 3);
  assert.equal(collected.workspaceEvidence.changedPathsTruncated, false);
  assert.ok(!JSON.stringify(collected).includes('before\n'));
  assert.ok(!JSON.stringify(collected).includes('after\n'), 'raw source never leaves the sandbox probe');
});

test('probe-owned, git, and harness files never contaminate the product diff', () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'same');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.git', 'index'), 'old');
  run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  fs.writeFileSync(path.join(cwd, '.git', 'index'), 'new');
  fs.appendFileSync(path.join(cwd, '.harness', 'events.jsonl'), '{"type":"orient"}\n');
  const collected = run(cwd, ['collect', '--before', '.harness/eval-before.json']);
  assert.deepEqual(collected.workspaceEvidence.changedPaths, []);
  assert.match(collected.workspaceEvidence.diffHash, /^[a-f0-9]{64}$/);
});

test('a sandbox-tampered baseline is reported unavailable against the host-retained start hash', () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'before');
  const before = run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  const baselinePath = path.join(cwd, '.harness', 'eval-before.json');
  const forged = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  forged.entries[0].sha256 = 'f'.repeat(64);
  fs.writeFileSync(baselinePath, JSON.stringify(forged));
  const collected = run(cwd, [
    'collect',
    '--before',
    '.harness/eval-before.json',
    '--expected-before-hash',
    before.manifestHash,
  ]);
  assert.equal(collected.workspaceEvidence.available, false);
  assert.equal(collected.workspaceEvidence.reason, 'before-manifest-unavailable');
});

test('workspace byte limits fail evidence closed without failing the probe process', () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'oversized.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
  const before = run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  assert.equal(before.available, false);
  assert.equal(before.reason, 'workspace-file-byte-limit-exceeded');
  assert.equal(before.manifestHash, null);
});

test('workspace traversal has independent directory, node, and depth bounds with explicit evidence reasons', () => {
  const cwd = workspace();
  let directory = cwd;
  for (let index = 0; index < 66; index += 1) {
    directory = path.join(directory, 'd');
    fs.mkdirSync(directory);
  }
  const before = run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  assert.equal(before.available, false);
  assert.equal(before.reason, 'workspace-depth-limit-exceeded');

  const state = JSON.parse(fs.readFileSync(path.join(cwd, '.harness', 'eval-before.json'), 'utf8'));
  assert.ok(state.limits.maxDirectories > 0);
  assert.ok(state.limits.maxNodes > 0);
  assert.ok(state.limits.maxDepth > 0);
  assert.ok(Number.isInteger(state.directoryCount));
  assert.ok(Number.isInteger(state.nodeCount));
});

test('directory enumeration stops at the node cap before retaining and sorting an unbounded name list', () => {
  const cwd = workspace();
  for (let index = 0; index < 17; index += 1) {
    fs.writeFileSync(path.join(cwd, `entry-${String(index).padStart(2, '0')}`), '');
  }

  const result = manifest(cwd, { maxNodes: 16 });

  assert.equal(result.available, false);
  assert.equal(result.reason, 'workspace-node-limit-exceeded');
  assert.equal(result.nodeCount, 17, 'the collector reads only the single entry needed to prove the cap was exceeded');
  assert.equal(result.limits.maxNodes, 16);
});

test('an opened directory cannot be redirected through an ancestor symlink race', () => {
  const cwd = workspace();
  const outside = workspace();
  fs.mkdirSync(path.join(cwd, 'nested'));
  fs.writeFileSync(path.join(cwd, 'nested', 'inside.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'outside-secret.txt'), 'must-not-be-hashed');
  let swapped = false;

  const result = manifest(cwd, {
    onDirectoryOpened({ relative }) {
      if (relative !== 'nested' || swapped) return;
      swapped = true;
      fs.renameSync(path.join(cwd, 'nested'), path.join(cwd, 'parked'));
      fs.symlinkSync(outside, path.join(cwd, 'nested'), 'dir');
    },
  });

  assert.equal(swapped, true);
  if (result.containmentMode === 'descriptor-relative-procfs') {
    assert.equal(result.available, true);
    assert.deepEqual(result.entries.map((entry) => entry.path), ['nested/inside.txt']);
    assert.ok(!JSON.stringify(result).includes('outside-secret'));
  } else {
    assert.equal(result.available, false);
    assert.equal(result.reason, 'workspace-ancestor-identity-ambiguous');
    assert.equal(result.containmentMode, 'identity-checked-path-fallback');
  }
});

test('untrusted FIFO read candidates fail promptly instead of blocking before fstat', (t) => {
  const cwd = workspace();
  const fifo = path.join(cwd, 'candidate');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (created.error?.code === 'ENOENT') {
    t.skip('mkfifo is unavailable');
    return;
  }
  assert.equal(created.status, 0, created.stderr);
  const source = `
    import { readRegularFileNoFollow } from ${JSON.stringify(pathToFileURL(probe).href)};
    try {
      readRegularFileNoFollow(process.argv[1], 1024);
      process.exitCode = 3;
    } catch (error) {
      process.stdout.write(String(error.evidenceReason ?? error.message));
    }
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, fifo], {
    encoding: 'utf8',
    timeout: 2_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'workspace-entry-not-regular-file');
});

test('probe state cannot escape through a symlinked .harness directory or nested state directory', () => {
  const outside = workspace();

  const symlinkedHarness = workspace();
  fs.symlinkSync(outside, path.join(symlinkedHarness, '.harness'));
  const harnessFailure = runFailure(symlinkedHarness, ['snapshot', '--output', '.harness/eval-before.json']);
  assert.match(harnessFailure.stderr, /state.*symlink|\.harness.*directory/i);
  assert.equal(fs.existsSync(path.join(outside, 'eval-before.json')), false);

  const symlinkedState = workspace();
  fs.mkdirSync(path.join(symlinkedState, '.harness'));
  fs.symlinkSync(outside, path.join(symlinkedState, '.harness', 'state'));
  const stateFailure = runFailure(symlinkedState, ['snapshot', '--output', '.harness/state/eval-before.json']);
  assert.match(stateFailure.stderr, /state.*symlink/i);
  assert.equal(fs.existsSync(path.join(outside, 'eval-before.json')), false);
});

test('an opened state parent cannot be redirected before the atomic write', () => {
  const cwd = workspace();
  const outside = workspace();
  fs.mkdirSync(path.join(cwd, '.harness', 'state'), { recursive: true });
  let containmentMode = null;
  let failure = null;

  try {
    writeStateJson(cwd, '.harness/state/eval.json', { ok: true }, {
      onParentOpened(info) {
        containmentMode = info.containmentMode;
        fs.renameSync(path.join(cwd, '.harness', 'state'), path.join(cwd, '.harness', 'parked'));
        fs.symlinkSync(outside, path.join(cwd, '.harness', 'state'), 'dir');
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(fs.existsSync(path.join(outside, 'eval.json')), false, 'the raced external directory is never written');
  if (containmentMode === 'descriptor-relative-procfs') {
    assert.equal(failure, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.harness', 'parked', 'eval.json'), 'utf8')), { ok: true });
  } else {
    assert.match(failure?.evidenceReason ?? failure?.message ?? '', /ancestor-identity-ambiguous/);
    assert.equal(fs.existsSync(path.join(cwd, '.harness', 'parked', 'eval.json')), false);
  }
});

test('changed-path detail is bounded while the complete diff count and hash are retained', () => {
  const cwd = workspace();
  run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  for (let index = 0; index < 205; index += 1) {
    fs.writeFileSync(path.join(cwd, `file-${String(index).padStart(3, '0')}.txt`), `${index}`);
  }
  const collected = run(cwd, ['collect', '--before', '.harness/eval-before.json']);
  assert.equal(collected.workspaceEvidence.changedPaths.length, 200);
  assert.equal(collected.workspaceEvidence.changedPathCount, 205);
  assert.equal(collected.workspaceEvidence.changedPathsTruncated, true);
  assert.match(collected.workspaceEvidence.diffHash, /^[a-f0-9]{64}$/);
});

test('harness events are bounded and projected through a redacted allowlist', () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'same');
  run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  const events = Array.from({ length: 230 }, (_, i) => ({
    version: 2,
    id: `event-${i}`,
    ts: `2026-07-31T00:00:${String(i % 60).padStart(2, '0')}Z`,
    type: i === 229 ? 'verify' : 'orient',
    command: i === 229 ? 'verify' : 'orient',
    result: 'pass',
    exitCode: 0,
    secretField: `must-not-leave-${i}`,
  }));
  fs.writeFileSync(path.join(cwd, '.harness', 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
  const collected = run(cwd, ['collect', '--before', '.harness/eval-before.json']);
  assert.equal(collected.harnessEvents.length, 200);
  assert.equal(collected.harnessEvents.at(-1).type, 'verify');
  assert.ok(collected.harnessEvents.every((event) => !('secretField' in event)));
  assert.ok(collected.harnessEvents.every((event) => !('command' in event)), 'full commands are never exported');
  assert.ok(!JSON.stringify(collected).includes('must-not-leave'), 'unknown secret-bearing values are not exported');
  assert.equal(collected.enforcement.hooksActive, false, 'ordinary CLI lifecycle events are not mechanical hook evidence');
  assert.deepEqual(collected.harnessEventEvidence, {
    available: true,
    complete: false,
    reason: 'harness-events-retention-limit-exceeded',
    retainedEvents: 200,
    sourceTruncated: true,
    projectionRejectedEvents: 0,
    projectionRejectedChecks: 0,
  });
});

test('realistic gate and verify checks survive projection while secrets do not', () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'same');
  run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  const sentinel = 'sentinel-provider-key-must-not-leave';
  const events = [
    {
      version: 2,
      id: 'gate-event',
      ts: '2026-07-31T00:00:01Z',
      type: 'gate',
      result: 'warn',
      checks: [
        { id: 'C1', pass: true, severity: 'ok', message: `plan includes ${sentinel}` },
        { id: 'C2', pass: false, severity: 'warn', secret: sentinel },
      ],
      providerSecret: sentinel,
    },
    {
      version: 2,
      id: 'verify-event',
      ts: '2026-07-31T00:00:02Z',
      type: 'verify',
      result: 'pass',
      checks: [{ id: 'harness-tests', pass: true, severity: 'ok', message: sentinel }],
    },
  ];
  fs.writeFileSync(path.join(cwd, '.harness', 'events.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`);
  const collected = run(cwd, ['collect', '--before', '.harness/eval-before.json']);

  assert.deepEqual(collected.harnessEvents.map((event) => event.type), ['gate', 'verify']);
  assert.deepEqual(collected.harnessEvents.map((event) => event.checks.length), [2, 1]);
  assert.deepEqual(collected.harnessEvents[0].checks.map((check) => check.severity), ['ok', 'warn']);
  assert.ok(collected.harnessEvents.every((event) => event.checks.every((check) => /^[a-f0-9]{24}$/.test(check.id))));
  assert.ok(!JSON.stringify(collected).includes(sentinel));
  assert.deepEqual(collected.harnessEventEvidence, {
    available: true,
    complete: true,
    reason: null,
    retainedEvents: 2,
    sourceTruncated: false,
    projectionRejectedEvents: 0,
    projectionRejectedChecks: 0,
  });
});

test('an empty harness event ledger is incomplete rather than evidence of zero behavior', () => {
  const cwd = workspace();
  run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  fs.writeFileSync(path.join(cwd, '.harness', 'events.jsonl'), '');
  const collected = run(cwd, ['collect', '--before', '.harness/eval-before.json']);
  assert.equal(collected.harnessEventEvidence.available, false);
  assert.equal(collected.harnessEventEvidence.complete, false);
  assert.equal(collected.harnessEventEvidence.reason, 'harness-events-empty');
  assert.deepEqual(collected.harnessEvents, []);
});

test('event and check projection rejects are counted and make evidence explicitly incomplete', () => {
  const cwd = workspace();
  run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  const events = [
    JSON.stringify({ type: 'gate', checks: [{ id: 'C1', pass: true, severity: 'ok' }, { id: 'C2', pass: false, severity: 'secret-value' }] }),
    '{invalid-json',
    JSON.stringify({ type: 'unknown-event', secret: 'must-not-leave' }),
  ];
  fs.writeFileSync(path.join(cwd, '.harness', 'events.jsonl'), `${events.join('\n')}\n`);
  const collected = run(cwd, ['collect', '--before', '.harness/eval-before.json']);

  assert.equal(collected.harnessEvents.length, 1);
  assert.equal(collected.harnessEvents[0].checks.length, 1);
  assert.equal(collected.harnessEventEvidence.available, true, 'the retained event remains usable');
  assert.equal(collected.harnessEventEvidence.complete, false);
  assert.equal(collected.harnessEventEvidence.projectionRejectedEvents, 2);
  assert.equal(collected.harnessEventEvidence.projectionRejectedChecks, 1);
  assert.match(collected.harnessEventEvidence.reason, /projection-rejected/);
  assert.ok(!JSON.stringify(collected).includes('secret-value'));
  assert.ok(!JSON.stringify(collected).includes('must-not-leave'));
});

test('valid checks beyond the retained projection limit are counted as rejected', () => {
  const cwd = workspace();
  run(cwd, ['snapshot', '--output', '.harness/eval-before.json']);
  const checks = Array.from({ length: 53 }, (_, index) => ({
    id: `C${index + 1}`,
    pass: true,
    severity: 'ok',
  }));
  fs.writeFileSync(path.join(cwd, '.harness', 'events.jsonl'), `${JSON.stringify({ type: 'gate', checks })}\n`);

  const collected = run(cwd, ['collect', '--before', '.harness/eval-before.json']);

  assert.equal(collected.harnessEvents[0].checks.length, 50);
  assert.equal(collected.harnessEventEvidence.projectionRejectedChecks, 3);
  assert.equal(collected.harnessEventEvidence.complete, false);
  assert.match(collected.harnessEventEvidence.reason, /projection-rejected/);
});

test('the evidence probe is bundled behind the same cross-architecture Node selection as Harness', () => {
  const root = workspace();
  const bundleDir = path.join(root, 'bundle');
  fs.mkdirSync(path.join(root, 'packages', 'harness'), { recursive: true });
  fs.mkdirSync(path.join(root, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'), 'process.stdout.write("{}\\n")');
  fs.writeFileSync(path.join(root, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'), 'process.stdout.write("{}\\n")');
  const nodeTarball = path.join(root, 'node-v-test-linux-x64.tar.gz');
  fs.writeFileSync(nodeTarball, 'pinned fixture archive bytes');
  const calls = [];
  prepareHarnessBundle({
    bundleDir,
    repoRoot: root,
    sourceIdentity: { releaseSha: 'a'.repeat(40), harnessVersion: '1.2.3-test' },
    nodeTarballs: { x64: nodeTarball, arm64: null },
    nodeTarballHashes: { x64: crypto.createHash('sha256').update(fs.readFileSync(nodeTarball)).digest('hex'), arm64: null },
    snapshotSource: ({ repoRoot: sourceRoot, destination }) => {
      fs.mkdirSync(path.join(destination, 'packages'), { recursive: true });
      fs.mkdirSync(path.join(destination, 'evals', 'external', 'terminal_bench'), { recursive: true });
      fs.cpSync(path.join(sourceRoot, 'packages', 'harness'), path.join(destination, 'packages', 'harness'), { recursive: true });
      for (const file of ['evidence-probe.mjs', 'bounded-exec.mjs']) {
        fs.copyFileSync(
          path.join(sourceRoot, 'evals', 'external', 'terminal_bench', file),
          path.join(destination, 'evals', 'external', 'terminal_bench', file)
        );
      }
    },
    spawnImpl: (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'cp') fs.cpSync(args[1], args[2], { recursive: true });
      if (cmd === 'tar') {
        const destination = args[args.indexOf('-C') + 1];
        fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(destination, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
      }
      return { status: 0, stderr: '' };
    },
  });

  const wrapper = evidenceProbeWrapperScript();
  assert.match(wrapper, /uname -m/);
  assert.ok(wrapper.includes(`${BUNDLE_MOUNT_TARGET}/node-x64/bin/node`));
  assert.ok(wrapper.includes(`${BUNDLE_MOUNT_TARGET}/node-arm64/bin/node`));
  assert.ok(wrapper.includes(`${BUNDLE_MOUNT_TARGET}/evidence-probe.mjs`));
  assert.equal(fs.readFileSync(path.join(bundleDir, 'evidence-probe.mjs'), 'utf8'), 'process.stdout.write("{}\\n")');
  assert.equal(fs.readFileSync(path.join(bundleDir, 'evidence-probe'), 'utf8'), wrapper);
  assert.ok(calls.some(([cmd]) => cmd === 'tar'));
});

test('the Python Harbor bridge never promotes model-command JSON into parsed protocol data', () => {
  const result = runPython(`
import asyncio, base64, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

payload = json.dumps({"payload": "x" * 9000}).encode()
envelope = json.dumps({
    "version": 1,
    "code": 0,
    "stdoutB64": base64.b64encode(payload).decode(),
    "stderrB64": "",
    "stdoutTruncated": False,
    "stderrTruncated": False,
})

class Result:
    return_code = 0
    output = envelope
    stderr = ""

class Environment:
    async def exec(self, command=None, **kwargs):
        return Result()

async def main():
    agent = StdioBridgeAgent()
    result = await agent._exec(Environment(), "harness verify --json")
    ordinary = await agent._exec(Environment(), "cat result.json")
    print(json.dumps({
        "stdoutLength": len(result["stdout"]),
        "verifyExposed": "_parsedJson" in result,
        "ordinaryExposed": "_parsedJson" in ordinary,
    }))

asyncio.run(main())
`);
  assert.ok(result.stdoutLength <= 6000);
  assert.equal(result.verifyExposed, false, 'sandbox-authored verifier JSON is untrusted data');
  assert.equal(result.ordinaryExposed, false, 'arbitrary JSON command output is never copied into the agent protocol unbounded');
});

test('the Python bridge snapshots after setup, enriches done evidence, and atomically replaces the host done file', () => {
  const result = runPython(`
import asyncio, json, pathlib, tempfile
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

root = pathlib.Path(tempfile.mkdtemp())
condition = root / "condition.json"
done_file = root / "done.json"
condition.write_text(json.dumps({"setupCommands": ["activate-harness"]}))
done_file.write_text(json.dumps({"type": "done", "stopReason": "old"}))

before_hash = "b" * 64
after_hash = "a" * 64
diff_hash = "d" * 64
collected = {
    "workspaceEvidence": {
        "available": True,
        "collectionMode": "bounded-content-hash-manifest-v1",
        "containmentMode": "descriptor-relative-procfs",
        "beforeManifestHash": before_hash,
        "afterManifestHash": after_hash,
        "diffHash": diff_hash,
        "changedPaths": ["src/a.c"],
        "reason": None,
    },
    "harnessEvents": [{"type": "pre_tool", "decision": "allow"}],
    "harnessEventEvidence": {"available": True, "complete": True, "reason": None, "retainedEvents": 1, "sourceTruncated": False, "projectionRejectedEvents": 0, "projectionRejectedChecks": 0},
    "enforcement": {"hooksActive": True, "source": "mechanical-hook-events"},
}

class Result:
    return_code = 0
    stderr = ""
    def __init__(self, output): self.output = output

class Environment:
    def __init__(self): self.commands = []
    async def exec(self, command=None, **kwargs):
        self.commands.append(command)
        if " snapshot " in command:
            return Result(json.dumps({"available": True, "manifestHash": before_hash}))
        if " collect " in command:
            return Result(json.dumps(collected))
        return Result("ok")

class Agent(StdioBridgeAgent):
    async def _exec(self, environment, command, **kwargs):
        result = await environment.exec(command=command)
        normalized = {"code": result.return_code, "stdout": result.output, "stderr": result.stderr}
        if kwargs.get("parse_json"):
            normalized["_parsedJson"] = json.loads(result.output)
        return normalized

async def main():
    agent = Agent()
    agent._extra_env = {
        "HARNESS_EVAL_TB_CONDITION": str(condition),
        "HARNESS_EVAL_TB_TELEMETRY_FILE": str(done_file),
    }
    environment = Environment()
    await agent.setup(environment)
    done = {"type": "done", "stopReason": "model_finish", "telemetry": {"totals": {}}}
    await agent._enrich_done(environment, done)
    persisted = json.loads(done_file.read_text())
    print(json.dumps({"commands": environment.commands, "done": done, "persisted": persisted, "tempFiles": [p.name for p in root.glob("*.tmp")]}))

asyncio.run(main())
`);
  assert.match(result.commands[0], /activate-harness/);
  assert.match(result.commands[1], /evidence-probe snapshot/, 'the baseline is taken after setup activation');
  assert.match(result.commands[2], /evidence-probe collect/);
  assert.equal(result.done.workspaceEvidence.diffHash, 'd'.repeat(64));
  assert.equal(result.done.workspaceEvidence.containmentMode, 'descriptor-relative-procfs');
  assert.equal(result.done.harnessEvents[0].type, 'pre_tool');
  assert.equal(result.done.harnessEventEvidence.retainedEvents, 1);
  assert.equal(result.done.enforcement.hooksActive, true);
  assert.deepEqual(result.persisted, result.done);
  assert.deepEqual(result.tempFiles, []);
});

test('an unavailable sandbox probe records observability loss without changing task correctness', () => {
  const result = runPython(`
import asyncio, json, pathlib, tempfile
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

root = pathlib.Path(tempfile.mkdtemp())
condition = root / "condition.json"
done_file = root / "done.json"
condition.write_text(json.dumps({"setupCommands": []}))

class Result:
    return_code = 127
    output = ""
    stderr = "probe unavailable"

class Environment:
    async def exec(self, command=None, **kwargs): return Result()

class Agent(StdioBridgeAgent):
    async def _exec(self, environment, command, **kwargs):
        result = await environment.exec(command=command)
        return {"code": result.return_code, "stdout": result.output, "stderr": result.stderr}

async def main():
    agent = Agent()
    agent._extra_env = {
        "HARNESS_EVAL_TB_CONDITION": str(condition),
        "HARNESS_EVAL_TB_TELEMETRY_FILE": str(done_file),
    }
    environment = Environment()
    await agent.setup(environment)
    done = {"type": "done", "stopReason": "model_finish", "answer": "correct"}
    await agent._enrich_done(environment, done)
    print(json.dumps({"done": done, "persisted": json.loads(done_file.read_text())}))

asyncio.run(main())
`);
  assert.equal(result.done.stopReason, 'model_finish');
  assert.equal(result.done.answer, 'correct');
  assert.equal(result.done.workspaceEvidence.available, false);
  assert.equal(result.done.workspaceEvidence.reason, 'evidence-probe-collect-unavailable');
  assert.deepEqual(result.done.harnessEvents, []);
  assert.equal(result.done.harnessEventEvidence.available, false);
  assert.equal(result.done.workspaceEvidence.changedPathCount, 0);
  assert.equal(result.done.workspaceEvidence.changedPathsTruncated, false);
  assert.deepEqual(result.persisted, result.done);
});
