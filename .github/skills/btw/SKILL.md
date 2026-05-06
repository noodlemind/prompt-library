---
name: btw
description: Quick repository or general Q&A without creating plans or editing files. Use for explanations, orientation, and small questions. Not for implementation -- use /engineer or /work-on-task.
argument-hint: "[question]"
---

# BTW

## Pipeline Role

Lightweight question-answering lane. Use this skill when the user wants a quick answer, explanation, or repository orientation without creating a plan, changing files, or entering the engineering pipeline.

## When to Use

Activate when the user asks:
- A quick question about the repository
- Where something lives
- How a piece of code, workflow, or convention works
- A general technical question that does not require edits
- A comparison or recommendation that can be answered from available context

## Trigger Examples

**Should trigger:**
- "BTW, where is auth configured?"
- "Quick question: what test command should I run?"
- "What does this repository do?"

**Should not trigger:**
- "Fix this bug" -> use /tdd-fix or /engineer
- "Create a plan for this feature" -> use /plan-issue
- "Update the README" -> use /project-readme

## Inputs and Outputs

**Inputs:** User question, repository context, docs, code references, and optionally general knowledge.

**Outputs:** Concise answer with file references when repository evidence was used. No file changes.

## Workflow

### 1. Classify the Question

Determine whether the answer needs:
- **Repo lookup:** search/read files and cite paths
- **General explanation:** answer directly
- **Current external facts:** ask to use an internet-capable tool if unavailable in the host
- **Implementation/planning:** redirect to the appropriate skill instead of continuing

### 2. Gather Minimal Context

For repository questions:
- Read available repository context first if project conventions matter: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, and `docs/solutions/`. When answering about this prompt-library repo, also read `.github/agent-context.md`.
- Search only the likely files or directories
- Prefer direct evidence over broad scans
- Stop once the answer is supported

### 3. Answer

Keep the response short and direct:
- Lead with the answer
- Include file references for repo claims
- Mention uncertainty or missing evidence explicitly
- Suggest the correct next skill only when the question has become implementation, planning, review, or documentation work

## Non-Interactive Mode

Answer from available context. If evidence is insufficient, state what is missing rather than creating a plan or making edits.

## Verification

- No files modified
- No plan file created
- Repo claims are backed by file references when applicable
- The response stays scoped to the question

## Guardrails

- Do not edit files.
- Do not create issues, plans, or solution docs.
- Do not start implementation.
- Do not run broad or expensive investigations for a quick question; route to `/engineer` for deeper investigation.
