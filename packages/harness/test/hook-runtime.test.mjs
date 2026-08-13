import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { planContractText } from '../../../.github/hooks/lib/evidence-binding.mjs';
import {
  activatedSkillFromPayload,
  analyzeShellMutation,
  normalizeToolPayload,
  planUsesCreatePrimitive,
  toolMutationSucceeded,
} from '../../../.github/hooks/lib/tool-payload.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hooksRoot = path.join(repoRoot, '.github', 'hooks');

function tempWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-fixture-'));
  fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.github', 'harness', 'policy.yaml'),
    'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n'
  );
  return workspace;
}

function writePlan(workspace, { createPrimitive = false } = {}) {
  const rel = 'docs/plans/hook-fixture-plan.md';
  const full = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    `---
plan_schema: 1
title: "Hook fixture"
type: fix
status: in-progress
plan_lock: true
phase: 1
risk: amber
intent: "Exercise hook governance"
expected_outputs: ["fixture"]
success_criteria: ["fixture passes"]
verification:
  required: [harness-tests, prompt-contracts, host-contracts, build-assets]
  criteria: {AC1: [harness-tests]}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [engineer${createPrimitive ? ', create-primitive' : ''}]
capability_gaps: []
---

# Hook fixture

## Overview

Fixture plan.

## Intent Contract

- Goal: Exercise hook governance.

## Acceptance Criteria

- [x] **AC1** Fixture passes.

## Plan

### Phase 1

- [x] Exercise hooks.

## Technical Notes

- Primitive classification: modify an existing skill.
- Existing-capability overlap analysis: reuse the existing skill.
- Intended artifact structure: keep the existing SKILL.md.
- Trigger and negative-trigger implications are covered.
- Verification expectations include registry and documentation impact.

## Impacted Files

- \`src/schema.json\`
- \`.github/skills/example/SKILL.md\`

## Verification Plan

- Run trusted checks.

## Risk & Review Routing

- Amber.

## Review Findings

- None.

## Activity

- Fixture.
`
  );
  return rel;
}

function writePassedGate(workspace, plan) {
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  const checksPath = path.join(workspace, '.github', 'harness', 'checks.yaml');
  const checksText = fs.existsSync(checksPath) ? fs.readFileSync(checksPath, 'utf8') : null;
  const configured = checksText ? YAML.parse(checksText)?.checks || {} : {};
  fs.writeFileSync(
    path.join(workspace, '.harness', 'session.json'),
    JSON.stringify({
      version: 1,
      sessionId: 'fixture-session',
      activePlan: plan,
      gatedPlan: plan,
      gatedPlanDigest: crypto
        .createHash('sha256')
        .update(planContractText(fs.readFileSync(path.join(workspace, plan), 'utf8')))
        .digest('hex'),
      gateStatus: 'pass',
      lastGateAt: new Date().toISOString(),
      gatedChecksDigest: checksText ? crypto.createHash('sha256').update(checksText).digest('hex') : null,
      gatedCheckCommands: Object.entries(configured)
        .filter(([, config]) => Array.isArray(config?.command) && config.command.every((part) => typeof part === 'string' && part.length > 0))
        .map(([name, config]) => ({ name, argv: config.command })),
    })
  );
}

/** Workspace-local stand-in for ~/.copilot/skills/<name>/SKILL.md so
 * target-based workspace resolution can never land on the real $HOME. */
function skillFixturePath(workspace, skill) {
  const full = path.join(workspace, 'copilot-home', 'skills', skill, 'SKILL.md');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (!fs.existsSync(full)) fs.writeFileSync(full, `# ${skill}\n`, 'utf8');
  return full;
}

function runHook(name, workspace, payload) {
  return spawnSync(process.execPath, [path.join(hooksRoot, name)], {
    cwd: workspace,
    input: JSON.stringify({
      cwd: workspace,
      session_id: 'vscode-session',
      hook_event_name: name === 'record-successful-edit.mjs' ? 'PostToolUse' : 'PreToolUse',
      ...payload,
    }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });
}

function outputJson(result) {
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return line ? JSON.parse(line) : {};
}

test('normalizes observed VS Code and compatible mutation payloads', () => {
  const cases = [
    ['multi_replace_string_in_file', { files: [{ filePath: 'src/a.json' }, { file_path: 'src/b.json' }] }, ['src/a.json', 'src/b.json']],
    ['multi_replace_string_in_file', { replacements: [{ filePath: 'src/a.json' }, { file_path: 'src/b.json' }] }, ['src/a.json', 'src/b.json']],
    ['replace_string_in_file', { filePath: 'src/a.json' }, ['src/a.json']],
    ['editFiles', { edits: [{ path: 'src/a.json' }] }, ['src/a.json']],
    ['create_file', { path: 'src/a.json' }, ['src/a.json']],
    ['createFile', { file_path: 'src/a.json' }, ['src/a.json']],
    ['apply_patch', { patch: '*** Begin Patch\n*** Update File: src/a.json\n*** End Patch' }, ['src/a.json']],
    ['run_in_terminal', { command: 'printf changed > src/a.json' }, ['src/a.json']],
    ['run_in_terminal', { command: 'printf changed>src/no-space.json' }, ['src/no-space.json']],
    ['runTerminalCommand', { command: 'touch src/a.json' }, ['src/a.json']],
    ['run_in_terminal', { command: "python3 - <<'PY'\nfrom pathlib import Path\npath = Path('src/a.json')\npath.write_text('changed')\nPY" }, ['src/a.json']],
    ['execute', { command: 'mkdir generated' }, ['generated']],
    ['Bash', { command: 'rg TODO src' }, []],
  ];

  for (const [toolName, toolInput, targets] of cases) {
    const normalized = normalizeToolPayload({ tool_name: toolName, tool_input: toolInput });
    assert.equal(normalized.toolName, toolName);
    assert.deepEqual(normalized.targets, targets, toolName);
    assert.equal(normalized.mutation, targets.length > 0, toolName);
  }
});

test('terminal hook blocks configured named checks outside plan verification.required', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  fs.writeFileSync(
    path.join(workspace, '.github', 'harness', 'checks.yaml'),
    `version: 1
checks:
  harness-tests:
    command:
      - node
      - scripts/run-harness-tests.mjs
  schema-validation:
    command: [node, scripts/validate-schema.mjs]
`,
    'utf8'
  );
  writePassedGate(workspace, plan);

  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: {
      command: 'node scripts/run-harness-tests.mjs && node scripts/validate-schema.mjs && harness verify --json',
    },
  });
  assert.equal(denied.status, 0, denied.stderr);
  const denial = outputJson(denied).hookSpecificOutput;
  assert.equal(denial.permissionDecision, 'deny');
  assert.match(denial.permissionDecisionReason, /out-of-plan-verification[\s\S]*schema-validation/i);

  const allowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'node scripts/run-harness-tests.mjs && harness verify --json' },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(outputJson(allowed).continue, true);

  for (const command of [
    'CI=1 node scripts/validate-schema.mjs',
    'env CI=1 node scripts/validate-schema.mjs',
    'command node scripts/validate-schema.mjs',
    'command -p node scripts/validate-schema.mjs',
  ]) {
    const wrapped = runHook('require-plan-gate.mjs', workspace, {
      tool_name: 'run_in_terminal',
      tool_input: { command },
    });
    assert.equal(outputJson(wrapped).hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('non-mutation VS Code tools remain read-only even when their payload includes a path', () => {
  for (const toolName of ['read_file', 'readFile', 'copilot_readFile', 'grep_search', 'file_search', 'list_dir']) {
    const normalized = normalizeToolPayload({
      tool_name: toolName,
      tool_input: { filePath: '/private/tmp/workspace/src/example.js' },
    });
    assert.equal(normalized.mutation, false, toolName);
    assert.equal(normalized.targetResolved, true, toolName);
  }
});

test('recognizes successful native skill reads without treating them as mutations', () => {
  const workspace = tempWorkspace();
  const payload = {
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
  };
  assert.equal(activatedSkillFromPayload(payload), 'create-primitive');
  assert.equal(normalizeToolPayload(payload).mutation, false);
  assert.equal(activatedSkillFromPayload({ tool_name: 'read_file', tool_input: { filePath: 'src/example.js' } }), null);
});

test('workspace normalization resolves host path aliases before scope checks', () => {
  const workspace = tempWorkspace();
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-alias-'));
  const alias = path.join(aliasRoot, 'workspace');
  fs.symlinkSync(workspace, alias);
  const normalized = normalizeToolPayload({ cwd: alias });
  assert.equal(normalized.workspace, fs.realpathSync(workspace));
});

test('VS Code transcript metadata resolves the product workspace instead of the installed hook cwd', () => {
  const workspace = tempWorkspace();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-vscode-storage-'));
  const transcript = path.join(storage, 'GitHub.copilot-chat', 'transcripts', 'session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(path.join(storage, 'workspace.json'), JSON.stringify({ folder: `file://${workspace}` }));
  const normalized = normalizeToolPayload({
    cwd: path.join(os.homedir(), '.copilot', 'hooks'),
    transcript_path: transcript,
    tool_name: 'replace_string_in_file',
    tool_input: JSON.stringify({ filePath: path.join(workspace, 'src', 'schema.json') }),
  });
  assert.equal(normalized.workspace, fs.realpathSync(workspace));
  assert.deepEqual(normalized.targets, [path.join(workspace, 'src', 'schema.json')]);
});

test('primitive skill parser handles a block list at the end of frontmatter', () => {
  assert.equal(planUsesCreatePrimitive('---\ntitle: Example\nskills_used:\n  - engineer\n  - create-primitive\n---\n'), true);
});

test('recognized file mutation without a resolvable target fails closed', () => {
  const normalized = normalizeToolPayload({
    tool_name: 'replace_string_in_file',
    tool_input: { oldString: 'a', newString: 'b' },
  });
  assert.equal(normalized.mutation, true);
  assert.equal(normalized.targetResolved, false);
});

test('successful tool detection does not treat explicit failures as edits', () => {
  assert.equal(toolMutationSucceeded({ hook_event_name: 'PostToolUse', tool_response: 'ok' }), true);
  assert.equal(toolMutationSucceeded({ hook_event_name: 'PostToolUse', success: false, error: 'failed' }), false);
  assert.equal(toolMutationSucceeded({ hook_event_name: 'PostToolUseFailure', tool_error: 'failed' }), false);
});

test('camelCase ungated mutation returns a structured deny decision', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /missing-implement-gate/i);
  assert.match(output.permissionDecisionReason, /ensure-plan\/SKILL\.md/);
  assert.match(output.permissionDecisionReason, /standalone mutation/i);
  assert.match(output.permissionDecisionReason, /no product paths/i);
  assert.match(output.permissionDecisionReason, /gate as its own non-mutating tool call[\s\S]*later tool call/i);
});

test('ungated interpreter heredoc mutation returns a structured deny decision', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: {
      command: "python3 - <<'PY'\nfrom pathlib import Path\npath = Path('src/schema.json')\npath.write_text('changed')\nPY",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /missing-implement-gate/i);
});

test('heredoc prose is not parsed as additional shell mutation targets', () => {
  const normalized = normalizeToolPayload({
    tool_name: 'run_in_terminal',
    tool_input: {
      command: "mkdir -p docs/guides .github/skills/example\ncat > docs/guides/example.md <<'EOF'\nInstall and use the guide.\nEOF\ncat > .github/skills/example/SKILL.md <<'EOF'\nUse this skill for migrations.\nEOF",
    },
  });
  assert.deepEqual(normalized.targets, [
    'docs/guides/example.md',
    '.github/skills/example/SKILL.md',
    'docs/guides',
    '.github/skills/example',
  ]);
});

test('creating the plan directory and plan file is exempt before the implement gate', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'mkdir -p docs/plans && printf plan > docs/plans/2026-07-21-feat-example-plan.md' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(outputJson(result).hookSpecificOutput?.permissionDecision, 'deny');
});

test('plan bootstrap cannot batch validation or the implement gate', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: {
      command: 'printf plan > docs/plans/2026-07-21-feat-example-plan.md && harness gate --phase implement --plan docs/plans/2026-07-21-feat-example-plan.md --workspace . --json',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /mixed-plan-command/i);
  assert.match(output.permissionDecisionReason, /separate non-mutating tool calls/i);
});

test('new plan shortcut path is denied before the implement gate', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'printf plan > docs/plans/example.md' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /invalid-plan-path/i);
  assert.match(output.permissionDecisionReason, /YYYY-MM-DD-<type>-<slug>-plan\.md/);
});

test('passed gate allows scoped mutation and primitive target requires current-session create-primitive activation', () => {
  const workspace = tempWorkspace();
  let plan = writePlan(workspace);
  writePassedGate(workspace, plan);

  const allowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'multi_replace_string_in_file',
    tool_input: { files: [{ filePath: 'src/schema.json' }] },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.notEqual(outputJson(allowed).hookSpecificOutput?.permissionDecision, 'deny');

  const primitiveBlocked = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.github/skills/example/SKILL.md' },
  });
  assert.equal(outputJson(primitiveBlocked).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outputJson(primitiveBlocked).hookSpecificOutput.permissionDecisionReason, /create-primitive/i);

  plan = writePlan(workspace, { createPrimitive: true });
  writePassedGate(workspace, plan);
  const notActivated = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.github/skills/example/SKILL.md' },
  });
  assert.equal(outputJson(notActivated).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outputJson(notActivated).hookSpecificOutput.permissionDecisionReason, /create-primitive-activation/i);
  assert.match(outputJson(notActivated).hookSpecificOutput.permissionDecisionReason, /create-primitive\/SKILL\.md/i);

  const activation = runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
    tool_response: 'Skill loaded',
  });
  assert.equal(activation.status, 0, activation.stderr);
  const recorded = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.equal(recorded.activatedSkills['create-primitive'].sessionId, 'vscode-session');
  const events = fs.readFileSync(path.join(workspace, '.harness', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.findLast((event) => event.type === 'skill_activation')?.skill, 'create-primitive');

  const primitiveAllowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.github/skills/example/SKILL.md' },
  });
  assert.notEqual(outputJson(primitiveAllowed).hookSpecificOutput?.permissionDecision, 'deny');
});

test('scoped shell creation permits only ancestor directories of planned files', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace, { createPrimitive: true });
  writePassedGate(workspace, plan);
  runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
    tool_response: 'Skill loaded',
  });

  const allowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: {
      command: "mkdir -p .github/skills/example && printf '%s' skill > .github/skills/example/SKILL.md",
    },
  });
  assert.notEqual(outputJson(allowed).hookSpecificOutput?.permissionDecision, 'deny');

  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'mkdir -p unrelated' },
  });
  assert.equal(outputJson(denied).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outputJson(denied).hookSpecificOutput.permissionDecisionReason, /out-of-plan-scope/i);
});

test('planned gate requires an in-progress transition and fresh gate before product mutation', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  const planPath = path.join(workspace, plan);
  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace('status: in-progress', 'status: planned'));
  writePassedGate(workspace, plan);

  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  });

  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /plan-not-in-progress/i);
  assert.match(output.permissionDecisionReason, /planned to in-progress[\s\S]*rerun the implement gate/i);
});

test('passed gate rejects a lexically scoped symlink that escapes the workspace', () => {
  const workspace = tempWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-outside-'));
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  fs.symlinkSync(outside, path.join(workspace, 'linked'));

  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'linked/escape.json' },
  });

  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /outside-workspace/i);
});

test('safety guards preserve force-push coverage without overblocking ordinary credential names', () => {
  const workspace = tempWorkspace();
  for (const command of [
    'git push --force-with-lease origin main',
    'git push origin main --force',
    'git push -f origin main',
    'git push -fv origin main',
    'git push origin main -f',
    'git push origin main -fv',
  ]) {
    const blocked = runHook('block-destructive-commands.mjs', process.cwd(), {
      tool_name: 'Bash',
      tool_input: { command },
    });
    assert.equal(outputJson(blocked).hookSpecificOutput?.permissionDecision, 'deny', command);
  }

  const ordinary = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/credentialsManager.ts' },
  });
  assert.notEqual(outputJson(ordinary).hookSpecificOutput?.permissionDecision, 'deny');
  const secret = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.env.local' },
  });
  assert.equal(outputJson(secret).hookSpecificOutput?.permissionDecision, 'deny');

  const recoverySkillRead = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'ensure-plan') },
  });
  assert.notEqual(outputJson(recoverySkillRead).hookSpecificOutput?.permissionDecision, 'deny');

  const terminalSecret = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'Bash',
    tool_input: { command: 'printf secret>.env.local' },
  });
  assert.equal(outputJson(terminalSecret).hookSpecificOutput?.permissionDecision, 'deny');

  const runtimeState = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.harness/session.json' },
  });
  assert.equal(outputJson(runtimeState).hookSpecificOutput?.permissionDecision, 'deny');

  const terminalRuntimeState = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'Bash',
    tool_input: { command: 'printf "{}">.harness/session.json' },
  });
  assert.equal(outputJson(terminalRuntimeState).hookSpecificOutput?.permissionDecision, 'deny');
});

test('plan edits require a fresh implement gate before product mutation', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);

  // Routine Activity logging is part of the workflow and must not invalidate
  // the gate: the digest covers the Activity-stripped contract text only.
  fs.appendFileSync(path.join(workspace, plan), '\n### Session log\n\n- Activity appended mid-phase.\n');
  const activityAllowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  });
  assert.notEqual(outputJson(activityAllowed).hookSpecificOutput?.permissionDecision, 'deny');

  fs.appendFileSync(path.join(workspace, plan), '\n## Extra Scope\n\n- `src/other.json`\n');
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  });

  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /plan changed after the implement gate/i);
});

test('PostToolUse records only successful mutations and emits event schema v2', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);

  const failed = runHook('record-successful-edit.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    success: false,
    error: 'edit failed',
  });
  assert.equal(failed.status, 0, failed.stderr);
  let session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.equal(session.lastEditAt, undefined);

  const passed = runHook('record-successful-edit.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    tool_response: 'File edited successfully',
  });
  assert.equal(passed.status, 0, passed.stderr);
  session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.match(session.lastEditAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(session.lastEditTool, 'replace_string_in_file');
  assert.deepEqual(session.lastEditTargets, ['src/schema.json']);

  const events = fs.readFileSync(path.join(workspace, '.harness', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const event = events.at(-1);
  assert.equal(event.version, 2);
  assert.equal(event.type, 'post_tool');
  assert.equal(event.session, 'vscode-session');
  assert.equal(event.host, 'github-copilot-vscode');
  assert.equal(event.tool, 'replace_string_in_file');
  assert.equal(event.mutation, true);
  assert.deepEqual(event.targets, ['src/schema.json']);
  assert.equal(event.decision, 'record');
  assert.equal(event.success, true);
});

test('successful PostToolUse without a session persists pending completion state', () => {
  const workspace = tempWorkspace();
  const post = runHook('record-successful-edit.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    tool_response: 'File edited successfully',
  });
  assert.equal(post.status, 0, post.stderr);
  assert.match(outputJson(post).systemMessage, /without an implement gate/i);

  const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.equal(session.gateStatus, 'missing');
  assert.match(session.lastEditAt, /^\d{4}-\d{2}-\d{2}T/);
  const stop = runHook('require-verification.mjs', workspace, {
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
  assert.equal(outputJson(stop).hookSpecificOutput?.decision, 'block');
});

test('Stop returns a structured block while a successful edit lacks verification', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.lastEditAt = new Date().toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify(session));

  const result = runHook('require-verification.mjs', workspace, {
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.hookEventName, 'Stop');
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /harness verify has not run/i);
});

test('Stop resolves the product workspace from VS Code transcript metadata', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.lastEditAt = new Date().toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify(session));

  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-vscode-stop-storage-'));
  const transcript = path.join(storage, 'GitHub.copilot-chat', 'transcripts', 'session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(path.join(storage, 'workspace.json'), JSON.stringify({ folder: `file://${workspace}` }));

  const result = runHook('require-verification.mjs', workspace, {
    cwd: path.join(os.homedir(), '.copilot', 'hooks'),
    transcript_path: transcript,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });

  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.hookEventName, 'Stop');
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /harness verify has not run/i);
});

test('hook configuration registers official lifecycle events from a deterministic cwd', () => {
  const config = JSON.parse(fs.readFileSync(path.join(hooksRoot, 'hooks.json'), 'utf8'));
  assert.ok(config.hooks.PreToolUse?.length);
  assert.ok(config.hooks.PostToolUse?.length);
  assert.ok(config.hooks.Stop?.length);
  for (const event of ['PreToolUse', 'PostToolUse', 'Stop']) {
    const commands = config.hooks[event].flatMap((entry) => entry.hooks || [entry]);
    assert.ok(commands.every((command) => command.cwd === '.github/hooks'), `${event} cwd`);
  }
});

test('SessionStart runtime context reinforces the critical Engineer Investigate contract', () => {
  const workspace = tempWorkspace();
  const result = runHook('load-context.mjs', workspace, {});
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result);
  assert.match(output.additionalContext, /@engineer[\s\S]{0,100}Mode: Answer\|Investigate\|Review\|Deliver/i);
  assert.match(output.additionalContext, /check\/action\/mark[\s\S]{0,100}confirmed race\/retry defect/i);
  assert.match(output.additionalContext, /missing-implement-gate[\s\S]{0,160}ensure-plan\/SKILL\.md/i);
});

test('shell analyzer catches clobber redirects, dd, nested shells, and PowerShell writers', () => {
  const cases = [
    ['echo x >| .harness/session.json', ['.harness/session.json']],
    ['echo x 1>| .env', ['.env']],
    ['dd if=/dev/zero of=.env bs=1 count=1', ['.env']],
    ['sh -c "rm -rf docs"', ['docs']],
    ['bash -lc "touch src/a.json"', ['src/a.json']],
    ['env FOO=1 touch src/a.json', ['src/a.json']],
    ['echo x | tee src/a.json', ['src/a.json']],
    ["python3 -c \"open('src/a.json', 'w').write('x')\"", ['src/a.json']],
    ['Set-Content .env secret', ['.env']],
    ['Add-Content -Path .env secret', ['.env']],
    ['Out-File -FilePath src/a.json', ['src/a.json']],
    ['Remove-Item -Recurse -Force src', ['src']],
    ['powershell -Command "Set-Content .env secret"', ['.env']],
  ];
  for (const [command, targets] of cases) {
    const analyzed = analyzeShellMutation(command);
    assert.equal(analyzed.mutation, true, command);
    assert.deepEqual(analyzed.targets, targets, command);
  }
});

test('mkdir ancestor exception applies only to paths mkdir alone creates', () => {
  const compound = analyzeShellMutation('mkdir -p src && rm -rf src');
  assert.equal(compound.mutation, true);
  assert.deepEqual(compound.mkdirTargets, []);
  const benign = analyzeShellMutation('mkdir -p src/generated && touch src/generated/a.json');
  assert.deepEqual(benign.mkdirTargets, ['src/generated']);

  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'mkdir -p src && rm -rf src' },
  });
  assert.equal(outputJson(denied).hookSpecificOutput?.permissionDecision, 'deny');
});

test('unrecognized tools carrying file targets fail closed as mutations', () => {
  const normalized = normalizeToolPayload({
    tool_name: 'future_edit_tool',
    tool_input: { filePath: 'src/a.json' },
  });
  assert.equal(normalized.mutation, true);
  assert.deepEqual(normalized.targets, ['src/a.json']);

  for (const toolName of ['insert_edit_into_file', 'edit_notebook_file', 'create_directory']) {
    assert.equal(
      normalizeToolPayload({ tool_name: toolName, tool_input: { filePath: 'src/a.json' } }).mutation,
      true,
      toolName
    );
  }

  const workspace = tempWorkspace();
  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'future_edit_tool',
    tool_input: { filePath: 'src/a.json' },
  });
  assert.equal(outputJson(denied).hookSpecificOutput?.permissionDecision, 'deny');

  const pending = runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'future_edit_tool',
    tool_input: { filePath: 'src/a.json' },
    tool_response: 'File edited successfully',
  });
  assert.equal(pending.status, 0, pending.stderr);
  const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.ok(session.lastEditAt, 'unknown edit tools must still create pending verification state');
});

test('apply_patch move destinations are scoped targets', () => {
  const normalized = normalizeToolPayload({
    tool_name: 'apply_patch',
    tool_input: {
      patch: '*** Begin Patch\n*** Update File: src/a.json\n*** Move to: src/renamed.json\n*** End Patch',
    },
  });
  assert.deepEqual(normalized.targets, ['src/a.json', 'src/renamed.json']);
});

test('hook denials expose both VS Code and Copilot CLI decision shapes', () => {
  const workspace = tempWorkspace();
  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/a.json' },
  });
  const output = outputJson(denied);
  assert.equal(output.permissionDecision, 'deny');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(output.permissionDecisionReason, output.hookSpecificOutput.permissionDecisionReason);

  writePassedGate(workspace, writePlan(workspace));
  runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    tool_response: 'File edited successfully',
  });
  const stop = runHook('require-verification.mjs', workspace, { hook_event_name: 'Stop', stop_hook_active: false });
  const stopOutput = outputJson(stop);
  assert.equal(stopOutput.decision, 'block');
  assert.equal(stopOutput.hookSpecificOutput.decision, 'block');
});

test('safety guards fail closed on malformed payloads', () => {
  for (const hook of ['guard-critical-files.mjs', 'block-destructive-commands.mjs']) {
    const result = spawnSync(process.execPath, [path.join(hooksRoot, hook)], {
      cwd: tempWorkspace(),
      input: '{not-json',
      encoding: 'utf8',
      env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = outputJson(result);
    assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny', hook);
    assert.match(output.hookSpecificOutput?.permissionDecisionReason || '', /invalid-hook-payload/, hook);
  }

  const recorder = spawnSync(process.execPath, [path.join(hooksRoot, 'record-successful-edit.mjs')], {
    cwd: tempWorkspace(),
    input: '{not-json',
    encoding: 'utf8',
  });
  assert.equal(recorder.status, 0, recorder.stderr);
  const recorderOutput = outputJson(recorder);
  assert.equal(recorderOutput.continue, true);
  assert.match(recorderOutput.systemMessage || '', /invalid-hook-payload/);
});

test('destructive push guard blocks refspec force pushes without overblocking benign flags', () => {
  const workspace = tempWorkspace();
  for (const command of [
    'git push origin +main',
    'git push origin +HEAD:main',
    'git push origin :main',
    'git push --force origin feature:main',
    'git push --repo origin +HEAD:main',
    'git -C . push --force origin main',
  ]) {
    const blocked = runHook('block-destructive-commands.mjs', workspace, {
      tool_name: 'Bash',
      tool_input: { command },
    });
    assert.equal(outputJson(blocked).hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  for (const command of [
    'git push --ff-only origin main',
    'git push --follow-tags origin main',
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin +main:feature',
    'git push --force origin main:feature',
  ]) {
    const allowed = runHook('block-destructive-commands.mjs', workspace, {
      tool_name: 'Bash',
      tool_input: { command },
    });
    assert.notEqual(outputJson(allowed).hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('critical-file guard blocks .envrc and symlinked sensitive paths', () => {
  const workspace = tempWorkspace();
  const envrc = runHook('guard-critical-files.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.envrc' },
  });
  assert.equal(outputJson(envrc).hookSpecificOutput?.permissionDecision, 'deny');

  fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=1\n');
  fs.symlinkSync(path.join(workspace, '.env'), path.join(workspace, 'config.txt'));
  const symlinked = runHook('guard-critical-files.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'config.txt' },
  });
  assert.equal(outputJson(symlinked).hookSpecificOutput?.permissionDecision, 'deny');
});

test('out-of-plan verification enforcement parses block-list verification.required', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  const planPath = path.join(workspace, plan);
  const blockList = fs
    .readFileSync(planPath, 'utf8')
    .replace(
      'required: [harness-tests, prompt-contracts, host-contracts, build-assets]',
      'required:\n    - harness-tests\n    - prompt-contracts\n    - host-contracts\n    - build-assets'
    );
  fs.writeFileSync(planPath, blockList);
  fs.writeFileSync(
    path.join(workspace, '.github', 'harness', 'checks.yaml'),
    'version: 1\nchecks:\n  harness-tests:\n    command: ["node", "scripts/run-harness-tests.mjs"]\n  schema-validation:\n    command: ["node", "scripts/validate-schema.mjs"]\n',
    'utf8'
  );
  writePassedGate(workspace, plan);
  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'node scripts/validate-schema.mjs' },
  });
  assert.equal(outputJson(denied).hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(outputJson(denied).hookSpecificOutput?.permissionDecisionReason || '', /out-of-plan-verification/);
});

test('primitive activation without a host session id is accepted only while fresh', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace, { createPrimitive: true });
  writePassedGate(workspace, plan);
  const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  session.activatedSkills = {
    'create-primitive': { sessionId: null, activatedAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify(session));

  const noSession = spawnSync(process.execPath, [path.join(hooksRoot, 'require-plan-gate.mjs')], {
    cwd: workspace,
    input: JSON.stringify({
      cwd: workspace,
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: '.github/skills/example/SKILL.md' },
    }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });
  assert.notEqual(outputJson(noSession).hookSpecificOutput?.permissionDecision, 'deny', noSession.stdout);

  session.activatedSkills['create-primitive'].activatedAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify(session));
  const stale = spawnSync(process.execPath, [path.join(hooksRoot, 'require-plan-gate.mjs')], {
    cwd: workspace,
    input: JSON.stringify({
      cwd: workspace,
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: '.github/skills/example/SKILL.md' },
    }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });
  assert.equal(outputJson(stale).hookSpecificOutput?.permissionDecision, 'deny');
});

test('hook and CLI primitive path rules and plan digests stay in parity', async () => {
  const cliGovernance = await import('../lib/primitive-governance.mjs');
  const cliEvidence = await import('../lib/evidence.mjs');
  const hookPayload = await import('../../../.github/hooks/lib/tool-payload.mjs');
  const samples = [
    '.github/skills/example/SKILL.md',
    '.github/agents/engineer.agent.md',
    '.github/instructions/global.instructions.md',
    '.github/prompts/example.prompt.md',
    '.github/checks/example.md',
    'enterprise/skills/example/SKILL.md',
    'knowledge/capability-registry.yaml',
    'src/app.js',
    'docs/plans/example-plan.md',
    '.github/workflows/ci.yml',
  ];
  for (const sample of samples) {
    assert.equal(
      cliGovernance.isPrimitivePath(sample),
      hookPayload.isPrimitivePath(sample),
      `primitive-path divergence: ${sample}`
    );
  }

  const fixture = '---\ntitle: X\n---\n\n## Overview\n\nBody.\n\n## Activity\n\n- Logged.\n';
  const hookDigest = crypto.createHash('sha256').update(planContractText(fixture)).digest('hex');
  assert.equal(cliEvidence.planDigest(fixture), hookDigest, 'plan digest algorithms diverged');
});

test('every enforcement denial names an actionable next command', () => {
  const workspace = tempWorkspace();
  // Missing-gate denial (PreToolUse)
  const missing = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/a.json' },
  });
  const missingReason = outputJson(missing).hookSpecificOutput?.permissionDecisionReason || '';
  assert.match(missingReason, /ensure-plan\/SKILL\.md|harness gate|Read ~/, 'gate denial must carry a recipe');

  // Out-of-plan-scope denial
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const outOfScope = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/unplanned-file.json' },
  });
  assert.match(
    outputJson(outOfScope).hookSpecificOutput?.permissionDecisionReason || '',
    /next: add it to ## Impacted Files/,
    'scope denial must tell the agent how to recover'
  );

  // Stop-hook denial carries a verify recipe
  runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    tool_response: 'File edited successfully',
  });
  const stop = runHook('require-verification.mjs', workspace, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.match(outputJson(stop).hookSpecificOutput?.reason || '', /next: run `harness verify/, 'Stop denial must carry a verify recipe');
});
