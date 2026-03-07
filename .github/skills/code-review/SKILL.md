---
name: code-review
description: Perform comprehensive multi-agent code reviews covering security, performance, architecture, and code quality. Use when reviewing PRs, uncommitted changes, or comparing branches.
---

# Code Review

## Pipeline Role

**Step 4** of the connected pipeline: Capture → Plan → Work → **Review** → Compound.

This skill coordinates multiple specialist agents to provide comprehensive code review from different perspectives.

## When to Use

Activate when the user wants to:
- Review a pull request or set of code changes
- Get multi-perspective analysis of code quality
- Audit code for security, performance, or architecture concerns

## Workflow

### 1. Understand the Scope

Determine what to review:
- **Pull Request**: Fetch PR details and modified files
- **Current Changes**: Review uncommitted changes in the workspace
- **Specific Files**: Review files or directories specified by the user
- **Branch Comparison**: Diff between two branches using the terminal workflow:
  1. Determine the base branch (ask the user if unclear; default `main` or `master`)
  2. Ask the user to run in the terminal: `git diff <base>...<branch> -- . ':!*.lock'`
  3. Read the diff output using `terminalLastCommand`
  4. Parse into changed files list with per-file hunks for specialist input

### 2. Gather Context

- Read modified files and understand the changes
- Check `.github/agent-context.md` for accumulated codebase knowledge
- If a plan file is referenced, read `## Implementation Notes` for decisions and trade-offs from the implementation phase
- Detect project type (Rails, TypeScript, Python, etc.) from project files
- Read related code and dependencies touched by the changes

**Orchestration:** If the `agent` tool is available for subagent delegation, invoke
specialist agents as isolated subagents (each with full review context in the task prompt).
Otherwise, apply each specialist perspective sequentially within this session.

### 3. Detect Project Type

- **Rails**: `Gemfile` with rails, `config/application.rb`, `app/` directory
- **TypeScript**: `tsconfig.json`, `.ts`/`.tsx` files
- **Python**: `pyproject.toml`/`requirements.txt`, `.py` files

### 4. Multi-Agent Analysis

Coordinate specialist perspectives. The agents provide judgment — this skill synthesizes their findings.

**Always engage these perspectives**:
- Architecture analysis — structural integrity and design patterns
- Security audit — vulnerabilities and attack surface
- Performance review — bottlenecks and scalability
- Code simplicity — over-engineering and unnecessary complexity
- Pattern consistency — adherence to established codebase patterns

**Language-specific perspectives** (engage when applicable):
- Rails projects: Rails conventions + DHH philosophy
- TypeScript projects: Type safety and modern patterns
- Python projects: Pythonic patterns and type annotations

**Migration-conditional perspectives** (engage when migration files are in scope):
- Data integrity review — migration safety, schema drift detection, rollback planning
- Spec flow analysis — if a plan file is referenced, analyze for gaps and edge cases

### 5. Synthesize and Prioritize

Merge findings from all perspectives. When agents flag the same location:
- Keep the highest severity
- Merge descriptions
- Note which perspectives flagged it

### 6. Categorize Findings

**Severity Levels**:
- **P1 Critical**: Security vulnerabilities, data loss risks, breaking changes
- **P2 Important**: Performance issues, architectural concerns, significant bugs
- **P3 Suggestion**: Code quality improvements, minor optimizations

### 7. Output Format

```markdown
# Code Review Summary

## Overview
[What was reviewed, scope, project type]

## Key Findings

### P1 Critical
1. **[Issue]** — `file:line` (flagged by: [agent perspectives])
   - Problem: [Description]
   - Impact: [Why critical]
   - Fix: [Specific recommendation]

### P2 Important
...

### P3 Suggestions
...

## Agent Perspectives
[Brief summary from each engaged perspective]

## Overall Assessment
- **Risk Level**: [Low / Medium / High]
- **Recommendation**: [Approve / Approve with changes / Request changes]

## Next Steps
1. [Priority actions]
```

### 8. Pipeline Continuation

If reviewing a plan file with `status: review`:
- After review is complete, suggest: "Run `/compound-learnings` to document any lessons learned."

## Guardrails

- Be specific: reference exact file paths and line numbers.
- Be constructive: suggest solutions, not just problems.
- Prioritize: most important issues first.
- Deduplicate: merge overlapping findings from different agents.
