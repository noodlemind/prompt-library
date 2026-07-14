# Capability Catalog Review

## Scope

Review performed 2026-07-13 against all current skill and agent sources, the Engineer runtime surfaces, prompt wrappers, references, hooks, and the capability registry. The goal was to remove duplicated ownership while preserving distinct procedures and independent judgment.

## Decisions

| Capability or overlap | Decision | Rationale |
|---|---|---|
| `engineer.agent.md` vs `engineer-autopilot` | Retired `engineer-autopilot` | It repeated the complete runtime loop; the agent is now the only normative owner. |
| `engineer.agent.md` vs `engineer-runtime.md` | Retired `engineer-runtime.md` | Its phase/route table was a second runtime contract. |
| `engineer` skill and prompt wrapper | Retained as thin adapters | Host discovery/routing is distinct from runtime procedure. |
| `/btw` vs `@engineer` | Retained with explicit task-mode boundary | `/btw` owns quick read-only Q&A; Engineer Investigate owns deeper evidence-only work; either must transition to Deliver before edits. |
| `tool-native-loop.md` vs harness contract | Reduced tool-native loop to integration notes | Command semantics belong to `harness-tool-contract.md`. |
| `work-on-task` vs `@engineer` | Narrowed `work-on-task` | It now executes/resumes a locked plan only; ordinary unplanned ownership stays with Engineer. |
| `ensure-plan` vs `plan-issue` | Retained | `ensure-plan` is internal orchestration; `plan-issue` is the detailed planning procedure and explicit pipeline surface. |
| `ensure-capability` vs `create-primitive` | Retained with boundary | Gap resolution is on demand; primitive creation is separate, governed, and promotion-evidence based. |
| `auto-compound` vs `compound-learnings` | Retained with boundary | Auto-compound classifies/routes learning; compound-learnings writes a solution document. |
| Domain skills vs domain reviewers | Retained | Skills encode procedures; reviewer agents provide independent judgment. |
| `code-review` skill vs coordinator/reviewers | Retained | Skill owns synthesis protocol; coordinator and specialists supply isolated review judgments. |

## Registry corrections

- Added every current skill and agent, including actors previously absent from the starter lists.
- Added owner, lifecycle state, version, and origin to every entry.
- Added richer triggers and eval-suite pointers for core/confusable skills.
- Retained `engineer-autopilot` only as a retired tombstone and added its hydrated cleanup path.

## Follow-up rule

Review the catalog when a capability is promoted, deprecated, or shows persistent trigger overlap. Prefer refining an existing primitive over adding a near-duplicate. Retirement must update source, routing, evals, registry, assets, and `retired.json` together.
