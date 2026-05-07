---
name: java
description: Java engineering workflow for implementation, debugging, refactoring, testing, and review preparation. Use for Java or Spring Boot code work.
argument-hint: "[describe the Java task, file, or failure]"
---

# Java

## Purpose

Apply Java engineering guidance as an on-demand skill. Use this inside the normal pipeline for planned work, or directly for small Java questions and focused edits.

## Trigger Examples

**Should trigger:**
- "Add validation to this Java service"
- "Review this CompletableFuture error handling"
- "Refactor this Spring Boot controller"

**Should not trigger:**
- "Review AWS IAM permissions" -> use `/aws` or `@aws-reviewer`
- "Tune this SQL query" -> use `/sql`
- "What does this repository do?" -> use `/btw`

## Workflow

1. **Load scoped conventions**: Apply the globally hydrated `java.instructions.md`. If Spring Boot is present, also apply `spring-boot.instructions.md`.
2. **Classify scope**:
   - Small focused change -> proceed directly with TDD.
   - Multi-step feature, migration, or risky refactor -> create or update a plan through `/capture-issue` and `/plan-issue`.
3. **Inspect local patterns**: Prefer existing package structure, dependency injection style, test framework, formatting, and error handling.
4. **Implement conservatively**:
   - Keep public API contracts explicit.
   - Preserve nullability and validation behavior.
   - Use records, sealed types, switch expressions, and streams only when they improve clarity.
   - Keep resource ownership and client lifecycle clear.
5. **Verify**:
   - Run the smallest relevant Java tests first.
   - Run broader project checks when the touched surface is shared.
   - Confirm changed files match the plan or stated request.
6. **Review route**:
   - Use `@java-reviewer` for Java correctness, API, concurrency, and test review.
   - Add `@aws-reviewer`, `@sql-reviewer`, or `@security-sentinel` when those boundaries are touched.

## Guardrails

- Do not bypass the local-first plan workflow for broad work.
- Do not introduce framework rewrites or package restructuring unless the plan calls for it.
- Do not report formatter-only issues as substantive review findings.
