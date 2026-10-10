---
name: auto-compound
description: Internal post-success learning classifier. Use only after harness verify passes to route durable learning and recommend, but never directly create, reusable primitives.
user-invocable: false
---

# Auto Compound

## Trigger Examples

**Should trigger:**

- "Verification passed; classify what this task taught us."
- "Route the durable learning from this completed plan."
- "Record post-success learning and decide whether promotion is warranted."

**Should not trigger:**

- "Verification failed; summarize what happened." → fix verification first
- "Create a new reusable skill now." → use `/create-primitive` after approval
- "Review this implementation." → use `/code-review`

## Confusable Boundaries

- `/auto-compound` is the Engineer's internal, automatic post-success classifier and recorder.
- `/compound-learnings` is the manual, user-invoked learning publication workflow.
- `/create-primitive` governs approved primitive creation; classification never creates one directly.
- `/code-review` evaluates work before learning is compounded.

## Gate

Require explicit passed evidence:

```bash
harness status --validate-evidence --plan <path> --workspace . --json
```

Do not run on `failed` or `inconclusive`, with open hard gaps, or before required review is satisfied.

## Classify the learning

| Learning | Destination |
|---|---|
| Task-specific implementation detail | Plan Implementation Notes |
| Reusable fact or gotcha | Knowledge solution |
| Repository convention | Instruction or agent context candidate |
| Reusable deterministic operation | Harness CLI candidate |
| Contextual judgment protocol | Skill candidate |
| Deterministic invariant | Check, hook, or CI candidate |
| Need for independent expertise | Specialist-agent candidate |
| External executable capability | Tool/integration candidate |

Supply a learning decision to Harness with an approved private/global publication destination or dormant ship-set proposal. See [learning-operations.md](../references/learning-operations.md). Record recurrence evidence and any candidate_primitive, candidate_name, and recommendation as proposals. Keep the learning outside the work contract:

```json
{
  "operation": "task-learning-1",
  "decision": "publish",
  "scope": "private",
  "rationale": "A durable, reusable lesson was demonstrated by this task",
  "title": "Task-specific lesson",
  "category": "testing",
  "body": "Evidence, root cause, correction, and applicability in Markdown"
}
```

Use `decision: "no-learning"` with a rationale when no durable lesson exists. It produces no episode. Operation IDs support safe replay; reuse an ID only for the same decision and proof. Promotion recommendations are proposals, never activation authority.

## Promotion test

Recommend primitive creation only when at least one is evidenced: the procedure succeeded more than once; organizational strategy adopted it; multiple repositories need it; high risk warrants standardization; or repeated fragile steps are commonly missed. A one-time unfamiliar API, simple task, adequate upstream documentation, or overlap with an existing skill is not promotion evidence.

Every promoted skill must have 8–10 positive trigger evals, 8–10 negative/confusable evals, outcome assertions, and supported-host coverage. Primitive creation is a separate governed `/create-primitive` action.

## Persist

Pass the JSON decision file to the writer:

```bash
harness compound --plan <path> --learning-decision <file> --workspace . --json
```

The command validates current proof, publishes through the existing writer, and reports the persisted destination and index or dormant proposal result. Never edit learning frontmatter before publication or rerun tests for bookkeeping. Report actual evidence and publication outcomes.

## Debt check (session-end drain)

After persisting, run:

```bash
harness consolidate --status --json
```

When the packet reports `due: true`, invoke `/consolidate` before ending the session.
