# Enterprise Capability Overlay

Optional layer for **company-specific** skills, agents, instructions, and knowledge — without forking the prompt-library.

## Purpose

| Layer | Examples | Hydrated to |
|-------|----------|-------------|
| **Prompt library (base)** | `/java`, `/aws`, `@aws-reviewer` | `~/.copilot/` |
| **Enterprise (this folder)** | `/terraform`, `@splunk-reviewer`, corp logging rules | `~/.copilot/enterprise/` (via `npx @dev-kit/harness install`) |

`@engineer` merges base + enterprise registries at intake and routes internally.

## Layout (target)

```text
enterprise/
  README.md
  capability-registry.enterprise.yaml
  skills/
    terraform/SKILL.md
    splunk-queries/SKILL.md
  agents/
    splunk-reviewer.agent.md
    terraform-reviewer.agent.md
  instructions/
    splunk.instructions.md
    terraform.instructions.md
  knowledge/
    solutions/
```

## Adding a specialist (e.g. Splunk expert)

1. Add `agents/splunk-reviewer.agent.md` (judgment-criteria reviewer).
2. Register in `capability-registry.enterprise.yaml`.
3. Add `splunk-reviewer` to `engineer.agent.md` frontmatter `agents:` in the **enterprise-maintained** patch or central platform PR (Tier 3 once).
4. `harness upgrade`.
5. Engineer auto-delegates when tasks mention Splunk/SPL.

## Adding a domain skill (e.g. Terraform)

1. Run `/import-conventions` on your Terraform standards repo **or** add `skills/terraform/SKILL.md`.
2. Register in `capability-registry.enterprise.yaml`.
3. `npx @dev-kit/harness upgrade` — engineer routes `.tf` work without users typing `/terraform`.

## Not the same as knowledge

- **Skill/agent** = how to work (procedure, review criteria).
- **Knowledge** = what we learned (solutions under `enterprise/knowledge/solutions/`).

See `docs/architecture/enterprise-capability-expansion.md`.
