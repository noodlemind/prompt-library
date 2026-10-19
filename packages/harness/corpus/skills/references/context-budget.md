# Context selection and budgets

Start with the task contract and a compact orientation. Expand evidence when a requirement, dependency, failure, or unresolved question needs more information. A small pack does not prove that the agent has enough evidence.

## Initial budgets

| Tier | Initial budget | Content |
|---|---|---|
| F0 Frozen | 600-900 estimated tokens | Engineer identity, modes, delivery lifecycle, required policy, and core actions |
| F1 Recall | 2048-byte context pack | Task contract, gate preview, selected facts, and expansion reference |
| F2 Plan slice | About 1500 estimated tokens | Complete constraints and acceptance criteria, current tasks, and relevant decisions |
| F3 On demand | Bound each request | Needed skill procedures, source excerpts, checks, and supporting references |

These budgets guide initial loading. If mandatory content exceeds a budget, report the barrier and read its source. Do not shorten accepted constraints to fit. The host can add instructions, tools, and history outside the pack.

## Select and expand evidence

Use `harness orient --read --context-version 2 --query <task> --file <path>` before product edits. Version two reports source identities, omissions, scan limits, and the task contract. The default read format remains available to existing clients.

Use a returned `path@sha256:<hash>` reference with `get --path <reference> --context-version 2`. A changed source requires fresh selection. Version two adds a source range and bounded declaration, import, type, or document-heading candidates. These candidates do not prove semantic completeness.

Start with at most three relevant memory matches. Read the required section or next window when an excerpt lacks needed evidence. Broader relevant files are permitted within the task scope. Avoid repeated whole-file reads when a named section resolves the question.

Keep required policy resident. Load a skill procedure when its trigger applies, then load its references as needed. Do not reload a duplicate copy of instructions the host already supplied.

## Preserve task state

The existing plan and evidence records own accepted intent, constraints, decisions, progress, unresolved work, and proof. After compaction or restart, reorient and reload their current state. A summary cannot amend accepted intent or make old source facts current.

Read relevant Research Notes and Review Findings before continuing unresolved work. Read Activity entries when their history resolves a question. Keep source references for omitted material.

## Retain bounded memory

Keep Memory Cards within 15 bullets and 1200 characters. Give each claim a source. Keep the profile under 1500 characters. These summaries guide retrieval and do not replace source evidence.

## Measure the complete task

Separate produced artifacts, runtime requests, and host observations. Count retries and failed attempts. Keep estimates and unavailable input distinct from observed usage. A cached request does not establish relevance or retained task knowledge.

The optional headless runtime exposes `--context-policy legacy|selective|subsystem` and `--retention-policy legacy|structured`. Defaults remain legacy. Evaluate task quality and total cost before changing a default. Native host compaction remains host-controlled unless an integration proves otherwise.
