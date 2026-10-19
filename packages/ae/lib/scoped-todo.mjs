import fs from 'node:fs';
import path from 'node:path';
import { projectStoreDir } from './project-layout.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';
import { validatePlaybookBinding } from './playbook-binding.mjs';

const SCHEMA = 1;
const MAX_ITEMS = 512;
const MAX_BYTES = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STEP = /^S[1-9][0-9]{0,3}$/;
const PLAYBOOK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(message) {
  throw new Error(`Scoped todo: ${message}`);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}

function timestamp(value) {
  return typeof value === 'string' && STAMP.test(value) && Number.isFinite(Date.parse(value));
}

function parseStore(raw, planId) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) fail('store exceeds its bounded size');
  let value;
  try { value = JSON.parse(raw); } catch { fail('store must contain bounded valid JSON'); }
  if (!exactKeys(value, ['schema', 'planId', 'items', 'updatedAt']) || value.schema !== SCHEMA || value.planId !== planId || !Array.isArray(value.items) || value.items.length > MAX_ITEMS || !timestamp(value.updatedAt)) fail('store schema or plan identity is invalid');
  const ids = new Set();
  for (const item of value.items) {
    if (!exactKeys(item, ['id', 'planId', 'playbook', 'playbookHash', 'step', 'text', 'status', 'createdAt', 'completedAt'])
      || item.planId !== planId || typeof item.playbook !== 'string' || item.playbook.length > 100 || !PLAYBOOK.test(item.playbook)
      || !HASH.test(item.playbookHash) || !STEP.test(item.step) || item.id !== `${item.playbook}:${item.playbookHash}:${item.step}`
      || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000
      || !['open', 'done'].includes(item.status) || !timestamp(item.createdAt)
      || (item.status === 'done' ? !timestamp(item.completedAt) : item.completedAt !== undefined)
      || ids.has(item.id)) fail('store has an invalid or duplicate work item');
    ids.add(item.id);
  }
  return value;
}

function readStore(home, rel, planId) {
  const filesystemRoot = path.parse(home).root;
  if (!assertNoSymlinkAncestors(filesystemRoot, path.relative(filesystemRoot, home))) fail('Harness home has unsafe ancestors');
  const full = assertNoSymlinkAncestors(home, rel);
  if (!full) fail('store path has unsafe ancestors');
  try { fs.lstatSync(full); } catch (error) {
    if (error.code === 'ENOENT') return { schema: SCHEMA, planId, items: [], updatedAt: null };
    fail('store is unreadable');
  }
  const raw = readFileNoFollow(full, { root: home, maxBytes: MAX_BYTES });
  if (raw === null) fail('store must be a bounded regular file');
  return parseStore(raw, planId);
}

function ensureStoreParent(home, rel) {
  const filesystemRoot = path.parse(home).root;
  if (!assertNoSymlinkAncestors(filesystemRoot, path.relative(filesystemRoot, home))) fail('Harness home has unsafe ancestors');
  fs.mkdirSync(home, { recursive: true });
  const full = assertNoSymlinkAncestors(home, rel);
  if (!full) fail('store path has unsafe ancestors');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (!assertNoSymlinkAncestors(home, rel)) fail('store path became unsafe');
  return full;
}

function inapplicableSteps(plan, binding) {
  const entries = plan.fm.workflow_not_applicable ?? [];
  if (!Array.isArray(entries) || entries.length > MAX_ITEMS) fail('accepted workflow exceptions are invalid');
  const reasons = new Map();
  for (const entry of entries) {
    if (!exactKeys(entry, ['playbook', 'sha256', 'step', 'reason']) || typeof entry.playbook !== 'string' || !PLAYBOOK.test(entry.playbook)
      || !HASH.test(entry.sha256) || !STEP.test(entry.step) || typeof entry.reason !== 'string' || !entry.reason.trim() || entry.reason.length > 1000) fail('accepted workflow exceptions need step identity and reason');
    if (entry.playbook === binding.id && entry.sha256 === binding.sha256) reasons.set(entry.step, entry.reason);
  }
  return reasons;
}

function resultFor(store, { plan, binding, steps, verb, changed = false, dryRun = false, item = null }) {
  const reasons = inapplicableSteps(plan, binding);
  const current = new Map(store.items.filter(i => i.playbookHash === binding.sha256 && i.playbook === binding.id).map(i => [i.step, i]));
  const performed = steps.filter(step => current.get(step.id)?.status === 'done').map(step => step.id);
  const inapplicable = steps.filter(step => current.get(step.id)?.status !== 'done' && reasons.has(step.id)).map(step => ({ step: step.id, reason: reasons.get(step.id) }));
  const pending = steps.filter(step => !performed.includes(step.id) && !reasons.has(step.id)).map(step => step.id);
  const items = store.items.map(value => ({
    ...value,
    disposition: value.playbookHash !== binding.sha256 || value.playbook !== binding.id ? 'previous-workflow'
      : value.status === 'done' ? 'performed' : reasons.has(value.step) ? 'accepted-inapplicable' : 'pending',
  }));
  return {
    schema: SCHEMA, mode: 'todo', scope: 'plan', verb, planId: store.planId, status: 'ok', exitCode: 0,
    dryRun, replayed: verb !== 'list' && !changed, items, ...(item ? { item } : {}),
    openCount: items.filter(value => value.status === 'open').length,
    doneCount: items.filter(value => value.status === 'done').length,
    performedCount: performed.length, inapplicableCount: inapplicable.length, pendingCount: pending.length,
    workflow: { playbook: binding.id, sha256: binding.sha256, performed, inapplicable, pending },
    output: items.length ? items.map(value => ({ line: `[${value.status === 'done' ? 'x' : ' '}] ${value.id}  ${value.text} (${value.disposition})` })) : [{ line: 'todo list empty; sync the accepted playbook to create its worklist' }],
  };
}

export function runScopedTodo({ workspace, plan, verb = 'list', id = null, dryRun = false, home, copilotHome } = {}) {
  const v = typeof verb === 'string' ? verb.toLowerCase() : '';
  try {
    if (!['list', 'sync', 'complete'].includes(v)) fail('scoped worklists support list, sync and complete only');
    const planId = plan?.fm?.plan_id;
    if (typeof planId !== 'string' || !UUID.test(planId)) fail('accepted plan needs a stable plan_id UUID');
    const storeHome = path.resolve(home || harnessGlobalHome());
    const full = path.join(projectStoreDir(workspace, { home: storeHome }), 'todos', `${planId}.json`);
    const rel = path.relative(storeHome, full);
    const perform = () => {
      const validated = validatePlaybookBinding(plan, { copilotHome });
      if (!validated.pass) fail(validated.message || 'accepted playbook binding is invalid');
      const { binding, steps } = validated;
      inapplicableSteps(plan, binding);
      const store = readStore(storeHome, rel, planId);
      for (const step of steps) {
        const existing = store.items.find(value => value.id === `${binding.id}:${binding.sha256}:${step.id}`);
        if (existing && (existing.playbook !== binding.id || existing.text !== step.text)) fail('work item conflicts with its frozen playbook step');
      }
      if (v === 'list') return resultFor(store, { plan, binding, steps, verb: v });
      let changed = false;
      let item = null;
      const now = new Date().toISOString();
      if (v === 'sync') {
        const existingIds = new Set(store.items.map(value => value.id));
        for (const step of steps) {
          const stepKey = `${binding.id}:${binding.sha256}:${step.id}`;
          if (existingIds.has(stepKey)) continue;
          store.items.push({ id: stepKey, planId, playbook: binding.id, playbookHash: binding.sha256, step: step.id, text: step.text, status: 'open', createdAt: now });
          changed = true;
        }
        if (store.items.length > MAX_ITEMS) fail('store reached its bounded work item limit');
      } else {
        const index = store.items.findIndex(value => value.id === id);
        if (index < 0) fail('complete needs the id of an existing work item');
        item = store.items[index];
        if (item.status !== 'done') {
          item = { ...item, status: 'done', completedAt: now };
          store.items[index] = item;
          changed = true;
        }
      }
      if (changed) {
        store.updatedAt = now;
        const payload = `${JSON.stringify(store, null, 2)}\n`;
        parseStore(payload, planId);
        if (!dryRun && writeFileContained(storeHome, rel, payload) === null) fail('could not publish the worklist safely');
      }
      return resultFor(store, { plan, binding, steps, verb: v, changed, dryRun: Boolean(dryRun), item });
    };
    if (v === 'list' || dryRun) return perform();
    return withPlanUpdateLock(ensureStoreParent(storeHome, rel), perform);
  } catch (error) {
    return { schema: SCHEMA, mode: 'todo', scope: 'plan', verb: v, status: 'failed', exitCode: 1, reason: error.message, items: [], output: [{ line: error.message }] };
  }
}
