---
name: start
description: Classify incoming work and route to the right pipeline entry point. Use when you have a task but don't know which skill to invoke. Not for tasks where you already know the skill — invoke it directly.
argument-hint: "[describe what you need done]"
---

# Start

## Purpose

Intelligent intake router — classifies your work prompt and guides you to the right skill or pipeline entry point. This is the **fallback** for ambiguous prompts. If you already know which skill you need, invoke it directly.

## When to Use

- You have a task but aren't sure which skill to use
- Your prompt describes multiple concerns (bug fix + new feature)
- You want to check if existing work already covers your task
- You typed something and VS Code didn't match a specific skill

## Trigger Examples

**Should trigger:**
- "I need to fix the calculator precision and add a new interface"
- "Where do I start with this task?"
- "Help me figure out the right approach for this"

**Should not trigger:**
- "Review this PR" → use /code-review
- "Plan this feature" → use /plan-issue
- "Fix this failing test" → use /tdd-fix

## Workflow

### Step 1: Check Existing State

Before classifying, scan for existing work that matches the user's prompt:

1. Extract 2-3 keywords from the prompt
2. Scan `docs/plans/` — read filenames and YAML `title:` fields for keyword overlap
3. Scan `docs/brainstorms/` — same approach

**If a match is found:**
- Present the match: "Found an existing [plan/brainstorm] for [topic]: `[file path]`"
- Ask: resume this work, or start fresh?
- If resume: route based on the file's status:
  - Brainstorm doc → `/brainstorming` (resume)
  - Plan with `status: planned` → `/work-on-task`
  - Plan with `status: in-progress` → `/work-on-task` (continue)
  - Plan with `status: review` → `/code-review`

**If no match found:** proceed to Step 2.

### Step 2: Classify the Prompt

Extract signals from the user's prompt across three dimensions:

**Complexity:**
| Signal | Classification |
|--------|---------------|
| Mentions specific file, function, or error message | Trivial |
| "fix", "bug", "error", "broken", "failing" (single concern) | Trivial |
| "add", "build", "implement", "create" (single feature) | Standard |
| Multiple distinct actions ("fix X and add Y") | Standard (compound) |
| "redesign", "migrate", "rewrite", "rearchitect" | Deep |

**Type:**
| Signal | Classification |
|--------|---------------|
| "fix", "bug", "error", "broken", "failing", "regression" | Bug fix |
| "add", "build", "implement", "create", "new" | Feature |
| "refactor", "clean up", "reorganize", "simplify" | Refactor |
| "investigate", "debug", "figure out", "understand" | Investigation |
| "explore", "brainstorm", "think through", "what if" | Exploration |
| "quick question", "btw", "where is", "what does", "how does" | Q&A |
| "README", "readme", "project docs", "overview documentation" | Documentation |
| "Java", "Spring Boot", ".java", "JVM" | Java domain |
| "Python", ".py", "pytest", "asyncio", "type hints" | Python domain |
| "SQL", "PostgreSQL", "migration", "schema", "query", "index" | SQL domain |
| "AWS", "SQS", "SNS", "IAM", "SDK", "CloudWatch" | AWS domain |

**Clarity:**
| Signal | Classification |
|--------|---------------|
| Names specific files, functions, or behavior | Clear |
| Describes desired outcome without specifics | Moderate |
| Vague or open-ended ("help with this code") | Unclear |

### Step 3: Route to Target Skill

Map classification to the appropriate skill. Prefer skills and pipeline flows over direct agent invocation unless the task is primarily a specialist review/research request or the user explicitly asks for an agent.

| Classification | Route | Reason |
|---------------|-------|--------|
| Trivial + Bug + Clear | `/tdd-fix` | Isolated bug, TDD approach |
| Standard + Feature + Unclear | `/brainstorming` | Needs requirements exploration first |
| Standard + Feature + Clear | `/capture-issue` | Ready to capture and plan |
| Standard + Compound | `/capture-issue` | Multiple concerns → single compound issue |
| Deep + any | `/capture-issue` | Needs formal planning pipeline |
| Deep + Unclear | `/brainstorming` | Needs exploration before capture |
| Investigation/Debug | `/engineer` | Autonomous investigation needed |
| Q&A | `/btw` | Quick answer without plan or file edits |
| Documentation + README | `/project-readme` | Update project-level README documentation |
| Java domain + focused | `/java` | Apply Java conventions and review routing |
| Python domain + focused | `/python` | Apply Python conventions and review routing |
| SQL domain + focused | `/sql` | Apply SQL/PostgreSQL conventions and data review routing |
| AWS domain + focused | `/aws` | Apply AWS conventions and cloud review routing |
| Exploration | `/brainstorming` | Exploring ideas |
| Refactor + Clear | `/capture-issue` | Track scope before changing |
| Refactor + Trivial | `/analyze-and-plan` | Quick plan sufficient |

**Confidence-based invocation:**

**High confidence** (classification is unambiguous — prompt clearly matches one row):
- Auto-invoke the target skill
- Brief explanation: "Routing to `/tdd-fix` — this looks like an isolated bug fix with a clear target."
- Pass the user's original prompt as the argument to the target skill

**Low confidence** (multiple rows could match, or signals are mixed):
- Present the recommendation: "This could go a few ways. I'd recommend `/capture-issue` because [reason]. Other options: `/brainstorming` (if scope needs exploration) or `/engineer` (if you want autonomous handling)."
- Wait for the user to confirm or choose differently
- Then invoke the selected skill with the original prompt

### Step 4: Hand Off

When invoking the target skill, pass the user's original prompt so the target skill has full context without re-asking.

If the target skill supports standalone mode, note that no plan file context is being passed — the target skill will operate in standalone mode.

## Error Handling

- **docs/plans/ or docs/brainstorms/ doesn't exist**: Skip existing state check, proceed to classification.
- **Classification signals are contradictory**: Default to low-confidence mode — present options.
- **User overrides the recommendation**: Invoke whatever skill the user chooses. /start never blocks.
- **Target skill is not available**: Suggest the closest alternative and explain.

## Guardrails

- Classification must complete in 1-2 exchanges maximum. If it takes more, you're over-thinking.
- Never block direct skill invocation. /start is a fallback, not a gateway.
- Pass the user's original prompt to the target skill. Don't lose context.
- When in doubt between /capture-issue and /brainstorming, prefer /brainstorming — it's cheaper to explore than to plan the wrong thing.
