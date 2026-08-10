import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureHarnessDir } from './session.mjs';
import { collectChangedFiles } from './plan-scope.mjs';
import { assertNoSymlinkAncestors } from './fs-safe.mjs';
import { createRedactor } from './redact.mjs';

const EVIDENCE_VERSION = 2;

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
    const full = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // Critical fix: a named check's captured stdout/stderr (result.checks[])
    // is arbitrary output from a trusted-but-unreviewed command — a test
    // run, a lint pass, a build — and routinely contains secret-shaped
    // content (a token echoed by a misconfigured tool, a credential in an
    // error trace). This artifact is a durable, on-disk file under
    // `.harness/evidence/`, unlike a terminal scrollback, so it is redacted
    // here at the persistence boundary before it is ever written — the
    // SAME `lib/redact.mjs` discipline already applied to the events log
    // (lib/event-registry.mjs) and the envelope/agent output lanes
    // (lib/registry.mjs). `redactValue` returns a new, deep-copied
    // structure — `result` itself (and therefore whatever the caller does
    // with it afterward, e.g. render it to the console) is untouched; only
    // the bytes actually written to disk are masked.
    const redactor = createRedactor();
    const payload = {
      ...redactor.redactValue(result),
      version: EVIDENCE_VERSION,
      verifiedAt: new Date().toISOString(),
      evidencePath: rel,
    };
    const temporary = `${full}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, full);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return rel;
}

export function readEvidence(workspace, planPath) {
  for (const rel of [evidenceRel(planPath), legacyEvidenceRel(planPath)]) {
    const full = path.join(workspace, rel);
    if (!fs.existsSync(full)) continue;
    try {
      return JSON.parse(fs.readFileSync(full, 'utf8'));
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
      /^[a-f0-9]{64}$/.test(binding.workspaceDigest)
  );
}

export function planContractText(text) {
  return String(text || '').replace(/\n## Activity\s*\n[\s\S]*?(?=\n## |$)/gi, '');
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
  // Physical containment for every ANCESTOR directory (adversarial-review
  // sweep) — deliberately NOT the leaf itself: workspaceDigest below already
  // has an intentional, correct answer for a symlinked LEAF (hash its link
  // target, never dereference it — see the isSymbolicLink() branch), so
  // rejecting the leaf here would fight that existing behavior. A symlinked
  // ANCESTOR directory is the actual gap: it would let the read below
  // resolve outside the workspace despite passing the lexical check above.
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

export function createEvidenceBinding({ workspace, plan, base = null, changedFiles = [] }) {
  const files = normalizedFiles(changedFiles);
  return {
    base: base || null,
    planDigest: digest(planContractText(plan.text)),
    changedFiles: files,
    workspaceDigest: workspaceDigest(workspace, files, plan.path),
  };
}

export function validateEvidence({ workspace, plan, evidence, maxAgeHours = 24 }) {
  if (!evidence) return { pass: false, message: 'No harness verify evidence artifact for this plan' };
  if (evidence.outcome !== 'passed') {
    return { pass: false, message: `Latest harness verify outcome is ${evidence.outcome || 'unknown'}` };
  }
  if (evidence.version !== EVIDENCE_VERSION || !validBinding(evidence.binding)) {
    return { pass: false, message: 'Verification evidence is not bound to the current plan and workspace' };
  }
  if (evidence.plan !== plan.path) {
    return { pass: false, message: 'Verification evidence belongs to a different plan' };
  }
  const verifiedAt = Date.parse(evidence.verifiedAt || '');
  if (!Number.isFinite(verifiedAt)) return { pass: false, message: 'Verification timestamp is missing or invalid' };
  if (Date.now() - verifiedAt > maxAgeHours * 60 * 60 * 1000) {
    return { pass: false, message: 'Verification evidence is stale' };
  }
  if (evidence.binding.planDigest !== digest(planContractText(plan.text))) {
    return { pass: false, message: 'Plan changed after verification' };
  }

  const changed = collectChangedFiles(workspace, evidence.binding.base || null);
  if (changed.error) return { pass: false, message: changed.error };
  const currentFiles = normalizedFiles(changed.files);
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
