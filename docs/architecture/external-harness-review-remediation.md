# External Harness Review — Remediation

**Status:** Applied (Codex / Claude Code / Cursor parity gaps)  
**Related:** [`composer-parity-review.md`](composer-parity-review.md), [`context-budget.md`](../../.github/skills/references/context-budget.md), [`tool-native-harness-design.md`](tool-native-harness-design.md)

---

## What top teams would flag

| Team | Primary concern | Our response |
|------|-----------------|--------------|
| **Codex / agentic workflows** | Token burn, non-inferential LLM steps, no evals | Deterministic CLI pre-steps; gate/orient JSON; diff advisories E1–E3; *eval suite still roadmap* |
| **Claude Code** | Context rot, encyclopedia instructions | 2KB context-pack; Memory Cards B1 in `validate-plan`; thin engineer agent |
| **Cursor Composer** | Ceremony, duplicate retrieval | Host search first in pack; tiered `/start` routes; snapshot = cold-start only |

---

## Fixes applied in this pass

### 1. Single turn artifact (`context-pack.md`)

- Frozen **Rules** block (read pack only, host search, surgical policy pointer)
- **Gate preview** with failed check IDs + autonomy
- **Active plan** slices: Edit Scope, Impacted Files hint, Memory Cards, Activity tail (2 entries max)
- **Recall** deprioritized in layout; truncated first when over 2KB
- **Codebase map** line when fresh (≤7 days)

### 2. Runtime enforcement (`context-budget.mjs`)

| Check | Where | Id |
|-------|-------|-----|
| Memory Cards ≤15 bullets, ≤1200 chars | `validate-plan` | B1 |
| Locked patch plans should have Edit Scope | `validate-plan` | B2 (warn) |

### 3. `orient.mjs` repair

- Fixed broken import order (map helper was split above imports)
- Passes `copilotHome` into `runGate` for autonomy-aware diff advisories
- `buildNextTools()` derives `/ensure-plan` vs `/ensure-capability` from failed check IDs

### 4. Agent contract streamlining

- `@engineer`: read **only** context-pack at turn start; mandatory implementer delegation rules
- `engineer-autopilot`: do not load four references every turn
- `subagent-context-packet`: Edit scope / line-range fields
- `/start`: `@engineer` for standard trackable bugs, not only “investigation”

---

## Still roadmap (not pretending done)

| Item | Owner |
|------|--------|
| Harness eval fixtures (orient/gate JSON golden files) | harness package |
| Per-workflow token-usage.jsonl / ET metric | product CI templates |
| Plan indexing in BM25 (separate collection) | RFC in quality plan §12 |
| Host-native diff/patch edit format | GitHub Copilot platform |
| Primitive audit / retire unused agents | maintainers quarterly |

---

## Maintainer checklist

- [x] Context-pack is the single frozen slice for turn 0
- [x] `validate-plan` enforces Memory Cards budget
- [x] `orient` passes copilotHome to gate
- [ ] `engineer.agent.md` stays under ~8KB with inlined checklist only
- [ ] Harness eval directory `packages/harness/test/fixtures/`
- [ ] Document MCP tool pruning for product repos (agentic CI guide)
