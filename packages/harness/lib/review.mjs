import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFlags } from './flags.mjs';
import { loadPlan } from './plan-parse.mjs';
import { createEvidenceBinding } from './evidence.mjs';
import { collectChangedFiles } from './plan-scope.mjs';
import { readFileNoFollow, writeFileContained, readBoundedInput } from './fs-safe.mjs';
import { ensureHarnessDir } from './session.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { redactedJson } from './redact.mjs';
import { reviewPreparation, preparationIsCurrent, reviewHash, compareText, CODE_REVIEWERS } from './review-preparation.mjs';
import { synthesizeReview, renderReview } from './review-synthesis.mjs';

export const REVIEW_VERBS = Object.freeze(['prepare', 'assemble']);
const ID = /^[a-f0-9]{64}$/;
export const recordHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reviewKey = plan => recordHash(plan?.path || 'standalone');
const scopePlan = plan => plan || { path: '__standalone__', text: '', phase: 0 };
const packetValue = packet => { const { id, createdAt, ...value } = packet; return value; };
const packetHash = packet => packet.version === 2 ? reviewHash(packetValue(packet)) : recordHash({ version: packet.version, plan: packet.plan, scope: packet.scope, required: packet.required });
function usage(message) { return Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint: 'harness help review' }); }

export function currentReviewScope(workspace, plan, base = null, copilotHome) {
  const changed = collectChangedFiles(workspace, base);
  if (changed.error) throw new Error(changed.error);
  return createEvidenceBinding({ workspace, plan: scopePlan(plan), base, changedFiles: changed.files, copilotHome });
}

export function readReviewRecord(workspace, rel) {
  const text = readFileNoFollow(path.join(workspace, rel), { root: workspace, maxBytes: 1024 * 1024 });
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function publishReviewRecord(workspace, rel, record) {
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw usage(`Record exceeds the 1 MiB storage/read limit: ${rel}; reduce review input size`);
  if (!ensureHarnessDir(workspace) || !writeFileContained(workspace, rel, serialized)) throw new Error(`Could not publish ${rel}`);
  return rel;
}

export function prepareReview({ workspace, plan, base = null, copilotHome, kind = 'code', reviewers = [], files = null, maxBytes = 16384, dryRun = false }) {
  if (!['code', 'document'].includes(kind)) throw usage('Review domain must be code or document');
  if (kind === 'document' && plan?.fm.reviews?.required?.includes('code-review')) throw usage('A document review cannot satisfy this plan\'s required code review; use a standalone document packet');
  const scope = currentReviewScope(workspace, plan, base, copilotHome);
  const prepared = reviewPreparation({ workspace, scope, plan, kind, reviewers, files, maxBytes });
  const contract = { version: 2, plan: plan?.path || null, kind, scope, ...prepared };
  const id = reviewHash(contract);
  const packet = { ...contract, id, createdAt: new Date().toISOString() };
  const rel = `.harness/reviews/packets/${id}.json`;
  const existing = readReviewRecord(workspace, rel);
  if (existing) {
    if (packetHash(existing) !== id) throw usage('Stored review packet is invalid');
    return existing;
  }
  if (JSON.stringify(scope) !== JSON.stringify(currentReviewScope(workspace, plan, base, copilotHome)) || !preparationIsCurrent(workspace, prepared.preparation)) throw usage('Review scope changed during preparation');
  if (Buffer.byteLength(JSON.stringify(packet)) > 1024 * 1024) throw usage('Review packet exceeds storage limit; narrow the explicit review files');
  if (!dryRun) publishReviewRecord(workspace, rel, packet);
  return packet;
}

export function assembleReview({ workspace, plan, packetId, input, copilotHome, dryRun = false }) {
  if (!ID.test(packetId || '')) throw usage('--packet requires the captured packet ID');
  const packet = readReviewRecord(workspace, `.harness/reviews/packets/${packetId}.json`);
  if (!packet || packet.id !== packetId || packetHash(packet) !== packetId) throw usage('Review packet is missing or tampered');
  if (packet.version !== 2) throw usage('Review packet version requires current preparation; version 1 records remain readable');
  const scope = currentReviewScope(workspace, plan, packet.scope.base, copilotHome);
  if (packet.plan !== (plan?.path || null) || JSON.stringify(scope) !== JSON.stringify(packet.scope) || (packet.version === 2 && !preparationIsCurrent(workspace, packet.preparation))) throw usage('Review packet is stale; prepare and review the current scope');
  if (input?.packet !== packetId || !Array.isArray(input.results)) throw usage('Results must reference the packet and contain a results array');
  const synthesis = synthesizeReview(workspace, packet.required, input, packet.preparation?.failures || []);
  const value = { version: packet.version, plan: packet.plan, packet: packetId, kind: packet.kind || 'code', scope, required: packet.required, declaredRequired: packet.declaredRequired || packet.required, ...synthesis };
  const id = reviewHash(value);
  const record = { ...value, id, recordedAt: new Date().toISOString() };
  if (JSON.stringify(scope) !== JSON.stringify(currentReviewScope(workspace, plan, packet.scope.base, copilotHome)) || (packet.version === 2 && !preparationIsCurrent(workspace, packet.preparation))) throw usage('Review scope changed during assembly');
  if (Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024) throw usage('Review record exceeds storage limit; reduce input size');
  const observationPath = `.harness/reviews/observations/${recordHash(input)}.json`;
  if (!dryRun) {
    publishReviewRecord(workspace, observationPath, input);
    const recordPath = `.harness/reviews/records/${id}.json`;
    if (!readReviewRecord(workspace, recordPath)) publishReviewRecord(workspace, recordPath, record);
    publishReviewRecord(workspace, `.harness/reviews/latest/${reviewKey(plan)}.json`, { version: packet.version, id });
  }
  return { ...record, observationPath };
}

export function validateReview({ workspace, plan, copilotHome }) {
  const required = plan.fm.reviews?.required || [];
  if (!required.length) return { pass: true, record: null, missing: [], critical: [], message: 'No required reviews' };
  const pointer = readReviewRecord(workspace, `.harness/reviews/latest/${reviewKey(plan)}.json`);
  const record = ID.test(pointer?.id || '') ? readReviewRecord(workspace, `.harness/reviews/records/${pointer.id}.json`) : null;
  const failure = message => ({ pass: false, record, missing: required.slice(), critical: [], message });
  if (!record || ![1, 2].includes(record.version)) return failure('Required reviews need a bound Harness review record; declared completed strings do not supply evidence');
  const { id, recordedAt, ...value } = record;
  if (id !== pointer.id || (record.version === 2 ? reviewHash(value) : recordHash(value)) !== id) return failure('Review record is invalid');
  if (record.plan !== plan.path || JSON.stringify(record.version === 2 ? record.declaredRequired : record.required) !== JSON.stringify([...new Set(required)].sort(compareText))) return failure('Review obligations changed');
  if (record.version === 2 && required.includes('code-review') && (record.kind !== 'code' || CODE_REVIEWERS.some(id => !record.required.includes(id)))) return failure('Required code review perspectives are missing');
  if (JSON.stringify(record.scope) !== JSON.stringify(currentReviewScope(workspace, plan, record.scope.base, copilotHome))) return failure('Reviewed content or policy changed; prepare and review the current scope');
  if (record.version === 2) {
    const packet = readReviewRecord(workspace, `.harness/reviews/packets/${record.packet}.json`);
    if (!packet || packetHash(packet) !== record.packet || packet.kind !== record.kind || JSON.stringify(packet.required) !== JSON.stringify(record.required) || !preparationIsCurrent(workspace, packet.preparation)) return failure('Review definitions or retrieved sources changed');
  }
  if (!record.coverage?.complete) return { ...failure('Review coverage is incomplete'), missing: record.coverage?.missing || required };
  return { pass: true, record, missing: [], critical: record.findings.filter(f => f.severity === 'P1'), message: 'Required results collected; review judgment and invocation identity remain host responsibilities' };
}

export async function reviewResultOf(argv) {
  const flags = parseFlags(argv);
  const verb = argv.find(arg => REVIEW_VERBS.includes(arg));
  const workspace = path.resolve(flags.workspace);
  const plan = flags.plan ? loadPlan(workspace, flags.plan) : null;
  if (flags.plan && !plan) throw usage('Review plan is missing or invalid');
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  if (verb === 'prepare') {
    const packet = prepareReview({ workspace, plan, base: flags.base, copilotHome, kind: flags.domain || 'code', reviewers: flags.reviewers || [], files: flags.files, maxBytes: argv.some(a => a.startsWith('--max-bytes')) ? flags.maxBytes : 16384, dryRun: flags.dryRun });
    return { ...packet, packetPath: `.harness/reviews/packets/${packet.id}.json`, persisted: !flags.dryRun };
  }
  if (verb !== 'assemble') throw usage('review requires prepare or assemble');
  const text = flags.files?.length ? readFileNoFollow(path.resolve(workspace, flags.files[0]), { maxBytes: 1024 * 1024 }) : readBoundedInput();
  if (!text || Buffer.byteLength(text) > 1024 * 1024) throw usage('Review input is absent, unreadable, or too large');
  let input;
  try { input = JSON.parse(text); } catch { throw usage('Review input must be JSON'); }
  const result = assembleReview({ workspace, plan, packetId: flags.packet, input, copilotHome, dryRun: flags.dryRun });
  const recordPath = `.harness/reviews/records/${result.id}.json`;
  const rendered = renderReview({ ...result, recordPath });
  return { ...result, results: result.results.map(({ raw, ...entry }) => entry), recordPath, report: rendered.text, reportOmittedRows: rendered.omittedRows, persisted: !flags.dryRun };
}

export async function cmdReview(argv) {
  const result = await reviewResultOf(argv);
  console.log(redactedJson(result));
  return result.status === 'blocked' ? 1 : 0;
}
