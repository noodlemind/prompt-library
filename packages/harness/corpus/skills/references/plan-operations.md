# Plan decisions

The agent chooses intent, scope, tasks, acceptance criteria, check adequacy, research, risk, and whether observed work satisfies the goal. Harness writes their representation and applies state transitions. It does not infer authorization from a payload field.

Put structured decision files under `.harness/decisions/` and pass them with `--file`. Inputs are bounded JSON files. Use `harness help plan-new` and `harness help plan-update` for the installed contract. Keep plan operations separate from product mutations.

## Create

Use `harness plan-new --file <creation.json> --json`. A creation decision has version 1, format `full|short`, and a goal. Supply acceptance text, constraints, scope paths, the inspected named check, and selected intent-source paths. Optional full-plan fields include type, slug, title, risk, outputs, authored notes, and phases. Omit slug to let Harness derive it. Use open or needs-info status for an unlocked capture; such a draft can omit a check. Missing proof remains explicit.

```json
{
  "version": 1,
  "format": "full",
  "goal": "Reject invalid parser input.",
  "acceptance": ["Invalid input returns the documented error."],
  "scope": ["src/parser.js", "test/parser.test.js"],
  "check": "parser-behavior",
  "outputs": ["src/parser.js", "test/parser.test.js"],
  "notes": {"context": "Preserve the existing parser API."},
  "phases": [{"title": "Guard and proof", "tasks": ["Validate parser input.", "Exercise valid and invalid input."]}]
}
```

The example check must exist in the product's trusted configuration. A short plan requires acceptance and constraints. Harness chooses storage, writes the date, headings, IDs, unchecked task state, initial status and source bindings, and returns `path`, `revision`, `planState`, `missing`, and `allowedNextActions`.

## Update

Use `harness plan-update --plan <path> --file <decision.json> --json`. Every operation supplies version 1, a stable decision `id`, an `action`, and `expect` copied from the observed revision. Get that revision from plan creation, a preceding operation, or `harness status --contract-digest --plan <path> --json`. Do not calculate it in the model.

```json
{"version":1,"id":"start-accepted-work","action":"start","expect":"<observed revision>"}
```

Supported decisions:

| Action | Agent input | Harness operation |
|---|---|---|
| start | Accepted readiness and current revision | Validate readiness and scope, lock and start the plan, publish its implement gate, recover interrupted publication |
| amend | Rationale and accepted changes | Validate and serialize scope, goal, constraints, criteria/check bindings, reviews, notes, phases, or selected source-byte amendments |
| progress | Accepted criterion/task IDs and optional current phase | Record checked state and phase without fabricating proof |
| finding | Stable finding ID and accepted text | Append once; reject conflicting content under the same finding ID |
| gap | Existing gap ID, done fulfillment, evidence path, and rationale | Bind the evidence hash, update the gap and resulting state; leave waivers and bridges to trusted policy |
| complete | Decision to finish | Require current review, executed proof, learning decision, and completed tasks across all phases; publish completion and done state |

An amendment's `changes` can contain `scope`, `goal`, `constraints`, `criteria`, `reviews`, `notes`, or `phases`. Criteria use `{ "id": "AC1", "text": "...", "checks": ["named-check"] }`; omit a new ID to let Harness allocate it. Reviews cannot remove an existing code-review baseline. Phases use `{ "title": "...", "tasks": ["..."] }`; Harness numbers phases and generates task IDs such as P1T1. Existing unlabelled tasks can be addressed by their list IDs T1, T2, and so on.

Authored note keys are overview, context, memory, technical, research, routing, and implementation. Values contain prose or Markdown content without owned `##` headings. Harness creates or updates the corresponding section while preserving other reasoning. Progress uses `{ "criteria": ["AC1"], "tasks": ["P1T1"], "phase": 1 }`; omit fields that did not change. Accepted progress is a declaration. Executed verification remains a separate requirement.

## Selected intent bytes

New full plans use plan_schema 2. New short plans use short-v2. Both declare intent_source_policy content-v1. Source selection freezes when locked. Changed, missing, or unreadable selected bytes block current authority and invalidate proof. Relock never silently accepts them.

Accept a reviewed spec change with an amend decision, rationale, `authority` containing scope `plan-intent` and the basis for the decision, and `intentSources` containing `{ "path": "selected/spec.md" }`. Harness reads and records old/new hashes and affected evidence. Optional supplied oldHash/newHash values act as additional conflict guards. The authority field records the decision's scope; it grants no tool permissions.

Legacy plan_schema 1 and short-v1 retain their declared paths-only policy. Explicit migration uses `migrateIntent: true`, rationale, and plan-intent authority on an amend or start decision. Harness preserves an existing frozen selection and records upgraded bindings. Never describe a legacy plan as content-bound until migration succeeds.

## Recovery and completion

Missing prerequisites return blocked work and allowed next actions without a successful transition. A stale revision requires rereading before accepting a new decision. Retry the identical operation ID and payload after interruption; a completed retry returns the prior logical result. Reusing an ID with different content conflicts. Replaying start does not renew an expired gate.

After implementation and collected review, require passed `harness verify`. Record durable learning or explicit no-learning with `harness compound --learning-decision`. Submit complete only after all planned work is accepted. A completion record remains current only while its product, policy, contract, review, and selected source bindings remain valid.
