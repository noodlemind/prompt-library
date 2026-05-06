---
name: deepen-plan
description: Enhance a plan with parallel research agents and interactive finding review per section. Use after /plan-issue to add depth, best practices, and implementation details. Not for initial planning — use /plan-issue first.
argument-hint: "[path to plan file]"
---

# Deepen Plan

## Pipeline Role

**Optional post-plan step**. Slots between `/plan-issue` and `/work-on-task` to enhance plans with research-backed depth. User reviews findings per section before integration.

## When to Use

- After `/plan-issue` produces a plan that would benefit from deeper research
- User says "deepen this plan", "research this more", "add more detail"
- Plan covers unfamiliar territory, security-sensitive areas, or complex integrations

## Trigger Examples

**Should trigger:**
- "Deepen this plan with more research"
- "This plan needs more detail on the authentication sections"
- "Research best practices for each section of my plan"

**Should not trigger:**
- "Plan this issue" → use /plan-issue (this is initial planning, not deepening)
- "Review this plan for quality" → use /document-review
- "Start working on this plan" → use /work-on-task

## Workflow

### Step 1: Read and Parse the Plan

1. Read the plan document from `$ARGUMENTS` or the user's message
2. If no path is provided, check for the most recently modified file in `docs/plans/`
3. Validate the plan exists and contains a `## Plan` section with phases
4. Identify the main sections that could benefit from research
5. Note the tech stack, framework, and domain from the plan context

### Step 2: Assess Sections for Deepening

For each plan section, evaluate whether research would add value:
- **High value**: Unfamiliar technologies, security boundaries, complex integrations, performance-critical paths
- **Medium value**: Standard patterns with nuanced trade-offs, multi-step workflows
- **Low value**: Simple CRUD, well-understood boilerplate, previously solved patterns (check `docs/solutions/`)

Skip sections where research adds minimal value. If no sections benefit from deepening, report "Plan is already well-grounded — all sections use established patterns with sufficient detail" and stop.

### Step 3: Discover and Dispatch Research Agents

Scan `.github/agents/` for agents that could provide expert perspective on the plan sections.

Agents to consider per section:
- `best-practices-researcher` for industry standards and patterns
- `framework-docs-researcher` for framework-specific guidance and APIs
- `repo-research-analyst` for codebase conventions and existing patterns
- Context7 MCP for up-to-date library documentation
- WebSearch for recent developments and known issues

**Orchestration:** If the `agent` tool is available for subagent delegation, delegate to research agents as isolated subagents in parallel batches (3-5 at a time, capped at 5 total for cost control). Each subagent receives the full section content and project context in the task prompt.

Otherwise, run research tasks sequentially within this session — read relevant codebase files, check best practices, and consult framework documentation inline.

### Step 4: Interactive Finding Review

After all agents complete, present findings to the user **grouped by plan section**. For each section:

```markdown
### Section: [Section Title]

**Agent:** [agent-name]
**Findings:**
1. [Finding summary]
2. [Finding summary]

**Options:** [Accept] / [Reject] / [Discuss]
```

**Accept**: Finding is integrated into the plan section.
**Reject**: Finding is skipped. No changes to the section.
**Discuss**: Brief dialogue about the finding. After discussion, re-ask Accept/Reject.

Process one section at a time. Wait for the user's decision before moving to the next section. This gives the user control over what research actually enters the plan.

### Step 5: Integrate Accepted Findings

For each accepted finding:
1. Merge the research into the relevant plan section inline — add detail, citations, and implementation guidance where they are most useful
2. Add source links and citations for external research
3. Resolve any conflicts between agent recommendations (prefer the recommendation that aligns with existing codebase patterns from available repository context such as `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, and `docs/solutions/`)

Preserve the plan's original structure — enhance sections, don't restructure the document.

### Step 6: Update the Plan File

Write the enhanced plan back to the same file path using the Edit tool.

Add `deepened: YYYY-MM-DD` to the YAML frontmatter to indicate the plan has been enriched.

### Step 7: Append Enhancement Summary

Append to the plan file:

```markdown
## Deepen-Plan Enhancement Summary

Enhanced on [YYYY-MM-DD] by [N] research agents across [M] sections.

| Section | Agent | Findings | Accepted | Rejected |
|---------|-------|----------|----------|----------|
| [Section 1] | best-practices-researcher | 3 | 2 | 1 |
| [Section 2] | framework-docs-researcher | 2 | 2 | 0 |

**Sections strengthened:** [list of sections that received accepted findings]
**Sections unchanged:** [list of sections where all findings were rejected or no research was needed]
```

### Step 8: Present Next Steps

Offer the user next steps:
- **Run `/document-review`** — Quality-check the enhanced plan before implementation
- **Start `/work-on-task`** — Begin implementation of Phase 1
- **Deepen further** — Run again targeting specific sections for additional research
- **Run `/code-review`** — Get multi-agent review of the enhanced plan

## Non-Interactive Mode

When invoked by another skill (programmatic use):
- Auto-accept all findings — skip the per-section Accept/Reject/Discuss loop
- Write the enhanced plan automatically
- Append the enhancement summary with all findings marked as accepted
- Return the file path and a one-line summary of what was added

## Error Handling

- **Plan file not found**: Report "Plan file not found at [path]." Suggest: "Provide the path to your plan file, or run `/plan-issue` to create one first."
- **No sections benefit from deepening**: Report "Plan is already well-grounded — all sections use established patterns with sufficient detail." No changes made.
- **User rejects all findings**: Plan unchanged. Report "No findings accepted — plan remains as-is." Still append a summary noting 0 accepted findings so the history is recorded.
- **Agent timeout** (partial output): Present whatever findings were returned from the timed-out agent, clearly marked as partial. Offer to retry the specific agent for the specific section.
- **Agent fails** (no output): Report which agent failed and for which section. Present findings from successful agents. Offer to retry the failed agent.
- **Tool not available**: Use the fallback from the cross-environment compatibility table in copilot-instructions.md. Specifically:
  - `agent` tool unavailable → run research sequentially in-session
  - Context7 MCP unavailable → use WebSearch or codebase files directly
  - WebSearch unavailable → rely on codebase analysis and agent knowledge

## Guardrails

- Cap parallel agents at 5 to control cost
- Focus on sections where research adds the most value — skip the obvious
- Don't over-research simple or well-understood topics
- Preserve the plan's original structure — enhance, don't restructure
- Always cite sources for external research
- Every finding presented must be actionable — no vague "consider this" without concrete guidance
