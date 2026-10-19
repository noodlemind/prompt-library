import path from 'node:path';
import { consolidateCandidates, collectEpisodes, episodeId } from './consolidate.mjs';
import { applyOps } from './apply.mjs';
import { listLearnings, readGovernance, repoId, storeDir } from './store.mjs';
import { resolveWriteLayer } from './layer.mjs';
import { readLearningFile } from './store-io.mjs';
import { deriveGitContext } from '../git-context.mjs';
import { readFileNoFollow } from '../fs-safe.mjs';
import { readReviewRecord, publishReviewRecord } from '../review.mjs';
import { reviewHash } from '../review-preparation.mjs';
import { withPlanUpdateLock } from '../plan-update.mjs';

const packetRel = id => `.harness/consolidation/packets/${id}.json`;
const repairable = new Set(['E_SCHEMA', 'E_BYTE_CAP', 'E_DELTA_CONTRACT', 'E_LINT']);
const reject = (code, reason) => ({ applied: [], governed: [], rejected: [{ code, reason }], committed: false, exitCode: 1 });

function context(options) {
  const git = deriveGitContext(options);
  return { repository: repoId(options.workspace), head: git.headSha, branch: git.branch, detached: git.detached };
}

function learningBindings(dir) {
  return listLearnings(dir).map(l => ({ id: l.id, sha256: reviewHash(readLearningFile(l.file)) }));
}

export function prepareConsolidationPacket(options) {
  const value = consolidateCandidates({ ...options, withIds: true, writeLayer: true, layerOverride: options.layer === 'golden' ? 'golden' : null });
  const layerDir = value.bucketKey ? path.join(value.storeDir, 'branches', value.bucketKey) : value.storeDir;
  const seen = new Set();
  const clusters = value.clusters.map(c => ({ ...c, episodes: c.episodes.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id); return true;
  }) })).filter(c => c.episodes.length);
  const packet = { ...value, schema: 2, clusters, binding: { context: context(options), layerDir, learnings: learningBindings(layerDir), governance: reviewHash([...readGovernance(value.storeDir)]) } };
  const id = reviewHash(packet), packetPath = packetRel(id);
  if (!options.dryRun) publishReviewRecord(options.workspace, packetPath, packet);
  return { ...packet, id, packetPath };
}

function expandProposal(options, input) {
  if (!input || input.schema !== 2 || !/^[a-f0-9]{64}$/.test(input.packet || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.operation || '') || ![1, 2].includes(input.attempt) || !Array.isArray(input.ops) || !input.ops.length || Object.keys(input).some(key => !['schema', 'packet', 'operation', 'attempt', 'ops'].includes(key))) throw new Error('Proposal requires schema 2, packet ID, operation ID, attempt 1 or 2, and ops');
  const packet = readReviewRecord(options.workspace, packetRel(input.packet));
  if (!packet || reviewHash(packet) !== input.packet) throw new Error('Frozen packet is missing, tampered, or unreadable');
  const episodes = new Map(packet.clusters.flatMap(c => c.episodes).map(e => [e.id, e]));
  const selected = new Set(), targets = new Set();
  const ops = input.ops.map(op => {
    if (!op || !Array.isArray(op.episodes) || !op.episodes.length) throw new Error('Every proposal op needs episode IDs');
    for (const target of op.targets || (op.target ? [op.target] : [])) targets.add(target);
    return { ...op, episodes: op.episodes.map(ref => {
      if (!ref || Object.keys(ref).some(key => !['id', 'plan'].includes(key)) || !episodes.has(ref.id)) throw new Error('Episode reference must select an ID from the frozen packet');
      const e = episodes.get(ref.id);
      if (selected.has(e.id)) throw new Error('One episode cannot be consumed by multiple proposal operations');
      selected.add(e.id);
      return { path: e.path, sha256: e.sha256, kind: e.kind, ...(ref.plan !== undefined ? { plan: ref.plan } : {}) };
    }) };
  });
  const preflight = actual => {
    const layerDir = actual.layer === 'branch' && actual.bucketKey ? path.join(actual.storeDir, 'branches', actual.bucketKey) : actual.storeDir;
    if (path.resolve(actual.storeDir) !== path.resolve(packet.storeDir) || path.resolve(layerDir) !== path.resolve(packet.binding.layerDir)) return { code: 'E_PACKET_STALE', reason: 'Packet store or layer destination differs from the actual write destination' };
    if (reviewHash(context(options)) !== reviewHash(packet.binding.context)) return { code: 'E_PACKET_STALE', reason: 'Packet repository or branch context is stale' };
    if (reviewHash([...readGovernance(packet.storeDir)]) !== packet.binding.governance) return { code: 'E_PACKET_STALE', reason: 'Packet governance is stale; preserve current human decisions and prepare again' };
    const current = new Set(collectEpisodes(options).map(episodeId));
    if ([...selected].some(id => !current.has(id))) return { code: 'E_PACKET_STALE', reason: 'Selected episode bytes or kind are stale' };
    const bindings = new Map(learningBindings(packet.binding.layerDir).map(l => [l.id, l.sha256]));
    if ([...targets].some(id => packet.binding.learnings.find(l => l.id === id)?.sha256 !== bindings.get(id) || !bindings.has(id))) return { code: 'E_PACKET_STALE', reason: 'Selected learning target is absent or stale' };
    return null;
  };
  return { operations: { schema: 1, ops }, preflight };
}

export function applyConsolidationProposal(options) {
  let input;
  try { input = JSON.parse(readFileNoFollow(options.opsPath, { maxBytes: 1024 * 1024 })); } catch { return reject('E_SCHEMA', 'Proposal must be bounded JSON'); }
  if (input?.schema !== 2) return applyOps(options);
  let expanded;
  try { expanded = expandProposal(options, input); } catch (error) { return { ...reject('E_PACKET', error.message), retry: { eligible: false, nextAttempt: null, reason: 'Prepare a fresh packet or correct the proposal envelope.' } }; }
  const key = reviewHash({ repository: repoId(options.workspace), operation: input.operation });
  const routing = resolveWriteLayer({ ...options, layerOverride: options.layer === 'golden' ? 'golden' : null });
  const destination = { storeDir: storeDir(options.workspace, { home: options.home }), layer: routing.layer, bucketKey: routing.bucketKey };
  const rel = `.harness/consolidation/operations/${key}.json`, digest = reviewHash({ input, destination });
  const perform = prior => {
    if (prior) {
      const { integrity, ...value } = prior;
      if (prior.version !== 1 || prior.packet !== input.packet || prior.operation !== input.operation || reviewHash(value) !== integrity) return { ...reject('E_OPERATION', 'Operation receipt or frozen packet binding is damaged'), retry: { eligible: false, nextAttempt: null } };
    }
    if (prior?.attempts?.[input.attempt]) {
      const saved = prior.attempts[input.attempt];
      if (saved.digest !== digest) return { ...reject('E_OPERATION', 'Operation attempt conflicts with a different payload'), retry: { eligible: false, nextAttempt: null } };
      return { ...saved.result, replayed: true };
    }
    const operationRecovery = !prior && input.attempt === 2;
    if (!operationRecovery && (input.attempt !== (prior?.nextAttempt || 1) || prior && !prior.eligible)) return { ...reject('E_RETRY', 'Operation is terminal or repair attempt is not eligible'), retry: { eligible: false, nextAttempt: null } };
    const result = applyOps({ ...options, ...expanded, packetPreflight: expanded.preflight, operationReceipt: { id: key, digest }, operationRecovery });
    const code = result.rejected?.[0]?.code;
    const eligible = result.exitCode !== 0 && input.attempt === 1 && repairable.has(code);
    const retry = { eligible, nextAttempt: eligible ? 2 : null, reason: eligible ? 'Repair the semantic proposal once using these diagnostics.' : result.exitCode === 0 ? 'Operation completed.' : 'Terminal failure; inspect evidence before a new operation.' };
    const final = { ...result, packet: input.packet, operation: input.operation, attempt: input.attempt, retry, diagnostics: result.rejected || [] };
    if (!options.dryRun) {
      const value = { version: 1, packet: input.packet, operation: input.operation, eligible, nextAttempt: retry.nextAttempt, attempts: { ...prior?.attempts, [input.attempt]: { digest, result: final } } };
      publishReviewRecord(options.workspace, rel, { ...value, integrity: reviewHash(value) });
    }
    return final;
  };
  if (options.dryRun) return perform(readReviewRecord(options.workspace, rel));
  publishReviewRecord(options.workspace, '.harness/consolidation/operations/.ready.json', { version: 1 });
  return withPlanUpdateLock(path.join(options.workspace, rel), () => perform(readReviewRecord(options.workspace, rel)));
}
