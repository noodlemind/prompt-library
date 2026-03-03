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

### Step 3: Launch Research Agents in Parallel

Spawn up to 5 agents simultaneously (cap for cost control):

For each relevant section, spawn a Task agent:
```
Task: "Review and enhance this section of the plan with best practices,
potential pitfalls, and implementation recommendations.

PLAN SECTION:
[paste section content]

PROJECT CONTEXT:
[tech stack, framework, conventions]

Return: enhanced section content with specific, actionable additions."
```

Also consider:
- `best-practices-researcher` for industry standards
- `framework-docs-researcher` for framework-specific guidance
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
