# Bug fix

The parent owns the outcome. A delegate may investigate or edit a named scope.

1. Reproduce the failure on the real surface. Ask the owner only with a stated reason that surface cannot reach it.
2. Name the candidate causes and rule them out with runtime evidence. Revert a change whose hypothesis was refuted.
3. Plan the fix. If it crosses a function boundary, read the architecture notes before editing.
4. Verify on the same surface. Inconclusive is not a pass.
5. Put the failing repro in history before the fix when a local test can express it.
