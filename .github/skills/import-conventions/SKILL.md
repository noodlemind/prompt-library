---
name: import-conventions
description: Generate instructions and skills from a custom framework, library, or repo. Use when onboarding a new dependency, capturing team conventions, or creating a Tool Wrapper from an existing codebase. Not for creating primitives from scratch — use /create-primitive.
argument-hint: "[repo URL, path, or framework name]"
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

### Step 3: Determine What to Generate

Based on the source analysis, decide what to create:

| Source Content | Generate |
|---------------|---------|
| Coding standards, style rules, naming conventions | `.instructions.md` file |
| Multi-step workflow or process | `SKILL.md` file (Pipeline or Tool Wrapper pattern) |
| Both standards and workflows | Both files |
| Framework with rich conventions | `.instructions.md` + `SKILL.md` with `references/` |

Ask the user to confirm before generating.

### Step 4: Generate Instruction File

Create `.github/instructions/<name>.instructions.md` following the established pattern:

```markdown
---
name: '<Framework/Library> Conventions'
description: '<What these conventions cover>'
applyTo: '<glob pattern for relevant files>'
---

# <Framework/Library> Conventions

## <Category>
- [Convention with rationale]

## <Category>
- [Convention with rationale]
```

**Guidelines for instruction content:**
- Be specific and actionable — "Use `@Transactional(readOnly = true)` for read queries" not "Use transactions appropriately"
- Include the WHY — "Prevents accidental writes and enables read replica routing"
- Use the framework's actual API names and patterns from the source
- Include common pitfalls with the correct alternative
- Keep under 100 lines — extract to references if longer
- Set `applyTo` to match the file types this framework affects

### Step 5: Generate Skill File (if applicable)

If the framework has workflow patterns worth encoding, create `.github/skills/<name>/SKILL.md`:

```markdown
---
name: <skill-name>
description: '<What and when>. Not for <confusable alternative>.'
---

# <Skill Name>

## When to Use
[Trigger scenarios]

## Trigger Examples
[3 should, 3 should-not]

## Workflow
[Steps encoding the framework's workflow patterns]

## Guardrails
[Key constraints and common mistakes]
```

For skills with rich conventions, extract checklists or reference material to `references/`.

### Step 6: Verify and Present

Before saving, verify:
- [ ] Instruction file has correct `applyTo` glob pattern
- [ ] Conventions are sourced from actual framework code/docs, not hallucinated
- [ ] Naming matches the project's existing instruction/skill patterns
- [ ] No duplicate coverage with existing instructions (check `.github/instructions/`)

Present the generated files to the user for review before writing.

### Step 7: Update Documentation

After creating new files:
- Update CLAUDE.md instruction count if applicable
- Update AGENTS.md if a new skill was created
- Note the new instruction/skill in the repository-owned context docs, such as `docs/agent-context.md` for product repos or `.github/agent-context.md` when working in this prompt-library repo

## Non-Interactive Mode

When invoked by another skill:
- Generate the instruction file automatically based on the source
- Skip confirmation prompts
- Return the file path(s)

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
