# Composer / Windsurf Parity Review

Would engineers who built **Cursor Composer** or **Windsurf Cascade** approve this repo as a “replacement”? **Not as a product substitute** — different hosts (GitHub Copilot global hydration vs native IDE agent + index). They **would approve the document-based architecture** as an enterprise-grade **workflow + memory layer** if we keep the orchestrator thin and memory bounded.

## Verdict

| Question | Answer |
|----------|--------|
| Replacement for Cursor? | **No** — no embedded codebase index, no host-native memory API, no single IDE shell |
| Better for regulated teams? | **Yes** — git-auditable plans, explicit capture gate, approved primitive growth |
| Good doc-based harness? | **Yes, after tightening** — thin `@engineer`, frozen context budget, indexed knowledge |
| Model-agnostic quality? | **Only if** rules live in **inline checklist + skills**, not “read five reference files” |

## What Composer does well (target bar)

1. **Thin orchestrator** — small system prompt; tools do retrieval.
2. **Indexed retrieval** — semantic search over code + rules; pull **top-k** chunks only.
3. **Tiered memory** — user rules + project rules + session; bounded injection.
4. **Low ceremony by default** — structure without six user checkpoints per issue.
5. **One loop** — plan → act → verify in one session; persistence is automatic.

## What we do better (keep)

| Our strength | Composer analogue |
|--------------|-------------------|
| `docs/plans/` state machine | Durable task DAG in files |
| Global `knowledge/solutions/` | Shared team rules / memories |
| Capture gate | Forced issue tracking for compliance |
| Specialist subagents with packets | Multi-agent review |
| `/create-primitive` governance | Prevents skill sprawl |

## What they would reject (fixed in this iteration)

| Gap | Why it fails | Fix |
|-----|--------------|-----|
| 17 KB `engineer.agent.md` | Buries checklist; weak models skip tail | Slim agent + `engineer-runtime.md` on demand |
| “Read 4 references each session” | Models do not reliably load external refs | Inline checklist + 12-line recall procedure |
| Keyword-only `manifest.yaml` | Poor recall vs embeddings | Top-k + tag scoring; v2 embeddings documented |
| Duplicate capture/rules prose | Conflicts and drift | Single gate in checklist |
| `copilot-instructions` bloat | Taxes every agent session | Engineer-only harness rules in agent |
| Too many checkpoints | Slower than Composer UX | Required gates only; optional consult on risk |

## Approved architecture (document-based Composer pattern)

```text
┌─────────────────────────────────────────────┐
│  Frozen slice (every @engineer turn)        │
│  • Session checklist (~400 tokens)          │
│  • profile.md if under cap                  │
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│  Retrieved slice (top-k, on demand)         │
│  • manifest matches (≤3 solutions, ≤30 lines each) │
│  • plan ## Memory Cards (≤15 lines)       │
│  • codebase search (host tool)              │
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│  Written slice (git persistence)            │
│  • docs/plans/ per issue                    │
│  • knowledge/solutions/ per team          │
└─────────────────────────────────────────────┘
```

## Implementation checklist (maintainers)

- [x] `engineer.agent.md` slim; checklist **inlined**; context-pack is turn-0 source of truth
- [x] `context-budget.md` enforced via `validate-plan` B1/B2 + context-pack truncation
- [x] Autopilot skill does not require four references at turn start
- [ ] `copilot-instructions.md` under ~4 KB for non-engineer agents
- [ ] Every pipeline skill points to `knowledge-locations.md` only
- [ ] Harness eval fixtures (see `external-harness-review-remediation.md`)

## v2 (parity with Composer index)

- MCP or host semantic search over `knowledge/solutions/`
- Session hook: inject plan `## Memory Cards` only (not full plan)

## Autonomous target (full proposal)

See [`composer-style-autonomous-harness-proposal.md`](composer-style-autonomous-harness-proposal.md): one loop, auto capture/recall/compound/index, consent Tier 3 only. Policy: `.github/skills/references/autonomy-policy.md`.

## Positioning statement

> **Adaptive Engineer Harness** is a portable, git-auditable **agent operating system** for Copilot-class hosts — not a Cursor fork. It trades native indexing for **explicit memory, governance, and cross-repo learning**.
