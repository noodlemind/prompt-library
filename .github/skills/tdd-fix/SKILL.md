---
name: tdd-fix
description: "Fix a bug or failing test using strict TDD methodology \u2014 reproduce with a failing test, implement the minimal fix, then clean up. Use when the user has a bug to fix, a failing test to resolve, or wants test-driven development guidance."
argument-hint: "[bug description, failing test, or error message]"
---

# TDD Fix

## When to Use

Activate when the user wants to:
- Fix a bug with test-driven methodology
- Resolve a failing test
- Implement a fix with confidence that it actually solves the problem

## Steps

### 1. Understand the Bug

Gather:
- **Symptom**: What's failing? Error message, unexpected behavior, failing test
- **Reproduction**: How to trigger the bug (if no failing test exists)
- **Expected behavior**: What should happen instead

### 2. Red — Write the Failing Test

If no test exists for this bug:
- Write a test that reproduces the exact failure
- Run it to confirm it fails for the right reason
- The test name should describe the expected behavior, not the bug

If a test already fails:
- Read the test to understand what it expects
- Run it to confirm the failure and understand the error

### 3. Green — Minimal Fix

- Write the smallest possible code change that makes the test pass
- Do not refactor. Do not improve nearby code. Do not add features.
- Run the test to confirm it passes
- Run the full test suite to confirm no regressions

### 4. Refactor — Clean Up

Only if the fix introduced something that should be cleaner:
- Rename for clarity
- Extract if duplicated
- Simplify if over-complicated
- Run tests again after any refactoring

### 5. Verify

- All tests pass (not just the new one)
- The fix is minimal — no unrelated changes
- The test would catch the same bug if it were reintroduced

### 6. Document

If the bug and fix are worth remembering, suggest: "Run `/compound-learnings` to document this fix for future reference."

## Output Format

```markdown
## TDD Fix

### Bug
[What was wrong]

### Test
`test/path/to/test_file:line` — [what the test verifies]

### Fix
`path/to/file:line` — [what was changed and why]

### Verification
- [x] New test passes
- [x] Full suite passes
- [x] Fix is minimal
```

## Guardrails

- Never skip the failing test step. If you can't reproduce it with a test, you don't understand the bug.
- Never change more than necessary. The fix should be obviously correct and obviously minimal.
- Never refactor unrelated code during a bug fix.
