---
name: edd-experiment
description: >
  Run an Experiment-Driven Development workflow with iterative attempts and
  learnings. Use when the user wants to try multiple approaches to solve a
  problem, document experiments, or iterate on a solution with structured
  logging of what was tried and what was learned.
---

# EDD Experiment Skill

## When to Use
Activate when the user wants to:
- Try multiple approaches to solve a tricky problem
- Document experimental iterations with structured learnings
- Run an experiment-driven development workflow

## User Preferences
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` for custom experiment conventions.

## Steps

1. Create or update `experiments/YYYY-MM-DD-<slug>.md`.
2. For each attempt:
   - **PLAN** → what will be tried and why
   - **Patch** (diff) → the code change
   - **Verify** (commands or TODOs) → how to validate
   - **Result** → what happened
   - **Learnings** → what was learned
   - **Next Step** → what to try next
3. Stop after two failed attempts without new info; add **one** question to the issue's `## Missing` and stop.
4. **Print a change summary**.

## Guardrails
- Do **not** call CLIs or the network.
- Document every attempt — never silently discard a failed experiment.
- Stop early if stuck rather than repeating the same approach.
