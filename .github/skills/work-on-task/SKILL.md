---
name: work-on-task
description: Execute the current phase of a planned issue using TDD with scope control and session logging. Use when implementing planned changes or resuming a session. Not without a plan — run /plan-issue first.
argument-hint: "[path to plan file]"
---

# Work on Task

## Pipeline Role

**Step 3** of the connected pipeline: Capture → Plan → **Work** → Review → Compound.

This skill executes the current phase of a locked plan, tracks progress with checkboxes, and appends timestamped activity entries so the next session can resume automatically.

## Mode Detection

**Pipeline mode:** If a plan file is provided as argument AND the file contains `status:` in YAML frontmatter, enforce pipeline state validation (`plan_lock` required, status checks, phase tracking, activity log entries).

**Standalone mode:** If no plan file is provided or the file lacks state machine fields, skip `plan_lock` check, status validation, and activity log entries. Work on the user's described task directly using TDD.

## When to Use

Activate when the user wants to:
- Implement code changes for a planned issue
- Continue work from a previous session
- Execute a specific phase of a development plan

## Trigger Examples

**Should trigger:**
- "Start working on Phase 1"
- "Continue implementing the plan"
- "Resume where I left off"

**Should not trigger:**
- "Plan this feature" → use /plan-issue
- "Fix this quick bug" → use /tdd-fix
- "Review my changes" → use /code-review

## Session Pickup Sequence

When invoked, follow this exact sequence:

1. **Read the plan file**
2. **Check `status`**:
   - `open` → "No plan yet. Run `/plan-issue` first."
   - `needs-info` → Attempt to resolve from context; if still missing, stop.
   - `planned` → Set `status: in-progress`, proceed to phase execution.
   - `in-progress` → Resume at current phase (check `## Activity` for progress).
   - `review` or `done` → "This issue is past the work phase."
3. **Check `plan_lock`**: If `false` → "Plan is not locked. Run `/plan-issue` first."
4. **Read the local context pack**: `## Context`, `## Acceptance Criteria`, `## Research Notes`, `## Impacted Files`, `## Verification Plan`, and `## Risk & Review Routing`. These sections are the memory bridge from `/capture-issue` and `/plan-issue`.
5. **Read `phase`**: Determine current phase number.
6. **Read `## Activity`**: Understand what was already done in this phase.
7. **Read plan checkboxes**: Find unchecked `- [ ]` items for the current phase.
8. **Resume from first unchecked item**.

## Execution Loop

For each task in the current phase:

### 1. Verify Before Coding

List the exact files, symbols, and lines that justify the planned change. Confirm the task is within `## Impacted Files` and has a matching acceptance criterion or verification item. If key evidence is missing, set `status: needs-info` with one focused question and stop.

### 2. Implement with TDD

- Write a failing test first (or test outline for the pattern)
- Write the minimal code to make it pass
- Run tests using the best available tool:
  - **VS Code**: Run in terminal, read output with `terminalLastCommand`
  - **CLI/Claude Code**: Run test commands directly via `run_command` or `Bash`
- Clean up while tests are green
- Keep diffs surgical — change only what the task requires

### 3. Scope Guard

- Only touch files listed in `## Impacted Files`
- If a change requires a file not in the allowlist, stop and ask to update the plan
- If the change feels too large for the phase, stop and ask to split

### 4. Check Off and Log

After completing each task:
- Mark the checkbox: `- [x] task`
- Continue to the next unchecked task

## Phase Completion

When all tasks in the current phase are checked:

1. **Run verification** — execute relevant checks from `## Verification Plan`; all required checks must pass
2. **Increment `phase`** in frontmatter
3. **Append to `## Activity`**:

```markdown
### YYYY-MM-DD HH:MM — Phase [N] completed ([M] tasks)
- [x] [Task 1 summary] (`path/to/file`)
- [x] [Task 2 summary] (`path/to/file`)
- **Result:** Phase [N] complete, all tests passing
- **Next:** Phase [N+1] — [brief description]
```

4. **Write `## Implementation Notes`** (append, do not overwrite):
   Key decisions made, trade-offs chosen, gotchas encountered, and deviations from the plan.
   This section persists context for `/code-review`.
5. **Check if all phases are done**:
   - If yes → set `status: review` and suggest: "All phases complete. Run `/code-review` to review changes."
   - If no → suggest: "Phase [N] complete. Run `/work-on-task` again for Phase [N+1]."

## Verification Before Completion

Before marking a phase complete, run verification and report evidence:

1. **Tests pass**: Run the project's test suite. Report the actual test output, not just "tests pass."
2. **Verification plan satisfied**: Run or explicitly account for each applicable item in `## Verification Plan`.
3. **Risk routing satisfied**: If `## Risk & Review Routing` names specialist checks for touched areas, run them or document why they are deferred to `/code-review`.
4. **Files match plan**: Compare modified files against `## Impacted Files` in the plan. Flag any files modified that aren't listed (ask user to update plan or revert).
5. **Phase tasks checked**: All checkboxes in the current phase must be checked.
6. **Clean working state**: No uncommitted changes that should be committed. Ignore expected untracked files (.env, lockfiles, generated files). Use git status + gitignore awareness to distinguish.

Report verification results as evidence in the activity log:
```
### Verification — Phase [N]
- Tests: [PASS/FAIL] — [summary of test output]
- Verification plan: [PASS/FAIL] — [items run or deferred]
- Risk routing: [completed/deferred/not applicable] — [specialist checks]
- Scope: [N] files modified, all within Impacted Files [or: file X not in scope]
- Tasks: [N/N] checked
- Working state: clean [or: uncommitted changes in X]
```

DO NOT claim completion if any check fails. Report the failure and stop.

## Activity Log Rules

1. **Append-only** — never modify previous entries
2. **Timestamped** — each entry starts with date/time
3. **Phase-scoped** — each entry tracks a single phase
4. **File references** — include paths of created/modified files
5. **Blockers noted** — record blockers and decisions explicitly
6. **Status summary** — end with current state and what's next

## Error Handling

### Skill-Specific Errors

- **`plan_lock` not set** → "Plan is not locked. Run `/plan-issue` to generate and lock a plan first."
- **Phase already complete** → "All tasks in Phase [N] are checked. Advance to the next phase or run `/code-review`."
- **Test failure during verification** → Report specific test failures with the actual test output. Do not claim completion. Log the failure in `## Activity` and stop.
- **Verification plan missing** → Generate a minimal verification plan from acceptance criteria and touched files, append it to the plan, and continue only after it is explicit.
- **Risk routing missing** → Add a short `## Risk & Review Routing` section before implementation continues.
- **File outside `## Impacted Files` scope** → Stop immediately. Report the file path and why it needs to change. Ask the user to update the plan's `## Impacted Files` section or revert the change.

### Common Errors

For subagent failure, tool unavailability, file-not-found, and timeout recovery, follow the shared patterns in `.github/skills/references/error-handling-patterns.md`.

## Guardrails

- Never start without `plan_lock: true`.
- Never touch files outside `## Impacted Files` without updating the plan.
- Never skip the test step — TDD is mandatory.
- Never modify previous `## Activity` entries.
- If blocked, document the blocker in the activity log and stop.
- Never claim phase completion without running verification. Evidence before assertions.
