---
name: code-review
description: Multi-agent code review with confidence-scored findings, persona synthesis, and action routing. Use when reviewing PRs, changes, or branches. Not for single-domain review — delegate to the specialist directly.
---

# Code Review

## Pipeline Role

**Step 4** of the connected pipeline: Capture → Plan → Work → **Review** → Compound.

This skill coordinates multiple specialist personas to provide comprehensive code review. Each persona returns structured findings with severity and confidence scores. The skill merges, deduplicates, and routes findings by action type.

## When to Use

Activate when the user wants to:
- Review a pull request or set of code changes
- Get multi-perspective analysis of code quality
- Audit code for security, performance, or architecture concerns

## Trigger Examples

**Should trigger:**
- "Review this PR"
- "Can you do a code review of my changes?"
- "Check this branch for issues before I merge"

**Should not trigger:**
- "Check this code for security issues only" → delegate to @security-sentinel directly
- "Is this Rails code idiomatic?" → delegate to @compounding-rails-reviewer directly
- "Review this plan document" → use /document-review

## References

- **Persona definitions:** Read `references/review-personas.md` for what each reviewer looks for, severity calibration, and engagement triggers
- **Findings schema:** Read `references/findings-schema.md` for the structured JSON output contract, severity definitions, confidence guidelines, and action routing classes

## Workflow

### 1. Determine Mode

**Pipeline mode:** If a plan file is provided and contains `status:` in YAML frontmatter, enforce pipeline state validation (status must be `review` or `in-progress`).

**Standalone mode:** If no plan file is provided or the file lacks state machine fields, skip pipeline validation and review whatever is provided.

### 2. Understand the Scope

Determine what to review:
- **Pull Request**: Fetch PR details and modified files
- **Current Changes**: Review uncommitted changes in the workspace
- **Specific Files**: Review files or directories specified by the user
- **Branch Comparison**: Diff between two branches:
  1. Determine the base branch (ask the user if unclear; default `main` or `master`)
  2. Get the diff using the best available tool:
     - **VS Code**: Ask the user to run `git diff <base>...<branch> -- . ':!*.lock'` in terminal, then read with `terminalLastCommand`
     - **CLI/Claude Code**: Run `git diff <base>...<branch> -- . ':!*.lock'` directly via `run_command` or `Bash`
  3. Parse into changed files list with per-file hunks for specialist input

### 3. Gather Context and Detect Intent

- Read modified files and understand the changes
- Check `.github/agent-context.md` for accumulated codebase knowledge
- Check `docs/solutions/` for prior solutions related to the changed areas
- If a plan file is referenced, read `## Implementation Notes` for decisions and trade-offs
- Detect project type (Rails, TypeScript, Python) from project files
- Read related code and dependencies touched by the changes
- Write a 2-3 line intent summary: what the change is trying to accomplish

### 4. Select Personas

Read `references/review-personas.md` for the full persona catalog.

**Always engage** (every review): architecture-strategist, security-sentinel, performance-oracle, code-simplicity-reviewer, pattern-recognition-specialist (5 personas)

**Conditionally engage** based on diff content — this is judgment, not keyword matching:
- **Language-specific**: compounding-rails-reviewer (Rails), compounding-typescript-reviewer (TypeScript), compounding-python-reviewer (Python)
- **Domain-specific**: dhh-rails-reviewer (Rails architecture/philosophy decisions), data-integrity-guardian (migration files), spec-flow-analyzer (plan file referenced), every-style-editor (prose content)

Announce the selected team before dispatching.

### 5. Dispatch Personas

**Orchestration:** If the `agent` tool is available for subagent delegation, delegate to persona agents as isolated subagents in parallel batches (3-4 at a time). Otherwise, apply each persona's perspective sequentially within this session.

Each persona receives:
1. Their persona definition from `references/review-personas.md`
2. The findings schema from `references/findings-schema.md`
3. Review context: intent summary, file list, diff, project type
4. Instruction to return structured JSON matching the schema

Each persona returns JSON:
```json
{
  "reviewer": "persona-name",
  "findings": [...],
  "residual_risks": [...],
  "testing_gaps": [...]
}
```

### 6. Synthesize Findings

Merge multiple persona outputs into one deduplicated, confidence-gated finding set:

1. **Validate**: Check each output against the schema. Drop malformed findings (missing required fields). Record drop count.
2. **Confidence gate**: Suppress findings below 0.60 confidence. Exception: P1 findings at 0.50+ confidence survive — critical-but-uncertain issues must not be silently dropped.
3. **Deduplicate**: Fingerprint = normalize(file) + line_bucket(line, ±3) + normalize(title). When fingerprints match: keep highest severity, keep highest confidence with strongest evidence, union evidence arrays, note which personas flagged it.
4. **Cross-persona boost**: When 2+ independent personas flag the same issue, boost merged confidence by 0.10 (capped at 1.0). Note agreement in the output.
5. **Route by action type**: For each merged finding, set the final `autofix_class` per the routing definitions in `references/findings-schema.md`:
   - `safe_auto` → in-skill fix queue (applied automatically)
   - `gated_auto` → user approval required before applying
   - `manual` → handoff as residual work
   - `advisory` → report only, no action
6. **Sort**: Order by severity (P1 first) → confidence (descending) → file path → line number.
7. **Collect coverage**: Union residual_risks and testing_gaps across all personas.

### 7. Output Format

Present findings as pipe-delimited markdown tables grouped by severity level. Omit empty severity levels.

```markdown
# Code Review

**Scope:** [What was reviewed]
**Intent:** [2-3 line summary of what the change accomplishes]
**Personas:** [List of engaged personas with conditional justifications]

### P1 — Critical

| # | File | Issue | Persona(s) | Confidence | Route |
|---|------|-------|------------|------------|-------|
| 1 | `path:line` | Issue title | security, architecture | 0.92 | safe_auto |

### P2 — Important

| # | File | Issue | Persona(s) | Confidence | Route |
|---|------|-------|------------|------------|-------|
| 2 | `path:line` | Issue title | performance | 0.78 | manual |

### P3 — Suggestions

| # | File | Issue | Persona(s) | Confidence | Route |
|---|------|-------|------------|------------|-------|
| 3 | `path:line` | Issue title | patterns | 0.65 | advisory |

## Coverage
- Suppressed: [N] findings below 0.60 confidence
- Residual risks: [from personas]
- Testing gaps: [from personas]
- Failed personas: [any that failed or timed out]

---

## Verdict
[Ready to merge / Ready with fixes / Not ready]
[Brief reasoning]
```

### 8. Quality Gates

Before delivering the review, verify:

1. **Every finding is actionable** — if it says "consider" or "might want to" without a concrete fix, rewrite it
2. **No false positives from skimming** — verify the "bug" isn't handled elsewhere in the same function
3. **Severity is calibrated** — a style nit is never P1; a SQL injection is never P3
4. **Line numbers are accurate** — verified against file content
5. **Findings don't duplicate linter output** — focus on semantic issues the linter won't catch

### 9. Pipeline Continuation

If reviewing a plan file with `status: review`:
- After review is complete, suggest: "Run `/compound-learnings` to document any lessons learned."

## Error Handling

- **Empty diff** (nothing to review): Report "No changes detected" and suggest checking the branch or staging area.
- **All personas fail** (no output from any): Report "Review degraded — 0 of N personas returned results" with the scope summary. Do not present an empty findings table.
- **Single persona fails**: Report which persona failed. Present findings from successful personas. Offer to retry the failed persona.
- **Persona returns malformed JSON**: Drop the malformed findings. Record the drop in the Coverage section. Continue with valid findings.
- **Persona times out** (partial output): Include whatever findings were returned. Note the timeout in Coverage.
- **Plan file missing or malformed**: Report the error and suggest running the prior pipeline step.
- **Tool not available**: Use the fallback from the cross-environment compatibility table in copilot-instructions.md.

## Guardrails

- Be specific: reference exact file paths and line numbers.
- Be constructive: suggest concrete fixes, not just problems.
- Prioritize: most important issues first.
- Deduplicate: merge overlapping findings from different personas.
- Separate pre-existing issues from newly introduced issues when the diff makes the distinction clear.
