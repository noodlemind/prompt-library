# An AI engineer that grows with the team — and asks before it learns

> How our skill-driven prompt library and Adaptive Engineer Harness give the org a reusable, auditable AI engineering workflow that compounds — and why it matters whether you write code or not.

This is a self-contained writeup intended to be shared as a pre-read before the demo and as a recap after. Paste into Confluence, an internal blog, or a long-form Slack post. Replace bracketed placeholders with your org and team names.

---

## The problem

We've all seen what happens when AI assistants try to do everything from a single prompt. They are confident on the easy parts, vague on the hard parts, inconsistent across teammates, and there is no way to capture what worked so the next person benefits. Every engineer reinvents the prompt. Every team relearns the same lessons. Reviewers catch the same mistakes for the fourth time. Leadership has no visibility into what the AI is actually doing.

What we want instead is the experience of working with a disciplined senior engineer who joined the team last quarter: they use the conventions that already exist, they ask before they invent, and when the team learns something new, that knowledge sticks.

That is what this library is.

---

## What we built (in one paragraph)

A **skill-driven prompt library** that ships a network of named workflows (skills), specialist experts (agents), file-scoped conventions (instructions), and review criteria (checks) — all reusable across VS Code and IntelliJ via GitHub Copilot. On top of that sits the **Adaptive Engineer Harness**: an accountable coordinator agent, `@engineer`, that picks the right skill, delegates to the right expert, asks a human before risky decisions, and — when it hits something the library doesn't yet cover — writes a structured proposal asking us whether to add it. Approved proposals route to `/create-primitive`, which is the only path that creates new skills or agents. Everything is auditable, reviewable, and version-controlled.

---

## How it works in 60 seconds

Imagine someone asks `@engineer`: "Our migrations keep causing outages. Can we make this safer?"

1. **Understand** — `@engineer` restates the request and the local context.
2. **Route** — it picks the right existing skill: `/sql`, `/code-review`, `/work-on-task`, etc.
3. **Delegate** — for specialist judgment, it dispatches `@sql-reviewer`, `@data-integrity-guardian`, or others, each with a self-contained context packet so they need nothing from memory.
4. **Pause for approval** — before destructive operations, schema changes, or anything that expands the system's own capabilities, it asks the human first.
5. **Implement and verify** — it does the work, then proves the work with tests or evidence.
6. **Propose new capabilities** — if it discovers a recurring gap (this is the third time we've reviewed migrations by hand), it writes a **capability-gap proposal**: what's missing, what already exists that doesn't cover it, what should be added, and the risks. It does not create anything until a human approves.
7. **Compounding** — approved proposals flow into `/create-primitive`, which writes the new skill, agent, instruction, or check. The next person to ask the same question gets the answer for free.

The thesis is simple: **reuse before invention, approval before expansion, evidence before "done"**.

---

## What this means if you write code

You get a Copilot setup that has opinions — the team's opinions, captured as skills you can run with a slash command:

- `/capture-issue` → `/plan-issue` → `/work-on-task` → `/code-review` → `/compound-learnings` is the core engineering loop. Each step is auditable; each plan is a single Markdown file in `docs/plans/`.
- Domain skills: `/java`, `/python`, `/sql`, `/aws`. Each routes to the matching reviewer agent and applies our conventions automatically.
- Quick utilities: `/btw` for ad-hoc questions, `/tdd-fix` for test-driven bug fixing, `/codebase-context` to snapshot a new repo, `/triage-issues` to prioritize a backlog.

You stop writing the same prompt twice. When you discover a better pattern, you don't paste it in a doc that no one reads — you propose it as a primitive, get it approved, and now every teammate (and `@engineer` itself) benefits.

For reviewers: code review becomes confidence-scored and persona-based. Specialist reviewers (`@architecture-strategist`, `@security-sentinel`, `@performance-oracle`, `@data-integrity-guardian`, language-specific reviewers, and more) run in parallel, dedupe overlapping findings, and route action items back into the plan.

For tech leads: every plan file is a complete audit trail — context, acceptance criteria, impacted files, verification plan, risk routing, approvals, and review findings — in one place, in the repo, in Git.

---

## What this means if you don't write code

If you are a PM, designer, ops lead, or in leadership, the value is governance and clarity:

- **Approval is built in.** The AI is structurally unable to silently expand its own capabilities. Every new agent, skill, or instruction goes through a written proposal with risks, overlap check, and an approval decision recorded with reviewer name and date — visible in Git history.
- **Decisions are auditable.** Every plan and proposal is a Markdown file in the repository. There is no opaque AI memory; there is a paper trail you can read.
- **Knowledge compounds in public.** When the team learns something — a postmortem lesson, a security pattern, a migration playbook — it can become a primitive that everyone (and every future onboard) inherits without a meeting.
- **The work is legible.** Plan files have status fields, phases, and activity logs. You can tell at a glance what state any piece of work is in, who reviewed it, and what's blocking it.

In short: this is the version of AI tooling you would actually approve at the security review and the compliance review, because it was built with both in mind.

---

## The governance story (the part to share with leadership)

Three rules make the whole system safe and reviewable:

1. **`@engineer` proposes, never creates.** It cannot write a new skill or agent. It can only fill a structured proposal template and ask.
2. **`/create-primitive` is the only writer.** And it refuses to act unless the proposal has a recorded `Approved` decision with reviewer and date.
3. **Every primitive change is a Git commit.** The artifact is the audit log.

The result: the AI grows with the team, but only with the team's consent. No quiet drift, no surprise capabilities, no "the AI did it" excuses.

---

## The compounding story (the part to share with engineering)

We've all seen knowledge die on Slack and in postmortem docs. This library turns those moments into durable assets:

- A postmortem becomes a solution doc in `docs/solutions/`.
- A repeated review observation becomes a review check that runs automatically.
- A recurring workflow becomes a skill that every teammate can invoke with a slash command.
- A new domain (Kotlin, Terraform, gRPC) becomes a reviewer agent that catches issues we currently miss.

Each one is a one-time write that pays back every time anyone — human or `@engineer` — hits the same situation again. The library gets smarter as we use it.

---

## What's coming up

[Day], we will demo the Adaptive Engineer Harness in action: a real prompt, a real gap, a real proposal, a real approval, a real new skill — end to end in under 15 minutes. You will see `@engineer` stop and ask for permission to grow. That moment is the system's most important feature.

After the demo, the library is available for any team to hydrate into VS Code or IntelliJ. The hydration steps are in `AGENTS.md`. If your team has a recurring workflow, a recurring review miss, or a hard-won lesson you want to make reusable — bring it. That is exactly what `/create-primitive` is for.

---

## TL;DR

- We built a Copilot setup that uses the team's actual conventions instead of generic defaults.
- The accountable coordinator agent (`@engineer`) routes work to existing skills, delegates to specialists, and asks before risky moves.
- When something is missing, `@engineer` proposes — in writing, with risks and overlap analysis — and only after a human approves does `/create-primitive` create the new skill, agent, or instruction.
- Every plan, proposal, and approval lives in Git. Nothing is invisible.
- The library compounds: yesterday's lesson is tomorrow's default behavior.

---

## Suggested distribution

- **Before demo (T-2 days):** post the full blog with the line "Live demo [day, time, link] — come watch `@engineer` stop and ask permission."
- **After demo (same day):** repost with the recording, a screenshot of the filled capability-gap proposal, and a one-line CTA: "If your team has a recurring workflow, propose it as a primitive — happy to pair on it."
- **Channels:** #engineering, #leadership, #ai-tooling, plus the org-wide announcements channel.
