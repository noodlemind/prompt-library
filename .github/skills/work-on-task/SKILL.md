---
name: work-on-task
description: Execute the current phase of a planned issue using TDD with scope control and session logging. Use when the user wants to implement code changes for a planned issue, continue from a previous session, or work through a specific phase. Enforces plan_lock, phase boundaries, and appends activity logs for session continuity.
argument-hint: "[path to plan file]"
disable-model-invocation: true
---

# Work on Task

## Pipeline Role

**Step 3** of the connected pipeline: Capture → Plan → **Work** → Review → Compound.

This skill executes the current phase of a locked plan, tracks progress with checkboxes, and appends timestamped activity entries so the next session can resume automatically.

## When to Use

Activate when the user wants to:
- Implement code changes for a planned issue
- Continue work from a previous session
- Execute a specific phase of a development plan

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
4. **Read `phase`**: Determine current phase number.
5. **Read `## Activity`**: Understand what was already done in this phase.
6. **Read plan checkboxes**: Find unchecked `- [ ]` items for the current phase.
7. **Resume from first unchecked item**.

## Execution Loop

For each task in the current phase:

### 1. Verify Before Coding

List the exact files, symbols, and lines that justify the planned change. If key evidence is missing, set `status: needs-info` with one focused question and stop.

### 2. Implement with TDD

- Write a failing test first (or test outline for the pattern)
- Write the minimal code to make it pass
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

1. **Run tests** — all must pass
2. **Increment `phase`** in frontmatter
3. **Append to `## Activity`**:

```markdown
### YYYY-MM-DD HH:MM — Phase [N] completed ([M] tasks)
- [x] [Task 1 summary] (`path/to/file`)
- [x] [Task 2 summary] (`path/to/file`)
- **Result:** Phase [N] complete, all tests passing
- **Next:** Phase [N+1] — [brief description]
```

4. **Check if all phases are done**:
   - If yes → set `status: review` and suggest: "All phases complete. Run `/code-review` to review changes."
   - If no → suggest: "Phase [N] complete. Run `/work-on-task` again for Phase [N+1]."

## Activity Log Rules

1. **Append-only** — never modify previous entries
2. **Timestamped** — each entry starts with date/time
3. **Phase-scoped** — each entry tracks a single phase
4. **File references** — include paths of created/modified files
5. **Blockers noted** — record blockers and decisions explicitly
6. **Status summary** — end with current state and what's next

## Guardrails

- Never start without `plan_lock: true`.
- Never touch files outside `## Impacted Files` without updating the plan.
- Never skip the test step — TDD is mandatory.
- Never modify previous `## Activity` entries.
- If blocked, document the blocker in the activity log and stop.
