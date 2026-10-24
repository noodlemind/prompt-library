# Refactor

Keep the observed behavior. Change the structure that makes the next edit hard.

1. Name the behavior that must stay the same and the check that shows it.
2. Subtract the unused path before adding a replacement.
3. Before the same condition is edited in two places, print `ae get --reference skills/references/duplicate-guards.md --json` and follow it.
4. Delegate one scope. Review the diff against the behavior check.
5. Verify the same check still passes.
