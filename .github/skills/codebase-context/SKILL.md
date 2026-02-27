---
name: codebase-context
description: Gather and summarize workspace context including project structure, technology stack, conventions, and key file locations. Use when starting work on an unfamiliar codebase or when agents need project context to make informed decisions.
user-invokable: false
---

# Codebase Context

## Purpose

This is a background knowledge skill. It's not invoked directly by users — it's referenced by other skills and agents when they need workspace context.

## What to Gather

When activated, build a context summary covering:

### Project Identity
- Repository name and purpose (from README)
- Technology stack (from package manifests and lock files)
- Framework versions (from lock files, not manifests)
- Build system and scripts

### Structure
- Top-level directory layout and purpose of each directory
- Entry points (main files, config, routes)
- Test directory structure and framework

### Conventions
- Naming patterns (files, classes, methods, variables)
- Architectural patterns in use (MVC, services, etc.)
- Error handling patterns
- Logging patterns

### Configuration
- Environment variables in use
- Config file locations
- CI/CD pipeline structure

### Accumulated Knowledge
- Read `.github/agent-context.md` for previously discovered patterns
- Read `docs/solutions/` index for documented learnings

## Output Format

```markdown
## Workspace Context

### Stack
[Language] [Framework] [Version] — [Build tool]

### Key Paths
- `path/` — [purpose]

### Conventions
- [Convention 1]
- [Convention 2]

### Accumulated Knowledge
[Summary from agent-context.md and docs/solutions/]
```

## Guardrails

- Read-only. Do not modify any files.
- Focus on facts discoverable from the codebase, not assumptions.
- Keep the summary under 200 lines — this will be injected into agent context.
