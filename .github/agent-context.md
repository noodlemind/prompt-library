# Agent Context

This file contains accumulated knowledge about the codebase, discovered by agents over time. Read this at the start of any session.

## Project Structure

This repository is a skill-driven prompt library containing AI agent systems:
- `.github/agents/` — 21 agents (17 specialists + 1 engineer + 1 implementer + 2 coordinators, judgment-criteria style)
- `.github/skills/` — 25 skills including internal planning (`ensure-plan`), on-demand gap resolution (`ensure-capability`), verified learning (`auto-compound`), and knowledge consolidation (`consolidate`)
- `enterprise/` — optional corp overlay (skills, agents, capability-gaps) hydrated to `~/.copilot/enterprise/`
- `harness index` — deterministic manifest rebuild (replaces manual index steps; `@dev-kit/harness` is only the npm package name)
- `docs/onboarding/harness-quickstart.md` — enterprise onboarding
- `knowledge/` — team-wide solutions and manifest (hydrated to `~/.copilot/knowledge/`), primitive creation, domain workflows, README maintenance, quick Q&A, and utilities
- `.github/instructions/` — scoped instructions (TypeScript, Python, Java, PostgreSQL); Spring Boot and AWS SDK guidance live as on-demand skill references under `.github/skills/java/` and `.github/skills/aws/`
- `.github/skills/code-review/references/checks/` — bundled review checks discovered by `/code-review`
- `.github/checks/` — optional product-specific review check examples
- `docs/plans/` — issue and plan files with state machine tracking
- `docs/architecture/` — canonical Engineer Harness architecture and primitive standard
- `knowledge/solutions/` — team-wide compounded learnings (hydrated to `~/.copilot/knowledge/`); product repos may use optional `docs/solutions/` for repo-private learnings only
- `docs/brainstorms/` — brainstorm documents from `/brainstorming` skill

## Conventions

- Agents use judgment-criteria design (define outcomes, not procedures)
- Skills are the primary reusable contract. Default repeated procedures, checklists, generators, and workflow guidance to skills; create agents only for separate judgment, authority, isolation, runtime profile, or accountability.
- Agents are classified as reviewers (read-only), researchers, actors (can modify code), engineers (full-cycle: modify code + delegate to subagents), or coordinators/navigation.
- Agent tools follow generous-but-meaningful permissions: reviewers get `codebase`, `search`, `read`, `usages`, `changes`, `problems`, `terminalLastCommand` (no editFiles); researchers get `codebase`, `search`, `read`, `fetch`, `problems`, `terminalLastCommand`; actors get tools matching their responsibilities plus `codebase`, `problems`, `usages`, `terminalLastCommand`; coordinators get `agent`, `codebase`, `problems` plus their operational tools; engineer has a broad but explicit tool allowlist, not wildcard access.
- Leaf-node agents set `user-invocable: false` to keep the `@` menu focused and `agents: []` to prevent accidental subagent spawning. Treat `user-invocable` as discovery/UX, not a security boundary.
- Coordinators and the engineer define `agents:` allowlists restricting which specialists they can invoke
- Coordinators dispatch subagents in parallel batches (3-4 at a time) rather than sequentially
- All review agents include prompt injection guardrails (Guardrails section before Mission)
- Skills follow progressive disclosure (frontmatter → body → references)
- The connected pipeline: `/brainstorming` (optional) → `/capture-issue` → `/plan-issue` → `/deepen-plan` (optional) → `@engineer` Deliver mode → `/code-review` → `/compound-learnings`. `@engineer` Answer mode covers quick Q&A outside the pipeline. `/project-readme` is documentation maintenance outside implementation planning. `/create-primitive` is the canonical primitive creator for skills, agents, instructions, checks, references, and solution docs. `/java`, `/python`, `/sql`, and `/aws` are reusable domain workflow skills that pair with scoped instructions and specialist reviewers.
- State machine: `status` (open/planned/in-progress/review/done/blocked-capability), `plan_lock`, `phase`, `domains`, `capability_gaps`
- `@engineer` owns the sole normative nine-step delivery lifecycle in `engineer.agent.md`; quick Answer and read-only Investigate modes stay outside it, skills load on demand, and users are not asked to run internal support steps manually
- Activity logs in plan files provide session continuity
- Plan files are the local context pack. Standard sections include `## Context`, `## Acceptance Criteria`, `## Research Notes`, `## Impacted Files`, `## Verification Plan`, `## Risk & Review Routing`, `## Implementation Notes`, `## Review Findings`, and `## Activity`.

## Technology Notes

_This section grows as agents discover patterns. Add notes here when you learn something about the codebase that future sessions should know._

### Subagent Tool Restrictions
When agents run as subagents (dispatched by coordinators), VS Code may restrict tool access even if the tool is in the agent's `tools:` array. Terminal and editor tools are most commonly restricted. Agents should check tool availability at execution time and use fallbacks from the cross-environment compatibility table in copilot-instructions.md. Extension-provided diagnostics (SonarQube, ESLint, Checkstyle) are accessed via the `problems` tool, not as individual named tools — they contribute to workspace diagnostics, not the tool registry.

### Codebase Snapshot
`docs/codebase-snapshot.md` is a point-in-time snapshot of the project structure, conventions, and architecture diagrams (Mermaid). Generated by `/codebase-context`. Fully replaced on each invocation — not append-only. Distinct from `agent-context.md`: the snapshot captures project structure and diagrams, while agent-context captures patterns discovered during agent work sessions. Refresh the snapshot by running `/codebase-context` when the codebase changes significantly.

### Code Review Branch Diffs
The code review coordinator uses `terminalLastCommand` to read branch diffs. When reviewing a feature branch, ask the user to run `git diff <base>...<branch> -- . ':!*.lock'` in the terminal, then read the output via `terminalLastCommand`. This works regardless of hosting provider (GitHub, GitLab, etc.) and captures the full diff without relying on the `changes` tool (which only shows uncommitted modifications).

### Intelligent Intake Routing
`@engineer` mode selection (Answer / Investigate / Review / Deliver) is the intake router: the Engineer classifies each incoming request, checks for existing plans/brainstorms, and picks the mode or pipeline skill that fits. Engineer handoffs cover pipeline transitions — both "where am I?" and "where should I begin?" resolve through the Engineer rather than a dedicated routing skill.

### Confidence-Gated Code Review
The `/code-review` skill uses persona-based review with structured JSON findings. Each persona returns findings with severity (P1-P3) and confidence (0.0-1.0). Synthesis: validate → confidence-gate (0.60 threshold, P1@0.50+ exception) → dedup (fingerprint on file+line+title) → cross-persona boost (+0.10 when 2+ agree) → route by autofix_class (safe_auto/gated_auto/manual/advisory). Persona definitions in `references/review-personas.md`, output schema in `references/findings-schema.md`. Quality gates verify actionability, accuracy, and calibration before delivery.

### Document Review as Quality Gate
The `/document-review` skill uses 4 personas (design, scope, coherence, feasibility) with per-document-type criteria. Available between brainstorm→plan and plan→work as a quality gate. Evaluation criteria in `references/review-criteria.md`. P1 findings block proceeding; P2/P3 auto-applied in non-interactive mode.

### Explicit execution boundary
`@engineer` Deliver mode executes or resumes locked plans and owns ordinary end-to-end work, while planning, review, and compounding retain their dedicated procedures.

### Verification Before Completion
`@engineer` Deliver mode runs evidence-based verification before claiming completion: tests pass (actual output reported), files match plan scope, all phase tasks checked, clean working state. Verification results logged in activity entries. Failed verification blocks completion claims.

### Skill-Specific Error Recovery
Four orchestrating skills (code-review, plan-issue, deepen-plan, engineer) have error handling specific to their failure modes. Common patterns (subagent failure, tool unavailability, file not found, timeout) are in `.github/skills/references/error-handling-patterns.md`. Each skill references shared patterns plus adds domain-specific errors.

### Solution Document Format
`/compound-learnings` publishes to **`knowledge/solutions/<category>/<slug>.md`** (global, cross-repo after hydrate). Template: `assets/solution-template.md`. Then **required** `/index-memory`. Repo-private copies optional under product `docs/solutions/`. Tags: specific ("n-plus-one", "java-21"), 3-7 per doc.

### Knowledge Lookup SSOT
`.github/skills/references/knowledge-locations.md` — single list of read/write paths; do not duplicate in other primitives.

### Engineer Agent
Thin accountable orchestrator within a 600–900 estimated-token frozen budget. It classifies Answer, Investigate, Deliver, or Review; its nine-step delivery lifecycle is the only normative change-making sequence. Context caps: `context-budget.md`; architecture: `docs/architecture/engineer-harness.md`. Entry: `@engineer` or `/engineer`.

### Engineer Memory System
Canonical model: `docs/MEMORY-MODEL.md` — three tiers, each with a single writer. T1 episodic ground truth (`docs/solutions/` + global solutions, plans, activity logs) is written by `/auto-compound` (verified fixes), `compound --insight`, and `harness remember` (human teachings). `/consolidate` clusters T1 episodes into the T2 learnings store at `~/.harness/knowledge/<repo-id>/` (CLI-managed local git repo outside the working tree; `harness consolidate --apply` is the sole writer of learning content, and direct human hand edits are absorbed with `source: human` provenance). Human retire/dispute/confirm/promote decisions persist in the governance ledger and are mechanically reapplied across rebuilds; `orient` injects the top-matching learnings into the context pack. T3 is behavior: `.github/` primitives via `/create-primitive` + human PR. `/recall` runs before investigate; `/compound-learnings` publishes globally; `/index-memory` rebuilds `manifest.yaml`. Capture gate: `.github/skills/references/capture-gate.md`.

### Adaptive Engineer Harness
`@engineer` is the central coordinator for adaptive capability expansion. It routes to known skills first, uses `.github/skills/references/subagent-context-packet.md` for delegated work, and uses `.github/skills/references/human-approval-policy.md` before risky strategy choices. Missing reusable capability must be documented with `.github/skills/references/capability-gap-proposal.md` and then routed to `/create-primitive` after human approval. Architecture details live in `docs/architecture/engineer-harness.md`.

### Skill-Driven Standardization
`docs/architecture/skill-driven-prompt-library.md` defines primitive boundaries for teams adapting this repo. Workflows live in skills, long criteria and library-managed checks go in skill `references/`, product-owned review overlays can live in product `.github/checks/`, file-scoped conventions go in `.github/instructions/`, and solution docs graduate to `agent-context.md` only when they capture durable project-level knowledge.
