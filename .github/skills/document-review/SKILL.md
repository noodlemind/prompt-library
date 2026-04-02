---
name: document-review
description: Multi-persona document review with severity-scored findings. Use as a quality gate between brainstorm and plan, or between plan and work. Not for code review — use /code-review.
disable-model-invocation: true
---

# Document Review

## Pipeline Role

**Optional quality gate** between pipeline stages:
- Between `/brainstorming` → `/plan-issue` (validate requirements before planning)
- Between `/plan-issue` → `/work-on-task` (validate plan before implementation)
- Standalone review of any brainstorm, plan, or spec document

## When to Use

- After brainstorming or planning, before the next pipeline step
- User says "review this document", "refine this plan", "check this spec"
- Another skill invokes document-review as a quality gate
- A document needs quality improvement before handoff

## Trigger Examples

**Should trigger:**
- "Review this plan before I start implementing"
- "Is this brainstorm doc ready for planning?"
- "Check this spec for gaps"

**Should not trigger:**
- "Review this PR" → use /code-review
- "Review this code for security" → delegate to @security-sentinel
- "Improve this README" → use @every-style-editor

## References

- **Evaluation criteria:** Read `references/review-criteria.md` for what each persona evaluates per document type

## Workflow

### 1. Get and Classify the Document

Read the document from `$ARGUMENTS` or the user's message. If no document specified, check for the most recently modified file in `docs/plans/` or `docs/brainstorms/`.

Classify the document type:
- **Brainstorm**: Files in `docs/brainstorms/` or containing problem frame + requirements sections
- **Plan**: Files in `docs/plans/` or containing implementation units + requirements trace
- **Spec**: Files with detailed behavioral specifications, API contracts, or flow definitions

### 2. Select and Dispatch Personas

Read `references/review-criteria.md` for the evaluation criteria per persona and document type.

Four personas evaluate every document:
1. **Design** — information architecture, flows, interaction states, behavior completeness
2. **Scope** — scope alignment, unjustified complexity, YAGNI, goals match
3. **Coherence** — internal consistency, contradictions, terminology drift, structural issues
4. **Feasibility** — technical feasibility, architecture conflicts, dependency gaps, implementability

**Orchestration:** If the `agent` tool is available for subagent delegation, delegate to 4 personas as isolated subagents in parallel. Each receives:
- The full document content
- The document type classification
- Their persona's evaluation criteria from `references/review-criteria.md`
- Instruction to return severity-scored findings

Otherwise, apply each persona's perspective sequentially within this session.

### 3. Collect and Merge Findings

Each persona returns findings with severity:
- **P1 (Must fix)**: Will cause confusion, incorrect implementation, or blocks the next pipeline step
- **P2 (Should fix)**: Improves clarity, completeness, or quality meaningfully
- **P3 (Nice to have)**: Polish, additional context, minor improvements

Merge findings across personas:
1. Deduplicate: if two personas flag the same gap, merge into one finding noting both personas
2. Boost severity when 2+ personas flag the same area (indicates a systemic issue)
3. Sort by severity (P1 first) → document section order

### 4. Present Findings

```markdown
# Document Review: [Document Title]

**Type:** [Brainstorm / Plan / Spec]
**Personas:** design, scope, coherence, feasibility

## Findings

### P1 — Must Fix
| # | Section | Issue | Persona(s) |
|---|---------|-------|------------|
| 1 | Requirements | Missing edge case for empty input | design, feasibility |

### P2 — Should Fix
| # | Section | Issue | Persona(s) |
|---|---------|-------|------------|
| 2 | Scope Boundaries | Requirement R3 depends on out-of-scope feature | scope |

### P3 — Nice to Have
| # | Section | Issue | Persona(s) |
|---|---------|-------|------------|
| 3 | Overview | Terminology "module" used inconsistently | coherence |

## Summary
- [N] P1 findings, [N] P2, [N] P3
- [Overall assessment: Ready for next step / Needs fixes / Needs rework]
```

### 5. Apply or Present Changes

**Interactive mode** (invoked by user):
- Present all findings
- Apply P1 and P2 fixes with user approval
- Skip P3 unless user requests

**Non-interactive mode** (invoked by another skill):
- Auto-apply all P1 and P2 improvements
- Skip P3 improvements
- Return the updated file path

### 6. Offer Next Action

After improvements:
- **Proceed to next step** — `/plan-issue` (for brainstorms) or `/work-on-task` (for plans)
- **Review again** — another pass for further refinement
- **Done** — return to user

## Error Handling

- **Document not found**: Report the error and suggest providing a file path.
- **Document too short** (under 10 lines): Adapt evaluation depth. Don't generate trivial findings for minimal documents.
- **Single persona fails**: Present findings from the other 3 personas. Note the failed persona in the summary.
- **All personas fail**: Report "Document review degraded — no personas returned results."
- **Tool not available**: Use the fallback from the cross-environment compatibility table in copilot-instructions.md.

## Guardrails

- Focus on substance, not formatting
- Every improvement should make the document more actionable
- Don't add content the author intentionally omitted (check scope boundaries)
- Keep reviews focused — 5-10 minutes, not hours
- Don't restructure the document unless the organization is actively confusing
