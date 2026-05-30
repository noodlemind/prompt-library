# External Harness Review — Remediation

**Status:** Applied (Codex / Claude Code / Cursor parity + GHCP credit efficiency)  
**Related:** [`composer-parity-review.md`](composer-parity-review.md), [`context-budget.md`](../../.github/skills/references/context-budget.md), [`github-copilot-credit-efficiency.md`](../onboarding/github-copilot-credit-efficiency.md)

---

## What top teams would flag

| Team | Primary concern | Our response |
|------|-----------------|--------------|
| **Codex / agentic workflows** | Token burn, non-inferential LLM steps, no evals | Deterministic CLI pre-steps; gate/orient JSON; diff advisories E1–E3; **golden eval fixtures** in `packages/harness/test/fixtures/` |
| **Claude Code** | Context rot, encyclopedia instructions | 2KB context-pack; Memory Cards B1 in `validate-plan`; thin `copilot-instructions.md` + `tool-compatibility.md` |
| **Cursor Composer** | Ceremony, duplicate retrieval | Host search first in pack; tiered `/start` routes; snapshot = cold-start only |
| **GHCP enterprise** | ~6000 credit waste | Credit guide, doctor H13–H15, `balanced` default, MCP pruning doc |

---

## Fixes applied

### 1. Single turn artifact (`context-pack.md`)

- Frozen **Rules** block (read pack only, host search, surgical policy pointer)
- **Gate preview** with failed check IDs + autonomy
- **Active plan** slices: Edit Scope, Impacted Files hint, Memory Cards, Activity tail
- **Recall** deprioritized; truncated first when over 2KB
- **Codebase map** line when fresh (≤7 days)

### 2. Runtime enforcement (`context-budget.mjs`)

| Check | Where | Id |
|-------|-------|-----|
| Memory Cards ≤15 bullets, ≤1200 chars | `validate-plan` | B1 |
| Locked patch plans should have Edit Scope | `validate-plan` | B2 (warn) |

### 3. `orient.mjs`

- Fixed import order; `copilotHome` → `runGate` for autonomy-aware E1–E3
- `buildNextTools()` from failed check IDs

### 4. Agent contract

- `@engineer`: turn 0 reads **only** `context-pack.md`; architect→editor delegation
- `engineer-autopilot`: no four-reference preload every turn
- `/start`: `@engineer` for standard trackable bugs

### 5. Credit efficiency pass (this iteration)

| Item | Deliverable |
|------|-------------|
| Golden evals | `packages/harness/test/fixtures/golden/*.json` + `eval-golden.test.mjs` |
| GHCP guide | `docs/onboarding/github-copilot-credit-efficiency.md` |
| Doctor H13–H15 | Instructions size, full+stale map, context-pack bytes |
| Instructions trim | `copilot-instructions.md` + `tool-compatibility.md` |
| CI token log pattern | JSONL example in credit guide |
| MCP pruning | Documented in credit guide |

---

## Remaining platform / maintainer scope

| Item | Owner | Notes |
|------|--------|-------|
| Host-native diff/patch edit format | GitHub Copilot platform | Harness compensates via policy + `code-implementer` |
| Plan indexing in BM25 (separate collection) | RFC in quality plan | Not blocking ship |
| Quarterly primitive audit | Maintainers | Checklist: retire unused agents/skills when registry shows zero invocations |

---

## Maintainer checklist

- [x] Context-pack is the single frozen slice for turn 0
- [x] `validate-plan` enforces Memory Cards budget
- [x] `orient` passes copilotHome to gate
- [x] `engineer.agent.md` under ~8KB (checklist inlined minimally)
- [x] Harness eval directory `packages/harness/test/fixtures/golden/`
- [x] MCP tool pruning documented for product repos
- [x] GHCP credit efficiency onboarding doc
