import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureHarnessDir } from './session.mjs';

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
  ensureHarnessDir(workspace, dryRun);
  const rel = evidenceRel(result.plan);
  if (!dryRun) {
    const full = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify({ version: 1, verifiedAt: new Date().toISOString(), ...result, evidencePath: rel }, null, 2)}\n`);
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
      return null;
    }
  }
  return null;
}
