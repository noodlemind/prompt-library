---
name: code-review
description: Multi-agent code review with confidence-scored findings, persona synthesis, and action routing. Use when reviewing PRs, changes, or branches. Not for single-domain review — delegate to the specialist directly.
user-invocable: false
---

# Code Review

## Pipeline Role

**Step 4** of the connected pipeline: Capture → Plan → Work → **Review** → Compound.

This skill coordinates multiple specialist personas to provide comprehensive code review. Each persona returns structured findings with severity and confidence scores. Harness captures the review scope, validates coverage, applies confidence policy, and renders the factual report. The Engineer assesses defects and ambiguous overlaps.

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
- "Is this Java code idiomatic?" → delegate to @java-reviewer directly
- "Review this plan document" → use /document-review

## References

- **Persona definitions:** Read `references/review-personas.md` for what each reviewer looks for, severity calibration, and engagement triggers
- **Findings schema:** Read `references/findings-schema.md` for the structured JSON output contract, severity definitions, confidence guidelines, and action routing classes

## Workflow

### 1. Capture Scope

Use `harness review prepare --plan <path> --base <base> --json` for delivery review. Omit `--plan` for standalone review. The packet supplies current head, working changes, required reviewers, applicable checks, source hashes, excerpts, retrieval paths, and explicit omissions. Use the host's PR tools to establish the requested comparison when reviewing a PR. A missing base or omitted source is an investigation input, never evidence of an empty scope.

Read the full packet at `packetPath` and retrieve omitted source content before judging that area. Do not manually discover checks or reconstruct the packet. A changed source requires fresh preparation.

### 2. Gather Context and Detect Intent

- Read modified files and understand the changes
- Check available repository context for accumulated codebase knowledge: `README.md`, `.harness/agent-context.md` or `docs/agent-context.md`, `docs/codebase-snapshot.md`, and `docs/solutions/`.
- Check `docs/solutions/` for prior solutions related to the changed areas
- If a plan file is referenced, read `## Implementation Notes` for decisions and trade-offs
- Detect project type (Java, Python, TypeScript, SQL/data, AWS) from project files
- Read related code and dependencies touched by the changes
- Write a 2-3 line intent summary: what the change is trying to accomplish

### 3. Choose Additional Perspectives

The CLI preserves the five mandatory perspectives and selects bundled/product checks from declared globs. Read `references/review-personas.md` and decide whether the change needs additional language or domain judgment. Add each selected specialist with `--reviewer <id>` when preparing the packet. Explain the relevance of additional perspectives before dispatch.

### 4. Dispatch Personas and Checks

**Orchestration:** If the `agent` tool is available for subagent delegation, delegate to persona agents as isolated subagents in parallel batches (3-4 at a time). Otherwise, apply each persona's perspective sequentially within this session.

Each persona receives:
1. Their persona definition from `references/review-personas.md`
2. The findings schema from `references/findings-schema.md`
3. Review context: intent summary, file list, diff, project type
4. Instruction to return structured JSON matching the schema

**Check dispatch:** Each discovered check is dispatched as a focused subagent. The subagent receives:
1. The check's full content (criteria, examples)
2. The findings schema from `references/findings-schema.md`
3. The same review context as personas
4. The check's `severity-default` as the default severity for findings

Checks run in parallel with personas. Their findings are merged into the same synthesis pipeline.

Each persona returns JSON:
```json
{
  "reviewer": "persona-name",
  "status": "completed",
  "findings": [...],
  "residual_risks": [...],
  "testing_gaps": [...]
}
```

### 5. Collect and Adjudicate

Submit `{ "packet": "<id>", "results": [...] }` as a file to `harness review assemble --plan <path> --packet <id> --file <results.json> --json`. Omit `--plan` for standalone review. Each required result needs `status: completed`, findings, residual risks, and testing gaps. Retain a failed or timed-out result with its actual status.

Harness validates locations and schema, applies the confidence floor before aggregation, merges exact identities, preserves suppressed/raw results, and renders `report`. Nearby locations remain distinct candidate overlaps. Decide whether they describe the same defect from their evidence. Submit explicit `adjudications` with `action: merge|retain`, member IDs, and a rationale. No automatic proximity clustering or severity escalation is permitted.

Use the returned report and coverage counts. Retrieve full raw evidence at `recordPath` and exact invocation payload at `observationPath`. Incomplete coverage blocks delivery completion. A supplied reviewer name does not authenticate the invocation; a confidence boost does not establish independent corroboration. Do not recalculate tables or counts in prose.

### 6. Quality Gates

Before delivering the review, verify:

1. **Each finding is actionable** — if it says "consider" or "might want to" without a concrete fix, rewrite it
2. **No false positives from skimming** — verify the "bug" isn't handled elsewhere in the same function
3. **Severity is calibrated** — a style nit is never P1; a SQL injection is never P3
4. **Line numbers are accurate** — verified against file content
5. **Findings don't duplicate linter output** — focus on semantic issues the linter won't catch

### 7. Continue from Evidence

Assess fix authority and behavior before acting. `autofix_class` is advisory routing metadata; it never grants permissions. Apply authorized fixes, then prepare and collect a new review for the changed content before verification. Clearing a plan string cannot discharge a recorded critical finding.

When current coverage is complete and critical findings are resolved, run `harness verify`. Completion and Stop consume this same bound review record. Optional learning follows passed verification.

## Error Handling

Use the CLI's missing/failure/omission diagnostics. Retry the affected judgment with its full evidence. Do not turn malformed, partial, timed-out, or unavailable results into a clean review. If a required capability is unavailable, report the degraded coverage. For semantic disagreements, retain both claims until the Engineer adjudicates them explicitly.

## Guardrails

- Be specific: reference exact file paths and line numbers.
- Be constructive: suggest concrete fixes, not just problems.
- Prioritize: most important issues first.
- Adjudicate candidate overlaps using the evidence; retain different defects separately.
- Separate pre-existing issues from newly introduced issues when the diff makes the distinction clear.
