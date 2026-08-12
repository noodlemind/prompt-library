# Adaptive Engineer Harness

Skill-driven AI engineering for teams on **GitHub Copilot** (VS Code / IntelliJ): one accountable entry (`@engineer`), gated delivery, and memory that compounds.

**Concept (start here):** [docs/adaptive-engineer-harness.md](docs/adaptive-engineer-harness.md)

---

## Quick start

```bash
npm install -g ./packages/harness    # or @dev-kit/harness@latest from your registry
harness install
```

1. Open a **product** repo (do not copy this library’s source into it).
2. In Copilot Chat, select **`@engineer`**.
3. Optional: `/harness-doctor`, `/project-readme`, `/triage-issues`.

---

## At a glance

```text
@engineer: Answer → direct reply
           Investigate → evidence-only report
           Deliver → orient → plan → work → verify → review → compound → report
           Review → independent code review
```

| Piece | Role |
|-------|------|
| **Skills** (25) | Reusable workflows; four user-invocable, rest engineer-internal |
| **Agents** (21) | Specialists + engineer + implementer + coordinators |
| **Kernel (`harness`)** | Orient, gate, edit/exec, verify, compound, knowledge, growth report — **never** starts an LLM on the host path |
| **Optional agent** | Opt-in headless loop (`agent.enabled`, default off) — same tools, not a second Engineer |
| **Knowledge** | Team solutions hydrated globally; product plans stay in the product repo |

User-invocable skills: `/engineer`, `/harness-doctor`, `/project-readme`, `/triage-issues`.

After a passed Deliver verify:

```bash
harness compound --plan <path>
harness report --growth
```

### Two tracks, one kernel

| Track | Use for | Success |
|-------|---------|---------|
| **Deliver** | Real product work (`@engineer` + gate/verify/compound) | Passed verify + compound/growth |
| **Autonomous** | Evals / unattended solve (`harness agent --profile autonomous`) | Task verifier green (`--verify-cmd`) |

Details: [docs/agent-loop.md](docs/agent-loop.md) · package CLI: [packages/harness/README.md](packages/harness/README.md)

---

## Layout

```text
.github/           agents, skills, instructions, hooks
knowledge/         team solutions + capability registry (hydrated globally)
docs/
  adaptive-engineer-harness.md   # practice model
  agent-loop.md                  # optional headless agent
  plans/                         # template + transient execution plans (this repo)
packages/harness/                # CLI, TUI, eval pack
AGENTS.md                        # inventory for coding agents
```

---

## Requirements

- VS Code 1.109+ with GitHub Copilot Chat, or IntelliJ with global Copilot customizations  
- Node.js 20+ for the `harness` CLI  
