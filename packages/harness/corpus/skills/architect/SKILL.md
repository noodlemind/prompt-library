---
name: architect
description: "Sketch types, signatures, and module boundaries before code. Use for a new shape or /architect. Not for a one-file bug that matches the local pattern -- implement it. Not for a diff -- use /code-review."
user-invocable: false
---

# Architect

Sketch the shape of a product change before writing it, when that shape is not already the local pattern. This skill decides types, signatures, and module boundaries. It does not sequence the work and it does not judge a diff.

## When to Use

- The change introduces a module, type, or responsibility the repo does not already have
- Two designs are plausible and the wrong boundary would be expensive to unwind
- The user asks to sketch, design the shape, or run `/architect`

## Trigger Examples

**Should trigger:**

- "Sketch the module boundaries before we add this subsystem"
- "This change does not match a pattern already in the repo"
- "Design the types and signatures first"

**Should not trigger:**

- "Fix this null check in the existing parser" — implement the one-file bug
- "Review this diff" — use /code-review
- "Break this known change into phases" — use /plan-issue

## Workflow

### 1. Ground

Read the code the change would sit beside. Name the module that already owns this job, or say that none does. Record the local pattern in a few lines: the type, the function that callers already use, and the file that owns the decision.

### 2. Sketch

Write the sketch before code. Keep it to one screen:

- the types and the fields that cross a boundary
- the function signatures callers will use
- the module that owns each decision
- what was subtracted so a new module was not added by default

No implementation in this step.

### 3. Screen

Read `references/design-red-flags.md`. Check the sketch for a shallow module, leaked knowledge, a split that follows time instead of knowledge, and a pass-through. If one of those is the structure, scrap the sketch. Remove a module before adding one, then draw the boundary again.

### 4. Proceed

When the user asked to decide the shape, show the sketch and wait. When Deliver loaded this skill to unblock an edit, write the sketch into the plan with `harness plan-update` and continue. Do not open a `~/.harness` plan in the editor.

### 5. Implement

Code follows the sketch. If the code needs a type, signature, or owner the sketch does not have, stop and redraw. Do not patch around a boundary that is wrong.

## Error Handling

- **No local pattern to read** — say what is absent, then sketch the smallest boundary that hides one decision.
- **The user rejects the sketch** — scrap it and draw one alternative. Do not keep both.
- For a missing file or a failed plan update, follow `~/.copilot/skills/references/error-handling-patterns.md`.
