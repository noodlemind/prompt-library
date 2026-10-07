# Enterprise Capability Overlay

Optional company registry. Install copies this folder to `~/.copilot/enterprise/`. Skills, agents, and instructions that routing loads stay in the corpus trees named below.

## Purpose

| Layer | Examples | Hydrated to |
|-------|----------|-------------|
| **Prompt library (base)** | `/java`, `/aws`, `@aws-reviewer` | `~/.copilot/` |
| **Enterprise (this folder)** | company registry, corp logging rules | `~/.copilot/enterprise/` (via `npx harness install`) |

`@engineer` reads the enterprise registry next to the base registry. Routing loads skills, agents, and instructions from `~/.copilot/skills`, `~/.copilot/agents`, `~/.copilot/instructions`, and the same three directories under `packages/harness/corpus/`.

## Layout

```text
packages/harness/corpus/enterprise/
  README.md
  capability-registry.enterprise.yaml
  capability-gaps/
  knowledge/
    solutions/
```

A skill for every install is a commit under `packages/harness/corpus/skills/<name>/SKILL.md`. An agent for every install is `packages/harness/corpus/agents/<name>.agent.md`. An instruction for every install is `packages/harness/corpus/instructions/<name>.instructions.md`. A personal primitive is `harness resources create <skill|agent|instruction> <name>` with the body on stdin.

## Adding a specialist (e.g. Splunk expert)

1. Add `packages/harness/corpus/agents/splunk-reviewer.agent.md` (judgment-criteria reviewer).
2. Register in `capability-registry.enterprise.yaml`.
3. Add `splunk-reviewer` to `engineer.agent.md` frontmatter `agents:` in the **enterprise-maintained** patch or central platform PR (Tier 3 once).
4. `npx harness upgrade`.
5. Engineer auto-delegates when tasks mention Splunk/SPL.

## Adding a domain skill (e.g. Terraform)

1. Run `/import-conventions` on your Terraform standards repo **or** add `packages/harness/corpus/skills/terraform/SKILL.md`.
2. Register in `capability-registry.enterprise.yaml`.
3. `npx harness upgrade` — engineer routes `.tf` work without users typing `/terraform`.

## Not the same as knowledge

- **Skill/agent** = how to work (procedure, review criteria).
- **Knowledge** = what we learned. Recall reads `~/.copilot/knowledge/solutions/`.

Capability lifecycle and approval remain governed by `packages/harness/corpus/knowledge/capability-registry.yaml`, `~/.copilot/skills/references/capability-gap-proposal.md`, and `/create-primitive`.
