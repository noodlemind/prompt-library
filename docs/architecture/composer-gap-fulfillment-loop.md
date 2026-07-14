# Composer-Style Gap Fulfillment Loop

> Historical gap-design exploration. Universal intake preflight was superseded
> by on-demand gap handling in
> [`engineer-operating-model.md`](engineer-operating-model.md) and the governed
> lifecycle in [`capability-lifecycle.md`](capability-lifecycle.md). The examples
> below are non-normative decision history.

How **Cursor** or **Windsurf** engineering teams would implement **blocking capability gaps**: detect early, **fulfill before execute**, promote to the team via **hydrate** — not “notify and hope.”

Related: [`enterprise-capability-expansion.md`](enterprise-capability-expansion.md), [`composer-style-autonomous-harness-proposal.md`](composer-style-autonomous-harness-proposal.md).

---

## 1. What product teams optimize for

Native IDE agents (Composer, Cascade) optimize for **session completion rate**, not proposal volume.

| Our earlier draft | Cursor/Windsurf-style target |
|-------------------|------------------------------|
| Draft gap doc, notify, continue with researchers | **Classify gap** → **fulfill or block** → **only then execute** |
| Primitive growth = maintainer ticket | **Same-session unblock** for skills/checks; agents still gated |
| Hydrate = manual desktop task | **CI + versioned overlay** so everyone gets the fix next hydrate |

**Your constraint is correct:** if Terraform or Splunk expertise is **required** for verification, unfilled gaps mean the engineer **cannot honestly complete** the task — fallback is a **bridge**, not done.

---

## 2. Hard vs soft gaps (Composer would split these)

At **ingest** (before `plan_lock`), engineer runs a **capability preflight** against merged registries:

| Class | Definition | Engineer behavior |
|-------|------------|-------------------|
| **Soft gap** | Nice-to-have workflow; generic tools + docs suffice | Log `capability_gaps`, proceed, compound may suggest primitive later |
| **Hard gap** | Acceptance criteria or verify step **requires** missing skill/agent/instruction | **Block execute** (`status: blocked-capability`) until fulfilled or explicit human waiver |
| **Bridge gap** | Hard domain but **MCP/tool** exists (Splunk API, Terraform CLI) | Use bridge in-session; still open gap PR to replace bridge with primitive |

Examples:

| Task | Missing | Class | Why |
|------|---------|-------|-----|
| Fix Java bug | — | — | `/java` hydrated |
| Wire new Lambda | — | — | `/aws` in base library |
| Apply corp Terraform module standards | `/terraform` skill | **Hard** if plan says “must follow module X conventions” | No skill → cannot claim compliance |
| “Validate payment delay in Splunk index=payments” | `@splunk-reviewer` | **Hard** if verify requires SPL expert sign-off | Researcher is not Splunk reviewer |
| Explore Splunk query for ad-hoc debug | agent missing | **Soft** | User can paste SPL; researcher OK |

Record on plan:

```yaml
status: blocked-capability   # when hard gap open
domains: [terraform]
capability_gaps:
  - id: terraform
    class: hard
    required_for: verify
    fulfillment: pending
specialists: []
```

---

## 3. The loop Composer/Windsurf would implement

```text
User: "@engineer implement Terraform module for service X"
        │
        ▼
┌───────────────────┐
│ 0 Capability       │  Merge base + enterprise registry
│   preflight        │  → hard gap? terraform skill missing
└─────────┬─────────┘
          │
    hard? ├─── no ──► recall → ensure plan → execute (green path)
          │
          yes
          ▼
┌───────────────────┐
│ 1 Fulfill gap      │  Same session / same PR (not async ticket)
│   (unblock)        │
└─────────┬─────────┘
          │
          ├── Skill/check → auto-draft + /create-primitive (Tier 1 notify)
          ├── Agent → /create-primitive + Tier 3 allowlist (block until approved)
          └── Bridge → MCP Splunk / terraform CLI + log "replace with primitive"
          │
          ▼
┌───────────────────┐
│ 2 Verify primitive │  Smoke: skill triggers, agent judgment packet
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ 3 Promote          │  Merge enterprise/ or library PR
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ 4 Hydrate team     │  CI publishes ~/.copilot/enterprise@version
└─────────┬─────────┘
          │
          ▼
     Resume execute on original plan (status → in-progress)
```

**Key difference from “notify and continue”:** hard gaps **stop** at step 1 until fulfillment or **documented waiver** (Tier 3: “proceed without Splunk reviewer”).

---

## 4. How they would fulfill (four speeds)

| Speed | When | Action | Team hydrate |
|-------|------|--------|--------------|
| **S0 — Already shipped** | In base or enterprise registry | Route only | Next routine hydrate |
| **S1 — Session skill** | Hard gap, skill-shaped | Engineer invokes `/create-primitive` → `enterprise/skills/<id>/` | Merge enterprise PR → hydrate |
| **S2 — Session agent** | Hard gap, judgment-shaped | Gap proposal → human Tier 3 → agent + allowlist | Same |
| **S3 — Import** | Standards exist in git | `/import-conventions` from corp repo | Hydrate |
| **S4 — Bridge** | Tool/MCP available now | Splunk MCP, `terraform plan` via terminal; gap stays open | Replace bridge when S1/S2 lands |

Cursor would prefer **S4 → S1** over permanent bridge: bridges are technical debt.

Windsurf would push **rules generation** from repeated edits (maps to our Phase G auto-skill draft + human merge).

---

## 5. Hydrate to everybody else (Composer “sync”)

Product agents sync **user rules** and **project rules** automatically. Our equivalent:

| Mechanism | Owner | Trigger |
|-----------|-------|---------|
| **Enterprise git repo** | Platform | Source of truth for `enterprise/` |
| **Hydrate task / CI** | DevEx | On merge to `main` of enterprise overlay |
| **Version pin** | `capability-registry.enterprise.yaml` `version:` | Engineer logs “requires enterprise ≥ 1.4” on plan |
| **Knowledge compound** | Any engineer | Solutions to `enterprise/knowledge/solutions/` |

Target path:

```text
engineer fulfills gap in PR #452 (enterprise/skills/terraform/)
        │
        ▼
platform merges → CI runs Hydrate-Enterprise
        │
        ▼
all dev machines ~/.copilot/enterprise/ updated
        │
        ▼
next @engineer on any repo routes /terraform automatically
```

**No per-developer “learn skill” step** — one fulfillment, team-wide capability.

---

## 6. Implementation plan additions (Phase H)

| ID | Deliverable | Notes |
|----|-------------|-------|
| H1 | `capability-preflight.md` reference + engineer ingest step | Before plan_lock |
| H2 | Gap classes `hard` \| `soft` \| `bridge` in plan frontmatter | Extends F4 |
| H3 | `ensure-capability` internal skill | Fulfill or set `blocked-capability` |
| H4 | Engineer: **no execute** while hard gap `pending` | Unless Tier 3 waiver |
| H5 | `enterprise-hydrate` CI workflow spec | Publish overlay artifact |
| H6 | Gap queue: `enterprise/capability-gaps/` or platform Linear | Track open hard gaps |

**Order with Phase F:** F2 registry merge → H1 preflight → F3 router → H3 fulfill → B autonomous loop.

---

## 7. Consent under blocking model

| Primitive | Block work? | Fulfill consent | Hydrate |
|-----------|-------------|-----------------|---------|
| Skill / instruction / check | Yes if **hard** | Tier 1 notify (`full`) | Auto on merge |
| Agent + allowlist | Yes if **hard** | Tier 3 | Auto on merge |
| Waiver (“skip Splunk review”) | Unblocks | Tier 3 | — |
| Bridge (MCP/CLI) | Unblocks temporarily | Tier 1 log assumption | — |

---

## 8. Answers (short)

**How would Cursor/Windsurf optimize this?**  
Preflight at ingest, **hard/soft classification**, fulfill in-session, verify primitive, promote via git, **CI hydrate** — not async notify-only.

**If gap isn’t fulfilled, can engineer finish?**  
**No** for hard gaps tied to verify/acceptance — status stays `blocked-capability` until S1–S4 or waiver.

**Once fulfilled, how does everyone get it?**  
Merge to **enterprise overlay** (or base library) → **hydrate pipeline** → all hosts load new skill/agent on next sync.

---

## 9. Confirmation (add to proposal §13)

| # | Decision |
|---|----------|
| 9 | Hard gaps **block** execute until fulfilled, bridged, or waived (recommended) |
| 10 | Fulfillment PR targets `enterprise/` (recommended) not product repo only |
| 11 | CI hydrate after enterprise merge (recommended) |
