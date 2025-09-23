---
applyTo: "**/*test*.*"
---
- Tests must be deterministic and isolated; no live network unless sanctioned mocks exist.
- For bug fixes: add a failing test first and confirm it fails before the fix.
- Prefer table-driven/parameterized tests where idiomatic.
