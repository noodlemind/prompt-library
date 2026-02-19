---
name: work-on-task
description: >
  Analyze a work document (plan, specification, or structured document), create
  a comprehensive task breakdown, and systematically execute each task until
  completion. Use when the user wants to implement a planned feature, work
  through a specification, or execute a development plan step by step.
---

# Work on Task Skill

## When to Use
Activate when the user wants to:
- Implement a planned feature from a specification or plan document
- Work through a development plan step by step
- Execute a structured task list with quality checks
- Convert a plan into working code with tests

## User Preferences
Before implementation, resolve the user's Profile:
1. Check for `.github/copilot-preferences.yml` or `.vscode/copilot-preferences.yml` in the workspace.
2. Apply the resolved Profile's conventions for coding style, testing, logging, and workflow.

## Prerequisites
- A work document to analyze (plan file, specification, or structured document)
- Clear understanding of project context and goals
- Git repository with main branch

## Workflow

### Phase 1: Environment Setup
1. Ensure main branch is up to date
2. Create feature branch with descriptive name
3. Set up worktree for isolated development (optional)
4. Verify environment with initial test run

### Phase 2: Document Analysis and Planning
1. **Read Input Document** — identify deliverables, requirements, constraints, and success criteria
2. **Create Task Breakdown** — convert requirements into specific tasks with implementation details, testing steps, and edge case handling
3. **Build Todo List** — set priorities based on dependencies, include subtasks and checkpoints

### Phase 3: Systematic Execution
1. **Task Execution Loop**:
   - Select next task by priority and dependencies
   - Execute task completely
   - Validate completion (tests, lint, typecheck)
   - Mark as completed and update progress
2. **Quality Assurance** — run tests after each task, verify no regressions, check against acceptance criteria
3. **Progress Tracking** — update task status, note blockers, create tasks for discoveries

### Phase 4: Completion and Submission
1. **Final Validation** — verify all tasks completed, run comprehensive test suite, check all deliverables
2. **Prepare Submission** — stage and commit changes, write commit messages, push feature branch
3. **Create Pull Request** with detailed description

## Guardrails
- Never skip the planning phase — always analyze before coding.
- Run tests after every meaningful change.
- Follow the resolved Profile's coding conventions.
- If blocked, document the blocker and move to the next unblocked task.
