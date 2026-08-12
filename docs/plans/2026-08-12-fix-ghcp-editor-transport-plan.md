---
plan_schema: 1
title: "Use VS Code for GitHub Copilot transport and finish TUI onboarding"
type: fix
status: done
plan_lock: true
phase: 1
risk: amber
intent: "Route GitHub Copilot model discovery and completions through the signed-in VS Code language model API when available, support Windows fallbacks, expose repo initialization in the TUI, hydrate the harness automatically on first TUI launch, and explain the Adaptive Engineering delivery model."
expected_outputs:
  - "Bundled VS Code companion extension with an authenticated loopback language-model bridge"
  - "GitHub Copilot provider transport that prefers the editor bridge and retains an explicit direct fallback"
  - "Cross-platform editor and credential discovery, including Windows"
  - "Automatic first-TUI hydration and a TUI repo-initialization action"
  - "Regression tests and operator documentation"
  - "Project documentation for Adaptive Engineering, predictable surgical delivery, and adjacent-method comparisons"
success_criteria:
  - "Bridge-backed model discovery and completions make no GitHub API request from the harness process"
  - "Tool calls and tool results survive the VS Code language-model message conversion"
  - "The bridge binds only to loopback and rejects requests without its per-session secret"
  - "Windows paths use USERPROFILE and LOCALAPPDATA fallbacks"
  - "First TUI launch installs once; the first launch after a newer npm package upgrades once; same-version launches do nothing"
  - "init-repo is selectable and runnable from the TUI"
  - "The harness test suite passes"
  - "The root README and canonical concept document explain Adaptive Engineering accurately, render valid Mermaid, and compare adjacent methods without straw-man claims"
verification:
  required: [harness-tests]
  criteria: {AC1: [harness-tests], AC2: [harness-tests], AC3: [harness-tests], AC4: [harness-tests], AC5: [harness-tests], AC6: [harness-tests], AC7: [harness-tests]}
reviews: {required: [security, architecture], completed: [security, architecture], critical_open: []}
skills_used: [engineer, ensure-plan, recall, context7-mcp, code-review, auto-compound, project-readme, parallel-web-search, every-style-editor-2]
capability_gaps: []
learning:
  destination: plan
  recurrence: possible
  candidate_primitive: null
  candidate_name: null
  evidence:
    - "verification outcome passed"
    - "authenticated editor bridge and fallback semantics are covered by integration tests"
  recommendation: "retain-in-plan; no promotion after a single integration"
---

# Use VS Code for GitHub Copilot transport and finish TUI onboarding

## Overview

Route GitHub Copilot model discovery and completions through the signed-in VS Code language model API when available, support Windows fallbacks, expose repo initialization in the TUI, hydrate the harness automatically on first TUI launch, and explain how the broader Adaptive Engineering model governs predictable, surgical delivery.

The direct Copilot adapter remains a fallback for non-editor use. When an active editor bridge is present, both catalogue and completion traffic stay inside VS Code so editor authentication, enterprise proxy policy, and certificate handling remain authoritative.

## Context

- `lib/providers/github-copilot.mjs` currently exchanges editor OAuth and calls GitHub endpoints itself.
- `lib/provider.mjs` discovers a partial set of editor installations and treats a plaintext credential file as editor readiness.
- `init-repo` is registered as CLI-only, so the registry-backed TUI omits it.
- `harness tui` does not hydrate a freshly npm-installed package when the global lock is absent.
- VS Code language-model APIs run only inside the extension host; the standalone Node TUI therefore needs a narrow local bridge rather than importing `vscode` directly.

## Intent Contract

- Goal: Route GitHub Copilot model discovery and completions through the signed-in VS Code language model API when available, support Windows fallbacks, expose repo initialization in the TUI, hydrate the harness automatically on first TUI launch, and document the governing delivery model.
- Expected outputs: companion extension, authenticated loopback client, provider preference/fallback, Windows discovery, first-run bootstrap, TUI init action, tests, operator docs, and the canonical Adaptive Engineering explanation.
- Success criteria: the eight frontmatter criteria above, with repository contracts proven by `harness-tests` and supplemental link/Mermaid validation recorded below.
- Organizational objective: make the Harness TUI usable on enterprise Windows laptops without bypassing editor-managed Copilot connectivity.

## Memory Cards

- No matching compounded learning was returned by `harness orient`. source: `.harness/context-pack.md`
- `vscode.lm.selectChatModels` is the dynamic catalogue and models must be re-queried when the set changes. source: `https://code.visualstudio.com/api/references/vscode-api`
- `LanguageModelChat.sendRequest` streams text/tool-call parts and may require user consent initiated by a user action. source: `https://code.visualstudio.com/api/references/vscode-api`
- A standalone Node provider cannot call `vscode.lm`; the editor-hosted companion owns that API and exposes only an authenticated loopback transport. source: `packages/harness/vscode-extension/extension.cjs`, `packages/harness/lib/vscode-lm-bridge.mjs`
- Direct HTTP fallback is valid only when the bridge is absent or unreachable; permission, quota, model, and protocol errors must remain authoritative. source: `packages/harness/lib/providers/github-copilot.mjs`, `packages/harness/test/vscode-lm-bridge.test.mjs`

## Acceptance Criteria

- [x] **AC1** Windows editor and Copilot credential locations are discovered without assuming macOS paths.
- [x] **AC2** A locally authenticated VS Code companion bridge enumerates Copilot models with vscode.lm.selectChatModels and streams requests with LanguageModelChat.sendRequest.
- [x] **AC3** The GitHub Copilot provider prefers the editor bridge for both model discovery and completions and does not make external API calls on that path.
- [x] **AC4** First interactive TUI launch automatically installs an absent harness or upgrades an older lock, while same-version launches do nothing.
- [x] **AC5** The TUI palette and typed command surface expose init-repo through the existing registry.
- [x] **AC6** Targeted and full harness tests cover transport, installation, Windows, and TUI behavior.
- [x] **AC7** The root README and canonical concept document explain Adaptive Engineering, its predictable/surgical controls, and its relationship to Spec-Driven Development, BMAD, graph orchestration, and graph-backed memory.

## Plan

### Phase 1 — Tests and bridge contract

- [x] Add failing tests for Windows discovery, authenticated loopback IPC, VS Code model/message conversion, provider bridge preference, first-run install, and the TUI `init-repo` row. <!-- phase:1 -->

### Phase 2 — Editor transport and installation

- [x] Add the bundled companion extension, bridge client, safe installer/uninstaller, provider integration, and Windows fallback paths. <!-- phase:2 -->

### Phase 3 — TUI onboarding and documentation

- [x] Auto-install or version-upgrade on TUI launch, expose `init-repo`, and document reload/fallback behavior. <!-- phase:3 -->
- [x] Rewrite the root overview and canonical concept page around Adaptive Engineering invariants, delivery mechanics, governed memory, and a source-backed adjacent-method comparison. <!-- phase:3 -->

### Phase 4 — Verification and review

- [x] Run `harness-tests`, inspect the scoped diff, and complete security/architecture review. <!-- phase:4 -->

## Technical Notes

- Bind the bridge to `127.0.0.1` on an ephemeral port and authenticate every request with a random secret stored in the user's Copilot home with restrictive permissions where supported.
- Treat a valid, running bridge as preferred. Fall back only when no bridge can be reached; do not bypass an editor permission/model/quota error with a direct API call.
- Convert prior assistant tool calls and user tool results into the corresponding VS Code language-model parts.
- Keep the extension dependency-free and copy it with the installed harness runtime.

## Research Notes

- Current VS Code exposes `LanguageModelChat.id`, `vendor`, `family`, `version`, `name`, and `maxInputTokens` for catalogue rows.
- The response stream yields `LanguageModelTextPart` and `LanguageModelToolCallPart`; follow-up results use `LanguageModelToolResultPart` in a user message.
- `LanguageModelAccessInformation.canSendRequest` permits a silent access check. If consent has not been decided, the extension must obtain an explicit VS Code UI action before the first request.
- The legacy Windows credential fallback is `%LOCALAPPDATA%\github-copilot`; the bridge avoids relying on plaintext editor credentials altogether.

## Impacted Files

- `packages/harness/vscode-extension/package.json`
- `packages/harness/vscode-extension/extension.cjs`
- `packages/harness/lib/vscode-lm-bridge.mjs`
- `packages/harness/lib/install-vscode-bridge.mjs`
- `packages/harness/lib/copilot-credential.mjs`
- `packages/harness/lib/provider.mjs`
- `packages/harness/lib/model-cmd.mjs`
- `packages/harness/lib/providers/github-copilot.mjs`
- `packages/harness/lib/commands.mjs`
- `packages/harness/lib/install-harness-bin.mjs`
- `packages/harness/lib/tui-cmd.mjs`
- `packages/harness/lib/registry.mjs`
- `packages/harness/lib/command-index.mjs`
- `packages/harness/package.json`
- `README.md`
- `docs/adaptive-engineer-harness.md`
- `packages/harness/README.md`
- `packages/harness/test/vscode-lm-bridge.test.mjs`
- `packages/harness/test/provider-knobs.test.mjs`
- `packages/harness/test/provider-adapters.test.mjs`
- `packages/harness/test/cli-install-upgrade.test.mjs`
- `packages/harness/test/command-index-contract.test.mjs`

## Verification Plan

- `harness-tests` covers all acceptance criteria through package unit/integration tests.
- Supplemental documentation checks parse both Mermaid diagrams, resolve all local Markdown links, and confirm each external comparison reference returns HTTP 200.
- Manual limitation: automated tests fake the VS Code API; final dogfood still needs an installed VS Code window reload and one consent interaction.

## Risk & Review Routing

- Amber: local IPC, extension installation outside Copilot home, credential fallback, and model tool-call translation are security/architecture-sensitive.
- Security review: loopback binding, secret handling, request bounds, path ownership/containment, uninstall targeting, and error redaction.
- Architecture review: provider fallback semantics, registry parity, first-run lifecycle, and avoiding a second agent/mutation stack.
- No destructive, schema, data-migration, or public network service changes.

## Implementation Notes

- Added a dependency-free VS Code extension that binds an ephemeral authenticated loopback bridge and translates Harness messages, tool calls, and tool results into the stable `vscode.lm` API.
- GitHub Copilot model discovery and completions prefer the editor bridge. Only a missing or unreachable bridge enters the existing direct-token fallback; editor permission, quota, model, protocol, and validation errors remain authoritative.
- The extension is installed into the user extension directory, included in the npm tarball and hydrated runtime, tracked separately in the install lock, and removed only after path and extension-identity validation.
- `harness tui` installs when the lock is absent and upgrades when the running package is newer than the lock, always targeting `vscode,cli` with VS Code settings enabled. Equal or newer installed versions are left untouched, preventing repeat hydration and automatic downgrades.
- Windows fallback discovery now includes `%LOCALAPPDATA%\\github-copilot`, `USERPROFILE`, per-user VS Code, and machine-wide Program Files installs.
- Reframed the root README and canonical concept document around adaptive depth with fixed safety invariants, the model-independent Harness boundary, deterministic evidence binding, governed memory, and a neutral comparison with Spec Kit, BMAD, graph orchestration, and knowledge-graph memory.

## Review Findings

- Security and architecture review completed with no critical findings open.
- Fixed an extension lifecycle finding: targeted CLI-only upgrades now preserve the prior VS Code extension lock record so uninstall cannot orphan it.
- Fixed a bridge reliability finding: request/response sizes are bounded and a disconnected client cancels the in-flight VS Code language-model stream.
- Reviewed automatic lifecycle mutation: it is bounded to a missing or older Harness lock, retains the existing opt-out, and refuses to auto-downgrade a newer hydrated version.
- Residual dogfood step: reload a real VS Code window after install, approve the first model-access prompt, and exercise one catalogue refresh and tool turn. Automated tests use a faithful API fake because the VS Code extension host is not available in CI.

## Activity

- Scaffolded by `harness plan-new`.
- 2026-08-12 — `ensure-plan`: researched current provider/TUI/installation paths, consulted current VS Code API documentation, refined scope, and locked the plan.
- 2026-08-12 — `engineer`: initial implementation gate passed; work entered `in-progress`.
- 2026-08-12 — `engineer`: implemented phases 1-3 with focused transport, Windows, install-lifecycle, and TUI tests passing.
- 2026-08-12 — `code-review`: completed security and architecture review; corrected lock-record preservation and stream cancellation/bounds; no critical findings remain.
- 2026-08-12 — `verify`: initial gate identified a missing `model-cmd.mjs` scope declaration and declined the untrusted named check; no product check ran.
- 2026-08-12 — `verify`: passed `harness-tests`; all six criteria, plan scope, required reviews, and workspace stability passed.
- 2026-08-12 — `auto-compound`: retained the editor-host boundary and fallback rule in this plan; no reusable primitive promotion recommended after one integration.
- 2026-08-12 — issue completed: passed evidence was compounded, knowledge debt is 0, and the plan moved to `done`.
- 2026-08-12 — `engineer`: reopened AC4 after handoff review found that an older install lock still required a manual upgrade after installing a newer npm package.
- 2026-08-12 — `engineer`: added version-aware TUI hydration; focused install/upgrade, transport, Windows, and palette tests pass (62/62).
- 2026-08-12 — `verify`: final named-check run passed after version-aware hydration; all criteria, scope, reviews, and workspace stability passed.
- 2026-08-12 — issue completed: final passed evidence was compounded, knowledge debt remains 0, and the plan returned to `done`.
- 2026-08-12 — `project-readme`: expanded the root and canonical concept documentation, validated both Mermaid diagrams and every local/external link, and added the requested method comparison without changing runtime behavior.
- 2026-08-12 — `verify`: refreshed passed evidence after the documentation expansion; all seven acceptance criteria, the full harness suite, plan scope, required reviews, and workspace stability passed (`.harness/evidence/2026-08-12-fix-ghcp-editor-transport-plan-796ce2f70f8c.json`).
