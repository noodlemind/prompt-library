import fs from 'node:fs';
import path from 'node:path';
import { ensureHarnessDir } from './session.mjs';

function evidenceRel(planPath) {
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
  const rel = evidenceRel(planPath);
  const full = path.join(workspace, rel);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}
