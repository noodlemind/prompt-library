# Harness CLI Workbench — Delivery Plan, Phases 2–5

Companion to `harness-cli-workbench.md` (the contract: boundary, invariants, output lanes, command surface). That document says *what* the workbench is; this one says *how the remaining releases get built* — scope, acceptance criteria, verification, risks, and what each phase inherits from the one before.

Phase 1 (CLI core) shipped the kernel: command registry, three output lanes, async cancellable runner, universal secret redaction, event registry. Everything below builds on those seams.

**Plan-file convention.** This repository keeps at most one dated plan under `docs/plans/` at a time (enforced by the `prompt-contracts` check). Each phase gets its own dated plan file when its PR opens, derived from the corresponding section here, and that file is removed after merge. This document is the durable source those transient plans are cut from.

## Sequence and dependencies

```text
Phase 1 ✅ CLI core ──▶ Phase 2 knowledge operator ──▶ Phase 3 governed execution
                                                              │
                                            Phase 4a durable runs ──▶ Phase 4b TUI
                                                              │
                                                    Phase 5 resources & plugins
```

Phase 3 depends on Phase 1's runner and side-effect metadata, not on Phase 2. Phase 4a depends on Phase 1's event registry. Phase 4b depends on 4a (run views need the journal) and reads better after Phase 3 (execution views need something to execute). Phase 5 depends on the existing hydration pipeline plus Phase 1's registry.

## Debt carried out of Phase 1

These are the deferred items whose natural home is a later phase. Each phase's plan must pick up the ones assigned to it.

| Item | Origin | Assigned |
|---|---|---|
| Expand `resultOf` producers to all commands (reverses the AC3 lane-scope amendment) | P1.2 / final review | Phase 2 |
| Surface quarantined learnings in search/tree results | P1.4 / M4 backlog | Phase 2 |
| ~20 legacy `writeEvent` call sites bypass the event registry (no actor metadata) | P1.5 review, deferred with ruling | Phase 4a |
| `events.jsonl` 200-event cap and retention contract | P1.5 brief (explicitly out of scope) | Phase 4a |
| `legacyResultForStatus` maps cancelled/timed-out to `warn`, hiding them from `--failures` | P1.5 review | Phase 4a |
| `learningsResultOf` duplication with `cmdLearnings` | P1.6 judgment call | Phase 2 |
| Redaction residuals: glued-secret `\b` boundaries, base64/split-transform env values | P1.4 reviews | Phase 3 |
| Cycle-guard returns masked sentinel — revisit if untrusted cyclic input ever reaches redaction | P1.4 round 2 | Phase 3 |

## Phase 2 — Knowledge operator

**Goal.** Code, knowledge, learnings, and plans become searchable, exactly retrievable, and structurally navigable through the CLI — on the substrate the merged knowledge layer (M1–M4) already provides.

**Scope.** `search` (ranked, literal, regex, path, symbol match modes; scopes incl. `learnings`), `lookup` (all entity kinds incl. `learning`/`episode`), `tree workspace|knowledge`, enhanced `get`/`orient`, content-addressed indexes, search snapshots, deterministic multi-source federation, pagination and filters, retrieval explanations, `recall` compatibility migration with deprecated aliases.

**Acceptance criteria (draft — refine when the plan file is cut).**
1. `search` implements all five match modes with the documented scope list; empty result exits 0 with an empty result set.
2. Every result carries source, scope, location/entity id, relevance score, index generation, and retrieval reason under `--explain`.
3. Federation across scopes is deterministic: normalized scores, stable tie-break, cursor validity across sources, explicit partial-source failure reporting.
4. `lookup` resolves every declared kind and returns a structured not-found error.
5. `recall`/`get` continue to work via deprecated aliases; `harness-tool-contract.md` and every hydrated skill caller are updated in the same phase.
6. Read paths never create the knowledge store (Phase 1 invariant holds under the new commands).
7. All three output lanes work for every command this phase adds or touches, closing the AC3 lane-scope amendment.

**Verification.** `harness-tests`, `prompt-contracts`, `build-assets`, plus new index/federation determinism tests (same query + same snapshot ⇒ byte-identical results).

**Risks.** Index generation identity must be stable enough to make results replayable; federation scoring is the most likely source of nondeterminism; the `recall` migration touches hydrated skills, so contract drift is the recurring Phase 1 failure mode to watch.

## Phase 3 — Governed execution and control

**Goal.** Hosts and users execute commands through Harness with consistent policy, cancellation, evidence, and audit.

**Scope.** `checks list/show/run`, `exec` (argv-only), `bash` (explicit, separately policy-gated), streaming `verify` (already delivered in Phase 1 — extend, don't rebuild), `config` (user/project scopes, effective values with provenance, schema validation, atomic writes), `trust` (project identity, approve/revoke, policy-and-resource loading gated on trust), environment allowlisting, network policy, isolation backend, redacted output artifacts, host-hook and CI completion enforcement, per-command-family authorization, cross-host validation on Copilot CLI and Codex CLI.

**Acceptance criteria (draft).**
1. Every control declares and honors its enforcement class: enforced, detect-and-block, or audit-only.
2. `exec` never invokes a shell; `bash` is separately allowed or denied by policy; both are identified distinctly in events and evidence.
3. Working-directory containment, timeout, environment allowlist, and network policy are enforced; where the platform lacks isolation primitives the degradation is recorded in the audit event.
4. Per-platform behavior is explicit — which shell `bash` resolves to on Windows and how descendant termination works there.
5. Command and mutation audit entries are written for every execution, redacted before persistence.
6. Trust gates project resource and policy loading; trust changes are recorded.
7. The same representative workflow runs through two named hosts using only documented CLI contracts.

**Verification.** `harness-tests`, `prompt-contracts`, `build-assets`, plus isolation-backend tests per platform and a cross-host validation run.

**Risks.** This is the phase where genuinely untrusted output flows through the redaction layer — the Phase 1 residuals in the debt table land here, and the redaction test surface should grow with adversarial fixtures. Windows behavior is the least-covered area in the current suite.

## Phase 4a — Durable runs

**Goal.** Run history becomes queryable and resumable; ships before any TUI work starts.

**Scope.** Append-only run journal with stable ids, `run list/show/resume/tree`, evidence and event queries, safe-boundary resume with no automatic replay of interrupted commands, evidence freshness against repository and plan digests, retention and redaction policy for durable output.

**Acceptance criteria (draft).**
1. Every run carries a stable id; the journal is append-only and never rewritten.
2. Journal entries cover command start/progress/result, plan and gate, execution and mutation, verification and evidence, cancellation and timeout.
3. Run status uses the unified vocabulary incl. `cancelled` and `timed out` as distinct terminal states.
4. `resume` restarts only from an explicitly safe boundary; interrupted commands are never auto-replayed.
5. Runs are queryable by status, command, host, plan, and date.
6. The ~20 legacy `writeEvent` call sites migrate onto the event registry, gaining actor metadata (Phase 1 deferral closed).
7. Retention replaces the current 200-event cap with a stated policy; `--failures` surfaces cancelled and timed-out runs correctly (Phase 1 deferral closed).

**Verification.** `harness-tests`, `prompt-contracts`, plus journal-integrity tests (crash mid-run leaves a readable journal; resume lands on a safe boundary).

**Risks.** The current `.harness/` state is gitignored and explicitly ephemeral; making it durable changes that contract and needs a migration story for existing workspaces.

## Phase 4b — TUI

**Goal.** `harness tui` performs the same search, lifecycle, and execution operations as the CLI, through one kernel and one behavior path.

**Design direction (settled).** Session Ledger — the flow-document form: a scrolling transcript in the terminal's main buffer (scrollback preserved; alt-screen a config, not a default), persistent chrome limited to a two-hairline editor and one dim status line, block meaning carried by faint background tints rather than boxes, near-monochrome with the harness v0.1 palette doing the semantic work, views dissolved into commands that print blocks, markdown plans rendered inline, ephemeral overlays for the command palette and run tree, editor border reflecting gate state, consequence context in the hint row, and an exit ritual that prints the closing tally and resume command into scrollback. Reference mock and research: the design session under `~/.gstack/projects/*/designs/harness-tui-*`.

**Scope.** TUI shell and command palette; search, plans, checks views; streaming execution with cancellation; runs, events, evidence views; resource inspection view; ASCII fallback for limited terminals; all rendering through the existing design system.

**Acceptance criteria (draft).**
1. Every TUI operation dispatches through the same command registry as the CLI — no second behavior path, no shell-out.
2. Scrollback, text selection, and terminal search keep working in the default mode.
3. Streaming output renders without flicker; cancellation is available from every long-running view.
4. All six state tokens render through `lib/style.mjs`, degrading to ASCII on limited terminals.
5. The TUI performs search, plan inspection, check execution, and run navigation without a capability the CLI lacks.

**Verification.** `harness-tests` plus TUI component tests; a rendering-golden approach for the ledger grammar.

**Risks.** Terminal compatibility is the classic sink (every surveyed tool was forced to ship both buffer modes); budget for it rather than discovering it. Keep the kernel dependency one-directional — the TUI consumes the registry, never the reverse.

## Phase 5 — Resources and plugins

**Goal.** An external plugin can add one command, one search scope, one named check, and one TUI panel without modifying Harness core.

**Scope.** Resource manifests and bundles extending the existing hydration/retirement machinery (`install`/`upgrade`/`retired.json`) rather than a parallel mechanism; `resources list/show/add/update/enable/disable/remove/reload` and `tree resources`; provenance, deterministic precedence, version and integrity pinning, capability declarations, explicit trust; out-of-process plugin protocol with version negotiation, manifest-declared capabilities, explicit capability approval, network and environment policy, timeout and cancellation, crash isolation, redacted communication.

**Acceptance criteria (draft).**
1. Bundles ride the existing hydration pipeline; no parallel install path exists.
2. Resource precedence is deterministic and inspectable, with provenance shown per resource.
3. Distributed bundles require integrity pinning and explicit trust before loading.
4. Plugins run out-of-process over versioned JSON/JSONL, with capabilities approved explicitly.
5. Plugins never mutate policy, the run journal, evidence, or the learnings store; contributed knowledge sources flow through the consolidation loop.
6. A crashing plugin cannot take down the host process.

**Verification.** `harness-tests`, `prompt-contracts`, `build-assets`, plus a fixture plugin exercising all four contribution types end to end.

**Risks.** This is the largest trust-boundary expansion in the roadmap; the Grok Build telemetry incident is the cautionary case — local-first defaults and explicit approval are the posture, and the security review for this phase should be adversarial from the start.

## How each phase gets executed

1. Cut the dated plan file for the phase from its section here (`docs/plans/<date>-<slug>.md`, plan schema v1, named checks in `verification.required`, review roster in `reviews.required`).
2. Work in a worktree on a branch off current `main`; open a draft PR early with the workstream checklist.
3. Implement in reviewable workstreams, each landing as one commit after its own review pass.
4. Close with the full suite, the named checks, `harness verify --plan` for the evidence artifact, and a whole-branch review — including a cross-model pass, which is what caught the systemic redaction gap in Phase 1.
5. After merge, delete the dated plan file and promote anything durable into `docs/architecture/` or `knowledge/solutions/`.
