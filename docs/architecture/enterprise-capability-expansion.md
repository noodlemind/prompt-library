# Enterprise Capability Expansion

How `@engineer` uses **Java / Python / SQL** today, gains **AWS / Terraform** skills, and reaches **Splunk (or other) specialist agents** — without the user typing dozens of slash commands.

Related: [`composer-style-autonomous-harness-proposal.md`](composer-style-autonomous-harness-proposal.md), [`engineer-vision-and-growth-loop.md`](engineer-vision-and-growth-loop.md).

---

## 1. Clarification: “Three interactions” ≠ “Three skills”

**Review for sign-off:** This document is the authoritative answer to “how does the engineer learn AWS / Terraform / Splunk?” The implementation plan checklist is in [`composer-style-autonomous-harness-proposal.md` §13](composer-style-autonomous-harness-proposal.md#13-confirmation-checklist-for-reviewer-sign-off).

| What the user types | What the system has |
|---------------------|---------------------|
| `@engineer` | Full autonomous loop + **all hydrated skills** (25+ today) |
| `/btw` | Q&A only |
| `/code-review` | Review pass (or coordinator) |

The engineer **does not only know three things**. It **invokes domain skills and agents internally** based on task signals — same way Composer applies rules and tools without you naming each one.

```text
User: "@engineer fix the Lambda timeout"
         │
         ▼
   Engineer intake (risk + domain signals: aws, java, lambda)
         │
         ├── applies /aws workflow (instructions + patterns)
         ├── delegates @aws-reviewer if review needed
         └── records route in plan Activity
```

User never types `/aws` unless they want to.

---

## 2. Two different “learning” mechanisms

Do not confuse **session memory** with **capability growth**.

| Kind | What it is | Example | How it grows |
|------|------------|---------|--------------|
| **Knowledge** | Facts about problems solved | “Orders API had N+1” | `/compound-learnings` → `knowledge/solutions/` |
| **Capability** | New **skills**, **agents**, **instructions** | `/terraform`, `@splunk-reviewer` | Enterprise pack or `/create-primitive` |

Java/Python/SQL in your question are **capabilities** (shipped in the library).  
“Half the fix is already documented” is **knowledge** (solutions + recall).

---

## 3. AWS task when the engineer “started with” Java and SQL

### Already in the global library (no learning step required)

| Capability | Path | Engineer access |
|------------|------|-----------------|
| **AWS workflow** | `.github/skills/aws/SKILL.md` | Auto-route when prompt mentions AWS, Lambda, SQS, IAM, etc. |
| **AWS conventions** | `.github/instructions/aws-sdk.instructions.md` | Auto-loaded for matching `.java` / SDK files |
| **AWS review** | `@aws-reviewer` | In engineer `agents:` allowlist — delegate with context packet |

So for a normal AWS integration task, the engineer:

1. Classifies domain → **aws** (+ maybe **java**).
2. Loads `aws-sdk.instructions.md` + `java.instructions.md` via host instruction globs.
3. Runs autonomous loop (plan → implement → verify).
4. Delegates `@aws-reviewer` during verify or `/code-review` if routing says so.

**No new skill is learned at runtime** — it was already hydrated to `~/.copilot/skills/aws/` on **Hydrate**.

### Terraform (not shipped today)

Terraform is **not** in `capability-registry.yaml` today. For Terraform work the engineer today would:

- Use `@best-practices-researcher` / `@framework-docs-researcher` (generic), **or**
- Trigger **capability expansion** (below) to add `/terraform` skill + optional `@terraform-reviewer` agent.

---

## 4. Splunk expert (specialist agent) — how access works

Specialists are **agents** (`.agent.md`), not skills. Access is controlled by:

1. **Agent file exists** (e.g. `.github/agents/splunk-reviewer.agent.md`).
2. **Hydrated** to `~/.copilot/agents/` (or enterprise overlay).
3. **Engineer allowlist** — `engineer.agent.md` frontmatter `agents: [...]` must include `splunk-reviewer` for `@engineer` to **delegate** as subagent.
4. **Optional:** user invokes `@splunk-reviewer` directly (always works if hydrated, even if not on allowlist).

Today: **no Splunk agent** in the library. So:

| Approach | Who does what | Consent |
|----------|---------------|---------|
| **Enterprise pre-load** | Platform team adds `splunk-reviewer.agent.md` + hydrates | Tier 3 once per agent (governance) |
| **User @mention** | Developer types `@splunk-reviewer` with task | No engineer delegation |
| **Engineer requests expansion** | Gap proposal → create agent → update allowlist | Tier 3 for new agent |

Under **autonomous proposal**: engineer detects “need Splunk validation” → if agent missing → **auto-draft** capability-gap + **notify** platform team; can still proceed with `framework-docs-researcher` or user-provided Splunk query context until agent exists.

---

## 5. Enterprise capability layers (recommended structure)

Teams should not fork the whole prompt-library per domain. Use **layers**:

```text
Layer 0 — Prompt library (this repo, global hydrate)
  skills: java, python, sql, aws, pipeline, engineer, ...
  agents: java-reviewer, aws-reviewer, security-sentinel, ...

Layer 1 — Enterprise overlay (~/.copilot/enterprise/ or second hydrate source)
  skills: terraform, splunk-queries, internal-api-wrapper, ...
  agents: splunk-reviewer, mainframe-reviewer, payments-domain-expert, ...
  instructions: *.instructions.md (corp naming, logging standards)
  knowledge/solutions: corp-specific compounded learnings

Layer 2 — Product repo (per service)
  docs/plans/, docs/agent-context.md, optional docs/solutions/
```

### Merge at runtime

Engineer (and `/start`) reads:

1. `knowledge/capability-registry.yaml` (base)
2. `enterprise/capability-registry.yaml` (overlay, if present)
3. Plan `## Risk & Review Routing` may name specialists: `splunk-reviewer`

**Hydrate task (future):** sync `enterprise/` from team git repo the same way as `.github/`.

---

## 6. How new skills are added (four paths)

| Path | When to use | Autonomous default (full profile) | Consent |
|------|-------------|-----------------------------------|---------|
| **A. Ship in library** | Reusable across all customers | N/A (maintainers) | Maintainer PR |
| **B. Enterprise overlay** | Corp-specific (Splunk, Terraform modules) | Platform team hydrates | Tier 3 for **new agents**; Tier 1 notify for new **skills** |
| **C. `/import-conventions`** | From internal repo / style guide | Engineer can invoke internally after import | Tier 1 notify |
| **D. `/create-primitive`** | After capability-gap | Auto-draft proposal; merge skill with notify | Tier 3 agents; skills/checks often Tier 1 |

### Capability-gap flow (engineer discovers missing skill)

```text
Task needs Terraform
  → registry: no terraform skill
  → engineer applies generic research + AWS/IaC docs via fetch
  → logs gap in plan Activity
  → auto-writes docs/capability-gaps/YYYY-MM-DD-terraform.md (draft)
  → Tier 1 notify: "Recommend /import-conventions from <corp-tf-repo>"
  → continues work OR waits per profile strict
```

**Hermes-style auto-skill** (optional Phase G): after **3** similar verified tasks, auto-generate `enterprise/skills/terraform/SKILL.md` from compounded solutions — **notify**, do not block.

---

## 7. How new specialist agents are added

| Step | Action | Autonomous? |
|------|--------|-------------|
| 1 | Create `.github/agents/splunk-reviewer.agent.md` (judgment criteria) | No — Tier 3 |
| 2 | Add to `enterprise/capability-registry.yaml` | Platform |
| 3 | Add `splunk-reviewer` to `engineer.agent.md` `agents:` | Tier 3 (allowlist change) |
| 4 | Add row to `engineer-delegation-matrix.md` | Same PR |
| 5 | Hydrate to `~/.copilot/enterprise/agents/` | CI or desktop task |
| 6 | Optional: add to `code-review-coordinator` allowlist | If used in review |

After step 5–6, `@engineer` can delegate:

```markdown
Delegate @splunk-reviewer: validate SPL against index=payments;
include subagent-context-packet; read-only.
```

**Direct access:** any user can `@splunk-reviewer` once hydrated — does not require engineer allowlist.

---

## 8. Domain routing table (engineer intake)

Engineer classifies **domains[]** and **specialists[]** at ingest (autonomous):

| Signals in request | Internal skill | Default specialists |
|--------------------|----------------|-------------------|
| `.java`, Spring, JVM | `/java` | `java-reviewer` |
| `.py`, pytest, asyncio | `/python` | `python-reviewer` |
| SQL, migration, Postgres | `/sql` | `sql-reviewer`, `data-integrity-guardian` |
| AWS, Lambda, SQS, IAM | `/aws` | `aws-reviewer` |
| Terraform, `.tf`, HCL | `/terraform` (enterprise) | `terraform-reviewer` (enterprise) |
| Splunk, SPL, index= | — | `splunk-reviewer` (enterprise) |
| Unknown domain | generic + research agents | `repo-research-analyst` |

Record in plan frontmatter (proposed):

```yaml
domains: [aws, java]
specialists: [aws-reviewer]
capability_gaps: [terraform]   # if skill missing
```

---

## 9. Answers to your scenarios (short)

**Q: Engineer started with Java/SQL; task is AWS?**  
**A:** AWS is already in the library. Engineer auto-routes to `/aws` + `@aws-reviewer`. No new skill learning — hydration already did it.

**Q: Task is Terraform?**  
**A:** Not in base library. Enterprise adds overlay skill via import or create-primitive; engineer uses gap flow until present. Optionally auto-draft skill after repeat work.

**Q: Need Splunk expert?**  
**A:** Add `splunk-reviewer` agent to enterprise overlay + engineer allowlist (Tier 3 once). Then engineer delegates autonomously on “validate in Splunk” tasks. Until then: `@splunk-reviewer` direct if agent exists, or researcher + user SPL.

**Q: Enterprise terminology / style?**  
**A:** `instructions/*.instructions.md` (auto by file pattern) + `knowledge/solutions/` + thin `docs/agent-context.md` per product — not a new slash command per term.

---

## 10. Implementation plan additions (for your confirmation)

See updated **Phase F & G** in `composer-style-autonomous-harness-proposal.md`.

| Phase | Deliverable |
|-------|-------------|
| **F1** | `enterprise/` overlay contract + `capability-registry.enterprise.yaml` template |
| **F2** | Engineer domain router + plan fields `domains`, `specialists`, `capability_gaps` |
| **F3** | Hydrate task merges enterprise layer |
| **F4** | `capability-gap` auto-draft to `docs/capability-gaps/` (product or enterprise repo) |
| **G1** | Optional auto-skill from 3× compounded solutions (enterprise only) |

**Consent unchanged:** new **agents** (Splunk expert) = Tier 3 once; new **skills** (Terraform workflow) = enterprise team can ship with notify under `full` profile.
