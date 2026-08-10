# Harness CLI Workbench — Delivery Plan, Phases 2–5

Companion to `harness-cli-workbench.md` (the contract: boundary, invariants, output lanes, command surface). That document says *what* the workbench is; this one says *how the remaining releases get built* — scope, acceptance criteria, verification, risks, and what each phase inherits from the one before.

Phase 1 (CLI core) shipped the kernel: command registry, three output lanes, async cancellable runner, universal secret redaction, event registry. Everything below builds on those seams.

**Plan-file convention.** This repository keeps at most one dated plan under `docs/plans/` at a time (enforced by the `prompt-contracts` check). Each phase gets its own dated plan file when its PR opens, derived from the corresponding section here, and that file is removed after merge. This document is the durable source those transient plans are cut from.

**Standing exception (as of the Phase 1 branch).** Two dated plans exist right now — `2026-07-29-harness-cli-phase1-core.md` for this phase, and `2026-08-06-feat-harness-evolution-phase1-plan.md`, which came in from `main` with the harness-evolution merge (#42) and is still carrying unresolved follow-on work rather than being cleaned up. The one-plan assertion in `prompt-contracts` is therefore red on this branch, deliberately: the accepted cost of keeping a live plan that still has work in it is one failing contract, and deleting a plan file to turn the check green would trade a visible policy failure for an invisible loss of state. The check returns to green when the evolution plan is retired, without any change to the convention above. Recorded here so the stated policy and the observed check result do not silently contradict each other.

## Sequence and dependencies

```text
Phase 1 ✅ CLI core
   │
   ├──▶ Phase 2 knowledge operator ──┐
   │                                 ├──▶ Phase 4b TUI
   ├──▶ Phase 4a durable runs ───────┘
   │
   ├──▶ Phase 3 governed execution
   │
   └──▶ Phase 5 resources & plugins
```

Every branch hangs off Phase 1, and the only hard join is 4b. Phase 3 depends on Phase 1's runner and side-effect metadata, not on Phase 2 — it can be built the moment the kernel lands. The same is true of Phase 4a, which needs Phase 1's event registry and nothing later, and of Phase 5, which needs the existing hydration pipeline plus Phase 1's registry. Only the TUI joins two lines: 4b depends on 4a (run views need the journal) *and* on **Phase 2's command index** (the palette reads it and adds no metadata of its own), and it reads better after Phase 3 (execution views need something to execute) — a sequencing preference, not a dependency, which is why the diagram leaves that edge out.

## Debt carried out of Phase 1

These are the deferred items whose natural home is a later phase. Each phase's plan must pick up the ones assigned to it.

| Item | Origin | Assigned |
|---|---|---|
| Expand `resultOf` producers to all commands (reverses the AC3 lane-scope amendment) | P1.2 / final review | Phase 2 |
| Surface quarantined learnings in search/tree results | P1.4 / M4 backlog | Phase 2 |
| ~20 legacy `writeEvent` call sites bypass the event registry (no actor metadata) — the scope Phase 1's AC7 was narrowed to exclude | P1.5 review, deferred with ruling | Phase 4a |
| `events.jsonl` 200-event cap and retention contract | P1.5 brief (explicitly out of scope) | Phase 4a |
| `legacyResultForStatus` maps cancelled/timed-out to `warn`, hiding them from `--failures` | P1.5 review | Phase 4a |
| `learningsResultOf` duplication with `cmdLearnings` | P1.6 judgment call | Phase 2 |
| Redaction residuals: glued-secret `\b` boundaries, base64/split-transform env values | P1.4 reviews | Phase 3 |
| Cycle-guard returns masked sentinel — revisit if untrusted cyclic input ever reaches redaction | P1.4 round 2 | Phase 3 |

## Settled decisions — command surface

Recorded so they are not re-litigated. Each was decided against ground truth read from eight agent CLIs installed locally (pi 0.82.1, Claude Code 2.1.220, Codex 0.146.0, Cursor Agent 2025.09.18, Grok 0.2.67, Amp, Warp v0.2026.08.04, Gemini) — binaries, bundles, settings schemas, and shell completions, not documentation.

**1. The CLI grammar does not change.** No flag is removed, renamed, or deprecated; no subcommand migration; no `config` store replacing configuration flags. An earlier proposal to collapse 91 command-specific flags was rejected: it paid a full migration cost — every hydrated skill calling `harness recall --collection …` breaks — to serve one of three audiences. The model reads a tool description per call and has no memory burden. A person in a shell has `--help` and completion. Only the TUI user lacked a discovery affordance, and an index supplies it without touching the grammar.

**2. The palette is an index, not a grammar.** One flat namespace over commands, their verbs, and skills — currently 24 + 98 + 25 = 147 entries. Reaching a capability never requires knowing its parent.

**3. No `--` is typed in the TUI.** Universal across all eight tools surveyed: not one accepts flag syntax inside a slash command. The palette presents noun + verb and resolves to argv internally, echoing the resolved command into the ledger.

**4. `:` namespaces; whitespace separates.** No surveyed tool uses `:` as a command/subcommand separator. Three use it for namespace or scope (pi `/skill:name`, Grok `/local:commit`, Warp's palette filter prefixes). Claude Code stores `:` in the registered name and accepts a space on the input line — the pattern adopted here. This also resolves the live collision in this repository, where `/consolidate` and `/recall` exist both as harness commands and as prompt-library skills.

**5. Sigils are `/`, `@`, `!`, `!!`.** The surveyed vocabulary converged on `/`, `@`, and a shell escape; `#` and `>` are dispatched by nobody. The `!`/`!!` split (output in context vs. private) is pi's, and is better than the single `!` that Claude Code, Codex, Cursor, and Grok ship.

**6. `Ctrl-P`, not `Ctrl-K`.** Warp binds `Ctrl-K` to `kill_to_line_end` and Grok to scroll-up, both deliberately — it belongs to readline. `Cmd-K` aliases on macOS only.

**7. The handler lives in the registry entry.** Pi keeps a data-only command table with dispatch in a separate branch chain, and the two have already drifted — three commands are dispatched but absent from the table, making them undiscoverable. A registry that does not own dispatch will drift the same way.

**8. Side-effect glyphs in the palette are ours alone.** No surveyed tool can show what a command will do before it runs, because none declares a side-effect class per command. Harness already does, on every entry.

## Phase 2 — Knowledge operator

**Goal.** Code, knowledge, learnings, and plans become searchable, exactly retrievable, and structurally navigable through the CLI — on the substrate the merged knowledge layer (M1–M4) already provides.

**Scope.** `search` (ranked, literal, regex, path, symbol match modes; scopes incl. `learnings`), `lookup` (all entity kinds incl. `learning`/`episode`), `tree workspace|knowledge`, enhanced `get`/`orient`, content-addressed indexes, search snapshots, deterministic multi-source federation, pagination and filters, retrieval explanations, `recall` compatibility migration with deprecated aliases.

**Plus: the command index (registry metadata).** The palette ships in 4b, but the metadata it reads belongs here — it is the same idea as the rest of this phase (make things findable) applied to commands, and it carries standalone value two phases before any TUI exists: richer `harness help`, and a strict-validation gap closed. Today `harness knowledge status --branch x` validates, because `--branch` is declared on the parent and nothing knows it is meaningless for that verb.

Three registry additions, all internal and additive:

- **Enumerate prose-only verbs.** `learning <retire|dispute|confirm|promote>`, `knowledge <on|suggest|off|freeze|capture-only>`, and `plan-new`'s risk tiers exist only inside `usage:` strings — roughly 18 working subcommands invisible to any index. Move them into data. Behavior is unchanged: `harness learning retire abc --reason "…"` runs identically before and after.
- **Tag every option with a TUI disposition** — `verb` (its own palette row, ~19), `prompt` (a picker after the verb is chosen, ~34), or `cli-only` (never shown, ~45). Dependent options declare `requires:` so they attach to a parent verb instead of floating in as nonsense rows.
- **Add `surfaces` and `userInvocable` per entry.** Warp's settings schema tags each of its 219 keys with the renderers that consume it; this is the command-side equivalent, and `userInvocable` is the field this repository's skills already carry.

**Acceptance criteria (draft — refine when the plan file is cut).**
1. `search` implements all five match modes with the documented scope list; empty result exits 0 with an empty result set.
2. Every result carries source, scope, location/entity id, relevance score, index generation, and retrieval reason under `--explain`.
3. Federation across scopes is deterministic: normalized scores, stable tie-break, cursor validity across sources, explicit partial-source failure reporting.
4. `lookup` resolves every declared kind and returns a structured not-found error.
5. `recall`/`get` continue to work via deprecated aliases; `harness-tool-contract.md` and every hydrated skill caller are updated in the same phase.
6. Read paths never create the knowledge store (Phase 1 invariant holds under the new commands).
7. All three output lanes work for every command this phase adds or touches, closing the AC3 lane-scope amendment.
8. Every verb reachable on the CLI is enumerable from the registry — no capability exists only inside a `usage:` string. A test asserts the count against a fixture so a new prose-only verb fails the build.
9. Every declared option carries a disposition; strict validation rejects an option applied to a verb that does not accept it.
10. The command index is emitted through the envelope lane, so it is consumable and testable without a terminal.

**Verification.** `harness-tests`, `prompt-contracts`, `build-assets`, plus new index/federation determinism tests (same query + same snapshot ⇒ byte-identical results) and a registry-enumerability test for AC8.

**Risks.** Index generation identity must be stable enough to make results replayable; federation scoring is the most likely source of nondeterminism; the `recall` migration touches hydrated skills, so contract drift is the recurring Phase 1 failure mode to watch. The disposition tagging is mechanical across 98 options and is the kind of sweep where a miscategorized `cli-only` silently hides a capability from the palette two phases later — AC9's test is the guard.

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
3. Run status uses the unified vocabulary incl. `cancelled` and `timed-out` as distinct terminal states.
4. `resume` restarts only from an explicitly safe boundary; interrupted commands are never auto-replayed.
5. Runs are queryable by status, command, host, plan, and date.
6. The ~20 legacy `writeEvent` call sites migrate onto the event registry, gaining actor metadata (Phase 1 deferral closed).
7. Retention replaces the current 200-event cap with a stated policy; `--failures` surfaces cancelled and timed-out runs correctly (Phase 1 deferral closed).

**Verification.** `harness-tests`, `prompt-contracts`, plus journal-integrity tests (crash mid-run leaves a readable journal; resume lands on a safe boundary).

**Risks.** The current `.harness/` state is gitignored and explicitly ephemeral; making it durable changes that contract and needs a migration story for existing workspaces.

## Phase 4b — TUI

**Goal.** `harness tui` performs the same search, lifecycle, and execution operations as the CLI, through one kernel and one behavior path.

**Design direction (settled).** Session Ledger — the flow-document form: a scrolling transcript in the terminal's main buffer (scrollback preserved; alt-screen a config, not a default), persistent chrome limited to a two-hairline editor and one dim status line, block meaning carried by faint background tints rather than boxes, near-monochrome with the harness v0.1 palette doing the semantic work, views dissolved into commands that print blocks, markdown plans rendered inline, ephemeral overlays for the command palette and run tree, editor border reflecting gate state, consequence context in the hint row, and an exit ritual that prints the closing tally and resume command into scrollback. Reference mock and research: the design session under `~/.gstack/projects/*/designs/harness-tui-*`.

**Scope.** TUI shell; the command palette per the contract in `harness-cli-workbench.md` §Command palette; search, plans, checks views; streaming execution with cancellation; runs, events, evidence views; resource inspection view; ASCII fallback for limited terminals; all rendering through the existing design system.

**The palette** consumes the Phase 2 command index and adds no grammar of its own: one flat namespace over commands, verbs, and `skill:`-namespaced workflows; word-boundary-weighted ranking with exact-match preselection; noun + verb presentation resolving to argv internally; value pickers populated from live state; dependent options offered as post-selection refinements; a side-effect glyph per row; unavailable commands greyed with their reason rather than hidden; `/` and `Ctrl-P` as entry points; `!`/`!!`/`@` as the composer sigils.

**Acceptance criteria (draft).**
1. Every TUI operation dispatches through the same command registry as the CLI — no second behavior path, no shell-out.
2. Scrollback, text selection, and terminal search keep working in the default mode.
3. Streaming output renders without flicker; cancellation is available from every long-running view.
4. All six state tokens render through `lib/style.mjs`, degrading to ASCII on limited terminals.
5. The TUI performs search, plan inspection, check execution, and run navigation without a capability the CLI lacks.
6. No palette path requires the user to type `--`; a test asserts that no rendered row and no accepted input contains flag syntax.
7. Every registry entry marked `surfaces: tui` is reachable from the palette, and every palette row resolves to an argv the CLI accepts — asserted in both directions so the index cannot drift from dispatch.
8. The resolved argv is echoed into the ledger for every palette-initiated run.
9. Ranking is deterministic: the same query against the same index yields the same order, with word-boundary matches above interior ones.

**Verification.** `harness-tests` plus TUI component tests; a rendering-golden approach for the ledger grammar; a palette-resolution test suite covering AC6–AC9.

**Risks.** Terminal compatibility is the classic sink (every surveyed tool was forced to ship both buffer modes); budget for it rather than discovering it. Keep the kernel dependency one-directional — the TUI consumes the registry, never the reverse. The bidirectional assertion in AC7 is the specific guard against the failure every surveyed tool has shipped: a palette list and a dispatcher that drift until commands become unreachable or undiscoverable.

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
