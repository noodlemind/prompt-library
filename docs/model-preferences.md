# Model preferences

The `ae` CLI does not call a model. It does not choose a model for a subagent, and this repository does not install a model router. Each host already has a native field. When that field is absent, the subagent inherits the parent session.

Krish can set a preferred model per role on the host that is actually running the agent. One AE config cannot do that for every host, because the fields are not the same and AE only hydrates GitHub Copilot agents.

## GitHub Copilot

Custom agents in VS Code and in the Copilot cloud agent use `model` in the agent frontmatter. An omitted `model` inherits the model selected in the session. VS Code also accepts a prioritized list and a `handoffs.model` value. JetBrains IDEs are in public preview for the same custom-agent file. A model name that contains parentheses can fail to resolve and fall back to the session model.

- [Custom agents in VS Code](https://code.visualstudio.com/docs/copilot/customization/custom-chat-modes)
- [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [Requests in GitHub Copilot](https://docs.github.com/en/copilot/concepts/billing/copilot-requests)

Copilot Chat bills one premium request per user prompt, multiplied by the model rate. The published request table says autonomous tool calls inside a prompt are not extra premium requests. A specialist dispatch is still a separate model session, and its tokens follow that model's rate.

## Claude Code

A subagent file sets `model` to `inherit`, a family alias (`sonnet`, `opus`, `haiku`, `fable`), or a full model id. `inherit` uses the parent conversation. Anthropic's cost guidance says a switch to Opus also applies to subagents that inherit the session model, and a simple subagent should set `model: haiku`. Subagent requests still draw on the same usage.

- [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Manage costs effectively](https://code.claude.com/docs/en/costs)

## Cursor

A custom subagent under `.cursor/agents/` or `~/.cursor/agents/` sets `model` to `inherit` or a model id. Bracket parameters set effort, for example `claude-opus-5[effort=high]`. The default is `inherit`. The built-in Explore subagent has its own setting. Other built-in subagents do not. Cursor has reported cases where a frontmatter model is ignored and the subagent inherits the parent.

- [Subagents](https://cursor.com/docs/subagents)

## Codex

A profile file such as `~/.codex/deep-review.config.toml` sets `model` and `model_reasoning_effort`. Select it with `codex --profile deep-review`. `[agents]` can set `default_subagent_model` and `default_subagent_reasoning_effort`. A role's `config_file` can pin `model` and `model_reasoning_effort` for that role. Omitted values inherit the parent. `codex exec` has a reported bug where a pinned role still inherits the parent model and effort.

- [Advanced configuration](https://developers.openai.com/codex/config-advanced)
- [Sample configuration](https://learn.chatgpt.com/docs/config-file/config-sample.md)

## What AE will not do

Shipped Copilot agents omit `model`, so they inherit the session model. Writing a model into those files would pin one choice for every user. A per-role overlay at install time would be a new preference store. That store is not part of this change.
