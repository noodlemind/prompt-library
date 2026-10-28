# Refactor

Keep the observed behavior. Change the structure that makes the next edit hard.

1. Name the behavior that must stay the same and the check that shows it.
2. Subtract the unused path before adding a replacement.
3. Delegate one scope. Compare the diff with the behavior check.
4. Verify the same check still passes.
