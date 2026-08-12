---
plan_schema: 1
title: "Harness TUI Phase 5 — product feel"
type: feat
status: done
plan_lock: true
phase: 1
priority: P1
risk: green
autonomy: balanced
intent: "Raise Session Ledger product feel without new kernel paths: product palette, human command language (tree/learnings/…), denser results, trustworthy chrome."
expected_outputs:
  - "Empty / palette shows common intents first, not A–Z registry dump"
  - "Tree, learnings, knowledge, lookup, orient, gate read as product language"
  - "Settings keys use human titles"
  - "Footer shows mode · shell · model when known"
  - "Tests for labels + empty palette order"
success_criteria:
  - "tree is not just 'Tree' — Browse files / knowledge is obvious"
  - "learnings is not a raw noun — Browse / explain learning"
  - "Empty palette first screen is scannable in <5s"
  - "No new agent mutation path; CLI inventory unchanged"
  - "tui-palette-fold and design contracts green"
created: 2026-08-12
updated: 2026-08-12
---

# Phase 5 — Feel only

Designer ACs (screenshot-testable):

1. **AC-F1** Open `/` with empty query → section **common** lists ~12 intents people recognize before **more**.
2. **AC-F2** Rows for tree / learnings / knowledge / lookup / orient / gate / compound have human labels + one-line notes, not man-page summaries.
3. **AC-F3** Settings sheet shows human titles (e.g. Agent loop) with key as secondary note.
4. **AC-F4** Footer includes mode and shell allowed/denied when known; model when known.
5. **AC-F5** CLI `buildCommandIndex({ surface: 'cli' })` inventory unchanged in shape.

Non-goals: second Engineer, new mutation stack, full IDE.
