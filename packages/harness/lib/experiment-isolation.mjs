import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { runProcess } from './runner.mjs';
import { EXPERIMENT_EVALUATOR_PATH, EXPERIMENT_ENVIRONMENT, experimentDigest, parseExperimentJson } from './experiment-contract.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from './fs-safe.mjs';

export const EXPERIMENT_SANDBOX_PATH = '/usr/bin/sandbox-exec';

export function experimentIsolationProfile(artifactRoot) {
  const canonical = fs.realpathSync(artifactRoot);
  return `(version 1)\n(deny default)\n(allow process-exec)\n(allow file-read*)\n(allow sysctl-read)\n(allow file-write* (subpath ${JSON.stringify(canonical)}))\n`;
}

export function experimentEvaluatorSetup() {
  const runtimePath = fs.realpathSync(process.execPath);
  const evaluatorPath = fs.realpathSync(EXPERIMENT_EVALUATOR_PATH);
  return { workload: 'linear-json-v1', supportedPlatform: 'darwin', platform: process.platform, isolation: 'unprobed', runtimePath, runtimeVersion: process.version, evaluatorPath, check: { artifacts: ['measurement.json'], experiment: { version: 1, workload: 'linear-json-v1', mode: 'score|guard' } } };
}

export async function probeExperimentIsolation({ runtime = process.execPath, artifactRoot, signal, platform = process.platform } = {}) {
  const unsupported = message => ({ supported: false, message, proof: null });
  if (process.platform !== 'darwin' || platform !== 'darwin') return unsupported('Experiment isolation is unsupported on this host');
  if (signal?.aborted) return unsupported('Experiment isolation probe cancelled');
  let tempRoot; let server;
  try {
    if (fs.realpathSync(runtime) !== fs.realpathSync(process.execPath)) return unsupported('Selected runtime does not match this trusted Node runtime');
    if (!path.isAbsolute(artifactRoot || '') || !assertNoSymlinkAncestors(path.dirname(artifactRoot), path.basename(artifactRoot))) return unsupported('Isolation artifact path is unsafe');
    fs.mkdirSync(artifactRoot, { recursive: true });
    artifactRoot = fs.realpathSync(artifactRoot);
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-experiment-probe-')));
    const frozen = path.join(tempRoot, 'frozen.json');
    const sentinel = '{"frozen":true}\n'; fs.writeFileSync(frozen, sentinel);
    let connections = 0;
    server = net.createServer(socket => { connections++; socket.end(); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const connectControl = () => new Promise((resolve, reject) => { const socket = net.connect(server.address().port, '127.0.0.1'); socket.on('connect', () => socket.end()); socket.once('close', resolve); socket.once('error', reject); });
    await connectControl();
    const before = connections;
    const output = `.isolation-${randomUUID()}.json`;
    const manifestPath = path.join(tempRoot, 'probe.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ frozen, port: server.address().port, output }));
    const profile = experimentIsolationProfile(artifactRoot);
    const profilePath = path.join(tempRoot, 'profile.sb'); fs.writeFileSync(profilePath, profile);
    const execution = await runProcess({ argv: [EXPERIMENT_SANDBOX_PATH, '-f', profilePath, fs.realpathSync(runtime), fs.realpathSync(EXPERIMENT_EVALUATOR_PATH), 'probe', manifestPath], cwd: tempRoot, env: { ...EXPERIMENT_ENVIRONMENT, HARNESS_CHECK_ARTIFACT_DIR: artifactRoot }, timeoutMs: 5000, signal });
    const bytes = readFileNoFollow(path.join(artifactRoot, output), { root: artifactRoot, maxBytes: 4096 });
    const receipt = bytes ? parseExperimentJson(bytes) : null;
    fs.rmSync(path.join(artifactRoot, output), { force: true });
    const serverListeningAfter = server.listening;
    await connectControl();
    const proof = { artifactWrite: receipt?.artifactWrite === true, frozenWriteRejected: receipt?.frozenWriteRejected === true && fs.readFileSync(frozen, 'utf8') === sentinel, networkRejected: receipt?.networkRejected === true && connections === before + 1, serverListeningBefore: before > 0, serverListeningAfter, groupReaped: execution.groupReaped === true };
    const supported = execution.status === 'ok' && Object.values(proof).every(value => value === true);
    return { supported, message: supported ? 'Read-only fixed evaluator and network isolation demonstrated' : 'Experiment isolation probe failed', proof, identity: { platform: process.platform, arch: process.arch, osRelease: os.release(), runtimePath: fs.realpathSync(runtime), runtimeSha256: experimentDigest(fs.readFileSync(runtime)), runtimeVersion: process.version, sandboxSha256: experimentDigest(fs.readFileSync(EXPERIMENT_SANDBOX_PATH)), profileSha256: experimentDigest(profile), evaluatorSha256: experimentDigest(fs.readFileSync(EXPERIMENT_EVALUATOR_PATH)), environmentDigest: experimentDigest(EXPERIMENT_ENVIRONMENT) } };
  } catch (error) { return unsupported(`Experiment isolation probe failed: ${String(error.message).slice(0, 180)}`); }
  finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
