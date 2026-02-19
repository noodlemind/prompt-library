---
name: user-preferences
description: >
  Resolve and apply user custom preferences for coding style, tooling, and
  workflow conventions. Use when the user wants to configure preferences,
  when other skills need to load user-specific settings, or when setting up
  a new workspace with custom conventions.
---

# User Preferences Skill

## When to Use
Activate when the user wants to:
- Set up or update their coding preferences for the workspace
- Configure custom conventions for logging, testing, or style
- Create or edit a preferences file
- Understand what preferences are currently active

This skill is also invoked internally by other skills to resolve the user's Profile before performing work.

## Preference Resolution Order (highest priority first)

1. **Workspace-level**: `.vscode/copilot-preferences.yml`
2. **Project-level**: `.github/copilot-preferences.yml`
3. **Policy packs**: `policy/packs/*.yml` (merged in alphabetical order)
4. **Module overrides**: `policy/modules/*.yml` (per-module settings that override packs)
5. **Defaults**: built-in sensible defaults (below)

Higher-priority sources override lower-priority ones. Within the same level, later files override earlier ones.

## Preference Schema

```yaml
# .github/copilot-preferences.yml (example)

# Coding style
style:
  language: typescript          # Primary language
  indent: 2                     # Spaces per indent
  quotes: single                # single | double
  semicolons: true              # Trailing semicolons
  max_line_length: 100

# Testing conventions
testing:
  framework: jest               # jest | mocha | pytest | rspec | go-test | ...
  coverage_threshold: 80        # Minimum coverage percentage
  test_location: colocated      # colocated | separate (__tests__/) | mirror (test/)

# Logging conventions
logging:
  library: pino                 # pino | winston | slf4j | logging | slog | ...
  level: info                   # Default log level
  format: json                  # json | text
  no_secrets: true              # Enforce no secrets in logs

# Observability
observability:
  metrics: true                 # Add metrics to critical paths
  tracing: true                 # Add tracing spans
  library: opentelemetry        # opentelemetry | datadog | ...

# Guardrails
guardrails:
  max_diff_lines: 400           # Advisory max lines changed per phase
  require_plan_lock: true       # Require locked plan before implementation
  require_tests: true           # Require tests for all changes
  block_generated_files: true   # Block edits to generated files

# Issue workflow
issues:
  template: docs/LOCAL_ISSUE_TEMPLATE.md
  location: local_issues/
  require_dor: true             # Enforce Definition of Ready
  require_dod: true             # Enforce Definition of Done
```

## Steps

### When Creating Preferences
1. Ask the user about their preferred language, test framework, logging library, and coding style.
2. Create `.github/copilot-preferences.yml` with their choices.
3. Print a summary of the configured preferences.

### When Resolving Preferences (for other skills)
1. Check each location in the resolution order above.
2. Merge preferences, with higher-priority sources winning conflicts.
3. Return the resolved Profile as a structured object.
4. If no preferences files exist, use built-in defaults:
   - `max_diff_lines: 400`
   - `require_plan_lock: true`
   - `require_tests: true`
   - `block_generated_files: true`
   - `no_secrets: true`

### When Displaying Current Preferences
1. Resolve all preference sources.
2. Print the merged result showing which source each value came from.
3. Highlight any conflicts between levels.

## Guardrails
- Do **not** call CLIs or the network.
- Do **not** override explicit user choices with defaults.
- If a preference file has syntax errors, report them and fall back to defaults for that source.
