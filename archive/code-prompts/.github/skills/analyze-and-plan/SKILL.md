---
name: analyze-and-plan
description: >
  Analyze a local issue, validate Definition of Ready, and produce a concrete
  phased plan with tests, risks, and invariants. Use when the user wants to
  plan implementation for an issue, create a step-by-step implementation plan,
  or prepare an issue for development work.
---

# Analyze and Plan Skill

## When to Use
Activate when the user wants to:
- Analyze an existing issue and create an implementation plan
- Validate that an issue is ready for development (DoR check)
- Break down a feature or fix into phased, actionable steps
- Identify impacted files, risks, and test strategies

## User Preferences
Before planning, resolve the user's Profile:
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` in the workspace.
2. Load policy packs from `policy/packs/*.yml` and overrides from `policy/module-policy.yml` or `policy/modules/*.yml` if they exist.
3. Apply the resolved Profile's conventions for logging, testing, observability, and coding style.

## Inputs
- Path to the issue file, or the issue open in the editor via `#file`.
- Use `#file`/`#selection` primarily; expand to `@workspace` only to find impacted modules.

## Steps

1. **Validate DoR**
   - Check the issue has: Overview, Quick Context & Summary, Acceptance Criteria, and Steps to Reproduce or Expected vs Actual (for bugs).
   - Verify Technical Notes subsections: Implementation Approach, Key Considerations, Investigation Areas, Diagnostic Steps, Dependencies/Blockers.
   - If anything is missing, patch the issue → set `status: needs-info` and add ONE question in `## Missing`; **stop**.

2. **Identify Impacted Files and Invariants**
   - Search the workspace for files and modules affected by the planned changes.
   - Document invariants (conditions that must remain true after changes).

3. **Write the Plan**
   - Write or replace `## Plan` in the issue file with 3–8 steps.
   - Each step should be tagged with `phase:<n>` for phased execution.
   - Focus on minimal diffs with rollback strategy.
   - Write or replace `## Impacted Files` listing all paths to be touched.

4. **Update Technical Notes**
   - Refresh Implementation Approach, Key Considerations, and Dependencies to reflect the current understanding.

5. **Propose Tests**
   - List file paths and test case names for each plan step.
   - If the test framework is unknown, create framework-agnostic test outlines (TODOs).

6. **Security and Performance Notes**
   - Note OWASP-class risks relevant to the changes.
   - Identify big-O complexity and memory hotspots.

7. **Lock the Plan**
   - Set `status: in-progress` in the issue front-matter.
   - Set `plan_lock: true`.
   - Create or update `_artifacts/plan.json` with `allowed_paths` matching `## Impacted Files`.
   - Append a timestamped entry under `## Activity` summarizing the plan.

8. **Print Change Summary**
   - List all files created or modified.

## Guardrails
- Do **not** write implementation code. This skill only plans.
- Do **not** call CLIs or the network.
- If the issue is in `status: brainstorm` with `plan_lock: false`, produce Alternatives and Open Questions but do **not** lock the plan.
