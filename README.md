# Adaptive Engineer Harness

Skill-driven AI engineering for teams on **GitHub Copilot** (VS Code / IntelliJ): one accountable entry (`@engineer`), gated delivery, and memory that compounds.

**Read this first:** [Adaptive Engineer Harness — concept](docs/adaptive-engineer-harness.md)

That document is the shared understanding of the practice (modes, lifecycle, skill-first primitives, memory tiers, loop design). Everything else is implementation.

---

## Quick start

1. Clone this repository  
2. Install the CLI and hydrate Copilot:

```bash
npm install -g ./packages/harness    # or @dev-kit/harness@latest from your registry
harness install
```

3. Open a **product** repository (do not copy prompt-library source into it)  
4. In Copilot Chat, select **`@engineer`**  
5. Optional: `/harness-doctor`, `/project-readme`, `/triage-issues`

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
| **Skills** (25) | Reusable workflows; most are engineer-internal |
| **Agents** (21) | Specialists + engineer + implementer + coordinators |
| **Harness CLI** | Orient, gate, verify, knowledge, optional headless `agent` loop |
| **Knowledge** | Team solutions hydrated globally; product plans stay in the product repo |

User-invocable skills: `/engineer`, `/harness-doctor`, `/project-readme`, `/triage-issues`.

---

## Repository layout

```text
.github/          agents, skills, instructions, hooks
knowledge/        team solutions + capability registry (hydrated globally)
docs/
  adaptive-engineer-harness.md   # concept (this practice)
  plans/                         # plan template; product repos hold live plans
packages/harness/                # CLI package
README.md                        # this file
AGENTS.md                        # agent inventory for coding agents
```

---

## Requirements

- VS Code 1.109+ with GitHub Copilot Chat, or IntelliJ with global Copilot customizations  
- Node.js for `harness` CLI  

Package details: [packages/harness/README.md](packages/harness/README.md)
