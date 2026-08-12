---
plan_schema: 1
title: "Harness TUI/TUX: frontier-inspired Session Ledger"
type: feat
status: done
plan_lock: true
phase: 4
priority: P1
risk: yellow
autonomy: balanced
intent: "Bring the harness Session Ledger TUI/TUX to frontier quality (Grok Build, Claude Code, Codex, Amp, Cursor, OpenCode, Droid, Warp, Copilot, Gemini) while remaining host-first Adaptive Engineering: kernel owns commands, scopes, gates, verify, and compound; TUI is a projection with discovery, status, approvals, and recovery—not a second Engineer."
expected_outputs:
  - "Persistent status frame: phase, agent mode, authority, scope, workspace, outcome"
  - "Command palette / slash discovery over registry with command preview (no flag soup as primary UX)"
  - "Product verbs for agent/config (e.g. /agent off) that compile to kernel argv"
  - "Usage correction cards distinct from task failed/inconclusive"
  - "Mode-aware composer: bare / ! shell / @ artifact / ? help; Shift+Tab host modes"
  - "Plan/question gate UX (approve/comment/rewrite + structured questions) as ledger states"
  - "Session lifecycle commands: resume, fork/export stubs or thin first pass as capacity allows"
  - "/inspect effective config/permissions/workspace provenance"
  - "Tests + short TUX notes in adaptive-engineer-harness or agent-loop docs"
  - "Research provenance linked (coding-tui-*.md reports)"
success_criteria:
  - "Users can toggle agent and common config without typing --scope flags in the ledger"
  - "Every palette/verb action shows or records the canonical registry command"
  - "E_USAGE exit 2 still nonzero; ledger projects usage/repair UI not work-failed theater"
  - "Status always shows agent mode + authority (not agent-on alone)"
  - "Host-first invariants: kernel no LLM on host path; optional agent remains opt-in"
  - "No second mutation stack; TUI only projects registry/kernel"
  - "tui-design contracts and package tests remain green"
  - "Product docs do not market harness agent as the Adaptive Engineer runtime"
verification:
  required: []
  criteria: {}
reviews:
  required: []
  completed: []
  critical_open: []
skills_used: []
org_objectives: []
domains:
  - harness
  - tui
  - ux
specialists: []
capability_gaps: []
created: 2026-08-11
updated: 2026-08-11
---

# Harness TUI/TUX: frontier-inspired Session Ledger

> **Audience:** implementers.  
> **Research basis:** `packages/harness/coding-tui-tux-industry-research.md` + `packages/harness/coding-tui-grok-frontier-ae-followup.md` (interaction ids `trun_ff52a747…`, `trun_8a449fa3…`).  
> **Product model (non-negotiable):** Host-first / Kernel-always / Agent-optional / Benchmark-test-only.  
> **Companion work:** test hygiene plan is deferred; dual-track lifecycle is separate—this plan owns interactive TUX only.

## Overview

The harness ledger is already a strong **Session Ledger** (blocks-as-records, registry-backed commands, optional agent via Shift+Tab). Industry frontier TUIs feel better because they hide flag machinery behind **discoverable verbs**, **visible authority**, **gate-shaped approvals**, and **usage vs task outcomes**.

This plan adapts the **best control surfaces** from Grok Build, Claude Code, Codex, Amp, Cursor, OpenCode, Droid, Warp, Copilot, Gemini, Aider, and Pi—without becoming a second Engineer or diluting deterministic kernel contracts.

## Context

### Pain (observed)

- `config set agent.enabled = false` fails on spaces and missing `--scope`
- Usage errors render as ledger **`inconclusive`** (verify vocabulary)
- Power path (`agent mode off`) works; raw registry path feels like a script CLI
- Status chrome is thin vs Codex/Grok (model, mode, authority, waiting state)

### Existing building blocks (reuse)

| Path | Role |
|------|------|
| `lib/tui-cmd.mjs` | Session loop, Shift+Tab agent toggle, `!` shell, runArgv |
| `lib/tui/palette.mjs` | Command index palette; **already forbids flag syntax in human rows** |
| `lib/tui/status.mjs` | Status segments (workspace, branch, gate, plan, runs) |
| `lib/tui/complete.mjs`, `composer.mjs`, `overlay.mjs` | Composer/completion/overlays |
| `lib/tui/ledger.mjs`, `block.mjs` | Block states including inconclusive |
| `lib/config-cmd.mjs` | Strict `set key value --scope user\|project` |
| `lib/run-journal.mjs` | `EXIT.usage` → `inconclusive` for run status |

### Inspiration map (steal, do not clone products)

| Source | Steal |
|--------|--------|
| **Grok Build** | Plan approve/comment/quit; multi-choice questions; `inspect`; session list/export; rich chrome (mode, waiting) |
| **Claude Code** | `!` shell, `@` files, `?` help; Shift+Tab **mode** cycle; `/config` `/status` |
| **Codex** | Slash popup; permission profiles; `/debug-config` `/status` `/raw`; queue slash during work |
| **Amp** | Ctrl+P/O **palette** always available; show command before apply |
| **Cursor** | Ask / Plan / implement separation (map to orient / gate / work) |
| **OpenCode** | Attention states; leader-safe controls; timeline/session list |
| **Droid** | Visible autonomy + MCP in chrome; Shift+Tab product modes |
| **Warp** | Explicit terminal vs agent mode boundary |
| **Copilot** | Once / location / Always approval vocabulary; resume picker |
| **Gemini** | Interactive vs headless flag boundary; session lifecycle |
| **Aider** | Explicit context (`/add`); Ctrl-C keeps partial output |
| **Pi** | Thin extensible surface; status/overlays at boundaries |

### Non-goals

- Second Deliver lifecycle inside optional agent
- YOLO/bypass as default
- Silent memory/`skillify` without verify
- Palette that hides kernel argv
- Rewriting product modules solely for aesthetics
- Trusting community `grok-cli` packages as official xAI

## Intent Contract

- **Goal:** Frontier-quality Session Ledger TUX that projects the Adaptive Engineer kernel: discoverable controls, visible authority, gate-shaped collaboration, recoverable sessions—while every mutation of durable state remains a deterministic registry command.
- **Expected outputs:** See frontmatter.
- **Success criteria:** See frontmatter.
- **Verification checks:** Package `npm test` (tui-design, tui, config, agent, growth contracts); manual TUI dry-run of agent toggle + config palette.
- **Organizational objective:** Host-first Adaptive Engineering with a terminal that matches peer products without abandoning kernel purity.

## Acceptance Criteria

### Discovery & config (P0)

- [x] **AC1** Palette and/or `/` completion can set `agent.enabled` and other common keys without the user typing `--scope` (default scope **user** in TUI; project requires explicit choice).
- [x] **AC2** Every successful config/agent UI action records or displays the **canonical** command (e.g. `config set agent.enabled false --scope user`).
- [x] **AC3** Product verbs work in ledger: at least `agent on` / `agent off` (existing) plus `/agent on|off` or palette equivalent; `key = value` / `key=value` accepted for config set when scope known or defaulted.
- [x] **AC4** Incomplete `config set` shows a short form + one working example, not only a dump of all keys.

### Status & outcomes (P0)

- [x] **AC5** Status frame includes at least: workspace (or short path), **agent on/off**, and **authority or mode** label; omit missing facts rather than inventing them.
- [x] **AC6** Process exit `E_USAGE` / exit 2 remains nonzero for scripts; ledger **projects** a distinct **usage** (or equivalent) correction card with remediation, not the same visual language as a failed verify task.
- [x] **AC7** Composer grammar documented in-session (`?` or help): `/` controls · `!` shell · bare line behavior · Shift+Tab.

### Modes & gates (P1)

- [x] **AC8** Shift+Tab cycles **host-defined** modes (minimum: agent off / agent on; prefer extend toward `assist` / `plan` without breaking current toggle). Mode changes are ledger events.
- [x] **AC9** When a plan or agent proposes gated work, TUI can present **approve / comment-or-edit / quit** style choices that map to host gate/plan state (thin first pass OK if wired to existing gate).
- [x] **AC10** Structured **question** checkpoint primitive exists (ledger event + overlay) for multi-choice; unanswered → inconclusive with reason, not failed.

### Inspect & recovery (P1–P2)

- [x] **AC11** `/inspect` or `inspect` (config/status) shows effective value, source, scope for key settings (at least `agent.enabled`, model if present).
- [x] **AC12** Session recovery surface: list or resume prior runs/sessions from existing journal APIs where present; export/fork can be stubbed with honest “not yet” only if inventory shows no API—prefer thin real wiring.
- [x] **AC13** Docs: short TUX section in concept doc or package README—composer grammar, modes, palette, host-first boundary. Official Grok product named **Grok Build** if mentioned; community clones not equated.

### Quality

- [x] **AC14** `packages/harness` tests green for touched areas; `tui-design` contracts preserved (no box chrome regressions).
- [x] **AC15** No new agent-only mutation path; no LLM from kernel on host path.

## Plan

### Phase 0 — Orient inventory (read-only + notes)

1. Map current: Shift+Tab, palette open key, status snapshot inputs, how blocks render exit codes, config-cmd parsing, command-index TUI surface.
2. Inventory run-journal / events APIs usable for resume/list.
3. Fill **Implementation Notes** with exact functions to change.
4. Record baseline: what `?` / help currently shows.

**Exit:** Touch list locked; no behavior change yet (or only plan file).

### Phase 1 — P0 usage cards + config sugar + status (implement now)

**Priority investment #1 (legibility).**

1. **Usage projection**  
   - When block/result is `E_USAGE` / exit usage: render title/state as **usage** (or `needs fix`) with `→ try` remediation from `error.hint` when present.  
   - Keep `runStatusForExit` process mapping for automation if required; separate **display** status from engineering outcome if needed.  
   - Tests: usage block ≠ failed verify styling where design allows.

2. **Config sugar**  
   - Accept `config set agent.enabled=false` and `agent.enabled = false` when verb is set (normalize `=` and spaces).  
   - TUI/session default: if `--scope` omitted on set, default **`user`** and print note `scope: user (default)`. Project scope still requires `--scope project` or palette prompt.  
   - Incomplete set: form line + example.

3. **Product verbs**  
   - Ensure `agent on` / `agent off` and `/agent on|off` (or palette rows labeled “Agent mode off”) compile to full argv with `--scope user`.  
   - Prefer extending `interpretLine` / session words over one-off hacks.

4. **Status frame**  
   - Extend `statusSegments` with `agent`, `mode`/`authority` (and model if already known cheaply).  
   - Wire snapshot from tui-cmd (read effective config for agent.enabled).

5. **Help/`?`**  
   - One screen: grammar + Shift+Tab + pointer to palette.

**Exit:** AC1–AC7, AC14 for this slice.

### Phase 2 — P1 palette polish + host modes + gate/question UI

1. Palette: ensure config set / agent rows **never show raw `--` in labels** (already partially enforced); preview panel: key, value, scope, full command.  
2. Mode cycle: document and implement host modes; Shift+Tab remains primary; status updates + ledger event.  
3. Gate interaction: thin overlay for approve/comment/quit when gate or plan proposal is pending (hook existing gate/plan commands).  
4. Question checkpoint: data shape + overlay + ledger event type (additive).

**Exit:** AC8–AC10.

### Phase 3 — P1/P2 inspect + session lifecycle

1. `inspect` / `/inspect config` via kernel command or pure status command (registry first).  
2. Resume/list from runs journal if APIs exist; else minimal list of recent run ids.  
3. Docs AC13; optional export stub only if needed.

**Exit:** AC11–AC13.

### Phase 4 — Verification and freeze

1. Full `npm test` in packages/harness.  
2. Manual TUI script: agent toggle, bad config line, good sugar line, status shows agent.  
3. Mark ACs; Activity; no souvenir test files.

## Technical Notes

### Constraints

- **Surgical:** prefer `tui/*`, `config-cmd.mjs`, `tui-cmd.mjs`, ledger display—not knowledge rewrite.  
- **One path:** palette/verbs → `runArgv` / registry; no parallel config writers.  
- **TDD:** failing test for config sugar and usage display first where practical.  
- **Design contracts:** keep ledger grammar; no alt-screen dashboard chrome.  
- **Official Grok naming:** Grok Build / `grok` binary; community clones separate.

### Suggested interaction contract (target)

```text
Bare line     → host command; or agent when mode allows
/  or palette → searchable registry projection
!             → shell under policy
@             → host artifact pick (Phase 2+ if cheap; else defer)
?             → help + keymap
Shift+Tab     → cycle host mode (agent off/on minimum)
Enter         → submit
Shift+Enter   → newline if supported
Esc           → cancel overlay / interrupt where already defined
```

### Suggested control names (projections)

`/status` `/inspect` `/config` `/agent` `/orient` `/gate` `/verify` `/compound` `/resume` — map to existing registry where possible; do not invent dual implementations.

## Impacted Files

| Area | Paths |
|------|--------|
| TUI loop | `packages/harness/lib/tui-cmd.mjs` |
| Status/palette/session | `lib/tui/status.mjs`, `palette.mjs`, `session.mjs`, `block.mjs`, `ledger.mjs`, `chrome.mjs` |
| Config | `lib/config-cmd.mjs`, possibly `lib/config.mjs` |
| Run status display | `lib/run-journal.mjs` (careful: display vs process contract) |
| Command index | `lib/command-index.mjs` if new rows/labels |
| Tests | `test/tui*.test.mjs`, `test/config-command.test.mjs`, new focused tests |
| Docs | `docs/adaptive-engineer-harness.md` or package README short TUX section |
| Research (read-only) | `packages/harness/coding-tui-*.md` |

## Verification Plan

1. `cd packages/harness && npm test` (or targeted tui/config then full).  
2. Manual: `harness tui` (or equivalent) — agent off/on, config sugar, usage card on bad line.  
3. Grep guard: no provider imports from status/config pure helpers.  
4. Confirm tui-design contracts still pass.

## Risk & Review Routing

| Risk | Mitigation |
|------|------------|
| Default scope user surprises project-only users | Print note; project requires explicit scope |
| Changing runStatusForExit breaks automation | Prefer display mapping; keep exit codes |
| Palette / mode scope creep into second Engineer | Phase gates; non-goals |
| Dual live plans in repo | This plan is active TUX work; hygiene deferred; dual-track separate owner |

## Implementation Notes

### Phase 0 inventory

- Shift+Tab → `intent: agent-mode` → `config set agent.enabled … --scope user`
- Palette → `/` → `openPalette` / command-index (flag syntax banned in labels)
- status/footer → `session.setStatus` + `renderFooter` / `renderHint`
- config set → `config-cmd.context` positionals
- E_USAGE → `statusForExit` in ledger (display) vs `runStatusForExit` in journal (inconclusive)

### Phase 1 shipped

- Default user scope on config set; `key=value` / `key = value` sugar
- `agent on` / `agent off` / `/agent on|off` product verbs
- Ledger block status `usage` for exit 2 (journal still inconclusive)
- Footer + hint show agent on/off; help documents grammar + sugar
- Tests: `test/config-tui-sugar.test.mjs` + updated config-command expectation

### Research links

- Industry + harness roadmap: `packages/harness/coding-tui-tux-industry-research.md`
- Grok Build + frontier deep dive: `packages/harness/coding-tui-grok-frontier-ae-followup.md`

## Agent instructions

```text
Implement docs/plans/2026-08-11-harness-tui-tux-frontier.md.

Product model: Host-first, Kernel-always, Agent-optional, Benchmark-test-only.
TUI is a projection of the registry/kernel—not a second Engineer.

Priority: Phase 0 inventory → Phase 1 (usage cards, config sugar, status, help) → Phase 2 (palette/modes/gate/questions) → Phase 3 (inspect/resume) → Phase 4 verify.

Rules:
- Reuse lib/tui/palette, status, session; extend config-cmd carefully
- Every UI config action shows/runs canonical argv
- Default TUI scope user when omitted; never invent project trust
- E_USAGE stays exit 2; improve human projection
- TDD where behavior is new; surgical diffs; no souvenir tests
- Update plan AC checkboxes and Activity as you go
- Full packages/harness tests before claiming phase done
```

## Activity

### 2026-08-11 — Captured + planned

- Research completed (industry TUI + Grok Build / frontier follow-up).  
- Plan locked: frontier-inspired Session Ledger TUX; P0 = usage cards, config sugar, status, help.  
- Ready for Phase 0 inventory and Phase 1 implementation.

### 2026-08-11 — Phase 0–1 implemented

- Config sugar + default user scope; agent product verbs; usage ledger status; status/hint agent chrome; help expanded.
- Targeted tests green (config + tui-design + tui + sugar).

### 2026-08-11 — Phases 2–4 implemented

- Palette selection **preview** (canonical argv; config key/value/scope).
- Host modes `commands | assist | plan` (Shift+Tab cycle; `mode …` verbs); plan labels proposal-only.
- **gate menu** approve/comment/quit → registry `gate` / plan path / dismiss.
- **question** multi-choice checkpoint; skip → inconclusive.
- Kernel **`inspect`** (config/permissions/workspace/tools) + TUI verbs.
- **runs** / **resume &lt;id&gt;** → `run list` / `run resume`.
- Docs: Session Ledger TUX in concept doc + package README.
- Tests: `tui-tux-phase2.test.mjs`; enumerability fixtures for inspect.

### 2026-08-12 — TUX regression inventory + fold palette inwards

**Ledger inventory (what already exists):** Session blocks, palette `/`, bash `!`, Shift+Tab modes, results picker, run journal hydrate, product verbs (agent/mode/gate/inspect/runs), search compact ledger, usage status projection.

**Pain found in dogfood:**
1. Palette was a **flat CLI dump** (every verb + `--scope` + `<key>` grammar).
2. Search/more/cursor and chrome noise (earlier fixes 0.8.3).
3. Bare `bash` / `tree test` usage walls (0.8.4 ergonomics).

**Fold (this change):**
- TUI multi-verb commands: **no bare parent** (`checks <verb>` gone); only product verb rows.
- Human labels: `Set config value`, `Run a check`, `List past runs`, …
- Signatures: `key · value` only — **no `--scope`**, no angle brackets.
- Soft-default `--scope user` when resolving config set from the palette.
- CLI surface unchanged (full inventory for scripts).
