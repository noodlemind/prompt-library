---
title: "[Descriptive title: problem and solution]"
date: YYYY-MM-DD
category: [performance-issues|security-issues|build-errors|configuration-fixes|<new-category>]
tags: [specific, technology, tags]
module: [affected module or area]
symptom: "[What the developer observed]"
root_cause: "[Technical root cause — one sentence]"
severity: [low|medium|high|critical]
---

## Problem
[Detailed description of what went wrong. Include error messages, unexpected behavior, or symptoms that led to investigation.]

## Root Cause
[Technical explanation of why it happened. Include the chain of causation, not just the proximate cause.]

## Solution
[What was done to fix it. Include code snippets, configuration changes, or architectural decisions where helpful.]

## Prevention
[How to avoid this in the future. Could be: tests to add, linting rules, conventions to follow, monitoring to set up.]

---

## Tagging Guidelines

Tags should be specific enough to match future searches. They are how agents and developers find relevant solutions when encountering similar problems.

- Use specific technology terms, not generic categories: "n-plus-one", "rails-7", "sidekiq-retry" — NOT just "performance" or "ruby"
- Include the technology/framework version when the solution is version-specific (e.g., "rails-7", "node-20", "typescript-5.3")
- Include the symptom category (e.g., "timeout", "memory-leak", "race-condition", "flaky-test")
- Aim for 3-7 tags per solution document

## Examples

**Good tags:**
```yaml
tags: [n-plus-one, rails-7, activerecord, eager-loading, api-endpoint]
tags: [memory-leak, node-20, event-listener, heap-snapshot, websocket]
tags: [race-condition, sidekiq-7, redis-lock, duplicate-job, idempotency]
```

**Bad tags:**
```yaml
tags: [performance, database, fix]
tags: [bug, ruby, solved]
tags: [error]
```
