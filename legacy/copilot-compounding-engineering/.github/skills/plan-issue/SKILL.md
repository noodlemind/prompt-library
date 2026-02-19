---
name: plan-issue
description: >
  Transform feature descriptions, bug reports, or improvement ideas into
  well-structured issue documents with research, technical analysis, and
  implementation phases. Use when the user wants to plan a feature, structure
  a bug report, or create a detailed issue with research backing.
---

# Plan Issue Skill

## When to Use
Activate when the user wants to:
- Plan a new feature with research and technical analysis
- Structure a bug report into an actionable issue
- Create a detailed issue document with implementation phases
- Transform an idea into a well-researched development plan

## User Preferences
Before planning, resolve the user's Profile:
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` in the workspace.
2. Apply any custom issue templates, labeling conventions, or planning standards.

## Workflow

### 1. Repository Research & Context Gathering
Run these research tasks in parallel:
- Analyze repository structure and conventions
- Research industry best practices related to the feature
- Look up framework documentation for relevant capabilities

**Reference Collection:**
- Document all findings with specific file paths
- Include URLs to documentation and best practices
- Note team conventions from `copilot-instructions.md` or documentation

### 2. Issue Planning & Structure

**Title & Categorization:**
- Draft a clear, searchable title using conventional format (`feat:`, `fix:`, `docs:`)
- Identify appropriate labels
- Determine issue type: enhancement, bug, refactor

**Stakeholder Analysis:**
- Identify who will be affected (end users, developers, operations)
- Consider implementation complexity and required expertise

### 3. Choose Detail Level

#### 📄 MINIMAL (Quick Issue)
Best for simple bugs, small improvements. Includes problem statement, basic acceptance criteria, essential context.

#### 📋 MORE (Standard Issue)
Best for most features. Adds background, technical considerations, success metrics, dependencies, implementation suggestions.

#### 📚 A LOT (Comprehensive Issue)
Best for major features, architectural changes. Adds phased implementation plan, alternatives considered, technical specs, resource requirements, risk mitigation.

### 4. Issue Creation & Formatting
- Use clear headings with proper hierarchy
- Include code examples with syntax highlighting
- Use task lists for trackable items
- Add collapsible sections for lengthy content
- Cross-reference related issues and PRs
- Link to code using permalink format

### 5. Final Review
- Title is searchable and descriptive
- Labels accurately categorize the issue
- All template sections are complete
- Acceptance criteria are measurable
- File names are included in code examples

## Guardrails
- Do **not** start implementation — this skill only plans.
- Include ERD mermaid diagrams for model changes when applicable.
- Account for AI-accelerated development when estimating effort.
