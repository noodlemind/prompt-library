# Engineer Operating Model

## Purpose

`@engineer` is the accountable generalist for substantial investigation and software delivery. It first selects a task mode, then applies only the controls required by that mode. A skill or specialist may improve one part of the work; neither assumes ownership of the outcome.

## Task modes

| Mode | Use | Runtime contract |
|---|---|---|
| Answer | Quick repository or general question | Route to `/btw`, gather minimal context, answer without plans or edits |
| Investigate | Evidence-heavy diagnosis or research with no requested change | Inspect proportionally, report evidence and uncertainty, create no delivery plan |
| Deliver | Any request that changes files or implements an outcome | Use the canonical nine-step delivery lifecycle, plan gate, verification, and eligible compounding |
| Review | Independent assessment of finished changes | Route to `/code-review`; do not assume implementation ownership |

Mode is selected before acting. Answer or Investigate must transition to Deliver before the first requested file mutation. This keeps conversational work fast while making the mutation boundary explicit and enforceable.

## Engineer accountability

The Engineer owns the final decision and any delivery completion claim. It may delegate bounded research, implementation, or review, but must evaluate the response against repository evidence, reconcile disagreements, run deterministic verification after changes, and disclose remaining risk. Failed or inconclusive required delivery verification is never reported as done. Read-only work reports its evidence and uncertainty without claiming implementation completion.

The normative nine-step delivery lifecycle lives only in [the Engineer agent](../../.github/agents/engineer.agent.md). This document explains the architecture; it does not redefine that sequence.

## Component ownership

| Component | Normative responsibility |
|---|---|
| `engineer.agent.md` | Task-mode boundary, delivery lifecycle, accountability, guardrails, and consultation policy |
| `harness-tool-contract.md` | CLI commands, inputs, outputs, and exit semantics |
| Individual `SKILL.md` | The reusable procedure owned by that skill |
| `tool-native-loop.md` | Host/CLI integration notes, without a second runtime loop |
| Architecture documents | Rationale, boundaries, modes, and diagrams |
| Plans | Durable goal, scope, progress, risk, and verification contract |
| Knowledge | Verified facts, decisions, failures, and prior solutions |
| Hooks and CI | Enforcement independent of prompt compliance |
| Capability registry | Discoverable ownership and lifecycle inventory, never a mandatory preflight checklist |

## Gap classification

Capability handling is proactive only when a task explicitly requires specialized capability or before high-risk security, data, concurrency, infrastructure, or destructive work. Otherwise it is reactive to uncertainty or a blocker.

| Gap | First response | Escalation |
|---|---|---|
| Missing fact or API knowledge | Inspect code and authoritative documentation | Bounded research consultation |
| Unfamiliar language or framework | Inspect repository conventions, docs, and relevant installed skills | Domain expert consultation |
| Specialized judgment | Consult the relevant specialist | Independent review |
| Repeatable procedure | Search installed skills | Import or draft after promotion evidence passes |
| Missing executable capability | Find an approved tool or integration | Propose a governed integration |
| Missing organizational convention | Search instructions and knowledge | Propose an instruction or deterministic check |
| Safety-critical capability | Stop only the affected operation | Require expert review or an explicit recorded waiver |

Optional capability absence does not block ordinary work. A hard gap is limited to the acceptance criterion or operation that requires it; unrelated safe investigation and work may continue.

## Consultation contract

Consult when separate judgment, high-risk expertise, independent review, cleanly bounded parallel research, or different tool authority materially improves the result. Do not consult for routine inspection, mechanical edits, simple decisions, or facts readily available in code or documentation.

Every consultation packet states the question, relevant goal and acceptance criterion, evidence and files already inspected, constraints and risks, and expected response format. The Engineer evaluates and integrates the response rather than forwarding it as truth.

## Runtime modes

### Standalone mode

The host has the Engineer primitives but the repository has not adopted governed plan/CI configuration. Read-only modes remain lightweight. Deliver mode still follows the canonical lifecycle, uses direct repository tests, and labels any unavailable governance check. Trackable delivery should create a plan when the repository permits it.

### Degraded mode

An optional skill, specialist, hook, or integration is unavailable. Ordinary low-risk work continues using repository evidence and authoritative documentation. Missing required verification makes the result `inconclusive`; a missing safety-critical capability blocks the affected operation unless a waiver is recorded.

### Governed mode

The repository supplies a versioned plan, trusted named checks, hooks where supported, and required CI. `harness gate --plan` controls preconditions; `harness verify --plan` runs checks, validates plan-to-diff scope, and writes evidence; compounding consumes only passed evidence.

## Duplicated-loop inventory

| Previous artifact | Decision |
|---|---|
| `engineer.agent.md` | Canonical task-mode boundary and delivery lifecycle |
| `engineer-autopilot/SKILL.md` | Retired; duplicated runtime ownership |
| `engineer-runtime.md` | Retired; duplicated phase and route tables |
| `engineer-session-checklist.md` | Non-normative binary assertions, tested against the canonical agent |
| `engineer/SKILL.md` | Thin host-facing entry adapter |
| `work-on-task/SKILL.md` | Locked-plan execution and resumption only |
| `ensure-plan/SKILL.md` | Detailed plan creation and locking |
| `ensure-capability/SKILL.md` | On-demand gap resolution |
| `auto-compound/SKILL.md` | Post-success learning classification |
| `tool-native-loop.md` | Short CLI integration explanation |

## Learning and promotion

Learning flows `solve → verify → compound → promote when reusable`. Task-specific details stay in the plan; reusable facts become knowledge; repository conventions become instructions or context; repeatable procedures become skill candidates; deterministic invariants become checks, hooks, or CI. Primitive creation remains a separate governed action and requires evidence described in [Capability Lifecycle](capability-lifecycle.md).
