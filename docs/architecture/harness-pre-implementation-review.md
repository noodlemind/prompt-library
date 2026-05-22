# Harness Pre-Implementation Review

**Purpose:** Explain how the proposed optimized harness works in plain terms, what is already in the repo vs still planned, and **gaps to close** before implementation — so the result is **usable by anyone in the enterprise** and **delivers faster** without silent failure modes.

**Audience:** Reviewers signing off on [`composer-style-autonomous-harness-proposal.md`](composer-style-autonomous-harness-proposal.md).

---

## 1. How the optimized harness works (one story)

Think of three layers the user never has to memorize:

```text
┌─────────────────────────────────────────────────────────────┐
│  YOU: @engineer  (one entry — describe the work)            │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  ORCHESTRATOR (@engineer, thin prompt)                       │
│  1. Recall team memory (manifest + plan cards)               │
│  2. Capability preflight (base + enterprise registry)        │
│  3. Ensure plan exists + lock (capture/plan logic)           │
│  4. Route domain (/java, /aws, enterprise /terraform…)       │
│  5. Implement within plan scope                              │
│  6. Verify (tests + verification plan)                       │
│  7. Compound + index learnings (team-wide knowledge)         │
└────────────────────────────┬────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
   Hydrated skills     Specialist agents    Product repo
   (procedures)         (judgment)           docs/plans/ only
   ~/.copilot/          subagent delegate    local audit trail
   + enterprise/
```

**Faster deliverables** come from:

| Mechanism | Why it speeds delivery |
|-----------|-------------------------|
| Auto recall | Prior fixes surfaced before rework |
| Auto capture/plan | No “please run six slash commands” |
| Domain routing | Right workflow without naming `/aws` |
| Bounded context | Smaller prompts → fewer mistakes / retries |
| Auto compound | Next engineer on any repo inherits the fix |
| Hard-gap block | Stops fake “done” when Splunk/Terraform primitive missing |

**Enterprise safety** stays via git-auditable plans, Tier 3 consent on risky changes, and optional `strict` profile.

---

## 2. What is done today (Phase A + partial vision)

| Area | Status | Notes |
|------|--------|-------|
| Policy docs | Done | `autonomy-policy.md`, capture gate, context budget |
| Memory layout | Done | `knowledge/`, manifest template, `/recall`, `/index-memory` |
| Engineer slim prompt | Done | ~4 KB agent; recall inline |
| Plan template fields | Done | `risk`, `domains`, `specialists`, `capability_gaps` |
| Enterprise scaffold | Done | `enterprise/README.md`, registry template |
| Architecture narrative | Done | Memory, enterprise expansion, gap fulfillment, Composer proposal |
| **Autonomous loop skills** | **Not done** | No `ensure-plan`, `auto-compound`, `ensure-capability` |
| **Enterprise hydrate** | **Not done** | VS Code task does not sync `enterprise/` |
| **Domain router in engineer** | **Not done** | Registry merge not in agent workflow |
| **Deterministic index script** | **Not done** | `scripts/index-knowledge.mjs` missing |
| **Pipeline UX shrink** | **Not done** | Pipeline skills still user-invocable |

**Reality check:** Today `@engineer` still behaves largely like **compliance-first** (user/handoff expected for capture/plan/compound) unless the model follows prose about autonomy. **Foolproof requires implementing Phases B, C, F, H** and reconciling contradictions below.

---

## 3. Critical gaps (must fix for “foolproof”)

### G1 — Contradictory instructions (models will pick the wrong rule)

| Source A | Source B | Resolution in implementation |
|----------|----------|------------------------------|
| `capture-gate.md`: plan must be created by **`/capture-issue`**, engineer must **invoke** skill | `engineer.agent.md`: “run capture/plan logic yourself”; mission: autonomous ensure plan | **Single rule:** engineer runs **`ensure-plan`** internal skill that applies capture template; retire “not you” C2 wording |
| `engineer.agent.md` Workflow: “**never** create or lock plans yourself” | Proposal §2.3: auto capture/plan | Same: engineer may **execute** capture/plan **logic**, not ad-hoc freeform plans |
| Handoffs still say “Run /capture-issue” | Autonomous target: no user slash steps | Handoffs → “Resume plan” / internal only; or `user-invocable: false` on navigator handoffs |

Without G1 fix, small models will keep skipping capture or conflicting with autopilot.

### G2 — Autonomous loop not in code/skills (only in docs)

Proposal mermaid omits **capability preflight** and `blocked-capability`. Implementation must add:

```text
Ingest → Preflight (H) → Recall → EnsurePlan (B) → AutoPlan (B) → Execute → Verify → Compound (C) → Index (C)
```

### G3 — No “harness ready” gate for new enterprise users

Anyone joining must:

1. Run Hydrate (Windows paths in `tasks.json` today)
2. Have `knowledge/profile.md` with `autonomy`
3. (Future) Enterprise overlay hydrated

**Missing:** `docs/onboarding/harness-quickstart.md` + optional `/harness-doctor` skill (read-only checks: manifest exists, profile exists, engineer agent present).

### G4 — Enterprise overlay not wired

| Missing | Impact |
|---------|--------|
| Hydrate does not copy `enterprise/` | Corp Terraform/Splunk never loads |
| Engineer does not read merged registry | Domain router is documentation only |
| No CI hydrate (H5) | Team-wide rollout manual |

### G5 — Host / environment split

| Environment | Gap |
|-------------|-----|
| **VS Code Copilot (Windows)** | Primary target; hydrate works |
| **IntelliJ** | Separate mirror path; feature parity (subagents, `user-invocable`) must be tested |
| **Linux cloud agents** | Hydrate task is PowerShell/`%USERPROFILE%\.copilot` — cloud workspace may **not** see global knowledge unless repo-local `knowledge/` fallback is enforced |

**Foolproof rule:** Engineer recall path must **always** fall back to repo `knowledge/manifest.yaml` when `~/.copilot/knowledge/` absent (partially documented; enforce in checklist).

### G6 — Hard vs soft gap classification undefined in code

`capability-preflight.md` exists but engineer agent does not reference it. Need:

- Explicit rules: hard = acceptance criteria or verify names missing primitive
- Default for unknown domain: **soft** (proceed + log) vs **hard** (org policy) — **must be a confirmation decision**

### G7 — No harness acceptance tests

“Foolproof” needs smoke scenarios (manual or scripted doc tests):

| # | Scenario | Expected |
|---|----------|----------|
| T1 | Green bug fix, no plan | Auto plan created, code only after lock |
| T2 | AWS Java change | Routes aws + java without user `/aws` |
| T3 | Requires Splunk, no agent | `blocked-capability` until fulfill or waiver |
| T4 | Verify pass | Solution + manifest updated without user `/compound-learnings` |
| T5 | Strict profile | Tier 1 behaves as Tier 3 |

---

## 4. High gaps (speed + enterprise scale)

| ID | Gap | Recommendation |
|----|-----|----------------|
| H1 | Semantic recall weak (keyword manifest only) | Phase E v2; acceptable v1 if tags maintained |
| H2 | `auto-compound` may write wrong global solution | Gate on tests + `## Verification Plan` checklist |
| H3 | Duplicate plan detection | `ensure-plan` must fuzzy-match `docs/plans/` titles |
| H4 | Coordinator latency | Keep parallel batches; don’t block autopilot on full review for green |
| H5 | Default profile `balanced` vs doc “full” for Composer parity | Pick one default in `profile.md.template` and README |
| H6 | F6 vs H6 path inconsistency | Use `enterprise/capability-gaps/` for corp; `docs/capability-gaps/` optional in product repo for local drafts |

---

## 5. Medium gaps (polish)

- Stale prose in proposal §0.2 (“Terraform … continue under full profile”) — superseded by Phase H block model
- Phase G auto-skill before enterprise layer stable — defer
- MCP Splunk bridge — optional S4; document in enterprise README when MCP exists
- Notification channel (`notify_channel` in profile) — no implementation spec

---

## 6. Recommended MVP (implement first — foolproof minimum)

**Goal:** Any hydrated developer can `@engineer` a green/amber task and get a plan + code + compound without ceremony; enterprise can add overlay later.

| Order | Phase | Deliverable |
|-------|-------|-------------|
| 1 | **G1 reconcile** | Update `capture-gate.md`, `engineer.agent.md`, `engineer-session-checklist.md` for `ensure-plan` |
| 2 | **B** | `ensure-plan` skill + engineer autopilot steps |
| 3 | **C** | `auto-compound` + index chain |
| 4 | **F2–F3** | Hydrate `enterprise/` + registry merge in engineer intake |
| 5 | **H1–H4** | Preflight + hard block (with org default: soft-unknown) |
| 6 | **G3** | Quickstart + harness doctor |
| 7 | **D** | Hide internal pipeline skills from `/` menu |

**Defer to v1.1:** Phase E semantic index, Phase G auto-skill, H5 CI hydrate (spec first, automate second).

---

## 7. What “foolproof for anybody” requires (non-negotiables)

1. **One entry command** — `@engineer` (documented in product README one-liner).
2. **Hydrate once** — documented; doctor skill verifies.
3. **No contradictory gates** — G1 resolved in same PR as `ensure-plan`.
4. **Predictable block states** — `blocked-capability`, `plan_lock`, `risk` visible in plan frontmatter.
5. **Fallback paths** — repo-local `knowledge/` when global missing.
6. **Enterprise path documented** — overlay repo + allowlist process, not tribal knowledge.

---

## 8. Sign-off questions (add to proposal §13)

| # | Question | Default recommendation |
|---|----------|------------------------|
| 12 | Unknown domain gap class | **soft** (log + proceed) — hard only when AC/verify names primitive |
| 13 | MVP scope | B + C + G1 + F2/F3 + H1–H4 before E and G |
| 14 | Cloud/Linux agents | Require repo-local `knowledge/` in product clone for cloud |
| 15 | Default autonomy | `balanced` ship; document `full` for speed teams |

---

## 9. Summary

The **optimized approach** is not more slash commands — it is **`@engineer` running an internal micro-pipeline** (recall → preflight → plan → work → verify → compound) over **hydrated** skills/agents and **enterprise overlay**, with **hard stops** only when a missing primitive makes “done” dishonest.

**Before implementation:** close **G1–G7**; treat Phases B, C, F, H as one **MVP harness**; defer semantic index and auto-skill.

**After confirmation:** implement in order §6; run smoke scenarios §G7.
