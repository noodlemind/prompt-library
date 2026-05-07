# Engineer Harness Evals

This eval suite checks whether `@engineer` follows the Adaptive Engineer Harness: skill-first routing, context discipline, delegated work packets, human approval gates, primitive boundaries, verification rigor, safety, and cost/request discipline.

## Providers

User machines use the VS Code GitHub Copilot localhost bridge:

- Base URL: `http://127.0.0.1:3001`
- Discovery: `/availableModels` and `/approvedModels`
- Chat API: `/v1/chat/completions`
- Model policy: approved models only
- No model downloads
- No external API keys

Maintainers may use subscription or local-model providers for exploration, but release evidence must be confirmed against `copilot-localhost`.

## Run Types

- **Smoke run:** 2-3 representative cases before or after small prompt changes.
- **Full run:** all cases before release.
- **Parity run:** P1 cases on Copilot localhost after a candidate was discovered using maintainer local/subscription providers.

## Release Gate

- Copilot localhost provider must pass.
- Aggregate score must be at least 85%.
- P1 cases must pass routing, human approval, and safety.
- Provider and model must be recorded in `results.tsv`.
- Local/subscription maintainer runs are advisory unless confirmed through Copilot localhost.

## Files

- `provider-config.example.yml`: default provider policy and maintainer override example.
- `rubric.md`: scoring rubric.
- `results.tsv`: append-only run log.
- `tuning-log.md`: one-change-at-a-time tuning decisions.
- `cases/*.md`: frozen eval cases.

## Manual IntelliJ Replay

Automated v1 evals target the VS Code localhost bridge. For IntelliJ, replay the same case prompts manually in GitHub Copilot Chat and score with `rubric.md`. Record the host as `intellij-manual` in notes; do not use manual IntelliJ replay as the sole release gate.
