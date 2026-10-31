import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDomain, observeDomainRepositoryIdentity } from './domain-contract.mjs';
import { snapshotDomain, domainAuthorityBinding } from './domain-bindings.mjs';
import { resolveDomainContext, domainPlanPath } from './domain-context.mjs';
import { createFullPlan } from './plan-new.mjs';
import { loadPlan } from './plan-parse.mjs';
import { planDigest } from './evidence.mjs';
import { planRevision, scopePaths } from './plan-decisions.mjs';
import { externalPlansDir } from './project-layout.mjs';
import { inspectIsolation, addIsolatedWorktree } from './worktree.mjs';
import { loadNamedChecks, validateCommand } from './checks.mjs';
import { withPlanUpdateLock, applyPlanUpdate } from './plan-update.mjs';
import { readFileNoFollow, writeFileContained, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { recordHash } from './review.mjs';
import { validateDomainParent, snapshotDomainCoordinator, domainCoordinatorCheck, validateDomainCoordinator } from './domain-delivery.mjs';

const OPERATION = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CREATE_FIELDS = ['version', 'id', 'format', 'goal', 'slug', 'title', 'type', 'risk', 'scope', 'check', 'acceptance', 'constraints', 'phases', 'notes', 'outputs', 'skillsUsed', 'playbook', 'verificationRecipe', 'intentSources', 'repos', 'joint_checks', 'release_order', 'rollback', 'executionRoots'];
const PLAN_FIELDS = ['version', 'format', 'goal', 'slug', 'title', 'type', 'risk', 'scope', 'check', 'acceptance', 'constraints', 'phases', 'notes', 'outputs', 'skillsUsed', 'playbook', 'verificationRecipe', 'intentSources'];
const live = new Set();

function failure(message) { return Object.assign(new Error(`Domain plan creation: ${message}`), { code: 'E_DOMAIN_CREATE', exit: 1 }); }

function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure(`${label} has unsupported fields`);
}

function requireCheck(root, name) {
  const configured = loadNamedChecks(root);
  const command = configured.checks?.[name];
  if (configured.error || !command || validateCommand(name, command)) throw failure(`${root}: configure the declared executable check ${name || '(missing)'} through the ordinary init-repo workflow before creating a domain delivery plan`);
}

function authored(input) {
  const value = Object.fromEntries(PLAN_FIELDS.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  return { ...value, version: 1, format: 'full', status: 'open' };
}

function validateCreation(decision, record) {
  fields(decision, CREATE_FIELDS, 'creation decision');
  if (decision.version !== 1 || !OPERATION.test(decision.id || '') || !SLUG.test(decision.slug || '') || decision.slug.length > 48 || !decision.goal || !Array.isArray(decision.acceptance) || !decision.acceptance.length || decision.format && decision.format !== 'full') throw failure('creation requires version 1, operation ID, bounded slug, full goal and acceptance criteria');
  if (decision.scope !== undefined && (!Array.isArray(decision.scope) || decision.scope.length !== 0)) throw failure('a coordinator parent requires empty product scope; touched scopes belong to its child obligations');
  if (!Array.isArray(decision.repos) || decision.repos.length !== record.config.repos.length || new Set(decision.repos.map(repo => repo?.id)).size !== decision.repos.length) throw failure('repository decisions must cover unique configured membership');
  const byId = new Map(record.config.repos.map(repo => [repo.id, repo]));
  for (const repo of decision.repos) {
    fields(repo, ['id', 'scope', 'depends_on', 'plan'], 'repository creation');
    if (!byId.has(repo.id) || !Array.isArray(repo.scope) || !Array.isArray(repo.depends_on)) throw failure('repository creation requires known ID, explicit scope and dependency list');
    if (repo.scope.length) {
      scopePaths(repo.scope);
      fields(repo.plan, PLAN_FIELDS, 'child authored plan');
      if (!repo.plan.goal || !Array.isArray(repo.plan.acceptance) || !repo.plan.acceptance.length || !SLUG.test(repo.plan.slug || '') || repo.plan.slug.length > 48 || repo.plan.scope !== undefined) throw failure('touched child requires authored full goal, acceptance and bounded slug; scope belongs to its repository obligation');
    } else if (repo.plan !== undefined) throw failure('unchanged dependencies cannot receive executable child plans');
  }
  if (Buffer.byteLength(JSON.stringify(decision)) > 1024 * 1024) throw failure('creation decision exceeds the size bound');
}

function operationRel(id) { return `.harness/domain/operations/create-${recordHash(id)}.json`; }

function readJournal(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  const text = readFileNoFollow(full, { root, maxBytes: 4 * 1024 * 1024 });
  try {
    const record = JSON.parse(text);
    if (record?.version !== 1 || !record.reservation || record.reservationDigest !== recordHash(record.reservation)) throw new Error('invalid journal');
    return record;
  } catch { throw failure('creation journal is unreadable or malformed; repair it without replacing its reserved identities'); }
}

function publish(root, rel, journal) {
  if (!writeFileContained(root, rel, `${JSON.stringify(journal, null, 2)}\n`)) throw failure('creation operation store is unsafe or unavailable');
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function preview({ workspace, home, name, decision, copilotHome, record, reservation = null }) {
  const context = resolveDomainContext({ workspace, home, name });
  const primary = snapshotDomain(record, { executionRoots: decision.executionRoots || {} });
  const date = reservation?.date || new Date().toISOString().slice(0, 10);
  const parentId = reservation?.parentId || randomUUID();
  const members = new Map(primary.bindings.repos.map(repo => [repo.id, repo]));
  const repos = decision.repos.map(repo => {
    const member = members.get(repo.id);
    const touched = repo.scope.length > 0;
    const prior = reservation?.repos.find(item => item.id === repo.id);
    const childId = touched ? prior?.childId || randomUUID() : null;
    const initialHead = prior?.initialHead || observeDomainRepositoryIdentity(member.root, primary.logical.repos.find(item => item.id === repo.id)).observed.head;
    const isolation = touched ? inspectIsolation({ workspace: member.root, home }) : { blocked: false };
    const worktree = isolation.blocked ? addIsolatedWorktree({ workspace: member.root, slug: `domain-${parentId.slice(0, 8)}-${repo.id}`, from: initialHead, dryRun: true }) : null;
    const root = prior?.root || worktree?.path || member.root;
    const file = touched ? `${date}-${repo.plan.type || 'feat'}-${repo.plan.slug}-plan.hplan` : null;
    return { id: repo.id, root, primaryRoot: member.primaryRoot, initialHead, childId, childPath: file, worktree: prior?.worktree || worktree, scope: repo.scope.slice(), dependsOn: repo.depends_on.slice(), decision: touched ? { ...authored(repo.plan), scope: repo.scope.slice(), date } : null };
  });
  for (const repo of repos) {
    if (repo.decision) requireCheck(members.get(repo.id).root, repo.decision.check);
  }
  for (const check of decision.joint_checks || []) {
    if (!members.has(check.repo)) throw failure('joint check names an unknown repository');
    requireCheck(members.get(check.repo).root, check.check);
  }
  requireCheck(workspace, decision.check);
  const parent = { version: 1, name, coordinator: reservation?.parent.coordinator || snapshotDomainCoordinator(workspace), repos: repos.map(repo => ({ id: repo.id, initial_head: repo.initialHead, touched_scope: repo.scope, depends_on: repo.dependsOn, child_plan_id: repo.childId, child_plan_path: repo.childPath })), joint_checks: decision.joint_checks, release_order: decision.release_order, rollback: decision.rollback };
  validateDomainParent(parent, primary);
  const parentDecision = { ...authored(decision), status: 'planned', scope: [], date };
  const prospectiveParent = createFullPlan({ workspace, home, domainContext: context, decision: { ...parentDecision, domain_parent: parent, domain_binding: primary }, planId: parentId, copilotHome, dryRun: true });
  for (const repo of repos.filter(item => item.childId)) {
    createFullPlan({ workspace: members.get(repo.id).root, home, decision: { ...repo.decision, domain_binding: primary, domain_child: { version: 1, name, parent_plan_id: parentId, parent_plan_path: path.basename(prospectiveParent.path), parent_contract_digest: planDigest(prospectiveParent.plan.text), repoId: repo.id } }, planId: repo.childId, copilotHome, dryRun: true });
  }
  return { context, reservation: { date, parentId, initialBinding: primary, repos, parent, parentDecision } };
}

function installPlan(options, expected) {
  const full = expected.path;
  if (fs.existsSync(full)) {
    const current = loadPlan(options.workspace, full, { home: options.home, domainContext: options.domainContext });
    const acceptedStart = expected.plan.fm.domain_child && !expected.plan.plan_lock && current?.plan_lock && ['planned', 'in-progress', 'review', 'done'].includes(current.status) && planDigest(current.text) === planDigest(applyPlanUpdate(expected.plan.text, { lock: true }));
    if (!current || current.fm.plan_id !== expected.plan.fm.plan_id || planDigest(current.text) !== planDigest(expected.plan.text) && !acceptedStart) throw failure(`reserved plan ${full} already exists with a different contract`);
    return { plan: current, path: full, revision: planRevision(current.text), created: false };
  }
  const created = createFullPlan(options);
  if (created.revision !== expected.revision) throw failure('in-repository intent changed while the reserved plan was being created');
  return created;
}

export function createDomainPlans({ workspace, home, name, decision, dryRun = false, copilotHome }) {
  const record = readDomain(name, { home });
  if (record.config.domain_version !== 2) throw failure('version 1 is advisory; deliberate version 2 conversion is required');
  validateCreation(decision, record);
  const inputDigest = recordHash(decision);
  const context = resolveDomainContext({ workspace, home: record.home, name });
  const rel = operationRel(decision.id);
  const full = path.join(context.root, rel);
  let journal = readJournal(context.root, rel);
  if (journal && journal.inputDigest !== inputDigest) throw failure('operation ID was already reserved for another creation decision');
  if (journal) {
    const accepted = domainCoordinatorCheck({ workspace, plan: { fm: { domain_parent: journal.reservation.parent } } });
    if (!accepted.pass) throw failure(accepted.message);
  }
  if (dryRun) {
    const proposed = preview({ workspace, home: record.home, name, decision, copilotHome, record, reservation: journal?.reservation });
    return { operation: decision.id, dryRun: true, created: false, parent: { plan_id: proposed.reservation.parentId, path: path.join(context.plansDir, `${proposed.reservation.date}-${decision.type || 'feat'}-${decision.slug}-plan.hplan`) }, children: proposed.reservation.repos.filter(repo => repo.childId).map(repo => ({ repo: repo.id, plan_id: repo.childId, workspace: repo.root, path: path.join(externalPlansDir(repo.root, { home: record.home }), repo.childPath) })) };
  }
  const prepared = journal ? null : preview({ workspace, home: record.home, name, decision, copilotHome, record }).reservation;
  const observedCoordinator = snapshotDomainCoordinator(workspace);
  if (prepared && recordHash(validateDomainCoordinator(prepared.parent.coordinator)) !== recordHash(observedCoordinator)) throw failure('coordinator changed while preparing the creation reservation');
  if (!assertNoSymlinkAncestors(context.root, rel)) throw failure('creation store is unsafe');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const key = `${context.root}:${decision.id}`;
  withPlanUpdateLock(full, () => {
    journal = readJournal(context.root, rel);
    if (journal && journal.inputDigest !== inputDigest) throw failure('operation ID was already reserved for another creation decision');
    if (journal) {
      if (recordHash(validateDomainCoordinator(journal.reservation.parent.coordinator)) !== recordHash(observedCoordinator)) throw failure('invocation differs from the accepted coordinator; creation cannot claim this journal');
    }
    if (live.has(key) || journal?.owner && alive(journal.owner.pid)) throw failure('creation operation is already active');
    if (!journal) {
      if (!prepared) throw failure('creation journal disappeared; restore its reserved identities before retrying');
      journal = { version: 1, operation: decision.id, inputDigest, reservation: prepared, reservationDigest: recordHash(prepared), completedChildren: [], complete: false };
    }
    journal.owner = { pid: process.pid, startedAt: new Date().toISOString() };
    publish(context.root, rel, journal);
    live.add(key);
  });
  const replayed = Boolean(journal.parent);
  try {
    const reservation = journal.reservation;
    const coordinator = domainCoordinatorCheck({ workspace, plan: { fm: { domain_parent: reservation.parent } } });
    if (!coordinator.pass) throw failure(coordinator.message);
    const priorAuthority = domainAuthorityBinding(workspace, { fm: { domain_binding: reservation.initialBinding } }, { home: record.home });
    if (!priorAuthority.pass) throw failure(priorAuthority.diagnostics.join(' '));
    const executionRoots = { repos: Object.fromEntries(reservation.repos.map(repo => [repo.id, repo.root])), sources: Object.fromEntries(reservation.initialBinding.bindings.sources.map(source => [source.id, source.root])) };
    for (const repo of reservation.repos) {
      if (repo.worktree) addIsolatedWorktree({ workspace: repo.primaryRoot, slug: path.basename(repo.root), from: repo.initialHead, record: false });
    }
    const binding = snapshotDomain(record, { executionRoots });
    const parentDecision = { ...reservation.parentDecision, domain_parent: reservation.parent, domain_binding: binding };
    const parentOptions = { workspace, home: record.home, domainContext: context, decision: parentDecision, planId: reservation.parentId, copilotHome };
    const expectedParent = createFullPlan({ ...parentOptions, dryRun: true });
    const expectedChildren = reservation.repos.filter(repo => repo.childId).map(repo => {
      const child = { version: 1, name, parent_plan_id: reservation.parentId, parent_plan_path: path.basename(expectedParent.path), parent_contract_digest: planDigest(expectedParent.plan.text), repoId: repo.id };
      const options = { workspace: repo.root, home: record.home, decision: { ...repo.decision, domain_child: child, domain_binding: binding }, planId: repo.childId, copilotHome };
      return { repo, options, expected: createFullPlan({ ...options, dryRun: true }) };
    });
    domainPlanPath(context, expectedParent.path);
    if (journal.parentContract && journal.parentContract !== planDigest(expectedParent.plan.text)) throw failure('reserved parent contract changed; accepted creation cannot silently discard obligations');
    const childContracts = Object.fromEntries(expectedChildren.map(item => [item.repo.id, planDigest(item.expected.plan.text)]));
    if (journal.childContracts && recordHash(journal.childContracts) !== recordHash(childContracts)) throw failure('reserved child contracts changed; accept a separate amendment instead of replaying changed intent');
    journal.childContracts = childContracts;
    journal.parentContract = planDigest(expectedParent.plan.text);
    journal.parent = { path: expectedParent.path, plan_id: reservation.parentId, revision: expectedParent.revision };
    publish(context.root, rel, journal);
    const parent = installPlan(parentOptions, expectedParent);
    const children = [];
    for (const item of expectedChildren) {
      const installed = installPlan(item.options, item.expected);
      children.push({ repo: item.repo.id, path: installed.path, plan_id: item.repo.childId, workspace: item.repo.root, revision: installed.revision, created: installed.created });
      if (!journal.completedChildren.includes(item.repo.id)) journal.completedChildren.push(item.repo.id);
      publish(context.root, rel, journal);
    }
    journal.complete = true;
    publish(context.root, rel, journal);
    return { operation: decision.id, replayed, parent: { path: parent.path, plan_id: reservation.parentId, revision: parent.revision, created: parent.created }, children };
  } finally {
    delete journal.owner;
    publish(context.root, rel, journal);
    live.delete(key);
  }
}
