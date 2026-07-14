# Capability Lifecycle

## Purpose

The capability registry is a discovery and governance inventory, not a checklist loaded before every task. Skill frontmatter remains the primary progressive-disclosure trigger. Registry entries add ownership, lifecycle, overlap, eval, usage, and promotion history.

## States

```text
candidate → experimental → active → deprecated → retired
```

| State | Meaning | Entry requirement | Exit requirement |
|---|---|---|---|
| `candidate` | Proposed capability, not shipped | Gap and overlap analysis | Promotion decision or rejection |
| `experimental` | Available to limited users | Owner, version, promotion evidence, initial trigger eval and outcome eval | Successful trials and quality thresholds |
| `active` | Supported capability | Named owner, current evals, documentation, verification evidence | Replacement or evidence that value no longer justifies support |
| `deprecated` | Still discoverable, migration underway | Replacement, rationale, deprecation date | Migration window completed |
| `retired` | Source removed; registry tombstone retained | Retirement date, replacement or reason, hydrated cleanup entry | Terminal |

## Promotion workflow

1. Solve the real task using code, documentation, an installed skill, an expert, or an approved tool.
2. Produce passed deterministic verification evidence.
3. Classify the learning with `/auto-compound` and record a candidate without creating it.
4. Show promotion evidence: repeated success, strategic adoption, multiple-repository demand, high-risk standardization, or repeated fragile steps.
5. Check overlap with every existing primitive and name the owner.
6. Add 8–10 positive trigger evals, 8–10 negative/confusable trigger evals, outcome eval assertions, and host coverage.
7. Create the primitive through `/create-primitive` after the required human governance decision.
8. Register as `experimental`, collect usage/outcome telemetry, then activate only when eval and task outcomes support it.

One unfamiliar API, a simple one-off task, adequate upstream documentation, or a duplicate procedure is not promotion evidence.

## Deprecation workflow

1. Identify the replacement or explain why no replacement is required.
2. Mark `deprecated`, add overlap/migration notes, and stop recommending the capability for new work.
3. Keep compatibility long enough for hydrated users to migrate.
4. Monitor use; unexplained continuing use blocks retirement.

## Retirement workflow

1. Confirm the migration window and owner approval.
2. Remove the source primitive and references from active routing, eval, and documentation.
3. Add the hydrated path to `packages/harness/retired.json`.
4. Retain a `retired` registry tombstone with date, reason, and replacement.
5. Verify packaged assets no longer contain the retired primitive.

## Telemetry

`harness compound --plan` reads `skills_used` from the verified plan and updates hydrated `knowledge/skill-usage.yaml` with usage count, last use, last plan, and passed/failed/inconclusive outcome counters. Harness events preserve per-run verification outcomes. Telemetry informs lifecycle review; it never overrides quality or safety evidence.
