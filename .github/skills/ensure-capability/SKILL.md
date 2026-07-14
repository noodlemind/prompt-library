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
5. For a hard gap, set the affected work to `blocked-capability` until fulfillment, an approved bridge, or an explicit waiver is recorded.
6. Resume unrelated safe work when the gap is limited to one operation or criterion.

## Plan record

```yaml
capability_gaps:
  - id: secure-schema-review
    class: hard
    required_for: AC4
    fulfillment: pending
    evidence: ["docs inspected", "missing required reviewer"]
```

Allowed fulfillment values are `pending`, `bridge`, `done`, or `waived`. A waiver quotes the human decision and scope.

## Promotion boundary

Solving an unfamiliar API once produces plan notes or knowledge, not a skill. Route to `/create-primitive` only after verified promotion evidence shows recurrence, strategic adoption, cross-repository need, high-risk standardization value, or repeated fragile steps.

## Output

Return the gap classification, affected criterion, chosen response, evidence, remaining restriction, and next safe action. The Engineer evaluates the result and owns the final decision.
