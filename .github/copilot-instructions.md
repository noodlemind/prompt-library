# Copilot Instructions

Shared context loaded into every agent and skill session.

## Project

Skill-driven prompt library for software development using GitHub Copilot in VS Code and IntelliJ IDEA on Windows. Teams hydrate prompts, agents, skills, and instructions globally from this repo; product repositories should not receive prompt-library source artifacts.

## Primitives

Skills = workflows. Agents = isolated judgment. Instructions = file-pattern rules. Details: `docs/architecture/skill-driven-prompt-library.md`.

## Plans and knowledge

- Product **`docs/plans/`** — per-issue context pack (`status`, `plan_lock`, `phase`, `## Memory Cards`).
- Team **`knowledge/solutions/`** — cross-repo learnings (hydrated to `~/.copilot/knowledge/`).
- Lookup order: `.github/skills/references/knowledge-locations.md`.

**`@engineer` only:** autonomous loop, capture gate, and checklist live in `engineer.agent.md` — not duplicated here. Onboarding: `docs/onboarding/harness-quickstart.md`.

## Conventions

- Follow existing patterns. Consistency over preference.
- Keep primitive boundaries clear: workflows belong in skills, role-specific judgment belongs in agents, file-scoped conventions belong in instructions, host routing belongs in prompt wrappers, bundled review checks belong in the owning skill's references, and narrow product-specific review rules belong in product `.github/checks`.
- TDD: failing test → minimal fix → cleanup.
- Surgical diffs only. No drive-by refactoring. Three similar lines > premature abstraction.
- Never commit secrets or credentials. Validate input at boundaries. Parameterized queries.

## Orchestration

The engineer selects the skill/flow first, then delegates only when separate judgment, authority, or isolation improves the result. Coordinators delegate to specialist subagents via `tools: ['agent']`. Subagents run in isolated context — include all necessary context in the task prompt. `/plan-issue` and `/code-review` prompt wrappers route to their coordinators via the `agent:` field (prompt tools override agent tools). Coordinators use `agents:` allowlists to restrict which specialists they can invoke. Coordinators dispatch subagents in parallel batches (3-4 at a time) rather than sequentially.

Engineer harness: `@engineer` agent file. Parity bar: `docs/architecture/composer-parity-review.md`. Delegation: `subagent-context-packet.md`. Risky work: `human-approval-policy.md`.

## Standardization

Read `docs/architecture/skill-driven-prompt-library.md` before adding or substantially changing agents, skills, instructions, prompt wrappers, checks, plan structure, or solution templates.

## Tool compatibility

VS Code / IntelliJ fallback table and subagent tool rules: `.github/skills/references/tool-compatibility.md`.

## Credit efficiency (GitHub Copilot)

Teams on metered plans (~6000 AI credits): run `harness orient` + read `.harness/context-pack.md` before `@engineer`; avoid pasting full plans or repo dumps; prefer `balanced` autonomy. Guide: `docs/onboarding/github-copilot-credit-efficiency.md`.
