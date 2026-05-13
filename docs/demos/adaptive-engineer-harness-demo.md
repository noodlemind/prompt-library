# Demo: Adaptive Engineer Harness — Capability-Gap Proposal & `/create-primitive`

## Purpose

This document is the demo script for showing how the Adaptive Engineer Harness works — specifically how `@engineer` detects a missing reusable capability, drafts a written **capability-gap proposal**, pauses for human approval, and only then routes to `/create-primitive` to materialize a new primitive.

Audience: mixed (IC + tech lead + non-technical). Format: walkthrough first, then live run. Target primitive: **Skill**. Length: ~12 minutes.

For shareable narrative (pre-read and post-demo recap), see [`adaptive-engineer-harness-blog.md`](./adaptive-engineer-harness-blog.md).

---

## Concept (elevator pitch — 30 seconds)

> The harness treats `@engineer` as an accountable coordinator, not an oracle. Known work routes to known skills. Missing capability triggers a written proposal with overlap check, boundary justification, and risk analysis — then a human approval gate — then `/create-primitive` creates the new skill, agent, or instruction. The system grows on purpose, not by accident.

Three properties to emphasize:

1. **Skill-first** — reuse before invention. The engineer is required to run an overlap check first.
2. **Human-in-the-loop on capability expansion** — no new primitives without recorded approval.
3. **Knowledge compounds** — once approved and created, the new primitive is immediately reusable by every future invocation.

---

## Demo Structure (~12 minutes)

| Act | Duration | What you show |
|---|---|---|
| 1. The story | 1 min | Why this exists — the "disciplined senior engineer with a network of experts" framing |
| 2. Doc tour | 3 min | Three files: harness architecture, proposal template, `/create-primitive` decision rules |
| 3. The contract | 2 min | The approval-then-route pattern — why the engineer can't just create primitives |
| 4. Live run | 4 min | Type the sample prompt into Copilot Chat; watch `@engineer` produce a filled proposal |
| 5. Approval & creation | 2 min | Approve in the proposal's `## Human Decision` section; invoke `/create-primitive`; show the new skill |

---

## Act 1 — The story (open with this)

Say:

> "Most AI coding tools either know everything or know nothing. This one is built to behave like a senior engineer joining a new team: it uses what already exists, and when it hits something the team hasn't codified yet, it doesn't invent — it proposes, gets sign-off, then we add it together. So the system gets smarter under our control."

This is the line for the non-technical viewer. The next acts back it up.

---

## Act 2 — Doc tour (pin these three files in your editor)

Open each in order. ~1 min each.

### 2a. `docs/architecture/adaptive-engineer-harness.md`

- Read the **Purpose** (lines 3–7) aloud — that's the thesis.
- Show the **Runtime Model** (lines 11–20) — point at step 5 ("Ask the human for approval before risky decisions or capability expansion") and step 8 ("Record misses as capability gaps").
- Show the **Expansion table** (lines 22–32) — note every row says "Approval: Required".
- Show the **Human-In-The-Loop Gates** (lines 44–52). Highlight bullet 1: "Creating or changing prompt-library primitives."

### 2b. `.github/skills/references/capability-gap-proposal.md`

- Read the intro (lines 1–3): "Do not create or modify primitives until the proposal is reviewed and approved."
- Walk the **Usage Workflow** for `@engineer` (lines 7–14) — six numbered steps, ending with "Ask the human liaison for approval; do not edit any primitive yet."
- Scroll through the template sections quickly: Summary → Trigger Evidence → **Existing Primitive Check** table (lines 43–55) → Proposed Primitive → Behavior Contract → Risks → Validation Coverage → **Human Decision** (lines 95–100).
- Pause on the **Existing Primitive Check** table. Say: "This forces a check across skills, agents, instructions, prompt wrappers, review checks, references, and solution docs before anything new is proposed. Reuse is the default."

### 2c. `.github/skills/create-primitive/SKILL.md`

- Show that `/create-primitive` **refuses to act** without a filled proposal (workflow lines 16–22 of the proposal template: "If the proposal is missing or incomplete, stop and produce the missing sections instead of creating files. … Confirm human approval is recorded in the `## Human Decision` section before writing or changing the primitive.")
- Show the decision table mapping primitive intents → primitive type (Skill / Agent / Instruction / Prompt wrapper / Review check / Reference / Solution doc).

---

## Act 3 — The contract (one slide-worth of words)

State plainly:

> "There are exactly two rules. One: `@engineer` proposes, never creates. Two: `/create-primitive` is the only path that creates, and only after the proposal has a recorded `Approved` decision with reviewer and date. Anything else is rejected."

This is the line for the tech lead — it's a governance story.

---

## Act 4 — Live run: the sample prompt

Open GitHub Copilot Chat (VS Code) and invoke `@engineer` with this prompt. It's chosen because it (a) is plausibly team-real, (b) is recurring not one-off, (c) clearly maps to a Skill and not an agent or check, and (d) forces the overlap-check to pay off.

### Sample prompt to paste

```
@engineer We've had three Postgres migrations this quarter that caused
partial outages: a NOT NULL backfill that locked the table, an index
build that wasn't CONCURRENT, and a column drop that broke the previous
deploy. Every time, the author and I do the same review by hand —
locking, backfill batching, online vs blocking DDL, rollback safety,
deploy ordering. I want this to be reusable so any teammate gets the
same review without pulling me in.
```

### What the audience should see `@engineer` do (in order)

1. **Restate** the request and note the recurrence ("three migrations this quarter" = signal, not a one-off).
2. **Run the overlap check** — speak through the existing primitive table:
   - Skills: `/sql` exists but is general; `/code-review` runs `sql-reviewer` but only at review-time, not authoring-time.
   - Agents: `sql-reviewer` and `data-integrity-guardian` exist for *review* judgment; not an authoring workflow.
   - Instructions: PostgreSQL instructions auto-load by file pattern but don't give a step-by-step migration authoring workflow.
   - Checks, references, solution docs: none specifically for online-migration authoring.
   - Conclusion: gap is a **reusable authoring workflow**, which maps to a **Skill**.
3. **Draft the proposal** by filling `.github/skills/references/capability-gap-proposal.md`, including:
   - **Trigger Evidence**: quote the three migrations.
   - **Proposed Primitive**: Skill `/postgres-migration-safety` at `.github/skills/postgres-migration-safety/SKILL.md`.
   - **Boundary reason**: "Repeated workflow with checklist + generator + reviewer protocol — fits Skill, not Agent. No separate judgment, isolation, or tool authority needed beyond what `/sql` already has."
   - **Behavior Contract**: should trigger on migration authoring requests; should NOT trigger on read-only query work or schema design without migration intent.
   - **Validation Coverage**: 3 should-trigger scenarios (online DDL, backfill, rollback) + 3 should-not-trigger scenarios (SELECT tuning, view creation, app-side data fix).
4. **Present the proposal and pause** with an `## Approval Needed` block.

This is the demo's punchline: the engineer *stops*. Point at the screen and say "watch — it's waiting."

---

## Act 5 — Approval & creation

1. Approve in the proposal's `## Human Decision` section: `Decision: Approved`, your name, today's date, any conditions.
2. Invoke `/create-primitive` referencing the approved proposal.
3. Show `/create-primitive` doing its checks — read proposal, verify approval, apply decision rules, then write `.github/skills/postgres-migration-safety/SKILL.md` using `.github/skills/references/skill-template.md`.
4. Show the new skill appears in `/` autocomplete in Copilot Chat — it's immediately usable.
5. Close with: "The next time anyone on the team writes a migration, they get the same review I would have given. That's the compounding."

---

## Talking points by audience (use as the moment fits)

**Non-technical:** "It's a safety governor on capability growth. The AI can't quietly grow new abilities — every new ability is a small written proposal that you approve like a PR."

**Tech lead / EM:** "This is the same control plane as code review, applied to the agent's own capabilities. The proposal is the artifact, the approval is auditable, and `/create-primitive` is the only writer. Reuse-first prevents primitive sprawl."

**Engineer / IC:** "Look at the overlap-check table — it forces the engineer to justify why an existing skill, agent, instruction, or check isn't enough. That's the part that keeps the library coherent instead of accreting near-duplicates."

---

## Files to pin in your editor before starting

- `docs/architecture/adaptive-engineer-harness.md`
- `.github/skills/references/capability-gap-proposal.md`
- `.github/skills/create-primitive/SKILL.md`
- `.github/agents/engineer.agent.md` (have ready in case someone asks "where does this behavior live?")

---

## Backup sample prompts (if the audience wants a second example)

- **Toward an Agent** (boundary-reason demo): "We need a Kotlin reviewer — none of our current reviewers handle Kotlin idioms, null safety, or coroutine misuse. The Java reviewer flags false positives." → forces `@engineer` to justify Agent (separate judgment) over Skill.
- **Toward a Review Check**: "We've shipped three regressions from Kafka consumers without DLQ wiring. I want this caught in review, not in production." → narrower scope, maps to a check under `.github/skills/code-review/references/checks/`.
- **Toward a Solution doc** (lightest weight): "I just figured out why our Lambda cold starts spiked after switching to ARM — bundle layout. Capture this." → maps to `docs/solutions/aws/lambda-arm-cold-start.md`, no skill needed.

These let you show that the **type of primitive depends on the boundary**, not on what the user asked for.

---

## Verification (confirm the demo will work before going live)

1. Open VS Code with Copilot Chat enabled and the prompt library globally hydrated.
2. Type `@` and confirm `@engineer` shows up; type `/` and confirm `/create-primitive` shows up.
3. Dry-run the sample prompt in a scratch chat. Confirm `@engineer`:
   - quotes the trigger evidence,
   - fills the overlap-check table,
   - proposes a Skill (not an Agent), and
   - stops at the approval gate.
4. Confirm `/create-primitive` refuses to act if `## Human Decision` is blank — that's the most impressive part for the audit-minded viewer. Test this once before the demo so you can show it on purpose if asked.
5. Have the three pinned files already open in tabs to avoid fumbling during Act 2.

If any of the above fails, the most likely cause is the prompt-library not being hydrated into `%USERPROFILE%\.copilot` (VS Code) — check `AGENTS.md` for hydration steps.
