---
name: import-conventions
description: Adapt conventions from an existing framework, library or repository. Use when onboarding a dependency or importing team practices. Create new primitives through /create-primitive.
argument-hint: "[repo URL, path, or framework name]"
user-invocable: false
---

# Import Conventions

## Purpose

Read a custom framework, library, or repository and generate `.instructions.md` files (scoped coding standards) and optional `SKILL.md` files (workflow guidance) that capture its conventions, patterns, and best practices. This is how you onboard a new dependency into the agent system.

## When to Use

- Onboarding a custom framework wrapper (e.g., internal Spring Boot starter or shared Python platform package)
- Capturing team conventions from an existing codebase
- Creating a Tool Wrapper skill from a library's documentation and examples
- Converting a README or style guide into agent-consumable instructions

## Trigger Examples

**Should trigger:**
- "Import conventions from our custom Spring framework"
- "Create instructions from this repo's patterns"
- "Capture how we use this internal library"

**Should not trigger:**
- "Create a new agent" → use /create-primitive
- "Write a Java class" → the agent should follow existing java.instructions.md
- "Review this code" → use /code-review

## Workflow

### Step 1: Identify the Source

Determine what to import from:

| Source Type | How to Access |
|-------------|--------------|
| **Local repo/directory** | Read files directly from the provided path |
| **GitHub repo URL** | Clone or fetch via `gh` CLI, or read via GitHub API |
| **Framework name** | Search for it in the project's dependencies, then read its source/docs |
| **Documentation URL** | Fetch and parse the documentation |

Ask the user what to import if the argument is ambiguous.

### Step 2: Analyze the Source

Read the source material to extract conventions. Prioritize in this order:

1. **README / Getting Started** — overall philosophy, quick-start patterns
2. **Style guides / Contributing docs** — explicit coding standards
3. **Example code / Tests** — actual usage patterns (often more reliable than docs)
4. **Source code** — internal conventions, naming patterns, API design
5. **Configuration files** — default settings, required config, environment variables

For each area, extract:
- **Naming conventions** — how things are named (classes, methods, config keys)
- **Usage patterns** — the idiomatic way to use the framework (do this, not that)
- **Common pitfalls** — mistakes that are easy to make
- **Configuration requirements** — what must be set up for the framework to work
- **Testing patterns** — how to test code that uses this framework

### Step 3: Choose the primitive

Classify with `/create-primitive`: deterministic reusable operation → Harness; contextual judgment protocol → skill; separate perspective or authority → agent; scoped convention → instruction; product assertion → product check. Inspect existing capabilities with `harness resources list --json` and source retrieval before choosing the smallest useful addition. A framework name alone is not promotion evidence.

### Step 4: Author and validate

Follow [resource-operations.md](../references/resource-operations.md). Use `resources scaffold` for the canonical metadata and host declaration shape, then author the source-backed rationale, concrete good/bad examples, relevant triggers and meaningful outcome evaluations. Decide narrow activation patterns and minimum permissions from the actual use cases.

Use schema1 `resources create <type> <name> --file <decision.json>` for a personal primitive; the existing writer validates and registers it. Use `resources validate --corpus --json` for an authorized ship-set change. Harness owns structural checks, references, limits, registry consistency, replacement conflicts and inventory counts. Interpret its diagnostics and repair authored content; do not maintain counts manually.

### Step 5: Present evidence

Report inspected sources, overlap decisions, selected primitive, operation outcome and evaluation limits. Structural validity does not prove that conventions are correct or useful. Record substantive repository rationale through plan notes when needed.

## Non-interactive use

A calling skill supplies scope and prior authorization. Apply the canonical [human-approval-policy.md](../references/human-approval-policy.md); invocation alone does not authorize capability activation. Do not discard existing direct authorization or ask again for the same action.

## Error Handling

- **Source not accessible** (private repo, broken URL): Report the error, suggest providing a local path or pasting the relevant docs.
- **Source too large** (monorepo, massive framework): Ask the user which modules/packages to focus on. Don't try to analyze everything.
- **No clear conventions found**: Report what was found, generate a minimal instruction file with what's available, note gaps.
- **Existing instruction overlap**: If an instruction file already exists for this language/framework, ask whether to merge or create a separate file.

## Guardrails

- Source conventions from actual code and documentation, not from general knowledge
- Verify patterns exist in the source before documenting them
- Keep generated files concise — agents work better with focused context
- Don't generate skills for frameworks that only need coding standards (instructions suffice)
- Match the existing naming and structure conventions in this repo
