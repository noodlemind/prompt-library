---
name: code-review
description: >
  Perform comprehensive multi-agent code reviews covering security, performance,
  architecture, and quality assurance. Use when reviewing pull requests,
  uncommitted changes, specific files, or comparing branches. Coordinates
  specialized agents for deep analysis across multiple dimensions.
---

# Code Review Skill

## When to Use
Activate when the user wants to:
- Review a pull request or set of code changes
- Get a multi-perspective analysis of code quality
- Audit code for security, performance, or architecture concerns
- Compare branches or review specific files

## User Preferences
Before reviewing, resolve the user's Profile:
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` in the workspace.
2. Apply any custom review conventions, severity thresholds, or focus areas.
3. For the full resolution order (including policy packs), see the `user-preferences` skill.

## Workflow

### 1. Understand the Request
Determine what needs to be reviewed:
- **Pull Request**: Analyze a specific PR by number or URL
- **Current Changes**: Review uncommitted changes in the workspace
- **File or Directory**: Review specific files or directories
- **Branch Comparison**: Compare two branches

### 2. Gather Context
- Fetch PR details if reviewing a pull request
- Read modified files and understand changes
- Detect project type (Rails, TypeScript, Python, etc.)
- Review related code and dependencies

### 3. Detect Project Type
Identify the project type to tailor the review:
- **Rails**: `Gemfile` with rails gem, `config/application.rb`, `app/` structure
- **TypeScript**: `tsconfig.json`, `.ts`/`.tsx` files
- **Python**: `requirements.txt`/`pyproject.toml`, `.py` files

### 4. Multi-Agent Analysis
Coordinate specialized analysis perspectives:

**Always Engaged**:
- Architecture analysis — system design and architectural patterns
- Security audit — vulnerabilities and security risks
- Performance review — characteristics and optimization
- Code simplicity — clarity and simplification opportunities
- Pattern analysis — design patterns and consistency
- Data integrity — database operations and data integrity

**Language-Specific** (invoke when applicable):
- Rails projects: Rails reviewer and DHH philosophy reviewer
- TypeScript projects: TypeScript reviewer
- Python projects: Python reviewer

### 5. Review Perspectives

**Technical Excellence**: Code quality, best practices, test coverage, documentation
**Security**: Input validation, auth, data protection, OWASP Top 10
**Performance**: Algorithmic complexity, query optimization, caching, scalability
**Architecture**: Component boundaries, pattern consistency, dependency management
**Maintainability**: Readability, simplicity, error handling, observability

### 6. Categorize Findings

**Severity Levels**:
- 🔴 **CRITICAL (P1)**: Security vulnerabilities, data loss risks, breaking changes
- 🟡 **IMPORTANT (P2)**: Performance issues, architectural concerns, significant bugs
- 🔵 **NICE-TO-HAVE (P3)**: Code quality improvements, minor optimizations

### 7. Output Format

```markdown
# Code Review Summary

## Overview
[Brief summary of what was reviewed]

## Project Type
[Rails/TypeScript/Python/etc.]

## Key Findings

### 🔴 Critical Issues (P1)
1. **[Issue Title]** - `file:line`
   - Problem: [Description]
   - Impact: [Why critical]
   - Solution: [How to fix]

### 🟡 Important Issues (P2)
...

### 🔵 Suggestions (P3)
...

## Agent Insights
[Summaries from each analysis perspective]

## Overall Assessment
**Risk Level**: [Low/Medium/High]
**Recommended Action**: [Approve / Approve with changes / Request changes]

## Next Steps
1. [Immediate action items]
2. [Follow-up tasks]
```

## Guardrails
- Be specific: reference exact file paths and line numbers.
- Be constructive: focus on improvements, not criticism.
- Prioritize: highlight the most important issues first.
- Suggest solutions: don't just identify problems, propose fixes.
