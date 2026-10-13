import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const artifactRoot = process.env.HARNESS_CHECK_ARTIFACT_DIR;
if (!artifactRoot || !path.isAbsolute(artifactRoot)) throw new Error('Owned artifact directory is required');

if (mode === 'probe') {
  let frozenWriteRejected = false;
  try { fs.writeFileSync(manifest.frozen, 'forbidden'); } catch (error) { frozenWriteRejected = error.code === 'EPERM' || error.code === 'EACCES'; }
  const network = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: manifest.port });
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve({ rejected: false }); });
    socket.on('error', error => resolve({ rejected: error.code === 'EPERM' || error.code === 'EACCES', code: error.code }));
    socket.on('timeout', () => { socket.destroy(); resolve({ rejected: false }); });
  });
  fs.writeFileSync(path.join(artifactRoot, manifest.output), JSON.stringify({ version: 1, artifactWrite: true, frozenWriteRejected, networkRejected: network.rejected, networkCode: network.code ?? null }));
} else {
  if (mode !== 'score' && mode !== 'guard' || manifest.version !== 1 || manifest.mode !== mode) throw new Error('Unsupported evaluator invocation');
  const started = performance.now();
  const candidateBytes = fs.readFileSync(manifest.inputPaths.candidate);
  const workloadBytes = fs.readFileSync(manifest.inputPaths.workload);
  if (digest(candidateBytes) !== manifest.candidate.sha256 || digest(workloadBytes) !== manifest.workloadIdentity.sha256) throw new Error('Frozen evaluator input changed');
  const candidate = JSON.parse(candidateBytes.toString('utf8'));
  const workload = JSON.parse(workloadBytes.toString('utf8'));
  const prediction = features => features.reduce((sum, value, index) => sum + value * candidate.weights[index], 0);
  const values = workload.objective.map(row => Math.abs(prediction(row.features) - row.expected));
  const value = values.reduce((sum, entry) => sum + entry, 0) / values.length;
  const guardResults = workload.guards.map((row, index) => { const output = prediction(row.features); return { index, output, passed: Number.isFinite(output) && output >= row.min && output <= row.max }; });
  if (!Number.isFinite(value) || guardResults.some(row => !Number.isFinite(row.output))) throw new Error('Evaluator result is nonfinite');
  const receipt = {
    version: 1, workload: 'linear-json-v1', mode, invocation: manifest.invocation, attempt: manifest.attempt, planId: manifest.planId, contractDigest: manifest.contractDigest,
    frozenDigest: manifest.frozenDigest, candidate: manifest.candidate, workloadIdentity: manifest.workloadIdentity, scorerDigest: manifest.scorerDigest,
    environmentDigest: manifest.environmentDigest, runtimeDigest: manifest.runtimeDigest, evaluatorDigest: manifest.evaluatorDigest,
    metric: { name: 'mean-absolute-error', units: 'absolute-error', direction: 'minimize', value, samples: [value] },
    correctness: { passed: guardResults.every(row => row.passed), guards: guardResults }, repetitions: 1, durationMs: performance.now() - started,
  };
  fs.writeFileSync(path.join(artifactRoot, 'measurement.json'), `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
}
