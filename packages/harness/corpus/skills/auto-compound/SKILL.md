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
harness verify --plan <path> --workspace . --json
```

Do not run on `failed` or `inconclusive`, with open hard gaps, or before required review is satisfied.

## Classify the learning

| Learning | Destination |
|---|---|
| Task-specific implementation detail | Plan Implementation Notes |
| Reusable fact or gotcha | Knowledge solution |
| Repository convention | Instruction or agent context candidate |
| Repeatable multi-step procedure | Skill candidate |
| Deterministic invariant | Check, hook, or CI candidate |
| Need for independent expertise | Specialist-agent candidate |
| External executable capability | Tool/integration candidate |

Append a structured recommendation to the plan:

```yaml
learning:
  destination: knowledge
  recurrence: possible
  candidate_primitive: skill
  candidate_name: spring-boot-jackson-migration
  evidence:
    - verification outcome passed
    - migration completed in one repository
  recommendation: record-now-promote-after-next-use
```

Fields `destination`, `recurrence`, `candidate_primitive`, `candidate_name`, `evidence`, and `recommendation` are required. Use `candidate_primitive: null` when no promotion is warranted.

## Promotion test

Recommend primitive creation only when at least one is evidenced: the procedure succeeded more than once; organizational strategy adopted it; multiple repositories need it; high risk warrants standardization; or repeated fragile steps are commonly missed. A one-time unfamiliar API, simple task, adequate upstream documentation, or overlap with an existing skill is not promotion evidence.

Every promoted skill must have 8–10 positive trigger evals, 8–10 negative/confusable evals, outcome assertions, and supported-host coverage. Primitive creation is a separate governed `/create-primitive` action.

## Persist

Write the selected plan/knowledge destination, then run:

```bash
harness compound --plan <path> --workspace . --json
```

The command consumes passed evidence, indexes knowledge, and records skill usage/outcome telemetry. Add 1–3 bounded Memory Cards with source paths. Report the evidence path, learning destination, and promotion recommendation.

## Debt check (session-end drain)

After persisting, run:

```bash
harness consolidate --status --json
```

When the packet reports `due: true`, invoke `/consolidate` before ending the session.
