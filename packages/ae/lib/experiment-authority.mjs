import { resolveProjectAuthority } from './project-authority.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadPlan } from './plan-parse.mjs';
import { planContractText } from './work-contract.mjs';
import { planHome, planTrustHome } from './domain-context.mjs';
import { readSession } from './session.mjs';
import { validatePlanSchema } from './plan-schema.mjs';
import { configuredCheckSnapshot } from './plan-readiness.mjs';
import { isProjectTrusted, trustStorePath } from './trust.mjs';
import { loadPolicy } from './policy.mjs';
import { runGate } from './gate.mjs';
import { experimentCompletionCheck, validateExperimentWorkspace, claimExperimentWorkspace } from './experiment-state.mjs';
import { experimentInputsCheck, validateExperimentMeasurement } from './experiment-measurement.mjs';
import { projectStoreDir } from './project-layout.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';

export function validateExperimentAuthority({ workspace, plan, copilotHome, home, acceptedInputs = null, requireGate = true, requireClaim = false }) {
  try {
    const current = loadPlan(workspace, plan.path, { home: home || planHome(workspace, plan) });
    if (!current || !current.fm.experiment || !validatePlanSchema(current).pass || !current.plan_lock || !['in-progress', 'review'].includes(current.status)) throw new Error('A locked active schema-4 experiment plan is required');
    if (current.text !== plan.text) throw new Error('Accepted experiment plan changed; reread and refresh its gate');
    const trustHome = planTrustHome(workspace, current);
    if (!isProjectTrusted({ workspace, copilotHome, home: trustHome })) throw new Error('Experiment checks require current project trust in the selected home');
    if (requireClaim) {
      const claim = validateExperimentWorkspace({ workspace, plan: current, home });
      if (!claim.pass) throw new Error(claim.message);
    }
    if (acceptedInputs) {
      const inputs = experimentInputsCheck({ workspace, plan: current, accepted: acceptedInputs, copilotHome, home });
      if (!inputs.pass) throw new Error(inputs.message);
    }
    if (requireGate) {
      const session = readSession(workspace), policy = loadPolicy(workspace, null, { copilotHome, home: trustHome });
      const at = Date.parse(session?.lastGateAt || ''), now = Date.now();
      const digest = createHash('sha256').update(planContractText(current.text)).digest('hex');
      const checks = configuredCheckSnapshot(workspace);
      if (session?.gateStatus !== 'pass' || session.gatedPhase !== 'implement' || session.gatedPlan !== current.path || session.gatedPlanDigest !== digest || checks.error || session.gatedChecksDigest !== checks.digest || !Number.isFinite(at) || at > now || now - at > policy.gateTtlMinutes * 60000) throw new Error('Experiment execution requires a fresh bound implement gate');
      const preview = runGate({ workspace, flags: { plan: current.path, phase: 'implement', copilotHome, harnessHome: home }, planOverride: current });
      if (!preview.pass || preview.exitCode !== 0) throw new Error(preview.blockedReason || 'Current implement prerequisites are blocked');
    }
    return { pass: true, message: 'Current accepted experiment execution authority validated', gateTtlMinutes: loadPolicy(workspace, null, { copilotHome, home: trustHome }).gateTtlMinutes };
  } catch (error) { return { pass: false, message: error.message }; }
}

function fileStamp(full) {
  if (!assertNoSymlinkAncestors(path.parse(full).root, path.relative(path.parse(full).root, full))) throw new Error('Experiment authority file contains a symlink');
  const stat = fs.lstatSync(full, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error('Experiment authority file must be regular');
  return ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'].map(key => stat[key].toString()).join(':');
}

const gateFields = ['gateStatus', 'gatedPhase', 'gatedPlan', 'gatedPlanDigest', 'gatedChecksDigest', 'lastGateAt'];
const gateStamp = workspace => {
  const session = readSession(workspace);
  return JSON.stringify(gateFields.map(key => session?.[key] ?? null));
};

export function prepareExperimentAuthority(options) {
  const { workspace, plan, acceptedInputs, copilotHome } = options;
  const { binding } = claimExperimentWorkspace({ ...options, dryRun: true });
  const trustHome = planTrustHome(workspace, plan);
  const files = new Set([plan.fullPath, trustStorePath({ copilotHome, home: trustHome }),
    ...Object.values(resolveProjectAuthority(workspace, { home: trustHome }).files),
    ...(acceptedInputs?.dependencies || []).map(file => path.join(workspace, file.path)),
    ...(acceptedInputs?.intent || []).map(file => path.join(workspace, file.path)),
    ...[acceptedInputs?.runtime?.path, acceptedInputs?.evaluator?.path, acceptedInputs?.isolation?.sandbox?.path].filter(Boolean),
    path.join(workspace, '.git'), path.join(binding.gitDir, 'gitdir'), path.join(binding.gitDir, 'commondir'), path.join(binding.gitDir, 'HEAD'),
    path.join(binding.gitDir, 'config.worktree'), path.join(binding.commonDir, 'config'), path.join(binding.commonDir, 'packed-refs'),
    ...(binding.headRef.startsWith('ref: ') ? [path.join(binding.commonDir, binding.headRef.slice(5))] : [])]);
  const stamps = [...files].map(full => [full, fileStamp(full)]), gate = gateStamp(workspace);
  const checked = validateExperimentAuthority(options);
  if (!checked.pass) throw new Error(checked.message);
  return () => {
    try {
      for (const [key, expected] of Object.entries(binding.filesystemIdentity)) {
        const stat = fs.lstatSync(binding[key], { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || ['dev', 'ino', 'birthtimeNs'].some(field => stat[field].toString() !== expected[field])) throw new Error('Physical experiment workspace changed after preflight');
      }
      if (stamps.some(([full, stamp]) => fileStamp(full) !== stamp) || readFileNoFollow(plan.fullPath, { maxBytes: 1024 * 1024 }) !== plan.text || gateStamp(workspace) !== gate) throw new Error('Experiment authority changed after preflight; retry against current accepted inputs');
      const at = Date.parse(readSession(workspace)?.lastGateAt || ''), now = Date.now();
      if (!Number.isFinite(at) || at > now || now - at > checked.gateTtlMinutes * 60000) throw new Error('Experiment implement gate expired before publication');
      return { pass: true };
    } catch (error) { return { pass: false, message: error.message }; }
  };
}

export function experimentMeasurementCheck(options) {
  return attempt => validateExperimentMeasurement({ ...options, accepted: attempt.acceptedInputs, attempt, recordRoot: options.recordRoot || projectStoreDir(options.workspace, { home: options.home }) });
}

export function experimentProof(options) {
  if (!options.plan.fm.experiment) return { pass: true, message: 'No experiment target obligation' };
  return experimentCompletionCheck({ ...options, measurementCheck: experimentMeasurementCheck(options) });
}
