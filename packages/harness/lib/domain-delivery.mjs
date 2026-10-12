import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { domainAuthorityBinding } from './domain-bindings.mjs';
import { observeDomainRepository } from './domain-contract.mjs';
import { planHome, planRecordRoot, resolveDomainContext } from './domain-context.mjs';
import { loadPlan } from './plan-parse.mjs';
import { externalPlansDir } from './project-layout.mjs';
import { collectChangedFiles, matchesScope } from './plan-scope.mjs';
import { createEvidenceBinding, planDigest, proofPolicyDigest } from './evidence.mjs';
import { validateCompletion } from './completion.mjs';
import { loadNamedChecks, runNamedCheck, validateCommand } from './checks.mjs';
import { isProjectTrusted, trustStatus } from './trust.mjs';
import { loadPolicy } from './policy.mjs';
import { validateCheckArtifacts } from './check-artifacts.mjs';
import { recordHash } from './review.mjs';
import { readFileNoFollow, writeFileContained, assertNoSymlinkAncestors } from './fs-safe.mjs';

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const HEAD = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const PLAN = /^\d{4}-\d{2}-\d{2}-(?:feat|fix|docs|refactor|chore)-[a-z0-9]+(?:-[a-z0-9]+)*-plan\.hplan$/;
const CHECK = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const STAT_FIELDS = ['dev', 'ino', 'birthtimeNs'];

function failure(message) {
  return Object.assign(new Error(`Domain delivery: ${message}`), { code: 'E_DOMAIN_DELIVERY', exit: 1 });
}

function shape(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure(`${label} has an unsupported shape`);
}

function scope(value) {
  return Array.isArray(value) && value.length <= 128 && new Set(value).size === value.length && value.every(item => typeof item === 'string' && item && !path.isAbsolute(item) && !path.win32.isAbsolute(item) && !/[\x00-\x1f\x7f\\]/.test(item) && !item.split('/').includes('..'));
}

export function validateDomainCoordinator(coordinator) {
  shape(coordinator, ['root', 'commonDir', 'gitDir', 'initial_head', 'filesystemIdentity'], 'coordinator binding');
  if (!HEAD.test(coordinator.initial_head || '') || ['root', 'commonDir', 'gitDir'].some(key => typeof coordinator[key] !== 'string' || !path.isAbsolute(coordinator[key]) || Buffer.byteLength(coordinator[key]) > 4096 || /[\x00-\x1f\x7f]/.test(coordinator[key]))) throw failure('coordinator requires canonical absolute Git identity paths and accepted HEAD');
  shape(coordinator.filesystemIdentity, ['root', 'commonDir', 'gitDir'], 'coordinator filesystem identity');
  for (const value of Object.values(coordinator.filesystemIdentity)) {
    shape(value, STAT_FIELDS, 'coordinator directory identity');
    if (STAT_FIELDS.some(key => typeof value[key] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value[key]) || BigInt(value[key]) > 18446744073709551615n)) throw failure('coordinator directory identity requires bounded nonzero device, inode and birth time');
  }
  if (Object.keys(coordinator.filesystemIdentity).length !== 3) throw failure('coordinator filesystem identity must cover each accepted path');
  const filesystemIdentity = Object.fromEntries(['root', 'commonDir', 'gitDir'].map(key => [key, Object.fromEntries(STAT_FIELDS.map(field => [field, coordinator.filesystemIdentity[key][field]]))]));
  return { root: coordinator.root, commonDir: coordinator.commonDir, gitDir: coordinator.gitDir, initial_head: coordinator.initial_head, filesystemIdentity };
}

export function snapshotDomainCoordinator(workspace) {
  const observation = observeDomainRepository(workspace, { id: 'coordinator' });
  const observed = observation.observed;
  if (observation.status !== 'available' || !observed.head || !observed.root || !observed.commonDir || !observed.gitDir) throw failure('coordinator root, Git identity or HEAD is unavailable');
  const identity = { root: observed.root, commonDir: observed.commonDir, gitDir: observed.gitDir, initial_head: observed.head };
  const filesystemIdentity = Object.fromEntries(['root', 'commonDir', 'gitDir'].map(key => {
    const full = identity[key];
    if (!assertNoSymlinkAncestors(path.parse(full).root, path.relative(path.parse(full).root, full)) || fs.realpathSync(full) !== full) throw failure('coordinator identity path is unsafe or noncanonical');
    const stat = fs.lstatSync(full, { bigint: true });
    if (!stat.isDirectory()) throw failure('coordinator identity path must be a directory');
    return [key, Object.fromEntries(STAT_FIELDS.map(field => [field, stat[field]?.toString()]))];
  }));
  return validateDomainCoordinator({ ...identity, filesystemIdentity });
}

export function validateCoordinatorBinding(workspace, coordinator) {
  try {
    const expected = validateDomainCoordinator(coordinator);
    const current = snapshotDomainCoordinator(workspace);
    if (recordHash(current) !== recordHash(expected)) throw failure('invocation differs from the accepted coordinator identity or HEAD; accept an explicit domain-intent amendment after live identity validation');
    return { pass: true, message: 'Accepted coordinator physical identity and HEAD are current' };
  } catch (error) { return { pass: false, message: error.message }; }
}

export function domainCoordinatorCheck({ workspace, plan }) {
  return plan?.fm?.domain_parent ? validateCoordinatorBinding(workspace, plan.fm.domain_parent.coordinator) : { pass: true, message: 'No domain coordinator execution authority' };
}

export function validateDomainParent(parent, binding) {
  shape(parent, ['version', 'name', 'coordinator', 'repos', 'joint_checks', 'release_order', 'rollback'], 'parent contract');
  validateDomainCoordinator(parent.coordinator);
  if (parent.version !== 1 || parent.name !== binding?.name || !ID.test(parent.name || '') || !Array.isArray(parent.repos) || !parent.repos.length || parent.repos.length > 32) throw failure('parent requires supported version and bounded repository obligations');
  const ids = parent.repos.map(repo => repo?.id);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids.slice().sort()) !== JSON.stringify((binding?.logical?.repos || []).map(repo => repo.id).sort())) throw failure('parent repository obligations must cover every accepted member exactly once');
  for (const repo of parent.repos) {
    shape(repo, ['id', 'initial_head', 'touched_scope', 'depends_on', 'child_plan_id', 'child_plan_path'], 'repository obligation');
    if (!ID.test(repo.id || '') || !HEAD.test(repo.initial_head || '') || !scope(repo.touched_scope) || !Array.isArray(repo.depends_on) || new Set(repo.depends_on).size !== repo.depends_on.length || repo.depends_on.some(id => !ids.includes(id) || id === repo.id)) throw failure('repository obligations require identity, initial HEAD, safe scope and known dependencies');
    const touched = repo.touched_scope.length > 0;
    if (touched ? !UUID.test(repo.child_plan_id || '') || !PLAN.test(repo.child_plan_path || '') : repo.child_plan_id !== null || repo.child_plan_path !== null) throw failure('each touched repository requires exactly one reserved child plan; unchanged members have no child');
  }
  const childIds = parent.repos.map(repo => repo.child_plan_id).filter(Boolean);
  if (new Set(childIds).size !== childIds.length) throw failure('reserved child plan identities must be unique');
  if (!Array.isArray(parent.joint_checks) || !parent.joint_checks.length || parent.joint_checks.length > 32) throw failure('parent requires a bounded nonempty integrated check contract');
  const joint = new Set();
  for (const check of parent.joint_checks) {
    shape(check, ['repo', 'check'], 'joint check');
    const key = `${check.repo}:${check.check}`;
    if (!ids.includes(check.repo) || !CHECK.test(check.check || '') || joint.has(key)) throw failure('joint checks must uniquely name an accepted repository and configured check');
    joint.add(key);
  }
  if (!Array.isArray(parent.release_order) || parent.release_order.length !== ids.length || new Set(parent.release_order).size !== ids.length || parent.release_order.some(id => !ids.includes(id)) || typeof parent.rollback !== 'string' || !parent.rollback.trim() || Buffer.byteLength(parent.rollback) > 8192) throw failure('parent requires an exact release order and bounded rollback responsibility');
  const order = new Map(parent.release_order.map((id, index) => [id, index]));
  if (parent.repos.some(repo => repo.depends_on.some(id => order.get(id) >= order.get(repo.id)))) throw failure('release order must place dependencies before their consumers');
  return parent;
}

function selectedHome(workspace, plan, home) {
  return home || planHome(workspace, plan);
}

export function domainLinkCheck({ workspace, plan, copilotHome, home }) {
  const child = plan?.fm?.domain_child;
  if (!child) return domainCoordinatorCheck({ workspace, plan });
  try {
    shape(child, ['version', 'name', 'parent_plan_id', 'parent_plan_path', 'parent_contract_digest', 'repoId'], 'child link');
    if (child.version !== 1 || child.name !== plan.fm.domain_binding?.name || !UUID.test(child.parent_plan_id || '') || !PLAN.test(child.parent_plan_path || '') || !HASH.test(child.parent_contract_digest || '') || !ID.test(child.repoId || '')) throw failure('child link requires an exact accepted parent identity and contract');
    const context = resolveDomainContext({ workspace, home: selectedHome(workspace, plan, home), name: child.name });
    const parent = loadPlan(workspace, child.parent_plan_path, { home: context.home, domainContext: context });
    if (!parent || !parent.plan_lock || parent.fm.plan_id !== child.parent_plan_id || planDigest(parent.text) !== child.parent_contract_digest) throw failure('accepted locked parent is missing or its contract changed');
    validateDomainParent(parent.fm.domain_parent, parent.fm.domain_binding);
    const coordinator = domainCoordinatorCheck({ workspace: parent.fm.domain_parent.coordinator.root, plan: parent });
    if (!coordinator.pass) throw failure(coordinator.message);
    const reservation = parent.fm.domain_parent.repos.find(repo => repo.id === child.repoId);
    if (!reservation || reservation.child_plan_id !== plan.fm.plan_id || reservation.child_plan_path !== path.basename(plan.path) || recordHash(parent.fm.domain_binding) !== recordHash(plan.fm.domain_binding)) throw failure('child is not the exact reserved record with the accepted shared authority');
    const authority = domainAuthorityBinding(workspace, plan, { home: context.home });
    if (!authority.pass) throw failure(authority.diagnostics.join(' '));
    return { pass: true, message: 'Accepted parent identity, contract, child reservation and shared authority are current' };
  } catch (error) { return { pass: false, message: error.message }; }
}

function childState(repo, member, parent, home, copilotHome) {
  if (!repo.child_plan_id) return { plan: null, result: { pass: !repo.touched_scope.length, message: repo.touched_scope.length ? 'Touched repository has no reserved child' : 'Unchanged dependency participates without product edits' } };
  const childPath = path.join(externalPlansDir(member.root, { home }), repo.child_plan_path);
  const child = loadPlan(member.root, childPath, { home });
  if (!child || child.fm.plan_id !== repo.child_plan_id || child.fm.domain_parent) return { plan: child, result: { pass: false, message: 'Reserved child record is missing or has another identity' } };
  const link = child.fm.domain_child;
  if (!link || link.parent_plan_id !== parent.fm.plan_id || link.parent_contract_digest !== planDigest(parent.text) || link.repoId !== repo.id || link.parent_plan_path !== path.basename(parent.path) || recordHash(child.fm.domain_binding) !== recordHash(parent.fm.domain_binding)) return { plan: child, result: { pass: false, message: 'Child link or accepted shared authority is stale' } };
  return { plan: child, result: validateCompletion({ workspace: member.root, plan: child, copilotHome, home }) };
}

export function domainExecutionBinding({ workspace, plan, copilotHome, home }) {
  if (!plan?.fm?.domain_parent) return null;
  const selected = selectedHome(workspace, plan, home);
  const binding = plan.fm.domain_binding;
  const diagnostics = [];
  try { validateDomainParent(plan.fm.domain_parent, binding); }
  catch (error) {
    const value = { version: 1, parentPlanId: plan.fm.plan_id, parentContractDigest: planDigest(plan.text), sharedBindingDigest: recordHash(binding), repos: [], diagnostics: [error.message] };
    return { ...value, digest: recordHash(value) };
  }
  const authority = domainAuthorityBinding(workspace, plan, { home: selected });
  diagnostics.push(...authority.diagnostics);
  const coordinator = domainCoordinatorCheck({ workspace, plan });
  if (!coordinator.pass) diagnostics.push(coordinator.message);
  const members = new Map((binding?.bindings?.repos || []).map(repo => [repo.id, repo]));
  const repos = [];
  for (const repo of plan.fm.domain_parent.repos || []) {
    const member = members.get(repo.id);
    try {
      if (!member) throw failure(`${repo.id} accepted execution root is missing`);
      const descriptor = binding.logical.repos.find(item => item.id === repo.id);
      const observed = observeDomainRepository(member.root, descriptor);
      if (observed.status !== 'available' || !observed.observed.head) throw failure(`${repo.id} root or Git identity is unavailable`);
      const changed = collectChangedFiles(member.root, repo.initial_head);
      if (changed.error) throw failure(`${repo.id}: ${changed.error}`);
      const excluded = changed.files.filter(file => !matchesScope(file, repo.touched_scope));
      if (excluded.length) diagnostics.push(`${repo.id} changed files outside its accepted touched scope: ${excluded.slice(0, 8).join(', ')}`);
      const content = createEvidenceBinding({ workspace: member.root, plan: { path: '', text: '', fm: {}, phase: 0 }, base: repo.initial_head, changedFiles: changed.files, copilotHome });
      const checked = childState(repo, member, plan, selected, copilotHome);
      repos.push({ id: repo.id, root: member.root, primaryRoot: member.primaryRoot, origin: member.origin, commonDir: member.commonDir, gitDir: member.gitDir, filesystemIdentity: member.filesystemIdentity, head: observed.observed.head, base: repo.initial_head, changedFiles: content.changedFiles, workspaceDigest: content.workspaceDigest, policyDigest: proofPolicyDigest(member.root, copilotHome, selected), trust: trustStatus({ workspace: member.root, copilotHome, home: selected }).state, child: checked.plan ? { planId: checked.plan.fm.plan_id, contractDigest: planDigest(checked.plan.text), completionId: checked.result.pass ? checked.result.record : null, current: checked.result.pass } : null, completion: { pass: checked.result.pass, message: checked.result.message } });
    } catch (error) { diagnostics.push(`${repo.id}: ${error.message}`); repos.push({ id: repo.id, root: member?.root || null, unavailable: true, completion: { pass: false, message: error.message } }); }
  }
  const value = { version: 1, parentPlanId: plan.fm.plan_id, parentContractDigest: planDigest(plan.text), sharedBindingDigest: recordHash(binding), coordinator: plan.fm.domain_parent.coordinator, repos, diagnostics };
  return { ...value, digest: recordHash(value) };
}

export function domainPrerequisites(options) {
  if (!options.plan?.fm?.domain_parent) return domainLinkCheck(options);
  try {
    const binding = domainExecutionBinding(options);
    const messages = [...binding.diagnostics, ...binding.repos.filter(repo => !repo.completion.pass).map(repo => `${repo.id}: ${repo.completion.message}`)];
    return { pass: messages.length === 0, message: messages.length ? messages.join(' ') : 'Every participating identity and required child completion is current', binding };
  } catch (error) { return { pass: false, message: error.message, binding: null }; }
}


function jointRel(plan, repo, check) {
  return `.harness/domain/joint/${plan.fm.plan_id}/${recordHash({ repo, check })}.json`;
}

function readJoint(root, rel) {
  const text = readFileNoFollow(path.join(root, rel), { root, maxBytes: 2 * 1024 * 1024 });
  try { return text === null ? null : JSON.parse(text); } catch { return null; }
}

function validReceipt(record) {
  return record?.version === 1 && record.id === recordHash(record.value) && record.value?.version === 1 && typeof record.value.stable === 'boolean' && HASH.test(record.value.revisionDigest || '') && record.value.manifestDigest === recordHash(record.value.manifestData) && record.value.manifestData?.revisionDigest === record.value.revisionDigest && ['passed', 'failed', 'timeout', 'unavailable'].includes(record.value.result?.status);
}

function receiptIsCurrent(record, binding, options) {
  if (!validReceipt(record) || !record.value.stable || record.value.revisionDigest !== binding?.digest) return false;
  const at = Date.parse(record.recordedAt || '');
  const ttl = loadPolicy(options.workspace, null, { copilotHome: options.copilotHome, home: selectedHome(options.workspace, options.plan, options.home) }).evidenceTtlHours;
  if (!Number.isFinite(at) || at > Date.now() + 1000 || Date.now() - at > ttl * 60 * 60 * 1000) return false;
  const member = binding.repos.find(repo => repo.id === record.value.repo);
  const configured = member?.root ? loadNamedChecks(member.root) : null;
  const check = configured?.checks?.[record.value.check];
  if (!check || configured.error || check.proof === 'type-check' || record.value.result.proof !== 'behavior') return false;
  return validateCheckArtifacts(authorizedRecordRoot(options), check, { ...record.value.result, id: record.value.check }).pass;
}

function authorizedRecordRoot(options) {
  const root = planRecordRoot(options.workspace, options.plan);
  if (options.recordRoot && path.resolve(options.recordRoot) !== root) throw failure('record root differs from the explicit parent context authority');
  return root;
}

export function domainStatus(options) {
  const prerequisite = domainPrerequisites(options);
  const binding = prerequisite.binding || domainExecutionBinding(options);
  if (!options.plan?.fm?.domain_parent) return { pass: prerequisite.pass, message: prerequisite.message, repos: [], joint: [] };
  const root = authorizedRecordRoot(options);
  const joint = options.plan.fm.domain_parent.joint_checks.map(item => {
    const record = readJoint(root, jointRel(options.plan, item.repo, item.check));
    const current = receiptIsCurrent(record, binding, options);
    return { ...item, status: !record ? 'missing' : !current ? 'stale' : record.value.result.status, record: current ? record.id : null };
  });
  const failed = joint.filter(check => check.status !== 'passed');
  return { pass: prerequisite.pass && failed.length === 0, message: !prerequisite.pass ? prerequisite.message : failed.length ? `Integrated proof is incomplete: ${failed.map(check => `${check.repo}/${check.check} ${check.status}`).join(', ')}` : 'Every participating child and integrated proof is current', binding, repos: binding?.repos || [], joint };
}

export async function runDomainJointChecks(options) {
  const { workspace, plan, copilotHome, signal, onEvent, events } = options;
  if (!plan?.fm?.domain_parent) return { pass: true, checks: [], binding: null };
  const prerequisite = domainPrerequisites(options);
  if (!prerequisite.pass) return { pass: false, checks: [{ id: 'domain-children', status: 'failed', message: prerequisite.message }], binding: prerequisite.binding };
  const root = authorizedRecordRoot(options);
  const before = prerequisite.binding;
  const invocation = randomUUID();
  const manifestRel = `.harness/domain/joint/${plan.fm.plan_id}/manifests/${invocation}.json`;
  const manifest = { version: 1, invocation, parentPlanId: plan.fm.plan_id, revisionDigest: before.digest, repos: before.repos, sharedSources: plan.fm.domain_binding.sharedSources };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestText) > 1024 * 1024) throw failure('participating revision manifest exceeds the size bound');
  if (!assertNoSymlinkAncestors(root, manifestRel) || !writeFileContained(root, manifestRel, manifestText)) throw failure('controller revision manifest store is unsafe or unavailable');
  const checks = [];
  const receipts = [];
  let manifestCurrent = true;
  const publish = value => {
    const record = { version: 1, id: recordHash(value), value, recordedAt: new Date().toISOString() };
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (!writeFileContained(root, `.harness/domain/joint/${plan.fm.plan_id}/history/${record.id}.json`, text) || !writeFileContained(root, jointRel(plan, value.repo, value.check), text)) throw failure('joint check receipt could not be published');
  };
  try {
    for (const joint of plan.fm.domain_parent.joint_checks) {
      const id = `domain-joint:${joint.repo}:${joint.check}`;
      const previous = readJoint(root, jointRel(plan, joint.repo, joint.check));
      if (receiptIsCurrent(previous, before, options) && previous.value.result.status === 'passed') {
        checks.push({ ...previous.value.result, reused: true, record: previous.id });
        onEvent?.('row', { check: id, status: 'passed', message: 'Retained current successful integrated proof for this exact revision set' });
        continue;
      }
      const repo = before.repos.find(member => member.id === joint.repo);
      let result;
      const configured = loadNamedChecks(repo.root);
      manifestCurrent &&= readFileNoFollow(path.join(root, manifestRel), { root, maxBytes: 1024 * 1024 }) === manifestText;
      if (!manifestCurrent) result = { status: 'failed', message: 'Controller revision manifest changed before the integrated check' };
      else if (!isProjectTrusted({ workspace: repo.root, copilotHome, home: selectedHome(workspace, plan, options.home) })) result = { status: 'unavailable', message: 'Joint check repository policy is not currently trusted' };
      else if (configured.error || !configured.checks?.[joint.check]) result = { status: 'unavailable', message: configured.error || 'Declared joint check is missing' };
      else if (configured.checks[joint.check].proof === 'type-check') result = { status: 'unavailable', message: 'Integrated compatibility proof requires an executed behavior check' };
      else if (validateCommand(joint.check, configured.checks[joint.check])) result = { status: 'unavailable', message: validateCommand(joint.check, configured.checks[joint.check]) };
      else {
        onEvent?.('progress', { check: id, phase: 'start' });
        result = await runNamedCheck(repo.root, joint.check, configured.checks[joint.check], { signal, copilotHome, home: selectedHome(workspace, plan, options.home), events, recordRoot: root, controllerPlan: plan, controllerWorkspace: workspace, controllerEnv: { HARNESS_DOMAIN_REVISION_MANIFEST: path.join(root, manifestRel) } });
      }
      manifestCurrent &&= readFileNoFollow(path.join(root, manifestRel), { root, maxBytes: 1024 * 1024 }) === manifestText;
      const outcome = { ...result, id, proof: 'behavior', ...(!manifestCurrent ? { status: 'failed', message: 'The integrated check changed or removed the controller revision manifest' } : {}) };
      checks.push(outcome);
      const value = { version: 1, invocation, parentPlanId: plan.fm.plan_id, repo: joint.repo, check: joint.check, revisionDigest: before.digest, manifest: manifestRel, manifestData: manifest, manifestDigest: recordHash(manifest), stable: false, result: outcome };
      receipts.push(value);
      publish(value);
      onEvent?.('row', { check: id, status: outcome.status, message: outcome.message });
      if (signal?.aborted || !manifestCurrent) break;
    }
    const after = domainExecutionBinding(options);
    const stable = manifestCurrent && after.digest === before.digest && readFileNoFollow(path.join(root, manifestRel), { root, maxBytes: 1024 * 1024 }) === manifestText;
    for (const value of receipts) publish({ ...value, stable });
    checks.push({ id: 'domain-revision-stability', status: stable ? 'passed' : 'failed', message: stable ? 'All participating revisions, dirty bytes, trust, shared sources and child completions remained current' : 'A participating revision, byte, authority or child completion changed while the integrated check ran' });
    return { pass: stable && checks.length === plan.fm.domain_parent.joint_checks.length + 1 && checks.every(check => check.status === 'passed'), checks, binding: after };
  } finally {
    const full = path.join(root, manifestRel);
    if (assertNoSymlinkAncestors(root, path.dirname(manifestRel))) {
      const stat = fs.lstatSync(full, { throwIfNoEntry: false });
      if (stat?.isFile() || stat?.isSymbolicLink()) fs.unlinkSync(full);
    }
  }
}
