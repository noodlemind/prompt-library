---
name: harness-doctor
description: Diagnose Harness installation, knowledge and hook enforcement. Use after onboarding or upgrades, or when mutation and completion gates misbehave.
argument-hint: "[optional product repo path]"
---

# Harness Doctor

Run `harness doctor --workspace <product-path> --host vscode --json`. Harness owns discovery, runtime probes, check criteria, counts and diagnostic hints. Read its actual check results. Diagnose causes and choose an authorized repair; do not manually reproduce its check list or infer success from the presence of files.

The VS Code hook probe uses an isolated fixture and the installed bundle. Passing it proves that executable contract on the fixture. Live editor invocation and a real product flow require their own evidence. Report an unsupported host as degraded; explicit gate and verify remain available.

Doctor is read-only. Product changes enter Engineer Deliver mode. Use [installed-product-proof.md](../references/installed-product-proof.md) when an agreed product adapter is available.

When a task names an editor or a host failure needs installation context, read `harness inventory show --json`. Missing or dated inventory is an observation, not a delivery blocker. Request an on-demand `harness inventory refresh --editor vscode|cursor|jetbrains --json` only when fresh metadata helps the diagnosis. Refresh writes the selected Harness home's cache; it does not change editor settings or open an editor. Installed extensions and settings overrides do not prove enabled, effective or running capabilities. Prove the actual task operation separately.

Use `harness domain show --name <name> --json` for an existing local domain configuration. Version 1 reports membership and identity drift only. Shared conventions are advisory; the view cannot authorize cross-repository edits or create plans and worktrees.

## Trigger Examples

**Should trigger:**
- "Check Harness after upgrading."
- "Explain why the installed edit hook denies this change."
- "Diagnose completion enforcement during onboarding."

**Should not trigger:**
- "Implement a product feature."
- "Review this diff."
- "Publish a learning from verified work."
