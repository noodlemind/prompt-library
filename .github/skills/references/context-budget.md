# Context Budget (Composer-style)

Keep retrieved context **small and frozen per turn**. Full procedures live in skills; only **top-k facts** enter the model.

## Budget tiers

| Tier | Max size | Contents | When loaded |
|------|----------|----------|-------------|
| **F0 Frozen** | ~600 tokens | Session checklist + active plan path + 3 memory cards | Every `@engineer` turn |
| **F1 Recall** | ~800 tokens | ≤3 manifest entries (title, symptom, path, 1-line summary each) | Phase 0 |
| **F2 Plan slice** | ~1500 tokens | `## Memory Cards` + `## Acceptance Criteria` + current phase tasks | Before implement |
| **F3 On demand** | skill-defined | `capture-gate`, `subagent-context-packet`, delegation matrix | Only when delegating or gating |

**Never** load full solution files (>30 lines) unless user asks. **Never** load full `## Activity` logs — scan last 2 entries only.

## Memory Cards section cap

- Max **15 bullets**
- Max **1200 characters** total in `## Memory Cards`
- Each bullet ≤1 line + `source:` path

## Manifest recall cap

- Score by tag/symptom keyword overlap
- Return **top 3** entries only
- Read at most **first 25 lines** of each matched solution file

## Profile cap

`~/.copilot/knowledge/profile.md` — keep under **1500 characters** (Hermes-scale user store).

## Anti-patterns (Composer reviewers would flag)

- Pasting entire plan file into chat
- Loading all of `copilot-instructions` into engineer (host may already load it)
- Re-explaining capture gate in prose every turn
- Keyword manifest scan of 50+ files without ranking
