import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { readPlanRecord } from './plan-record.mjs';
import { extractAcceptanceCriteria } from './plan-schema.mjs';
import { sourcePath, sourceHash, hashIntentFile, bindLockedIntentSources, lockIntentSources } from './intent-sources.mjs';
import { assertNoPersonalWrite } from './primitive-governance.mjs';
import { readFileNoFollow } from './fs-safe.mjs';

export const PLAN_ACTIONS = Object.freeze(['start', 'amend', 'progress', 'finding', 'gap', 'complete']);
export const planRevision = text => createHash('sha256').update(text).digest('hex');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = message => { throw Object.assign(new Error(`plan-update: ${message}`), { code: 'E_USAGE', exit: 2 }); };
function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail(`unsupported ${label} fields: ${unknown.join(', ')}`);
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) fail(`${label} must be a nonempty line`);
  return value.trim();
}
function section(body, heading, value) {
  const pattern = new RegExp(`(^|\\n)## ${heading}[^\\n]*\\n[\\s\\S]*?(?=\\n## |$)`);
  const replacement = `\n## ${heading}\n\n${value}\n`;
  return pattern.test(body) ? body.replace(pattern, () => replacement) : `${body.trimEnd()}\n${replacement}`;
}
function appendSection(body, heading, value) {
  const pattern = new RegExp(`(?:^|\\n)## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const current = body.match(pattern)?.[1]?.trimEnd() || '';
  return section(body, heading, `${current}${current ? '\n' : ''}${value}`);
}
const NOTE_HEADINGS = Object.freeze({ overview: 'Overview', context: 'Context', memory: 'Memory Cards', technical: 'Technical Notes', research: 'Research Notes', routing: 'Risk & Review Routing', implementation: 'Implementation Notes' });
export function applyPlanNotes(body, notes) {
  fields(notes, Object.keys(NOTE_HEADINGS), 'notes');
  for (const [key, value] of Object.entries(notes)) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /^##\s/m.test(value)) fail('notes must be content without owned section headings');
    body = section(body, NOTE_HEADINGS[key], value.trim());
  }
  return body;
}
export function renderPlanPhases(phases) {
  if (!Array.isArray(phases) || !phases.length || phases.length > 100) fail('phases must be a bounded nonempty list');
  return phases.map((phase, i) => {
    fields(phase, ['title', 'tasks'], 'phase');
    if (!Array.isArray(phase.tasks) || !phase.tasks.length || phase.tasks.length > 1000) fail('phase tasks must be a bounded nonempty list');
    return `### Phase ${i + 1}: ${text(phase.title, 'phase title')}\n\n${phase.tasks.map((task, j) => `- [ ] **P${i + 1}T${j + 1}** ${text(task, 'task')} <!-- phase:${i + 1} -->`).join('\n')}`;
  }).join('\n\n');
}
export function planState(plan) {
  const body = plan.sections.plan || '';
  const tasks = [...body.matchAll(/^-\s*\[([ xX])\]\s+(.+)$/gm)];
  return { phases: [...body.matchAll(/^### Phase \d+/gm)].length, tasks: tasks.length, completedTasks: tasks.filter(task => task[1] !== ' ').length };
}
function markProgress(body, heading, ids, { tasks = false } = {}) {
  if (ids === undefined) return body;
  if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(id))) fail('progress requires criterion or task IDs');
  const pattern = new RegExp(`(?:^|\\n)## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const content = body.match(pattern)?.[1] || '';
  let index = 0;
  const found = new Set();
  const changed = content.replace(/^(-\s*\[)[ xX](\]\s+)(.+)$/gm, (line, prefix, suffix, task) => {
    index++;
    const id = task.match(/^\*\*([A-Za-z][A-Za-z0-9]*)\*\*/)?.[1] || (tasks ? `T${index}` : null);
    if (!ids.includes(id)) return line;
    found.add(id);
    return `${prefix}x${suffix}${task}`;
  });
  if (ids.some(id => !found.has(id))) fail(`unknown progress IDs in ${heading}`);
  return section(body, heading, changed.trim());
}
export function scopePaths(values) {
  if (!Array.isArray(values) || !values.length) fail('scope must be a nonempty list');
  const paths = [...new Set(values.map(value => text(value, 'scope path').replace(/\\/g, '/').replace(/^\.\//, '')))];
  if (paths.some(value => path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').includes('..') || value.startsWith('~'))) fail('scope paths must be inside the product workspace');
  assertNoPersonalWrite(paths);
  return paths.sort();
}

export function validatePlanDecision(input) {
  fields(input, ['version', 'id', 'action', 'expect', 'rationale', 'authority', 'changes', 'intentSources', 'finding', 'gap', 'migrateIntent', 'progress'], 'operation');
  if (input.version !== 1 || !ID.test(input.id || '') || !PLAN_ACTIONS.includes(input.action) || !HASH.test(input.expect || '')) fail('operation requires version 1, id, action and observed plan sha256 in expect');
  if (input.migrateIntent !== undefined && typeof input.migrateIntent !== 'boolean') fail('migrateIntent must be boolean');
  if (['amend', 'gap'].includes(input.action)) text(input.rationale, 'rationale');
  const allowed = { start: ['migrateIntent'], amend: ['changes', 'intentSources', 'migrateIntent'], progress: ['progress'], finding: ['finding'], gap: ['gap'], complete: [] }[input.action];
  for (const key of ['changes', 'intentSources', 'finding', 'gap', 'migrateIntent', 'progress']) if (input[key] !== undefined && !allowed.includes(key)) fail(`${key} is not valid for ${input.action}`);
  if (input.authority !== undefined) {
    fields(input.authority, ['scope', 'basis'], 'authority');
    text(input.authority.scope, 'authority scope');
    text(input.authority.basis, 'authority basis');
  }
  if (input.migrateIntent && (input.authority?.scope !== 'plan-intent' || !input.rationale)) fail('migration requires a rationale and explicit plan-intent authority scope');
  return input;
}

export function applyPlanDecision(workspace, plan, input, { applyUpdate, recordedAt }) {
  validatePlanDecision(input);
  const change = { activity: [`${recordedAt} ${input.action} (${input.id})${input.rationale ? `: ${text(input.rationale, 'rationale')}` : ''}`] };
  if (input.action === 'start') {
    if (!['open', 'needs-info', 'planned', 'in-progress'].includes(plan.status)) fail(`cannot start from ${plan.status}`);
    change.status = 'in-progress';
    change.lock = true;
  }
  if (input.action === 'complete') change.status = 'done';
  let output = applyUpdate(plan.text, change);
  const match = output.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = YAML.parse(match[1]);
  if (input.action === 'start' && !(Number(plan.phase) > 0)) fm.phase = Number(plan.sections.plan?.match(/^###\s+Phase\s+(\d+)/m)?.[1] || 1);
  let body = output.slice(match[0].length);
  const amendments = [];
  if (input.migrateIntent) {
    if (fm.intent_source_policy === 'content-v1') fail('intent policy is already current; amend explicit source bindings instead of migrating again');
    fm.intent_sources = plan.plan_lock && fm.intent_sources?.length ? lockIntentSources(workspace, fm.intent_sources, { rehash: true }) : bindLockedIntentSources(workspace, fm.intent_sources || [], { query: fm.intent || readPlanRecord(plan.text)?.goal || '' });
    amendments.push(...fm.intent_sources.map(source => ({ path: source.path, oldHash: sourceHash(plan.fm.intent_sources?.find(entry => sourcePath(entry) === source.path)), newHash: source.sha256 })));
    fm.intent_source_policy = 'content-v1';
    if (readPlanRecord(plan.text)) fm.plan_format = 'short-v2'; else fm.plan_schema = 2;
  } else if (input.action === 'start' && !plan.plan_lock) {
    fm.intent_sources = fm.intent_sources?.length ? lockIntentSources(workspace, fm.intent_sources, { rehash: false }) : bindLockedIntentSources(workspace, fm.intent_sources || [], { query: fm.intent || readPlanRecord(plan.text)?.goal || '' });
  }
  if (input.intentSources !== undefined) {
    if (!Array.isArray(input.intentSources) || !input.intentSources.length || input.authority?.scope !== 'plan-intent') fail('source amendments require entries and explicit plan-intent authority scope');
    if (fm.intent_source_policy !== 'content-v1') fail('explicitly migrate legacy intent policy before amending bytes');
    for (const source of input.intentSources) {
      fields(source, ['path', 'oldHash', 'newHash'], 'source amendment');
      const rel = sourcePath(source);
      const existing = (fm.intent_sources || []).find(entry => sourcePath(entry) === rel);
      const oldHash = sourceHash(existing), newHash = hashIntentFile(workspace, rel);
      if (!existing || !oldHash || !newHash || source.oldHash !== undefined && source.oldHash !== oldHash || source.newHash !== undefined && source.newHash !== newHash) fail(`source amendment has stale or invalid bindings: ${rel}`);
      amendments.push({ path: rel, oldHash, newHash });
      existing.sha256 = newHash;
    }
  }
  if (input.changes !== undefined) {
    fields(input.changes, ['scope', 'goal', 'constraints', 'criteria', 'reviews', 'notes', 'phases', 'gaps'], 'changes');
    const changes = input.changes, record = readPlanRecord(plan.text);
    if (changes.notes !== undefined) body = applyPlanNotes(body, changes.notes);
    if (changes.phases !== undefined) body = section(body, 'Plan', renderPlanPhases(changes.phases));
    if (changes.scope !== undefined) body = section(body, 'Impacted Files', scopePaths(changes.scope).map(value => `- \`${value}\``).join('\n'));
    if (changes.goal !== undefined) {
      const goal = text(changes.goal, 'goal');
      fm.intent = goal;
      if (record) record.goal = goal;
      else body = appendSection(body, 'Accepted Intent', `- ${input.id}: ${goal}`);
    }
    if (changes.constraints !== undefined) {
      if (!Array.isArray(changes.constraints) || !changes.constraints.length) fail('constraints must be nonempty');
      const constraints = changes.constraints.map(value => text(value, 'constraint'));
      if (record) record.constraints = constraints; else body = section(body, 'Constraints', constraints.map(value => `- ${value}`).join('\n'));
    }
    if (changes.criteria !== undefined) {
      if (!Array.isArray(changes.criteria) || !changes.criteria.length) fail('criteria must be a nonempty list');
      const existingIds = extractAcceptanceCriteria(plan);
      let number = Math.max(0, ...existingIds.map(id => Number(id.match(/\d+$/)?.[0] || 0)));
      const criteria = changes.criteria.map(criterion => {
        fields(criterion, ['id', 'text', 'checks'], 'criterion');
        const value = text(criterion.text, 'criterion text');
        const id = criterion.id || (record ? existingIds[record.acceptance.indexOf(value)] : null) || `AC${++number}`;
        if (!/^[A-Za-z]+\d+$/.test(id) || !Array.isArray(criterion.checks) || !criterion.checks.length || !criterion.checks.every(check => typeof check === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(check))) fail('criterion requires a stable ID and named check bindings');
        return { id, text: value, checks: [...new Set(criterion.checks)] };
      });
      if (new Set(criteria.map(c => c.id)).size !== criteria.length) fail('criterion IDs must be unique');
      fm.verification = { ...fm.verification, required: [...new Set(criteria.flatMap(c => c.checks))].sort(), criteria: Object.fromEntries(criteria.map(c => [c.id, c.checks])) };
      if (!record) fm.success_criteria = criteria.map(c => `${c.id} ${c.text}`);
      if (record) {
        record.acceptance = criteria.map(c => c.text);
        fm.acceptance_ids = criteria.map(c => c.id);
        fm.acceptance_text = Object.fromEntries(criteria.map(c => [c.id, c.text]));
      } else body = section(body, 'Acceptance Criteria', criteria.map(c => `- [ ] **${c.id}** ${c.text}`).join('\n'));
    }
    if (changes.reviews !== undefined) {
      if (!Array.isArray(changes.reviews) || !changes.reviews.every(id => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) fail('reviews must be reviewer IDs');
      if (plan.fm.reviews?.required?.includes('code-review') && !changes.reviews.includes('code-review')) fail('the mandatory code-review baseline cannot be removed by a decision payload');
      fm.reviews.required = [...new Set(changes.reviews)].sort();
    }
    if (changes.gaps !== undefined) {
      if (!Array.isArray(changes.gaps) || !changes.gaps.length || changes.gaps.length > 100) fail('gaps must be a bounded nonempty list');
      if (plan.status === 'done') fail('new capability gaps require active work');
      if (fm.capability_gaps !== undefined && !Array.isArray(fm.capability_gaps)) fail('existing capability gaps must be a list');
      const gaps = Array.isArray(fm.capability_gaps) ? fm.capability_gaps : [];
      const ids = new Set(gaps.map(gap => gap.id));
      for (const gap of changes.gaps) {
        fields(gap, ['id', 'class', 'scope', 'required_for', 'evidence'], 'gap declaration');
        if (!ID.test(gap.id || '') || ids.has(gap.id)) fail('gap IDs must be new and unique; existing gaps cannot be overwritten');
        if (!['soft', 'bridge', 'hard'].includes(gap.class) || !['operation', 'criterion', 'plan'].includes(gap.scope)) fail('gap requires a supported class and scope');
        const required = text(gap.required_for, 'affected criterion or operation');
        if (gap.scope === 'criterion' && !extractAcceptanceCriteria(plan).includes(required)) fail('gap names an unknown criterion');
        if (!Array.isArray(gap.evidence) || !gap.evidence.length || gap.evidence.length > 32) fail('gap requires bounded authored evidence observations');
        gaps.push({ id: gap.id, class: gap.class, scope: gap.scope, required_for: required, fulfillment: 'pending', evidence: gap.evidence.map(value => text(value, 'gap observation')) });
        if (gap.class === 'hard' && gap.scope === 'plan') fm.status = 'blocked-capability';
        ids.add(gap.id);
      }
      fm.capability_gaps = gaps;
    }
    if (record) body = body.replace(/^\s*\{[^\n]+\}/, () => JSON.stringify(record));
  }
  if (input.action === 'progress') {
    fields(input.progress, ['criteria', 'tasks', 'phase'], 'progress');
    if (!['in-progress', 'review'].includes(plan.status)) fail('start work before recording progress');
    if (input.progress.criteria === undefined && input.progress.tasks === undefined && input.progress.phase === undefined) fail('progress has no accepted change');
    if (input.progress.criteria !== undefined && readPlanRecord(plan.text)) {
      if (!Array.isArray(input.progress.criteria) || !input.progress.criteria.length || input.progress.criteria.some(id => !fm.acceptance_ids.includes(id))) fail('unknown progress criterion IDs');
      fm.progress = { ...fm.progress, criteria: [...new Set([...(fm.progress?.criteria || []), ...input.progress.criteria])].sort() };
    } else body = markProgress(body, 'Acceptance Criteria', input.progress.criteria);
    body = markProgress(body, 'Plan', input.progress.tasks, { tasks: true });
    if (input.progress.phase !== undefined) {
      if (!Number.isInteger(input.progress.phase) || !new RegExp(`^### Phase ${input.progress.phase}(?:\\D|$)`, 'm').test(body)) fail('unknown progress phase');
      fm.phase = input.progress.phase;
    }
  }
  if (input.action === 'finding') {
    fields(input.finding, ['id', 'text'], 'finding');
    if (!ID.test(input.finding.id || '')) fail('finding requires an ID');
    const line = `- ${input.finding.id}: ${text(input.finding.text, 'finding text')}`;
    const accepted = body.match(/(?:^|\n)## Accepted Findings[^\n]*\n([\s\S]*?)(?=\n## |$)/)?.[1] || '';
    const previous = accepted.split('\n').find(value => value.startsWith(`- ${input.finding.id}: `));
    if (previous && previous !== line) fail('accepted finding identity has conflicting content');
    if (!previous) body = appendSection(body, 'Accepted Findings', line);
  }
  if (input.action === 'gap') {
    fields(input.gap, ['id', 'fulfillment', 'evidence'], 'gap');
    const gap = fm.capability_gaps?.find(g => g.id === input.gap.id);
    if (!gap || input.gap.fulfillment !== 'done') fail('gap must exist; bridge/waiver authority remains in trusted policy');
    const rel = text(input.gap.evidence, 'gap evidence').replace(/\\/g, '/');
    const bytes = readFileNoFollow(path.resolve(workspace, rel), { root: workspace, maxBytes: 1024 * 1024, encoding: null });
    if (bytes === null) fail('gap evidence is unavailable, unsafe or oversized');
    gap.fulfillment = 'done';
    gap.evidence_binding = { path: rel, sha256: planRevision(bytes) };
    if (fm.status === 'blocked-capability' && fm.capability_gaps.every(item => item.class !== 'hard' || item.fulfillment === 'done')) {
      const completed = /^-\s*\[[xX]\]\s/m.test(plan.sections.acceptanceText || '') || /^-\s*\[[xX]\]\s/m.test(plan.sections.plan || '') || (fm.progress?.criteria || []).length > 0;
      fm.status = completed ? 'in-progress' : 'planned';
    }
  }
  output = `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${body}`;
  return { text: output, amendments, authority: input.authority ? { ...input.authority, provenance: 'declared decision scope; does not grant tool permissions' } : null };
}
