# Autonomy Policy

Default: **run the pipeline autonomously**. Human consent is for **Tier 3** only.

Profiles in `~/.copilot/knowledge/profile.md`:

```yaml
autonomy: full   # full | balanced | strict
```

| Profile | Tier 0 (auto) | Tier 1 (notify) | Tier 2 (soft) | Tier 3 (block) |
|---------|---------------|-----------------|---------------|----------------|
| **full** | All green + amber | Same | Enabled | red + new agents |
| **balanced** | green | amber + compound | limited | same as full Tier 3 |
| **strict** | `/tdd-fix`, `/btw` only | — | — | capture, plan, implement, primitives |

## Tier 0 — Autonomous (no ask)

`@engineer` and internal pipeline skills **must** run without user approval:

- **Recall** — top-3 manifest + plan memory cards (`context-budget.md`)
- **Ensure plan** — create `docs/plans/*.md` via capture rules if missing
- **Auto-plan** — lock plan when trackable and `risk: green|amber`
- **Implement** — within `## Impacted Files`
- **Verify** — tests and verification plan
- **Compound + index** — on verified success (tests reported, criteria met)
- **Memory cards** — append with `source:`

Do **not** tell the user to “run `/capture-issue`” — execute capture/plan logic yourself or invoke the skill internally.

## Tier 1 — Notify (proceed + Activity log)

Proceed and append `## Activity`:

- Autonomous plan created (path, risk tier)
- Global solution published (`knowledge/solutions/…`)
- Specialist review delegated and summarized
- Minor scope drift (one extra file) with justification

## Tier 2 — Soft consent (balanced + non-interactive only)

May proceed if user unavailable; log assumption in Activity:

- Amber plan amendment without scope expansion
- Default fix strategy when tests already reproduce failure

Never use Tier 2 for Tier 3 topics.

## Tier 3 — Hard consent (block)

Follow `human-approval-policy.md` approval format. Block until approved:

- New/changed **agents** or engineer `agents:` allowlist
- Schema, migration, production data, backfill
- Auth, secrets, IAM, tenant isolation, public API contract breaks
- Destructive operations, force push, mass delete
- Concurrency strategy choice (locks, isolation, idempotency)
- Edits outside `## Impacted Files` or broad refactor
- `autonomy: strict` profile — treat capture/plan/implement as Tier 3

### Primitives

| Change | Autonomous? |
|--------|-------------|
| Solution + manifest + memory cards | Yes (Tier 0) |
| Review check from repeated pattern | Yes + notify (Tier 1) |
| New skill from approved proposal | Yes if proposal approved |
| New skill/agent without proposal | No (Tier 3) |
| New agent | **Never** auto (Tier 3) |

Capability-gap proposals may be **auto-drafted** after repeat failures; merging into repo still Tier 3 for agents, Tier 1 notify for skills/checks under `full` profile.

## Risk tier (plan frontmatter)

```yaml
risk: green   # green | amber | red
```

| risk | Auto-plan | Auto-implement |
|------|-----------|----------------|
| green | yes | yes |
| amber | yes | yes + Tier 1 notify on sensitive files |
| red | plan draft yes; lock/implement Tier 3 | Tier 3 |

Engineer sets `risk` at intake from signals (schema, auth, prod, payments → red; test fix → green).

## Composer alignment

- **One loop** — engineer owns Tier 0 chain end-to-end
- **Memory automatic** — compound/index not user commands
- **Consent on red** — not on every step
