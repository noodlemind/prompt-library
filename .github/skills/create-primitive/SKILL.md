---
name: create-primitive
description: "Decide and create the right prompt-library primitive: skill, agent, instruction, check, prompt wrapper, reference, or solution doc. Not for importing external repos — use /import-conventions."
---

# Create Primitive

## Pipeline Role

Canonical primitive creator and maintainer for this prompt library. Use it to keep the library skill-driven: skills hold reusable workflows, agents hold isolated roles, instructions hold scoped conventions, prompt wrappers route to skills, checks hold narrow review criteria, references hold dense supporting material, and solution docs hold verified learnings.

## When to Use

- Creating a new agent (`.github/agents/*.agent.md`)
- Creating a new skill (`.github/skills/*/SKILL.md`)
- Creating a new scoped instruction (`.github/instructions/*.instructions.md`)
- Creating a new review check (bundled under `.github/skills/code-review/references/checks/*.md` or product-owned `.github/checks/*.md`) or thin prompt wrapper (`.github/prompts/*.prompt.md`)
- Creating or moving dense supporting material into skill `references/` or `assets/`
- Creating or updating a team solution under `knowledge/solutions/` (global) or product `docs/solutions/` (repo-private)
- Modifying any prompt-library primitive
- Understanding which primitive type should exist

## Trigger Examples

**Should trigger:**
- "Create a new agent"
- "Build a new skill"
- "Add a Java instruction file"
- "Add a review check for Sonar complexity issues"
- "Where should this new convention live?"
- "How do I write a prompt-library primitive?"

**Should not trigger:**
- "Import conventions from a repo" → use /import-conventions
- "Review my code" → use /code-review
- "Plan a feature" → use /plan-issue

## Primitive Decision Rules

Read `docs/architecture/skill-driven-prompt-library.md` before creating or substantially changing primitives.

Default to a **skill** only when the request is a reusable workflow. Do not create any artifact before classifying the primitive:

| Question | If yes, create |
|---|---|
| Is this a repeated workflow, checklist, generator, reviewer protocol, or pipeline step? | Skill |
| Does it need separate judgment, tool authority, isolation, runtime profile, or accountability? | Agent |
| Should it load automatically for matching file patterns? | Instruction |
| Is it a host-facing slash command wrapper for an existing skill? | Prompt wrapper |
| Is it a narrow review-time rule? | Review check |
| Is it dense examples, schema, checklist detail, or a template used only by one skill? | Reference or asset under the owning skill |
| Is it a verified learning from completed work? | Solution doc |

Do not create a new agent just to store reference material. Put long criteria in `references/`, team conventions in scoped instructions, bundled review rules under the owning skill's references, and product-specific review rules in product `.github/checks/`.

### Host Mapping

This repository is host-neutral source material, but the current primary consumption target is GitHub Copilot in VS Code and IntelliJ IDEA:

| Prompt-library primitive | Host-native status |
|---|---|
| Agent | Native in VS Code Copilot custom agents; native in current JetBrains Copilot custom agents when global customizations are enabled |
| Skill | Native in Copilot Agent Skills where available; hydrated globally for both VS Code and IntelliJ IDEA |
| Instruction | Native as Copilot custom instructions / instruction files |
| Prompt wrapper | Native prompt file / slash command adapter where supported by the host |
| Review check | Prompt-library-native; consumed by `/code-review`, not a universal Copilot primitive |
| Reference/asset | Prompt-library-native progressive disclosure material |
| Solution doc | Product-repo knowledge artifact, not a global prompt customization |

Do not claim feature parity across hosts. When a host lacks a primitive, document the fallback behavior.

## Creator Workflow

Changes under `.github/skills/`, `.github/agents/`, `.github/instructions/`, `.github/prompts/`, `.github/checks/`, `knowledge/capability-registry.yaml`, or `enterprise/skills/` are governed primitive work. Before editing, use this sequence: classify primitive → check overlap → decide minimal artifact structure → record the change rationale and, before creating or substantially expanding a skill, promotion evidence → create or reuse a plan → gate → edit → run primitive verification → report evidence.

Activation means this `SKILL.md` was actually loaded in the current chat session. Do not claim activation by only adding `create-primitive` to `skills_used`.

For a Java/Spring/AWS migration request, explicitly compare: Existing /java skill; Existing /aws skill; Reference under /java; Reference under /aws; New cross-domain migration skill. Select the smallest justified reusable option. Dense migration guidance belongs in a reference rather than bloating `SKILL.md`.

Inspect both repository-owned capabilities and the installed `~/.copilot/skills/java/SKILL.md` and `~/.copilot/skills/aws/SKILL.md` when those installed paths exist. State what was inspected and why reuse, a reference, or a new cross-domain skill is the smallest justified choice before editing.

Before writing files:

1. **Classify the primitive** using the decision rules above.
2. **Check for overlap** in `.github/skills/`, `.github/agents/`, `.github/instructions/`, `.github/prompts/`, skill `references/`, `knowledge/solutions/`, optional product `.github/checks/`, and product `docs/solutions/`.
3. **State the decision** before editing: "This should be a [primitive] because [boundary]."
4. **Define triggers and negative triggers** for discovery when the primitive is user/model selectable.
5. **Declare permissions/tool needs** using the smallest sufficient tool set.
6. **Define outputs and verification**: generated files, state changes, review criteria, or acceptance checks.
7. **Add eval scenarios**: for promoted or core/confusable skills, add 8–10 should-trigger prompts, 8–10 should-not/confusable prompts, outcome assertions, and supported-host coverage. Checks and instructions need good/bad examples.
8. **Update docs** listed in the validation checklist.
9. **Update growth inventory** when adding a skill or agent in this repo:
   - Append to `knowledge/capability-registry.yaml` under `starter_skills` or `starter_agents`.
   - If new agent is delegatable from `@engineer`, add to `engineer_allowlist` and `engineer.agent.md` frontmatter `agents:` (human-approved).
   - Update `docs/architecture/engineer-harness.md` if runtime or capability boundaries changed.

Before the first full `harness verify`, map every acceptance criterion to trusted checks from `.github/harness/checks.yaml`, complete only the tasks and criteria actually proven, and include `prompt-contracts`, `host-contracts`, and `build-assets` when those standard primitive checks are configured. Inspect candidate commands/assertions: a specialized check for another output (such as `schema-validation` with no schema artifact) is forbidden. In a product repo where standard primitive checks are absent, use only the generic or strongest relevant local named check and state that prompt-library registry/eval/build surfaces are not present; do not invent check names, run unrelated optional checks, repair their failures, widen scope for them, or fake registry updates.

## Capability Expansion Mode

When invoked because `@engineer` or another skill found a missing capability, require `.github/skills/references/capability-gap-proposal.md` before creating or substantially changing primitives. Follow the steps in that template's `## Usage Workflow`.

Do not create primitives in non-interactive mode unless prior human approval is already recorded.

### Promotion evidence

Before creating or substantially expanding a skill, record the verified real-task evidence and satisfy at least one criterion:

- the procedure has succeeded more than once;
- the organization has strategically adopted the technology;
- multiple repositories need the workflow;
- the procedure is high-risk and benefits from standardization; or
- the procedure has fragile steps models repeatedly miss.

The evidence record must link passed verification artifacts, prior uses or strategic adoption, overlap analysis, an owner, proposed lifecycle state, a trigger eval suite, and an outcome eval suite. One unfamiliar API, a simple one-off task, adequate upstream documentation, or duplication of an existing skill is insufficient promotion evidence.

Primitive creation remains separate from learning classification. `/auto-compound` may recommend a candidate but must not create it.

## Primitive Creation Paths

### Skill

Use for reusable workflows, generators, reviewer protocols, or pipeline steps. Read `references/skill-template.md`.

Required files:
- `.github/skills/<name>/SKILL.md`
- `.github/prompts/<name>.prompt.md` only if the skill needs a VS Code slash-command wrapper

### Agent

Use only for separate judgment, authority, isolation, runtime profile, or accountability. Read `references/agent-template.md`.

Required file:
- `.github/agents/<name>.agent.md`

### Instruction

Use for concise standards that should load by file pattern, such as language conventions, framework conventions, or quality standards.

Read `references/instruction-template.md`.

Required file:
- `.github/instructions/<name>.instructions.md`

### Review Check

Use for narrow review-time criteria that `/code-review` discovers, such as complexity budgets, Sonar maintainability concerns, logging standards, or API versioning rules.

Read `references/check-template.md`.

Required file:
- `.github/skills/code-review/references/checks/<name>.md` for prompt-library-managed checks
- `.github/checks/<name>.md` only for product-repo overlays

### Prompt Wrapper

Use only as a host-facing route to an existing skill. Do not put workflow logic here.

Required file:
- `.github/prompts/<name>.prompt.md`

### Reference or Asset

Use when an existing skill needs dense criteria, templates, schemas, or examples without bloating `SKILL.md`.

Required location:
- `.github/skills/<skill>/references/<name>.md` for readable supporting material
- `.github/skills/<skill>/assets/<name>` for templates or output resources

### Solution Doc

Use only for verified learnings from completed work. Prefer `/compound-learnings` when the learning came from a pipeline issue.

Required locations:
- **Team-wide:** `knowledge/solutions/<category>/<slug>.md` (preferred; hydrated globally)
- **Repo-private:** product `docs/solutions/<category>/<slug>.md` when the learning must not be shared

## Detailed creation paths

For per-type creation detail — agent classifications and templates, skill patterns, cross-tool frontmatter, token budgets, prompt-wrapper, review-check, and instruction creation — read `references/creation-details.md` on demand.

## Validation Checklist

After creating an agent, skill, or instruction, verify:

- [ ] Primitive type is justified against `docs/architecture/skill-driven-prompt-library.md`
- [ ] Description conveys WHAT + WHEN (agents ≤180 characters, skills ≤220 characters)
- [ ] Correct tool classification (reviewer/researcher/actor)
- [ ] No provider-specific model pinning; let GitHub Copilot choose the active model in VS Code or IntelliJ IDEA
- [ ] `user-invocable: false` set for specialist/leaf-node agents
- [ ] `agents: []` set for non-coordinator agents (prevents accidental subagent spawning)
- [ ] Guardrails section present (for reviewers and actors)
- [ ] Output format defined with markdown template
- [ ] "What NOT to Report" section present (for reviewers)
- [ ] File in correct directory with correct naming
- [ ] For skills: inputs, outputs, mode behavior, gates, verification, error handling, and trigger examples are present
- [ ] New or substantially expanded skills include recorded promotion or strategic evidence, 8–10 positive trigger evals, 8–10 negative/confusable trigger evals, outcome eval assertions, owner, and lifecycle state
- [ ] For instructions: `applyTo` glob pattern matches target files, conventions are specific and actionable
- [ ] For prompt wrappers: body routes to the matching skill instead of duplicating workflow logic
- [ ] For checks: follows `.github/checks/README.md` format, lives in the correct bundled or product-owned location, and stays focused on one concern
- [ ] Documentation updated: CLAUDE.md, AGENTS.md, README.md, copilot-instructions.md, repository context docs, and architecture docs if the standard changed
