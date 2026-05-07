# Shared Error Handling Patterns

Common error recovery patterns referenced by individual skill error handling sections. Skills define their own domain-specific errors and reference this file for cross-cutting concerns.

## Subagent Failure

When a subagent returns no output or errors out:

1. **Never halt entirely.** Present partial results from subagents that succeeded.
2. Report which subagent failed and what it was researching.
3. Offer the user the option to retry the failed subagent or proceed without its results.
4. If the failed subagent was the only one, explain what information is missing and suggest an alternative approach (e.g., manual research, different agent).

## Tool Unavailability

When a required tool is not available in the current environment:

1. Consult the cross-environment compatibility table from the globally hydrated prompt-library instructions or `.github/copilot-instructions.md` when present.
2. Use the fallback tool transparently — do not ask the user to switch environments.
3. If no fallback exists, report what capability is missing and what the user can do (e.g., switch to VS Code, install an extension, use CLI).

## File Not Found

When an expected file does not exist:

1. Report the error with the **exact expected path**.
2. Suggest running the prior pipeline step that creates the file:
   - Missing issue file → "Create one with `/capture-issue` first."
   - Missing plan file → "Generate one with `/plan-issue` first."
   - Missing solution/context file → "Run `/compound-learnings` to generate it."
3. If the file path looks like a typo (close match exists), suggest the correct path.

## Timeout

When a subagent or tool call times out with partial output:

1. Include whatever partial output was returned — partial results are better than none.
2. Note the timeout clearly in the output so the user knows the results are incomplete.
3. Suggest retrying the timed-out operation if the partial results are insufficient.
4. Do not retry automatically — let the user decide whether to retry or proceed.
