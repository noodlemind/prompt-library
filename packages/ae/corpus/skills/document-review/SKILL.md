---
name: document-review
description: Multi-persona document review with severity-scored findings. Use as a quality gate between brainstorm and plan, or between plan and work. Not for code review — use /code-review.
user-invocable: false
---

# Document Review

## Pipeline Role

**Optional quality gate** between pipeline stages:
- Between `/brainstorming` → `/plan-issue` (validate requirements before planning)
- Between `/plan-issue` → Engineer Deliver mode (validate plan before implementation)
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
- "Improve this README" → use /project-readme

## References

- **Evaluation criteria:** Read `references/review-criteria.md` for what each persona evaluates per document type

## Workflow

### 1. Get and Classify the Document

Read the document from `$ARGUMENTS` or the user's message. If no document is specified, use the active plan or Harness plan lookup from the current project's store; legacy `docs/plans/`, `.harness/plans/`, and `docs/brainstorms/` remain discovery inputs. Confirm the intended document when more than one candidate fits.

Classify the document type:
- **Brainstorm**: Files in `docs/brainstorms/` or containing problem frame + requirements sections
- **Plan**: Harness-created plans in the project store or legacy plan directories, or documents containing implementation units + requirements trace
- **Spec**: Files with detailed behavioral specifications, API contracts, or flow definitions

### 2. Select and Dispatch Personas

Read `references/review-criteria.md` for the evaluation criteria per persona and document type.

The Engineer runs `ae review prepare --domain document --file <document> --json` once before dispatch. Bind `--plan <path>` only when its review obligations are compatible with document review. Use a standalone document packet for a plan that requires code review; document judgments cannot satisfy that obligation. Use the exact source path returned in the packet, including an absolute path for a current-project plan outside the checkout. The packet supplies the source references and four required perspectives. Four personas evaluate every document:
1. **Design** — information architecture, flows, interaction states, behavior completeness
2. **Scope** — scope alignment, unjustified complexity, YAGNI, goals match
3. **Coherence** — internal consistency, contradictions, terminology drift, structural issues
4. **Feasibility** — technical feasibility, architecture conflicts, dependency gaps, implementability

**Orchestration:** If the `agent` tool is available for subagent delegation, delegate to 4 personas as isolated subagents in parallel. Each receives:
- The full document content
- The document type classification
- Their persona's evaluation criteria from `references/review-criteria.md`
- The shared `../code-review/references/findings-schema.md` JSON contract, packet source paths, and instruction to return its actual completion status and exact document locations

Otherwise, apply each persona's perspective sequentially within this session.

### 3. Collect and Assess Findings

Collect results against the same packet used for dispatch. Each perspective returns its shared JSON contract with its actual completion status and exact document locations. Reprepare only when the reviewed document or its definitions changed; earlier results cannot establish coverage for the changed source.

The Engineer collects using `ae review assemble --packet <id> --file <results.json> --json`, retaining `--plan <path>` for a delivery-bound packet. Use the returned factual `report` and retrieve the full record at `recordPath`. The CLI owns validation, confidence filtering, exact matching, counts, and sorting. Missing or malformed results remain incomplete coverage.

Decide semantic overlap and severity from the document's goals and evidence. Nearby findings remain separate until explicit merge/retain adjudication with member IDs and rationale. Multiple perspectives do not automatically raise severity or establish independence.

### 4. Apply or Present Changes

**Interactive mode** (invoked by user):
- Present all findings
- Apply authorized P1 and P2 fixes; request approval only when mutation authority or scope is missing
- Skip P3 unless user requests

**Non-interactive mode** (invoked by another skill):
- Return P1 and P2 improvements for application within the existing authorized scope
- Skip P3 improvements
- Return the document path and proposed changes; include the updated path when the Engineer has applied them

The Engineer applies accepted fixes. For a Harness-managed plan, return authored amendments for `ae plan-update --file` against its observed revision; never edit the project-store plan in the editor. Product document edits enter Deliver and require a successful implement gate before mutation. Existing authorization covers necessary corrections; a review request alone supplies no new mutation authority. Prepare a fresh packet after changing the reviewed content.

### 5. Offer Next Action

After improvements:
- **Proceed to next step** — `/plan-issue` (for brainstorms) or `@engineer` Deliver mode (for plans)
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
