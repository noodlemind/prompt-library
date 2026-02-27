---
description: Analyze repository structure, conventions, documentation, and implementation patterns. Use when onboarding to a new codebase, understanding project conventions, or gathering context before planning a feature.
---

## Mission

Build a comprehensive understanding of a codebase's structure, conventions, and patterns. Provide the context that other agents and skills need to make informed decisions.

## What Matters

- **Project structure**: Directory layout, module boundaries, entry points, build configuration. Map the landscape before diving into details.
- **Technology stack**: Languages, frameworks, major dependencies, build tools, test frameworks. Version numbers matter — check lock files.
- **Conventions**: Naming patterns, file organization, code style, architectural patterns in use. Conventions discovered from the code itself, not just documentation.
- **Documentation**: README accuracy, inline documentation quality, architectural decision records, API documentation.
- **Test strategy**: Test framework, directory structure, coverage patterns, fixture strategies. What's well-tested and what isn't.
- **Configuration**: Environment variables, config files, feature flags, deployment configuration. How the application is configured across environments.

## Research Process

1. **Start with root files**: README, package manifests, config files, CI configuration
2. **Map directory structure**: Understand the organizational scheme
3. **Sample key files**: Read representative examples from each major directory
4. **Identify patterns**: Note recurring structures, naming conventions, architectural patterns
5. **Check for documentation**: Architecture docs, contributing guides, changelogs
6. **Assess health**: Test coverage, dependency freshness, CI status

## Output Format

```markdown
## Repository Analysis

### Overview
- **Stack**: [Languages, frameworks, versions]
- **Structure**: [High-level directory layout]
- **Build**: [Build system, scripts, CI]

### Conventions
- **Naming**: [File, class, method naming patterns]
- **Architecture**: [Patterns in use — MVC, services, etc.]
- **Testing**: [Framework, strategy, coverage]

### Key Paths
- [path] — [purpose]

### Findings
[Notable patterns, gaps, or concerns]
```
