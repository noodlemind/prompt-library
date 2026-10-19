---
name: ensure-plan
description: Internal plan creation and locking procedure for trackable work. Use when no suitable explicit plan exists or a matched plan is unlocked; not for execution, review, or capability discovery.
user-invocable: false
---
# Ensure Plan (internal)

Bridge capture and planning for Engineer Deliver mode. Decide intent, scope, criteria, check adequacy, research needs, and risk. Harness owns plan representation and transitions.

## Trigger Examples

**Should trigger:**
- "Implement this feature" when no suitable plan exists.
- "Continue this task" when the matched plan is open and unlocked.
- "Make these trackable changes" when required intent or proof inputs are missing.

**Should not trigger:**
- "Log this issue for later." Use /capture-issue.
- "Research this captured issue." Use /plan-issue.
- "Execute this locked plan." Use Engineer Deliver mode.

## Confusable Boundaries

Capture records the problem. Planning chooses the approach. Engineer executes the accepted plan. /ensure-capability handles encountered capability gaps.

## Proportional planning

Use concise content for one or two intended product files, expected completion in one session, a user-supplied target or reference, no architectural choice, and focused trusted verification. Use one phase and no broad repository scan. Consult a specialist only when its judgment is needed.

Escalate when investigation reveals a data migration, security or concurrency implications, compatibility risk, more affected files, or unclear verification. Choose full or short representation through the same CLI contract; both require current proof.

## Establish the decision

1. Use `ae lookup` or `ae orient --read` to retrieve existing plans. Judge semantic overlap before creating another work item.
2. Read selected specs and relevant /recall evidence. Resolve ambiguity from available sources. If required intent remains ambiguous, capture an unlocked needs-info draft and state the missing decision.
3. Read `.github/harness/checks.yaml` and inspect each candidate assertion. Never invent a named check. A schema-validation check is inadequate when no schema output is planned. Choose a relevant trusted check and explain any limitation.
   For a visible behavior change, inspect orient's verification metadata and read the selected recipe. Resolve an ambiguous or incomplete inventory through an explicit accepted selection. Read [product-verification.md](../create-primitive/references/product-verification.md) when creating or updating the recipe or feature map. Choose affected features and shared prerequisites, then bind their named drives to criteria. Create a missing recipe only within the Deliver plan's accepted scope. Answer mode does not create plans or recipes.
4. Use `ae plan-new --file <creation.json> --json` for new work. Use `ae plan-update --plan <path> --file <decision.json> --json` for accepted amendments, reasoning, phases, progress, findings, gaps, and completion. See `../references/plan-operations.md`. Do not generate frontmatter, headings, dates, hashes, or activity records.
5. Before the first product edit on the default branch of a primary checkout, use `ae worktree --slug <slug>`. Keep later operations bound to that workspace.
6. Submit a start decision as its own tool call. Harness validates readiness, changes state, and publishes the implement gate as one recoverable operation. Wait for explicit success before making a product edit in a later tool call. A blocked result supplies missing prerequisites.

## Continue delivery

After prerequisites pass, follow orient's returned procedure read pointers. A current accepted playbook activates the internal /caffeinated skill by an actual read; a path or `skills_used` declaration alone is insufficient. That skill continues the established Deliver work without repeating intake classification or planning. Missing prerequisites stay with /ensure-plan, and high uncertainty remains abstention.

Implement within the accepted scope. Use focused TDD checks during implementation. Record accepted progress through the CLI. Prepare review with `ae review prepare`, obtain the required judgments, fix valid findings, and collect them with `ae review assemble`. Require passed `ae verify`, then record durable learning or explicit no-learning with `ae compound --learning-decision <file>`. Submit a complete decision.

An intent amendment records accepted source bytes and affected evidence. Refresh the start/gate before a later product correction when its contract changed. Do not repair an unrelated optional check or add its files to scope.

## Guardrails

Use the CLI's missing prerequisites and allowed next actions. An operation retry returns the prior logical result; it does not renew an expired gate or bless changed content. Preserve authored reasoning. Do not edit a `~/.ae` plan in the editor.

Respect existing user authorization and the single human approval policy. Under strict autonomy, stop at an unauthorized gated decision. This skill plans; it does not implement product code.
