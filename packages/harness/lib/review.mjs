import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFlags } from './flags.mjs';
import { loadPlan } from './plan-parse.mjs';
import { createEvidenceBinding } from './evidence.mjs';
import { collectChangedFiles } from './plan-scope.mjs';
import { readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { ensureHarnessDir } from './session.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { redactedJson } from './redact.mjs';

export const REVIEW_VERBS = Object.freeze(['prepare', 'assemble']);
const ID = /^[a-f0-9]{64}$/;
export const recordHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reviewKey = plan => recordHash(plan.path);
function usage(message) { return Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint: 'harness help review' }); }

export function currentReviewScope(workspace, plan, base = null, copilotHome) {
  const changed = collectChangedFiles(workspace, base);
  if (changed.error) throw new Error(changed.error);
  return createEvidenceBinding({ workspace, plan, base, changedFiles: changed.files, copilotHome });
}

export function readReviewRecord(workspace, rel) {
  const text = readFileNoFollow(path.join(workspace, rel), { root: workspace, maxBytes: 1024 * 1024 });
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function publishReviewRecord(workspace, rel, record) {
  if (!ensureHarnessDir(workspace) || !writeFileContained(workspace, rel, `${JSON.stringify(record, null, 2)}\n`)) throw new Error(`Could not publish ${rel}`);
  return rel;
}

export function prepareReview({ workspace, plan, base = null, copilotHome }) {
  const scope = currentReviewScope(workspace, plan, base, copilotHome);
  const required = [...new Set(plan.fm.reviews?.required || [])].sort();
  if (required.some(id => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw usage('Invalid required review IDs');
  const contract = { version: 1, plan: plan.path, scope, required };
  const id = recordHash(contract);
  const packet = { ...contract, id, createdAt: new Date().toISOString(), provenance: 'Invocation identity unknown; supplied reviewer names are declarations' };
  const rel = `.harness/reviews/packets/${id}.json`;
  const existing = readReviewRecord(workspace, rel);
  if (existing) return existing;
  if (JSON.stringify(scope) !== JSON.stringify(currentReviewScope(workspace, plan, base, copilotHome))) throw usage('Review scope changed during preparation');
  publishReviewRecord(workspace, rel, packet);
  return packet;
}

function findingErrors(workspace, finding) {
  if (!finding || typeof finding !== 'object') return ['Finding must be an object'];
  const errors = [];
  const normalized = typeof finding.file === 'string' ? finding.file.replace(/\\/g, '/') : '';
  if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) errors.push('Invalid finding file');
  const text = errors.length ? null : readFileNoFollow(path.join(workspace, normalized), { root: workspace });
  if (text === null || !Number.isInteger(finding.line) || finding.line < 1 || finding.line > text.split(/\r?\n/).length) errors.push('Finding location is missing, unreadable, or outside the file');
  if (!['P1', 'P2', 'P3'].includes(finding.severity)) errors.push('Invalid severity');
  if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) errors.push('Invalid confidence');
  for (const key of ['title', 'description', 'suggested_fix']) if (typeof finding[key] !== 'string' || !finding[key].trim()) errors.push(`Missing ${key}`);
  if (!['safe_auto', 'gated_auto', 'manual', 'advisory'].includes(finding.autofix_class)) errors.push('Invalid action routing');
  if (!Array.isArray(finding.evidence) || !finding.evidence.length || !finding.evidence.every(s => typeof s === 'string' && s.trim())) errors.push('Missing finding evidence');
  return errors;
}

export function assembleReview({ workspace, plan, packetId, input, copilotHome }) {
  if (!ID.test(packetId || '')) throw usage('--packet requires the captured packet ID');
  const packet = readReviewRecord(workspace, `.harness/reviews/packets/${packetId}.json`);
  if (!packet || packet.id !== packetId || recordHash({ version: packet.version, plan: packet.plan, scope: packet.scope, required: packet.required }) !== packetId) throw usage('Review packet is missing or tampered');
  const scope = currentReviewScope(workspace, plan, packet.scope.base, copilotHome);
  if (packet.plan !== plan.path || JSON.stringify(scope) !== JSON.stringify(packet.scope)) throw usage('Review packet is stale; prepare and review the current scope');
  if (input?.packet !== packetId || !Array.isArray(input.results)) throw usage('Results must reference the packet and contain a results array');
  const results = [], failures = [], findings = [];
  for (const result of input.results) {
    const errors = [];
    if (!packet.required.includes(result?.reviewer)) errors.push('Unexpected reviewer');
    if (result?.status !== 'completed') errors.push(`Reviewer did not complete: ${result?.status || 'unknown'}`);
    if (!Array.isArray(result?.findings)) errors.push('Missing findings array');
    for (const field of ['residual_risks', 'testing_gaps']) if (!Array.isArray(result?.[field]) || !result[field].every(s => typeof s === 'string')) errors.push(`Invalid ${field}`);
    if (Array.isArray(result?.findings)) for (const finding of result.findings) errors.push(...findingErrors(workspace, finding));
    results.push({ reviewer: result?.reviewer || null, status: errors.length ? 'invalid' : 'completed', provenance: { kind: 'unverified-declaration', declared: result?.provenance || null }, raw: result, errors });
    if (errors.length) failures.push({ reviewer: result?.reviewer || null, errors });
    else for (const finding of result.findings) findings.push({ ...finding, file: finding.file.replace(/\\/g, '/'), reviewer: result.reviewer, id: recordHash({ file: finding.file.replace(/\\/g, '/'), line: finding.line, title: finding.title, description: finding.description }) });
  }
  const missing = packet.required.filter(id => results.filter(r => r.reviewer === id && r.status === 'completed').length !== 1);
  const complete = missing.length === 0 && failures.length === 0;
  const value = { version: 1, plan: plan.path, packet: packetId, scope, required: packet.required, results, findings, failures, coverage: { complete, missing }, status: complete ? 'ok' : 'blocked' };
  const id = recordHash(value);
  const record = { ...value, id, recordedAt: new Date().toISOString() };
  if (JSON.stringify(scope) !== JSON.stringify(currentReviewScope(workspace, plan, packet.scope.base, copilotHome))) throw usage('Review scope changed during assembly');
  publishReviewRecord(workspace, `.harness/reviews/records/${id}.json`, record);
  publishReviewRecord(workspace, `.harness/reviews/latest/${reviewKey(plan)}.json`, { version: 1, id });
  return record;
}

export function validateReview({ workspace, plan, copilotHome }) {
  const required = plan.fm.reviews?.required || [];
  if (!required.length) return { pass: true, record: null, missing: [], critical: [], message: 'No required reviews' };
  const pointer = readReviewRecord(workspace, `.harness/reviews/latest/${reviewKey(plan)}.json`);
  const record = ID.test(pointer?.id || '') ? readReviewRecord(workspace, `.harness/reviews/records/${pointer.id}.json`) : null;
  const failure = message => ({ pass: false, record, missing: required.slice(), critical: [], message });
  if (!record || record.version !== 1) return failure('Required reviews need a bound Harness review record; declared completed strings do not supply evidence');
  const { id, recordedAt, ...value } = record;
  if (id !== pointer.id || recordHash(value) !== id) return failure('Review record is invalid');
  if (record.plan !== plan.path || JSON.stringify(record.required) !== JSON.stringify([...new Set(required)].sort())) return failure('Review obligations changed');
  if (JSON.stringify(record.scope) !== JSON.stringify(currentReviewScope(workspace, plan, record.scope.base, copilotHome))) return failure('Reviewed content or policy changed; prepare and review the current scope');
  if (!record.coverage?.complete) return { ...failure('Review coverage is incomplete'), missing: record.coverage?.missing || required };
  return { pass: true, record, missing: [], critical: record.findings.filter(f => f.severity === 'P1'), message: 'Required results collected; review judgment and invocation identity remain host responsibilities' };
}

export async function reviewResultOf(argv) {
  const flags = parseFlags(argv);
  const verb = argv.find(arg => REVIEW_VERBS.includes(arg));
  const workspace = path.resolve(flags.workspace);
  const plan = loadPlan(workspace, flags.plan);
  if (!plan) throw usage('review requires --plan');
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  if (verb === 'prepare') return prepareReview({ workspace, plan, base: flags.base, copilotHome });
  if (verb !== 'assemble') throw usage('review requires prepare or assemble');
  const text = flags.files?.length ? readFileNoFollow(path.resolve(flags.files[0]), { maxBytes: 1024 * 1024 }) : fs.readFileSync(0, 'utf8');
  if (!text || Buffer.byteLength(text) > 1024 * 1024) throw usage('Review input is absent, unreadable, or too large');
  let input;
  try { input = JSON.parse(text); } catch { throw usage('Review input must be JSON'); }
  return assembleReview({ workspace, plan, packetId: flags.packet, input, copilotHome });
}

export async function cmdReview(argv) {
  const result = await reviewResultOf(argv);
  console.log(redactedJson(result));
  return result.status === 'blocked' ? 1 : 0;
}
