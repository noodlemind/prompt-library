---
name: deepen-plan
description: Enhance a plan with parallel research agents for each section. Use after /plan-issue to add depth, best practices, and implementation details.
disable-model-invocation: true
---

# Deepen Plan

## Pipeline Role

**Optional post-plan step**. Slots between `/plan-issue` and `/work-on-task` to enhance plans with research-backed depth.

## When to Use

- After `/plan-issue` produces a plan that would benefit from deeper research
- User says "deepen this plan", "research this more", "add more detail"
- Plan covers unfamiliar territory or security-sensitive areas

## Workflow

### Step 1: Read and Parse the Plan

1. Read the plan document from `$ARGUMENTS` or the user's message
2. Identify the main sections that could benefit from research
3. Note the tech stack, framework, and domain from the plan context

### Step 2: Discover Relevant Agents

Scan `.github/agents/` for agents that could provide expert perspective on the plan:
- Architecture agents for structural sections
- Security agents for security-related sections
- Performance agents for scalability sections
- Language-specific reviewers for implementation sections

### Step 3: Launch Research Agents

**Orchestration:** If the `agent` tool is available for subagent delegation, invoke
research agents as isolated subagents (each with full plan context in the task prompt).
Otherwise, run research tasks sequentially within this session.

**When subagents are available:** Spawn up to 5 agents simultaneously (cap for cost control).
For each relevant section, invoke a research agent as a subagent with the full section content
and project context in the task prompt.

**When subagents are not available:** Research each section sequentially — read relevant
codebase files, check best practices, and consult framework documentation inline.

Agents to consider per section:
- `best-practices-researcher` for industry standards
- `framework-docs-researcher` for framework-specific guidance
- `repo-research-analyst` for codebase patterns
- Context7 MCP for up-to-date documentation
- WebSearch for recent developments

### Step 4: Synthesize Findings

After all agents complete:

1. Collect enhancements from each agent
2. Merge into the plan — add research findings inline where they're most relevant
3. Add citations and source links
4. Note any conflicts between agent recommendations (and resolve them)

### Step 5: Add Enhancement Summary

Append a summary section to the plan:

```markdown
## Deepen-Plan Enhancement Summary

This plan was enhanced by [N] research agents. Key additions:

### [Topic 1]
- [Key finding or recommendation]

### [Topic 2]
- [Key finding or recommendation]
```

### Step 6: Update the Plan File

Write the enhanced plan back to the same file path using the Edit tool.

Add `deepened: YYYY-MM-DD` to the YAML frontmatter to indicate the plan has been enriched.

### Step 7: Present Options

Offer the user next steps:
- **Open plan in editor** — Review the enhanced plan
- **Run `/code-review`** — Get multi-agent review of the plan
- **Start `/work-on-task`** — Begin implementation
- **Refine further** — Continue enhancing specific sections

## Non-Interactive Mode

When invoked by another skill:
- Skip AskUserQuestion calls
- Write the enhanced plan automatically
- Return the file path

## Guidelines

- Cap parallel agents at 5 to control cost
- Focus on sections where research adds the most value
- Don't over-research simple or well-understood topics
- Preserve the plan's original structure — enhance, don't restructure
- Always cite sources for external research
