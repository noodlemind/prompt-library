# Engineer Starter Kit

What a **new** Adaptive Engineer begins with — and how the kit grows.

## Starter skills (invoke with `/`)

**Pipeline:** `/start`, `/recall`, `/capture-issue`, `/plan-issue`, `/work-on-task`, `/code-review`, `/compound-learnings`, `/index-memory`

**Hands-on:** `/engineer`, `/tdd-fix`, `/brainstorming`, `/deepen-plan`, `/document-review`

**Domain:** `/java`, `/python`, `/sql`, `/aws`

**Utilities:** `/btw`, `/analyze-and-plan` (plan enrichment only), `/codebase-context`, `/review-guardrails`, `/create-primitive`

Full list: `knowledge/capability-registry.yaml`

## Starter expert network

`@engineer` may delegate to agents listed in `engineer.agent.md` `agents:` frontmatter. Matrix: `engineer-delegation-matrix.md`.

**Coordinators:** `plan-coordinator`, `code-review-coordinator`, `pipeline-navigator`

**Not in default allowlist** (invoke directly or expand via approved primitive): `data-integrity-guardian`, `compounding-typescript-reviewer`, `spec-flow-analyzer`, `feedback-codifier`, `pr-comment-resolver`, `code-simplicity-reviewer`, `pattern-recognition-specialist`

## Starter knowledge

- **Team:** `~/.copilot/knowledge/solutions/` + `manifest.yaml` (after hydrate)
- **Repo:** `docs/plans/`, `docs/agent-context.md`, optional `docs/solutions/`
- **User:** `~/.copilot/knowledge/profile.md`

## How the kit grows

| Growth type | Path |
|-------------|------|
| New pattern learned | `/compound-learnings` → `knowledge/solutions/` |
| New workflow | verified repeated use → compound classification → promotion evidence + evals → `/create-primitive` |
| New specialist | capability-gap → new agent → update `engineer.agents:` + registry |
| New convention | scoped instruction or repo `agent-context.md` |

After adding, deprecating, or retiring skills/agents, update ownership/lifecycle in `knowledge/capability-registry.yaml`; synchronize inventory and operating guidance in `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.github/agent-context.md`, `README.md`, and `docs/architecture/skill-driven-prompt-library.md` where primitive boundaries or workflow contracts change; update evals and supporting references; run **`npm run build:assets`** in `packages/harness`; and verify the package before publishing **`@dev-kit/harness`**.
