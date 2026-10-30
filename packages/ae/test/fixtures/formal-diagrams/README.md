# Recorded TLC protocol fixtures

`pstack-counterjump.txt` is the saved `test/corpus/CounterJump/verdict-1.out` from Lauren Tan's pstack `/statechart` v0.15.36, `cursor/plugins` commit `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`.

Source: https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/statechart/scripts/test/corpus/CounterJump/verdict-1.out

`pstack-counter-graph.dot` and `pstack-player-graph.dot` retain the same revision's
`test/corpus/Counter/graph.dot` and `test/corpus/MediaPlayerFixed/graph.dot`.
They exercise original checker IDs, initial states, escaped values, parallel
concrete actions and rank rows. AE's native reader preserves this protocol; it
does not copy the upstream parser.

The tests replay recorded output; they do not run TLC or claim a new
model-checking result. The fixtures retain the full MIT notice in
`LICENSE.pstack` (Copyright (c) 2026 Lauren Tan).
