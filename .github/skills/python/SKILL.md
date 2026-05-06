---
name: python
description: Python engineering workflow for implementation, debugging, refactoring, testing, typing, and review preparation.
argument-hint: "[describe the Python task, file, or failure]"
---

# Python

## Purpose

Apply Python engineering guidance as an on-demand skill. Use this inside the normal pipeline for planned work, or directly for small Python questions and focused edits.

## Trigger Examples

**Should trigger:**
- "Add tests for this Python parser"
- "Fix this async Python timeout"
- "Make this module type-safe"

**Should not trigger:**
- "Tune this database index" -> use `/sql`
- "Review AWS queue configuration" -> use `/aws`
- "Answer a quick repo question" -> use `/btw`

## Workflow

1. **Load scoped conventions**: Apply the globally hydrated `python.instructions.md`.
2. **Classify scope**:
   - Small bug or focused edit -> proceed with TDD.
   - Multi-step feature, migration, or cross-module refactor -> create or update a plan through `/capture-issue` and `/plan-issue`.
3. **Inspect local patterns**: Match package layout, dependency management, test framework, type checker, formatter, and async style.
4. **Implement conservatively**:
   - Add type hints to public boundaries.
   - Prefer explicit data models for structured inputs and outputs.
   - Preserve exception causes with `raise from`.
   - Avoid blocking work inside async functions.
   - Parameterize SQL and validate external inputs.
5. **Verify**:
   - Run the smallest relevant tests first.
   - Run type checks or linters when present and relevant.
   - Confirm changed files match the plan or stated request.
6. **Review route**:
   - Use `@python-reviewer` for Python correctness, typing, async, and test review.
   - Add `@sql-reviewer`, `@aws-reviewer`, or `@security-sentinel` when those boundaries are touched.

## Guardrails

- Do not introduce new runtime dependencies unless the plan or user explicitly accepts them.
- Do not rewrite module structure for style alone.
- Do not claim verification passed without reporting the actual checks run.
