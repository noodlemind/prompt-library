import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildPlanSkeleton } from '../lib/plan-new.mjs';

const binPath = path.resolve(import.meta.dirname, '..', 'bin', 'harness.mjs');

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plannew-'));
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n');
  const git = (a) => spawnSync('git', a, { cwd: ws, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  return ws;
}

function harness(ws, args) {
  const r = spawnSync(process.execPath, [binPath, ...args, '--workspace', ws], { cwd: ws, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writePlan(ws, opts) {
  const { path: rel, content } = buildPlanSkeleton(opts);
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return rel;
}

test('scaffolded feat plan passes validate-plan and the implement gate', () => {
  const ws = workspace();
  const rel = writePlan(ws, { type: 'feat', slug: 'payment-audit', intent: 'Add audit logging to the override path', date: '2026-07-21', impacted: ['src/PaymentController.java'] });
  assert.equal(harness(ws, ['validate-plan', '--plan', rel]).status, 0);
  const gate = harness(ws, ['gate', '--phase', 'implement', '--plan', rel, '--json']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.equal(JSON.parse(gate.stdout).pass, true);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('scaffolded primitive plan includes governance and passes the gate', () => {
  const ws = workspace();
  const rel = writePlan(ws, { type: 'feat', slug: 'payment-check-skill', intent: 'Create the payment-check skill', date: '2026-07-21', impacted: ['.github/skills/payment-check/SKILL.md'] });
  const content = fs.readFileSync(path.join(ws, rel), 'utf8');
  assert.match(content, /## Primitive Governance/);
  assert.match(content, /Primitive classification: skill/);
  assert.match(content, /skills_used: \[engineer, create-primitive\]/);
  const gate = harness(ws, ['gate', '--phase', 'implement', '--plan', rel, '--json']);
  assert.equal(JSON.parse(gate.stdout).pass, true, gate.stdout);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('scaffolded capability-gap plan is blocked-capability and the gate denies it', () => {
  const ws = workspace();
  const rel = writePlan(ws, {
    type: 'feat',
    slug: 'payment-audit',
    intent: 'Add audit logging',
    date: '2026-07-21',
    impacted: ['src/PaymentController.java'],
    gap: { id: 'payment-audit-skill', primitive: '.github/skills/payment-audit/SKILL.md' },
  });
  const content = fs.readFileSync(path.join(ws, rel), 'utf8');
  assert.match(content, /status: blocked-capability/);
  assert.match(content, /id: payment-audit-skill\n\s+class: hard\n\s+fulfillment: proposed/);
  const gate = harness(ws, ['gate', '--phase', 'implement', '--plan', rel, '--json']);
  const body = JSON.parse(gate.stdout);
  assert.equal(body.pass, false);
  assert.match(body.blockedReason || '', /blocked-capability/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('cmdPlanNew CLI writes the dated plan file', () => {
  const ws = workspace();
  const r = harness(ws, ['plan-new', '--type', 'feat', '--slug', 'demo-thing', '--intent', 'Do the demo', '--date', '2026-07-21', '--impacted', 'src/A.java,src/B.java', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.path, 'docs/plans/2026-07-21-feat-demo-thing-plan.md');
  assert.ok(fs.existsSync(path.join(ws, out.path)));
  fs.rmSync(ws, { recursive: true, force: true });
});
