import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
    reason: null,
    retainedEvents: 200,
    sourceTruncated: false,
  });
});

test('the evidence probe is bundled behind the same cross-architecture Node selection as Harness', () => {
  const root = workspace();
  const bundleDir = path.join(root, 'bundle');
  fs.mkdirSync(path.join(root, 'packages', 'harness'), { recursive: true });
  fs.mkdirSync(path.join(root, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'), 'process.stdout.write("{}\\n")');
  const calls = [];
  prepareHarnessBundle({
    bundleDir,
    repoRoot: root,
    nodeTarballs: { x64: '/tmp/node-x64.tar.gz', arm64: null },
    spawnImpl: (cmd, args) => {
      calls.push([cmd, args]);
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

test('the Python Harbor bridge parses complete JSON before bounding model-visible stdout', () => {
  const result = runPython(`
import asyncio, json
from evals.external.terminal_bench.harbor_agent import StdioBridgeAgent

class Result:
    return_code = 0
    output = json.dumps({"payload": "x" * 9000})
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
        "parsedLength": len(result["parsedStdout"]["payload"]),
        "ordinaryExposed": "parsedStdout" in ordinary,
    }))

asyncio.run(main())
`);
  assert.equal(result.stdoutLength, 6000);
  assert.equal(result.parsedLength, 9000);
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
        "beforeManifestHash": before_hash,
        "afterManifestHash": after_hash,
        "diffHash": diff_hash,
        "changedPaths": ["src/a.c"],
        "reason": None,
    },
    "harnessEvents": [{"type": "pre_tool", "decision": "allow"}],
    "harnessEventEvidence": {"available": True, "reason": None, "retainedEvents": 1, "sourceTruncated": False},
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

async def main():
    agent = StdioBridgeAgent()
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

async def main():
    agent = StdioBridgeAgent()
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
