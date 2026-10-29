# Investigation

This playbook is read-only. It produces a cited explanation, not a code change. Do not call `plan-new` or `ensure-plan`.

1. Start with a short list of questions. Read the subsystem and, for a regression, the history that introduced it.
2. Record findings with file:line refs as you go, in chat, or in one notes file if the list is long.
3. For a large scope, split by repo or area across parallel researchers. Each researcher gets one narrow question. Read the `researcher` line in `~/.cursor/rules/ae-models.mdc` or `~/.claude/rules/ae-models.md`. Pass that model when the host spawn tool takes one. A missing file, a missing line, or `inherit` means omit the model.
4. Report overview, how it works, where it lives, and gotchas. If the premise is wrong, say so.
5. A plan starts only when the user asks for a change. Switch to Deliver and use a bug-fix or feature playbook. Do not start that change here.
