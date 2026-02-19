---
name: tdd-fix
description: >
  Fix a bug using test-driven development: failing test first, then minimal fix,
  then cleanup. Use when the user has a bug to fix, a failing test to address,
  or wants to apply TDD methodology to resolve an issue.
---

# TDD Fix Skill

## When to Use
Activate when the user wants to:
- Fix a bug using test-driven development
- Create a failing test that reproduces an issue, then fix it
- Apply the red-green-refactor cycle to a code problem

## User Preferences
Before implementation, resolve the user's Profile:
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` in the workspace.
2. Apply the resolved Profile's conventions for test frameworks, logging, and coding style.

## Steps

1. Prefer `#selection`/`#file`; expand to `@workspace` only if needed.
2. Create a failing test (or framework-agnostic test outline) that isolates the bug.
3. Provide the minimal code patch to pass that test, then an optional small cleanup/refactor patch.
4. Add a short root-cause note to the corresponding issue (if provided) under `## Activity`.
5. **Print a change summary** listing all files created or modified.

## Guardrails
- Do **not** call CLIs or the network.
- Keep diffs minimal and surgical.
- Follow the resolved Profile's test framework conventions.
