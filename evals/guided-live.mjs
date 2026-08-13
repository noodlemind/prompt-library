/**
 * Guided live measurement: can a real model navigate the harness governance
 * ceremony when it has the loaded-skill guidance a real engineer session gets?
 *
 * This is a live-only measurement tool (not part of `node evals/run.mjs`). It
 * runs the governance instructions against an OpenAI-compatible model with the
 * real ensure-plan + create-primitive skill text injected, then grades on
 * OUTCOMES — and because the PreToolUse hook is the gatekeeper, a new primitive
 * on disk (or the blocked work delivered) proves the model actually satisfied
 * the plan + gate + activation ceremony; the hook would have denied it otherwise.
 *
 * Usage:
 *   source ~/.openrouter.env
 *   HARNESS_EVAL_AGENT_URL=https://openrouter.ai/api/v1/chat/completions \
 *   HARNESS_EVAL_AGENT_MODEL=anthropic/claude-sonnet-5 \
 *   HARNESS_EVAL_AGENT_KEY="$OPENROUTER_API_KEY" \
 *     node evals/guided-live.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAgentLoop } from './lib/agent-loop.mjs';
import { materializeFixture, finalizeWorkspace } from './lib/fixture.mjs';
import { openAiToolDriver } from './lib/drivers.mjs';
import { engineerContract, buildGuidance } from './lib/scenario.mjs';
import { assessCapabilityGap, assessPrimitiveCreation, guidedLiveExitCode } from './lib/guided-live-grade.mjs';
import { fileURLToPath } from 'node:url';

const model = process.env.HARNESS_EVAL_AGENT_MODEL || '(unset)';
const guidance = buildGuidance(['ensure-plan', 'create-primitive']);

function newSkillFiles(ws) {
  // Any .github/skills/*/SKILL.md except the create-primitive stub that ships in
  // the fixture. Existence ⟹ the governance gate allowed it.
  const root = path.join(ws, '.github', 'skills');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => d !== 'create-primitive' && fs.existsSync(path.join(root, d, 'SKILL.md')))
    .map((d) => `.github/skills/${d}/SKILL.md`);
}

function driver() {
  const d = openAiToolDriver({
    url: process.env.HARNESS_EVAL_AGENT_URL,
    apiKey: process.env.HARNESS_EVAL_AGENT_KEY,
    model: process.env.HARNESS_EVAL_AGENT_MODEL,
  });
  if (!d) {
    console.error('Set HARNESS_EVAL_AGENT_URL, HARNESS_EVAL_AGENT_MODEL, HARNESS_EVAL_AGENT_KEY');
    process.exit(1);
  }
  return d;
}

async function scenario(name, instruction, assess) {
  const ws = materializeFixture('payment-service');
  try {
    const controllerBefore = fs.readFileSync(path.join(ws, 'src', 'PaymentController.java'), 'utf8');
    // The harness records create-primitive activation only on an actual read of
    // the skill file (the load-context hook tells a real engineer this), so state
    // it — having the text in context is not activation.
    const activationNote =
      '\n\nHARNESS ACTIVATION RULE: to create or edit any `.github/skills/**` path you must (1) have a locked plan that scopes that path in ## Impacted Files, lists create-primitive in skills_used, and includes the six-line ## Primitive Governance block; and (2) read `.github/skills/create-primitive/SKILL.md` as a tool call this session to activate it. Do both before editing the primitive; run each `harness gate` with --json.';
    const loop = await runAgentLoop({ workspace: ws, system: engineerContract, instruction: instruction + activationNote, driver: driver(), guidance, maxSteps: 40 });
    const created = newSkillFiles(ws);
    const controller = fs.readFileSync(path.join(ws, 'src', 'PaymentController.java'), 'utf8');
    const gatePasses = loop.trajectory.filter(
      (s) => s.type === 'tool' && s.name === 'runInTerminal' && /gate --phase implement/.test(s.input.command) && s.result.code === 0
    ).length;
    const readCreatePrimitive = loop.trajectory.some((s) => s.type === 'tool' && s.name === 'readFile' && /create-primitive\/SKILL\.md/.test(s.input.path));
    const denials = loop.trajectory.filter((s) => s.type === 'tool' && s.result?.denied === true).length;
    const eventFile = path.join(ws, '.harness', 'events.jsonl');
    const events = fs.existsSync(eventFile)
      ? fs.readFileSync(eventFile, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        })
      : [];
    const changed = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: ws, encoding: 'utf8' }).stdout || '';
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ws, encoding: 'utf8' }).stdout || '';
    const changedFiles = [...new Set(`${changed}\n${untracked}`.split(/\r?\n/).filter(Boolean))].sort();
    const ev = {
      model,
      steps: loop.trajectory.length,
      gatePasses,
      readCreatePrimitive,
      activationRecorded: events.some((event) => event.type === 'skill_activation' && event.skill === 'create-primitive'),
      denialsSeen: denials,
      primitivesCreated: created,
      changedFiles,
      controllerChanged: controller !== controllerBefore && /audit/i.test(controller),
    };
    const pass = assess(ev);
    console.log(`\n[${name}] ${pass ? 'PASS' : 'FAIL'} — ${JSON.stringify(ev)}`);
    return pass;
  } finally {
    finalizeWorkspace(ws, name);
  }
}

console.log(`Guided-live governance measurement — model=${model}, guidance=${(guidance.length / 1024).toFixed(1)}KB`);

export async function runGuidedLive(runScenario = scenario) {
  const results = [];
  results.push(await runScenario(
    'guided:primitive-creation',
    'Create a new reusable skill `.github/skills/payment-check/SKILL.md` capturing the payment override review steps. Creating a primitive is governed — follow the loaded create-primitive skill exactly (lock a governed plan, activate create-primitive by reading it, then author the skill).',
    assessPrimitiveCreation
  ));
  results.push(await runScenario(
    'guided:capability-gap',
    'Add audit logging to the payment override path. This needs a payment-audit skill that does not exist yet — a capability gap. Follow the loaded ensure-plan and create-primitive skills: capture the blocked work, create the payment-audit primitive through governance, fulfill the gap, then add the audit logging to src/PaymentController.java.',
    assessCapabilityGap
  ));
  return guidedLiveExitCode(results);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await runGuidedLive();
