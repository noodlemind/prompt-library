---
name: ensure-capability
description: Internal on-demand gap-resolution procedure. Use when a task explicitly requires specialized capability, high-risk work needs assurance, or uncertainty/blockage is encountered. Not a session-start checklist.
user-invocable: false
---

# Ensure Capability (on demand)

## Activation

Resolve gaps when encountered. Invoke only when:

- the acceptance criteria explicitly require a skill, specialist, convention, or tool;
- security, data, concurrency, infrastructure, or destructive work needs capability assurance; or
- investigation encounters unresolved uncertainty or an executable blocker.

Do not scan or load the full registry before ordinary work. Missing optional capability never blocks low-risk work.

### Trigger examples

**Should trigger:**

- An acceptance criterion requires a security review capability that is not currently available.
- A destructive database migration needs independent data-integrity assurance.
- Investigation reaches an executable blocker after repository evidence and authoritative documentation are exhausted.

**Should not trigger:**

- A routine low-risk change can proceed with current repository patterns and tests.
- A quick read-only question needs `@engineer` Answer mode, not capability acquisition.
- A one-off unfamiliar API can be resolved from authoritative documentation without creating or importing a primitive.

### Confusable boundaries

- `/ensure-capability` resolves a specific encountered gap; `/ensure-plan` establishes the work contract.
- `/create-primitive` creates an approved reusable artifact only after promotion evidence; one gap is not promotion evidence.
- `/harness-doctor` diagnoses installed harness health; it does not fulfill task-specific expertise or tool gaps.

## Gap classification

| Gap | First response | Escalation |
|---|---|---|
| Missing fact or API | Inspect code and authoritative docs | Bounded research consultation |
| Unfamiliar framework | Inspect repository conventions, docs, and one relevant skill | Domain expert |
| Specialized judgment | Consult the relevant specialist | Independent review |
| Repeatable procedure | Search installed skills | Import or draft after promotion evidence |
| Missing executable capability | Find an approved tool or integration | Governed tool proposal |
| Missing organizational convention | Search instructions and knowledge | Instruction or check proposal |
| Safety-critical capability | Stop the affected operation | Expert review or recorded waiver |

## Resolution workflow

1. State the blocked criterion or decision, evidence already inspected, and why direct investigation is insufficient.
2. Classify the gap as `soft`, `bridge`, or `hard` and record it on the explicit plan.
3. Choose the smallest response from the table. Consultations use `subagent-context-packet.md`.
4. For a repeatable capability candidate, search existing skills and registry overlap before drafting anything.
5. For a hard gap, record its affected criterion or operation and stop only that scope until fulfillment, an approved bridge, or an explicit waiver is recorded.
6. Keep the plan `in-progress` while unrelated safe work remains. Use plan-level `status: blocked-capability` only when no executable safe work remains.

## Plan record

```yaml
capability_gaps:
  - id: secure-schema-review
    class: hard
    required_for: AC4
    scope: criterion
    fulfillment: pending
    evidence: ["docs inspected", "missing required reviewer"]
```

Allowed scope values are `operation`, `criterion`, or `plan`. Allowed fulfillment values are `pending`, `bridge`, `done`, or `waived`. A waiver quotes the human decision and scope. `scope: plan` is required before setting the entire plan to `blocked-capability`.

## Promotion boundary

Solving an unfamiliar API once produces plan notes or knowledge, not a skill. Route to `/create-primitive` only after verified promotion evidence shows recurrence, strategic adoption, cross-repository need, high-risk standardization value, or repeated fragile steps.

## Output

Return the gap classification, affected criterion, chosen response, evidence, remaining restriction, and next safe action. The Engineer evaluates the result and owns the final decision.
