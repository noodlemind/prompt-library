import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ensureHarnessDir } from './session.mjs';
import { collectChangedFiles } from './plan-scope.mjs';
import { assertNoSymlinkAncestors, writeFileContained, readFileNoFollow } from './fs-safe.mjs';
import { createRedactor } from './redact.mjs';
import { planContractText } from './work-contract.mjs';
import { policyDigest, trustStatus } from './trust.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { loadPolicy } from './policy.mjs';
import { intentSourceBindings, intentSourcesCheck } from './intent-sources.mjs';
import { gapEvidenceCheck } from './plan-readiness.mjs';

export const EVIDENCE_VERSION = 4;
export { planContractText } from './work-contract.mjs';

function evidenceRel(planPath) {
  if (!planPath) return '.harness/evidence/unresolved-plan.json';
  const normalized = String(planPath).replace(/\\/g, '/');
  const base = path.basename(normalized, '.md').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  const slug = `${base}-${digest}`;
  return `.harness/evidence/${slug}.json`;
}

function legacyEvidenceRel(planPath) {
  const slug = planPath ? path.basename(planPath, '.md') : 'unresolved-plan';
  return `.harness/evidence/${slug}.json`;
}

export function writeEvidence(workspace, result, dryRun = false) {
  // Same reason as every other writer under .harness — see harnessDirEscapes.
  if (ensureHarnessDir(workspace, dryRun) === null) return null;
  const rel = evidenceRel(result.plan);
  if (!dryRun) {
    const redactor = createRedactor();
    const payload = {
      ...redactor.redactValue(result),
      version: EVIDENCE_VERSION,
      verifiedAt: new Date().toISOString(),
      evidencePath: rel,
    };
    const observation = digest(JSON.stringify(payload));
    const history = `.harness/evidence/history/${observation}.json`;
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    if (!writeFileContained(workspace, history, content) || !writeFileContained(workspace, rel, content)) throw new Error('Could not publish verification evidence; retry after repairing the evidence store');
  }
  return rel;
}

export function readEvidence(workspace, planPath) {
  for (const rel of [evidenceRel(planPath), legacyEvidenceRel(planPath)]) {
    const full = path.join(workspace, rel);
    if (!fs.existsSync(full)) continue;
    try {
      return JSON.parse(readFileNoFollow(full, { root: workspace, maxBytes: 1024 * 1024 }) || 'null');
    } catch {
      continue;
    }
  }
  return null;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedFiles(files) {
  return [...new Set((files || []).map((file) => String(file).replace(/\\/g, '/')))].sort();
}

function validBinding(binding) {
  return Boolean(
    binding &&
      typeof binding === 'object' &&
      !Array.isArray(binding) &&
      (binding.base === null || (typeof binding.base === 'string' && !binding.base.startsWith('-'))) &&
      typeof binding.planDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(binding.planDigest) &&
      Array.isArray(binding.changedFiles) &&
      binding.changedFiles.every((file) => typeof file === 'string' && file.length > 0) &&
      typeof binding.workspaceDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(binding.workspaceDigest) &&
      (binding.head === null || (typeof binding.head === 'string' && /^[0-9a-f]{40,64}$/.test(binding.head)))
  );
}

function gitHead(workspace) {
  const head = spawnSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  if (head.error || head.status !== 0) return null;
  return String(head.stdout || '').trim();
}

/** Canonical plan digest: SHA-256 of the Activity-stripped contract text.
 * Gate, doctor, evidence, and the installed hooks must all agree on this. */
export function planDigest(text) {
  return digest(planContractText(text));
}

function containedPath(workspace, rel) {
  const root = path.resolve(workspace);
  const full = path.resolve(root, rel);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Evidence path escapes workspace: ${rel}`);
  }
    const parentRel = path.dirname(relative);
  if (parentRel !== '.' && !assertNoSymlinkAncestors(root, parentRel)) {
    throw new Error(`Evidence path resolves through a symlinked ancestor: ${rel}`);
  }
  return full;
}

function workspaceDigest(workspace, files, planPath) {
  const hash = createHash('sha256');
  for (const rel of normalizedFiles(files)) {
    const full = containedPath(workspace, rel);
    hash.update(`${rel}\0`);
    if (!fs.existsSync(full)) {
      hash.update('missing\0');
      continue;
    }
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${fs.readlinkSync(full)}\0`);
    } else if (stat.isFile()) {
      const content = fs.readFileSync(full);
      hash.update('file\0');
      hash.update(rel === planPath ? planContractText(content.toString('utf8')) : content);
      hash.update('\0');
    } else {
      hash.update(`other\0${stat.mode}\0`);
    }
  }
  return hash.digest('hex');
}

export function proofPolicyDigest(workspace, copilotHome = resolveCopilotHome()) {
  const policy = loadPolicy(workspace, null, { copilotHome });
  const trust = trustStatus({ workspace, copilotHome });
  return digest(JSON.stringify({ source: policyDigest(workspace), trust: trust.state, approval: trust.approvedDigest, enforcement: policy.enforcement, rules: policy.rules, checks: policy.checkSeverities, ttl: policy.evidenceTtlHours }));
}

export function createEvidenceBinding({ workspace, plan, base = null, changedFiles = [], copilotHome }) {
  // The plan has its own semantic binding. Lifecycle-only edits must not add
  // it to the product diff and invalidate otherwise current product proof.
  const files = normalizedFiles(changedFiles).filter(file => file !== plan.path);
  return {
    contractVersion: plan.fm?.intent_source_policy === 'content-v1' ? 2 : 1,
    ...(plan.fm?.intent_source_policy === 'content-v1' ? { intentSources: intentSourceBindings(plan, workspace) } : {}),
    executionPhase: String(plan.phase ?? 0),
    policyDigest: proofPolicyDigest(workspace, copilotHome),
    base: base || null,
    planDigest: digest(planContractText(plan.text)),
    changedFiles: files,
    workspaceDigest: workspaceDigest(workspace, files, plan.path),
    head: gitHead(workspace),
  };
}

export function validateEvidence({ workspace, plan, evidence, maxAgeHours = 24, copilotHome }) {
  if (!evidence) return { pass: false, message: 'No harness verify evidence artifact for this plan' };
  if (evidence.outcome !== 'passed') {
    return { pass: false, message: `Latest harness verify outcome is ${evidence.outcome || 'unknown'}` };
  }
  const expectedVersion = plan.fm?.intent_source_policy === 'content-v1' ? 2 : 1;
  if (evidence.version !== EVIDENCE_VERSION || !validBinding(evidence.binding) || evidence.binding.contractVersion !== expectedVersion) {
    return { pass: false, message: 'Verification evidence is not bound to the current plan and workspace' };
  }
  const intent = plan.fm?.intent_source_policy !== undefined ? intentSourcesCheck(plan, workspace) : null;
  if (intent && !intent.pass) return { pass: false, message: intent.message };
  const gaps = gapEvidenceCheck(workspace, plan);
  if (!gaps.pass) return { pass: false, message: gaps.message };
  if (expectedVersion === 2 && JSON.stringify(evidence.binding.intentSources) !== JSON.stringify(intentSourceBindings(plan, workspace))) return { pass: false, message: 'Selected intent source evidence changed; amend and reverify' };
  const required = plan.fm.verification?.required;
  if (!Array.isArray(evidence.checks) || !Array.isArray(required) || !required.length || required.some(id => !evidence.checks.some(check => check.id === id && check.status === 'passed' && ['behavior', 'type-check'].includes(check.proof))) || !evidence.checks.some(check => required.includes(check.id) && check.status === 'passed' && check.proof === 'behavior') || !evidence.checks.some(check => check.id === 'criteria-evidence' && check.status === 'passed')) return { pass: false, message: 'Verification record lacks executed proof for the current acceptance criteria' };
  if (evidence.binding.policyDigest !== proofPolicyDigest(workspace, copilotHome)) return { pass: false, message: 'Policy or trust changed after verification; refresh trust and reverify' };
  if (evidence.binding.executionPhase !== String(plan.phase ?? 0)) return { pass: false, message: 'Execution phase changed after verification' };
  if (gitHead(workspace) !== evidence.binding.head) {
    return { pass: false, message: 'Verification evidence was recorded at a different head' };
  }
  if (evidence.plan !== plan.path) {
    return { pass: false, message: 'Verification evidence belongs to a different plan' };
  }
  const verifiedAt = Date.parse(evidence.verifiedAt || '');
  if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() + 1000) return { pass: false, message: 'Verification timestamp is missing or invalid' };
  if (Date.now() - verifiedAt > maxAgeHours * 60 * 60 * 1000) {
    return { pass: false, message: 'Verification evidence is stale' };
  }
  if (evidence.binding.planDigest !== digest(planContractText(plan.text))) {
    return { pass: false, message: 'Plan changed after verification' };
  }

  const changed = collectChangedFiles(workspace, evidence.binding.base || null);
  if (changed.error) return { pass: false, message: changed.error };
  const currentFiles = normalizedFiles(changed.files).filter(file => file !== plan.path);
  const evidenceFiles = normalizedFiles(evidence.binding.changedFiles);
  if (JSON.stringify(currentFiles) !== JSON.stringify(evidenceFiles)) {
    return { pass: false, message: 'Workspace scope changed after verification' };
  }
  try {
    if (evidence.binding.workspaceDigest !== workspaceDigest(workspace, currentFiles, plan.path)) {
      return { pass: false, message: 'Workspace files changed after verification' };
    }
  } catch (error) {
    return { pass: false, message: error.message };
  }
  return { pass: true, message: `Fresh passed verification evidence: ${evidence.evidencePath}` };
}
