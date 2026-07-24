import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function planContractText(text) {
  return String(text || '').replace(/\n## Activity\s*\n[\s\S]*?(?=\n## |$)/gi, '');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPlan(workspace, planPath) {
  try {
    const root = fs.realpathSync(workspace);
    const plans = fs.realpathSync(path.join(workspace, 'docs', 'plans'));
    const full = fs.realpathSync(path.resolve(workspace, planPath));
    return isWithin(root, plans) && isWithin(plans, full) ? full : null;
  } catch {
    return null;
  }
}

function lines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function normalizedRel(value) {
  return String(value || '').replace(/\\/g, '/');
}

function changedFiles(workspace, base) {
  if (base !== null && base !== undefined && (typeof base !== 'string' || base.startsWith('-') || /[\0\r\n]/.test(base))) {
    throw new Error('base must be a safe git ref');
  }
  const diff = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMRDTUXB', base || 'HEAD', '--'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (diff.status !== 0) throw new Error(diff.error?.message || String(diff.stderr || '').trim() || 'git diff failed');
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (untracked.status !== 0) {
    throw new Error(untracked.error?.message || String(untracked.stderr || '').trim() || 'git ls-files failed');
  }
  return [...new Set([...lines(diff.stdout), ...lines(untracked.stdout)])]
    .filter((file) => !file.startsWith('.harness/'))
    .sort();
}

function containedPath(workspace, rel) {
  const root = path.resolve(workspace);
  const full = path.resolve(root, rel);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Evidence path escapes workspace: ${rel}`);
  }
  return full;
}

function workspaceDigest(workspace, files, planPath) {
  const hash = createHash('sha256');
  const normalizedPlanPath = normalizedRel(planPath);
  for (const rel of files) {
    const full = containedPath(workspace, rel);
    hash.update(`${rel}\0`);
    if (!fs.existsSync(full)) {
      hash.update('missing\0');
      continue;
    }
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) hash.update(`symlink\0${fs.readlinkSync(full)}\0`);
    else if (stat.isFile()) {
      const content = fs.readFileSync(full);
      hash.update('file\0');
      hash.update(rel === normalizedPlanPath ? planContractText(content.toString('utf8')) : content);
      hash.update('\0');
    } else hash.update(`other\0${stat.mode}\0`);
  }
  return hash.digest('hex');
}

export function validateEvidenceBinding({ workspace, planPath, evidence, maxAgeHours }) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return 'evidence is invalid';
  const binding = evidence.binding;
  if (
    evidence.version !== 2 ||
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    (binding.base !== null && (typeof binding.base !== 'string' || binding.base.startsWith('-'))) ||
    typeof binding.planDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(binding.planDigest) ||
    !Array.isArray(binding.changedFiles) ||
    !binding.changedFiles.every((file) => typeof file === 'string' && file.length > 0) ||
    typeof binding.workspaceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(binding.workspaceDigest)
  ) {
    return 'evidence binding is invalid';
  }
  const normalizedPlanPath = normalizedRel(planPath);
  if (normalizedRel(evidence.plan) !== normalizedPlanPath) return 'evidence belongs to a different plan';
  const verifiedAt = Date.parse(evidence.verifiedAt || '');
  if (!Number.isFinite(verifiedAt)) return 'verification timestamp is missing or invalid';
  if (Date.now() - verifiedAt > maxAgeHours * 60 * 60 * 1000) return 'verification evidence is stale';

  const planFull = canonicalPlan(workspace, normalizedPlanPath);
  if (!planFull) return 'verified plan is missing or outside docs/plans';
  const planText = fs.readFileSync(planFull, 'utf8');
  if (evidence.binding.planDigest !== digest(planContractText(planText))) return 'plan changed after verification';

  try {
    const currentFiles = changedFiles(workspace, binding.base || null);
    const evidenceFiles = [...new Set(binding.changedFiles.map((file) => file.replace(/\\/g, '/')))].sort();
    if (JSON.stringify(currentFiles) !== JSON.stringify(evidenceFiles)) return 'workspace scope changed after verification';
    if (binding.workspaceDigest !== workspaceDigest(workspace, currentFiles, normalizedPlanPath)) {
      return 'workspace files changed after verification';
    }
  } catch (error) {
    return error.message;
  }
  return null;
}
