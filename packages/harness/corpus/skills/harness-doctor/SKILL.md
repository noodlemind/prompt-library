---
name: harness-doctor
description: Diagnose Harness installation, knowledge and hook enforcement. Use after onboarding or upgrades, or when mutation and completion gates misbehave.
argument-hint: "[optional product repo path]"
---

# Harness Doctor

Run `harness doctor --workspace <product-path> --host vscode --json`. Harness owns discovery, runtime probes, check criteria, counts and diagnostic hints. Read its actual check results. Diagnose causes and choose an authorized repair; do not manually reproduce its check list or infer success from the presence of files.

The VS Code hook probe uses an isolated fixture and the installed bundle. Passing it proves that executable contract on the fixture. Live editor invocation and a real product flow require their own evidence. Report an unsupported host as degraded; explicit gate and verify remain available.

Doctor is read-only. Product changes enter Engineer Deliver mode. Use [installed-product-proof.md](../references/installed-product-proof.md) when an agreed product adapter is available.

## Trigger Examples

**Should trigger:**
- "Check Harness after upgrading."
- "Explain why the installed edit hook denies this change."
- "Diagnose completion enforcement during onboarding."

**Should not trigger:**
- "Implement a product feature."
- "Review this diff."
- "Publish a learning from verified work."
