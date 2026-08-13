#!/usr/bin/env node
/** PreToolUse gate: require a fresh explicit implement gate and planned scope. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planContractText } from './lib/evidence-binding.mjs';
import { writeHookEvent } from './lib/events.mjs';
import { preToolDenyOutput } from './lib/hook-output.mjs';
import { loadHookPolicy } from './lib/policy.mjs';
import { isPrimitivePath, normalizeToolPayload, planUsesCreatePrimitive, tokenizeShell } from './lib/tool-payload.mjs';

const startedAt = Date.now();
let payload = {};
let normalized = null;
let policy = { enforcement: process.env.HARNESS_ENFORCEMENT || 'enforce', ttl: 30 };
const RECOVER_MISSING_GATE = 'Read ~/.copilot/skills/ensure-plan/SKILL.md and follow it exactly; create or lock only the canonical plan in a standalone mutation containing no product paths, run the implement gate as its own non-mutating tool call, wait for pass, then retry this mutation in a later tool call';
const NEW_PLAN_PATH = /^docs\/plans\/\d{4}-\d{2}-\d{2}-(?:feat|fix|docs|refactor|chore)-[a-z0-9]+(?:-[a-z0-9]+)*-plan\.md$/;

function output(value) {
  console.log(JSON.stringify(value));
}

function record(fields) {
  const item = normalized || {
    workspace: path.resolve(payload.workspace || payload.cwd || process.cwd()),
    toolName: payload.tool_name || payload.toolName || null,
    mutation: true,
    targets: [],
    targetResolved: false,
  };
  writeHookEvent(item.workspace, payload, {
    type: 'pre_tool',
    tool: item.toolName,
    mutation: item.mutation,
    targets: item.targets,
    targetResolved: item.targetResolved,
    durationMs: Date.now() - startedAt,
    ...fields,
  });
}

function deny(reason, message, gate = 'missing') {
  const detail = `${reason}: ${message}`;
  console.error(`[harness hook] ${detail}`);
  if (policy.enforcement !== 'enforce') {
    record({ gate, decision: 'warn', blockedReason: detail, result: 'warn' });
    output({ continue: true, systemMessage: `[harness hook] ${detail}` });
    process.exit(0);
  }
  record({ gate, decision: 'block', blockedReason: detail, result: 'fail' });
  output(preToolDenyOutput(detail));
  process.exit(0);
}

function impactedFiles(text) {
  const section = text.match(/## Impacted Files\s*\n([\s\S]*?)(?=\n## |$)/i)?.[1] || '';
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+`?([^`#]+?)`?\s*(?:#.*)?$/)?.[1]?.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, '').replace(/\\/g, '/'));
}

function inScope(file, entries) {
  return entries.some((entry) => {
    if (entry.endsWith('/**')) return file === entry.slice(0, -3) || file.startsWith(entry.slice(0, -2));
    if (entry.endsWith('/')) return file.startsWith(entry);
    return file === entry;
  });
}

function isPlannedAncestor(file, entries) {
  const prefix = `${file.replace(/\/+$/, '')}/`;
  return entries.some((entry) => {
    const planned = entry.replace(/\/\*\*$/, '').replace(/\/+$/, '');
    return planned.startsWith(prefix);
  });
}

function sessionActivatedSkill(session, skill, sessionId, ttlMinutes) {
  const activation = session?.activatedSkills?.[skill];
  if (!activation?.activatedAt) return false;
  if (sessionId) return activation.sessionId === sessionId;
  // Hosts may omit session_id; accept only a fresh activation so a stale
  // record from an earlier chat cannot satisfy the governance gate.
  const activatedAt = Date.parse(activation.activatedAt);
  return Number.isFinite(activatedAt) && Date.now() - activatedAt <= ttlMinutes * 60 * 1000;
}

function targetEscapesWorkspace(workspace, target) {
  let cursor = path.resolve(workspace, target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  try {
    const realWorkspace = fs.realpathSync(workspace);
    const realAncestor = fs.realpathSync(cursor);
    const relative = path.relative(realWorkspace, realAncestor);
    return relative.startsWith('..') || path.isAbsolute(relative);
  } catch {
    return true;
  }
}

function parseInlineList(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return [];
  return text
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function requiredChecks(planText) {
  const frontmatter = planText.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  const lines = frontmatter.split(/\r?\n/);
  const verification = lines.findIndex((line) => /^verification:\s*(?:#.*)?$/.test(line));
  if (verification < 0) return [];
  for (let index = verification + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break;
    const required = line.match(/^\s{2}required:\s*(.*?)\s*(?:#.*)?$/);
    if (!required) continue;
    if (required[1]) return parseInlineList(required[1]);
    const names = [];
    for (let child = index + 1; child < lines.length; child += 1) {
      const item = lines[child].match(/^\s{4}-\s+(.+?)\s*(?:#.*)?$/);
      if (!item) break;
      names.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
    }
    return names;
  }
  return [];
}

function configuredChecksDigest(workspace) {
  const configPath = path.join(workspace, '.github', 'harness', 'checks.yaml');
  if (!fs.existsSync(configPath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
}

function normalizeCommandTokens(tokens) {
  const normalized = tokens.slice();
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
  while (normalized[0] && assignment.test(normalized[0])) normalized.shift();
  if (path.basename(normalized[0] || '') === 'env') {
    normalized.shift();
    while (normalized.length) {
      if (assignment.test(normalized[0])) normalized.shift();
      else if (normalized[0] === '--') {
        normalized.shift();
        break;
      } else if (normalized[0] === '-u' || normalized[0] === '--unset') normalized.splice(0, 2);
      else if (/^--unset=/.test(normalized[0]) || /^-(?:i|0)$/.test(normalized[0]) || normalized[0] === '--ignore-environment') normalized.shift();
      else break;
    }
  }
  while (normalized[0] && assignment.test(normalized[0])) normalized.shift();
  if (path.basename(normalized[0] || '') === 'command') {
    normalized.shift();
    if (normalized[0] === '-p') normalized.shift();
    if (normalized[0] === '--') normalized.shift();
  }
  return normalized;
}

function commandMatches(actual, expected) {
  if (actual.length < expected.length) return false;
  return expected.every((part, index) => {
    if (index === 0) return path.basename(actual[index] || '') === path.basename(part);
    return actual[index] === part;
  });
}

function unplannedNamedChecks(commands, command, planText) {
  const required = new Set(requiredChecks(planText));
  const segments = String(command || '')
    .split(/(?:&&|\|\||[;|\n])/)
    .map((segment) => normalizeCommandTokens(tokenizeShell(String(segment))))
    .filter((tokens) => tokens.length > 0);
  return commands
    .filter(({ name, argv }) => !required.has(name) && segments.some((segment) => commandMatches(segment, argv)))
    .map(({ name }) => name);
}

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) throw new Error('payload is empty');
  payload = JSON.parse(raw);
} catch (error) {
  deny('invalid-hook-payload', error.message, 'invalid');
}

normalized = normalizeToolPayload(payload);
policy = loadHookPolicy(normalized.workspace, { ttlKey: 'gate_ttl_minutes', ttlDefault: 30 });
if (!normalized.mutation) {
  if (normalized.command) {
    const sessionPath = path.join(normalized.workspace, '.harness', 'session.json');
    try {
      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      const activePlan = session.gatedPlan || session.activePlan;
      const planText = activePlan ? fs.readFileSync(path.join(normalized.workspace, activePlan), 'utf8') : '';
      const currentDigest = configuredChecksDigest(normalized.workspace);
      if (session.gatedChecksDigest !== currentDigest && !/^\s*harness\s+gate\b/.test(normalized.command)) {
        deny(
          'changed-check-config',
          'The configured check manifest changed after the implement gate. Rerun harness gate before running terminal commands',
          'invalid'
        );
      }
      const commands = Array.isArray(session.gatedCheckCommands) ? session.gatedCheckCommands : [];
      const unplanned = unplannedNamedChecks(commands, normalized.command, planText);
      if (unplanned.length) {
        deny(
          'out-of-plan-verification',
          `Do not run configured checks outside this plan's verification.required list: ${unplanned.join(', ')}. Run only the required named checks, then harness verify; report unrelated failures without executing or repairing them`,
          'invalid'
        );
      }
    } catch {
      // No readable active session/plan means there is no plan-scoped verification contract to enforce here.
    }
  }
  output({ continue: true });
  process.exit(0);
}
if (!normalized.targetResolved) {
  deny('unresolved-mutation-target', 'Mutation target could not be resolved for scope validation; next: retry the edit with an explicit file path, or read ~/.copilot/skills/ensure-plan/SKILL.md', 'unresolved');
}

const relatives = normalized.targets.map((target) => {
  const relative = path.relative(normalized.workspace, path.resolve(normalized.workspace, target)).replace(/\\/g, '/');
  if (relative.startsWith('../') || path.isAbsolute(relative) || targetEscapesWorkspace(normalized.workspace, target)) {
    deny('outside-workspace', `Edit target is outside workspace: ${target}; next: edit only files inside the workspace`, 'invalid');
  }
  return relative;
});
for (const relative of relatives) {
  if (!relative.startsWith('docs/plans/') || fs.existsSync(path.join(normalized.workspace, relative))) continue;
  if (!NEW_PLAN_PATH.test(relative)) {
    deny(
      'invalid-plan-path',
      'New plans must use docs/plans/YYYY-MM-DD-<type>-<slug>-plan.md with type feat|fix|docs|refactor|chore; read ~/.copilot/skills/ensure-plan/SKILL.md and do not create an undated shortcut',
      'invalid'
    );
  }
}
const mutatesPlan = relatives.some((relative) => relative === 'docs/plans' || relative.startsWith('docs/plans/'));
if (mutatesPlan && /\bharness\s+(?:validate-plan|gate)\b/.test(normalized.command || '')) {
  deny(
    'mixed-plan-command',
    'Create or lock only the canonical plan in this mutation. After it succeeds, run validate-plan and the implement gate as separate non-mutating tool calls',
    'invalid'
  );
}
const governed = relatives.filter((relative) =>
  relative !== 'docs/plans'
  && !relative.startsWith('docs/plans/')
  && relative !== '.harness'
  && !relative.startsWith('.harness/')
);
if (governed.length === 0) {
  record({ gate: 'exempt', decision: 'allow', result: 'pass' });
  output({ continue: true });
  process.exit(0);
}

const sessionPath = path.join(normalized.workspace, '.harness', 'session.json');
if (!fs.existsSync(sessionPath)) {
  deny('missing-implement-gate', RECOVER_MISSING_GATE);
}

let session;
try {
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
} catch {
  deny('missing-implement-gate', 'Harness session is unreadable; next: rerun `harness gate --phase implement --plan <plan> --workspace . --json`', 'invalid');
}
if (session.gateStatus !== 'pass' || !session.gatedPlan || !session.lastGateAt) {
  deny('missing-implement-gate', RECOVER_MISSING_GATE);
}
const lastGateAt = Date.parse(session.lastGateAt);
if (!Number.isFinite(lastGateAt)) {
  deny('invalid-implement-gate', 'Implement gate timestamp is invalid; rerun the gate', 'invalid');
}
if (Date.now() - lastGateAt > policy.ttl * 60 * 1000) {
  deny('stale-implement-gate', 'Implement gate is stale; rerun the gate', 'stale');
}

const lexicalPlanPath = path.resolve(normalized.workspace, session.gatedPlan);
let planPath = null;
try {
  const plansRoot = fs.realpathSync(path.join(normalized.workspace, 'docs', 'plans'));
  const candidate = fs.realpathSync(lexicalPlanPath);
  const relative = path.relative(plansRoot, candidate);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) planPath = candidate;
} catch {
  // The fail-closed check below reports the missing or escaping plan.
}
if (!planPath) deny('invalid-implement-gate', 'Gated plan is missing or outside docs/plans; next: rerun `harness gate --phase implement --plan <plan> --workspace . --json`', 'invalid');

const planText = fs.readFileSync(planPath, 'utf8');
// Digest the Activity-stripped contract text so routine session logging does
// not invalidate the gate; this must match the evidence-binding digest rule.
const planDigest = crypto.createHash('sha256').update(planContractText(planText)).digest('hex');
if (!session.gatedPlanDigest || session.gatedPlanDigest !== planDigest) {
  deny('changed-implement-plan', 'Plan changed after the implement gate; rerun the gate', 'invalid');
}
const planStatus = planText.match(/^status:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/m)?.[1] || null;
if (planStatus === 'planned') {
  deny(
    'plan-not-in-progress',
    'After the initial gate, change plan status from planned to in-progress, rerun the implement gate as its own tool call, wait for pass, then retry this product mutation',
    'invalid'
  );
}
const allowed = impactedFiles(planText);
// The planned-ancestor exception applies only to paths mkdir itself creates,
// not to every target of a compound command that happens to include mkdir.
const mkdirRelatives = new Set(
  normalized.mkdirTargets.map((target) =>
    path.relative(normalized.workspace, path.resolve(normalized.workspace, target)).replace(/\\/g, '/')
  )
);
for (const relative of governed) {
  if (!inScope(relative, allowed) && !(mkdirRelatives.has(relative) && isPlannedAncestor(relative, allowed))) {
    deny('out-of-plan-scope', `File is outside the plan's ## Impacted Files: ${relative}; next: add it to ## Impacted Files and rerun the gate, or edit only planned files`, 'passed');
  }
}
if (governed.some(isPrimitivePath)) {
  if (!planUsesCreatePrimitive(planText)) {
    deny(
      'missing-create-primitive',
      'Read ~/.copilot/skills/create-primitive/SKILL.md and follow it before planning or editing primitive paths; then record create-primitive in plan skills_used',
      'passed'
    );
  }
  if (!sessionActivatedSkill(session, 'create-primitive', normalized.sessionId, policy.ttl)) {
    deny(
      'missing-create-primitive-activation',
      'Read ~/.copilot/skills/create-primitive/SKILL.md now and follow it; naming create-primitive in skills_used is not activation, so retry this mutation only after the successful skill read is recorded for this chat session',
      'passed'
    );
  }
}

record({ gate: 'passed', decision: 'allow', plan: session.gatedPlan, result: 'pass' });
output({ continue: true });
