---
name: auto-skill-draft
description: Internal — draft enterprise skill from repeated solutions (Phase G). Platform reviews before merge.
user-invocable: false
---

# Auto Skill Draft (internal)

Hermes-style: after **3+** global solutions share tags/domain, draft `enterprise/skills/<domain>/SKILL.md`.

## Trigger

`/auto-compound` or maintainer invokes when `knowledge/manifest.yaml` shows ≥3 entries with same primary tag and `scope: global`.

## Steps

1. Load matching solution paths (titles + prevention sections only)
2. Draft skill using `create-primitive/references/skill-template.md`
3. Write to `enterprise/skills/<domain>/SKILL.md` (PR branch)
4. Register in `enterprise/capability-registry.enterprise.yaml`
5. **Never** auto-create agents or change `engineer.agent.md` allowlist
6. Tier 1 notify platform in Activity / PR description

Human merges + hydrate before production routing.
