# Adaptive Engineer Harness

Skill-driven AI engineering for teams on **GitHub Copilot** in VS Code and IntelliJ: one accountable entry, deterministic delivery gates, and memory that earns trust.

**Adaptive Engineering** varies the process with the task while keeping the delivery bar fixed:

> **Mode before action. Intent before mutation. Evidence before done. Learning after proof.**

The model may be stochastic; acceptance is not. Every product change is constrained by an explicit scope and trusted checks, then verified against the current workspace. Reusable lessons retain provenance and cannot promote themselves into team behavior.

**Start with the [Adaptive Engineering primer](docs/adaptive-engineering-primer.md)** (concept, delivery, token bounds, and how a Harness plan differs from Spec Kit / BMAD). The operational contract is the [practice model](docs/adaptive-engineer-harness.md).

---

## Why teams use it

| Outcome | How the Harness supports it |
|---------|-----------------------------|
| **Predictable delivery** | A locked intent contract, stable gate semantics, named repository checks, and fresh `passed`, `failed`, or `inconclusive` evidence |
| **Surgical changes** | Bounded context, explicit impacted files, pre-mutation authorization, scope verification, and re-gating whenever the plan changes |
| **Safe adaptation** | Task modes scale ceremony; skills and specialists load on demand; promotion requires verified evidence or explicit human authority |

Adaptive Engineering complements specification, agile planning, graph orchestration, and memory systems. Its specific job is to govern the code-change boundary: who may mutate, what is in scope, what proves success, and what the team is allowed to learn from the result.

## Quick start

```bash
npm install -g @dev-kit/harness@latest  # or ./packages/harness from this clone
harness tui                           # first launch hydrates VS Code + CLI assets
```

1. Open a **product** repo; do not copy this library’s source into it.
2. Use **Initialize this repo** in the TUI palette when Harness scaffolding is absent.
3. If you use VS Code, reload it after first hydration; then select **`@engineer`** in Copilot Chat.
4. Optional direct commands: `/harness-doctor`, `/project-readme`, `/triage-issues`.

For explicit or non-TUI setup, run `harness install --configure-vscode`. Full setup and CI reference: [packages/harness/README.md](packages/harness/README.md).

## At a glance

```text
@engineer: Answer      → direct, read-only reply
           Investigate → evidence-backed, read-only report
           Deliver     → orient → lock intent → gate → work → verify → review → compound → report
           Review      → independent assessment
```

| Piece | Role |
|-------|------|
| **Skills** (25) | Reusable workflows; four user-invocable, the rest loaded by the Engineer when relevant |
| **Agents** (21) | Accountable Engineer, implementation and review coordinators, and bounded specialists |
| **Kernel (`harness`)** | Deterministic orient, gate, edit, exec, verify, compound, knowledge, and reporting |
| **Session Ledger (`harness tui`)** | Human-facing projection of the same kernel; not a second Engineer |
| **Optional agent** | Opt-in headless loop (`agent.enabled`, default off); not the normal delivery runtime |
| **Knowledge** | Team episodes, local governed learnings, and human-reviewed behavioral promotion |

User-invocable skills: `/engineer`, `/harness-doctor`, `/project-readme`, `/triage-issues`.

After a passed Deliver verification:

```bash
harness compound --plan <path>
harness report --growth
```

### Two tracks, one kernel

| Track | Use for | Success |
|-------|---------|---------|
| **Deliver** | Real product work (`@engineer` plus gate, verify, review, and compound) | Fresh passed evidence and an auditable handoff |
| **Autonomous** | Evals or deliberately unattended tasks | Task verifier green (`--verify-cmd`) within budget |

Details: [docs/agent-loop.md](docs/agent-loop.md) · package CLI: [packages/harness/README.md](packages/harness/README.md)

---

## Layout

```text
.github/           agents, skills, instructions, hooks
knowledge/         team solution episodes + capability registry
docs/
  adaptive-engineering-primer.md # Adaptive Engineering primer: concept, delivery, tokens, SDD/BMAD
  adaptive-engineer-harness.md   # practice model and method comparison
  agent-loop.md                  # optional headless agent
  plans/                         # template + transient execution plans for this repo
packages/harness/                # deterministic CLI, TUI, bridge, and eval pack
AGENTS.md                        # inventory and conventions for coding agents
```

## Requirements

- VS Code 1.109+ with GitHub Copilot Chat, or IntelliJ with global Copilot customizations
- Node.js 20+ for the `harness` CLI
