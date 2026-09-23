# Delivery principles

Read this file before the first edit of a Deliver task. Name a principle in the report only after reading its section. The harness does not treat the name as proof.

| Name | Rule |
|---|---|
| smallest-change | Make the smallest change that solves the problem. |
| prove-with-evidence | A pass is the named check output, not a claim that it passed. |
| behavior-not-implementation | Tests assert the observed behavior. |
| bind-before-lock | The routing snapshot on the plan is the contract. |
| classify-inputs-only | Classification proposes paths, risk, domains, and a playbook. Policy binds procedure names. |
| pointers-not-bodies | Context carries paths. It does not paste skill or principle bodies. |
| harness-never-calls-a-model | Routing, plan creation, indexing, and projection do not start a model client. |
| legacy-stays-valid | A locked plan without `routing:` does not gain a new failure. |
| attack-the-premise | After two failed fixes that share one premise, stop and list who holds that premise. |
| subtract-before-you-add | Remove the dead path before adding a new one. |
| build-the-lever | A repeated edit becomes a script or check a reviewer can rerun. |
| model-the-domain | Choose the data shape before writing the logic that uses it. |
| sequence-verifiable-units | Each commit ends in a state someone can check. |
| ask-only-when-undrivable | Ask the owner only with a stated reason the product surface could not answer the question. Gate denial and destructive actions still stop. |

## smallest-change

See `AGENTS.md` coding standards. Three similar lines are enough until a fourth appears.

## prove-with-evidence

See `docs/adaptive-engineer-harness.md`. Run the checks named on the plan. Paste the result that shows the pass.

## behavior-not-implementation

Assert what a caller observes. A test that only mirrors the current private structure does not lock the behavior.

## bind-before-lock

`evaluateRouting` writes the snapshot. Later steps read it. They do not match the live policy again.

## classify-inputs-only

The host sub-agent returns the classification object. `harness plan-new --classification` validates it. A glob match wins a disagreement.

## pointers-not-bodies

Orient and SessionStart name files to read. They do not inline the skill.

## harness-never-calls-a-model

`plan-new`, `route`, orient, hooks, and the index builders do not start a provider. The optional agent switch is outside delivery routing.

## legacy-stays-valid

R1 checks a snapshot when the plan has one. A plan locked before routing existed stays valid.

## attack-the-premise

If two fixes fail for the same reason, the premise is the next thing to test. Do not ship a third patch on top of it.

## subtract-before-you-add

Delete the unused branch, flag, or copy before introducing a replacement.

## build-the-lever

When the same edit would be repeated, leave a check or script that a reviewer can run.

## model-the-domain

Name the type, table, or state machine in the plan before the implementer writes behavior around it.

## sequence-verifiable-units

For a bug, land the failing repro before the fix. For a feature, keep each commit independently checkable.

## ask-only-when-undrivable

Drive the real surface first. A question to the owner includes the reason that surface could not reach the answer. Approval for a destructive action, and a denied gate, still wait.
