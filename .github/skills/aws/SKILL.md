---
name: aws
description: AWS engineering workflow for SDK usage, IAM, queues, topics, configuration, reliability, observability, and review preparation.
argument-hint: "[describe the AWS integration, service, or configuration task]"
---

# AWS

## Purpose

Apply AWS engineering guidance as an on-demand skill. Use this for AWS SDK usage, IAM policy changes, SQS/SNS messaging, service configuration, reliability, and observability work.

## Trigger Examples

**Should trigger:**
- "Review this SQS consumer retry behavior"
- "Add SNS publish support"
- "Check least-privilege permissions for this integration"

**Should not trigger:**
- "Refactor this Java value object" -> use `/java`
- "Tune a PostgreSQL index" -> use `/sql`
- "Deploy this to production now" -> require explicit user approval and host-specific tooling

## Workflow

1. **Load scoped conventions**: Apply the globally hydrated `aws-sdk.instructions.md` for Java AWS SDK work. Also apply language-specific instructions for the implementation language.
2. **Classify risk**:
   - SDK call or local test change -> proceed with focused verification.
   - IAM, production infrastructure, queue/topic topology, encryption, or data movement -> require a plan through `/capture-issue` and `/plan-issue`.
3. **Inspect local patterns**: Match existing client lifecycle, region/config handling, retry policy, idempotency strategy, and observability conventions.
4. **Design conservatively**:
   - Use least-privilege IAM.
   - Never hardcode credentials, ARNs, account IDs, or regions unless they are explicit documented configuration.
   - Make retry, timeout, DLQ, and idempotency behavior explicit for messaging flows.
   - Add metrics/logging around business-critical cloud boundaries.
5. **Verify**:
   - Run local unit and integration tests when available.
   - Prefer LocalStack/Testcontainers or host-approved cloud test environments for integration behavior.
   - Review IAM/action/resource scope before completion.
6. **Review route**:
   - Use `@aws-reviewer` for AWS service, IAM, resilience, and observability review.
   - Add `@security-sentinel` for auth/secrets/data exposure risk.
   - Add `@java-reviewer`, `@python-reviewer`, or other language reviewers for implementation quality.

## Guardrails

- Do not deploy, mutate cloud resources, or use live credentials unless the user explicitly asks and the host approval policy allows it.
- Do not broaden IAM permissions to make an error disappear.
- Do not hide operational risk; document retries, DLQs, alarms, and rollback expectations.
