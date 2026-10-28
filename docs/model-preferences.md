# Model preferences

This note records how other systems set a model per role, and three ways AE could follow them. It does not choose one. AE does not call a model, and the shipped agents still omit `model`, so each host inherits the session model.

## pstack

Source: [cursor/plugins](https://github.com/cursor/plugins), plugin directory `pstack`. Lauren Tan describes it in [pstack/README.md](https://github.com/cursor/plugins/blob/main/pstack/README.md).

Setup is the skill [pstack/skills/setup-pstack/SKILL.md](https://github.com/cursor/plugins/blob/main/pstack/skills/setup-pstack/SKILL.md). The README says to run `/setup-pstack`, pick a reasoning budget, and choose models. The skill does this:

1. It lists model slugs the session can pass to a `Task` subagent. If it cannot detect any, it asks the user to paste slugs. It does not write a real slug it has not confirmed. `inherit-parent` and `auto` are always allowed.
2. If `~/.cursor/rules/pstack-models.mdc` already exists, it reads that file's `# budget` line and role values. Otherwise it starts from the defaults in the skill. A role line that is no longer in the skill, such as `how critics`, is dropped.
3. It asks for a budget with these labels: `unlimited — max reasoning`, `large — xhigh reasoning`, `medium — high reasoning`, `small — medium reasoning`. With no rule, it says `large` matches the skill defaults. The budget rewrites the effort token of every real slug to `max`, `xhigh`, `high`, or `medium`. `inherit-parent` and `auto` stay as they are. On a re-run it keeps a role the user changed by family, list, or alias.
4. It shows every role and asks the user to accept or change it. Panel roles take a list, and one subagent runs per entry. The skill says to prefer AskQuestion over free text.
5. It overwrites `~/.cursor/rules/pstack-models.mdc` with `alwaysApply: true`, a `# budget` line, and one line per role. The comment in that file says to delete a line to fall back to the skill default, and that `inherit-parent` or `auto` means the role runs on the parent chat model.

I did not find a program that parses this file. [pstack/skills/poteto-mode/SKILL.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md) tells the model to read the rule. A role line overrides the skill default. A missing line keeps the skill default. `inherit-parent` or `auto` means omit the Task `model` field so the subagent uses the parent chat model. The same skill says the budget sets the starting effort, `xhigh` by default, and the model may step that effort up or down for one spawn.

Claude Code is a generated copy under [harness/pstack/claude-code](https://github.com/cursor/plugins/tree/main/harness/pstack/claude-code). [pstack/README.md](https://github.com/cursor/plugins/blob/main/pstack/README.md) says `/pstack:setup-pstack` writes `~/.claude/rules/pstack-models.md`. [pstack/docs/harness/claude-code.md](https://github.com/cursor/plugins/blob/main/pstack/docs/harness/claude-code.md) says Claude Code loads every `.md` file in `~/.claude/rules/` into each new session. The adapter tells setup to write that file with no frontmatter. It maps a Claude slug such as `claude-opus-5-5-xhigh` to `model: "opus"` and `effort: "xhigh"`. A `grok-*`, `gpt-*`, or other non-Claude slug, and `auto` or `inherit-parent`, omit `model`. If the rule is not already in context, the adapter says to read the file. If the file or the role line is missing, use the skill's default slug. The adapter says not to put the role lines in `CLAUDE.md` or `AGENTS.md`.

## Other hosts

[Claude Code subagents](https://code.claude.com/docs/en/sub-agents) set `model` to `inherit`, a family alias (`sonnet`, `opus`, `haiku`, `fable`), or a full model id. The documented resolution order is the per-invocation `model` parameter, then the subagent file's `model` frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main conversation's model. [Manage costs effectively](https://code.claude.com/docs/en/costs) says a switch to Opus also applies to subagents that inherit the session model, and that a simple subagent can set `model: haiku`. The same page says the subagent's own requests still draw on usage.

[GitHub Copilot custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-chat-modes) use `model` in the agent frontmatter. VS Code documents a string or a prioritized list. If it is omitted, VS Code uses the model selected in the picker. [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration) says the same `model` property applies to GitHub.com, the Copilot CLI, and supported IDEs, and that an unset model inherits the default. That page says custom agents are in public preview for JetBrains IDEs. [Requests in GitHub Copilot](https://docs.github.com/en/copilot/concepts/billing/copilot-requests) says Copilot Chat uses one premium request per user prompt, multiplied by the model's rate, and that autonomous tool calls inside that prompt are not extra premium requests.

[Cursor subagents](https://cursor.com/docs/subagents) use `model` in `.cursor/agents/` or `~/.cursor/agents/`. The documented values are `inherit` (the default) or a model id. Bracket parameters set options such as `claude-opus-5[effort=high]`. The docs say the built-in Explore subagent has its own setting. They do not describe a separate picker for every built-in subagent.

[Codex advanced configuration](https://developers.openai.com/codex/config-advanced) stores a profile as a separate file, `~/.codex/<profile>.config.toml`, selected with `codex --profile <profile>`. The sample on that page sets `model` and `model_reasoning_effort`. The [sample configuration](https://learn.chatgpt.com/docs/config-file/config-sample.md) shows `[agents]` keys `default_subagent_model` and `default_subagent_reasoning_effort`, and a role table with `config_file`. The sample comments say an explicit spawn model or effort takes precedence, and that omitted values inherit. [openai/codex#33881](https://github.com/openai/codex/issues/33881) reports that `codex exec` 0.144.5 ignored a role file's `model` and `model_reasoning_effort` and kept the parent model. I did not run that case.

[CrewAI agents](https://docs.crewai.com/edge/en/concepts/agents) take an optional `llm` on each agent. The docs say it defaults to `OPENAI_MODEL_NAME` or `gpt-4`. [Connect to any LLM](https://docs.crewai.com/edge/en/learn/llm-connections) shows passing a different string or an `LLM` object per agent. This is application code, not a setup interview.

[AutoGen AssistantAgent](https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.agents.html) requires a `model_client`. The [quickstart](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/quickstart.html) constructs `OpenAIChatCompletionClient(model="gpt-4o")` and passes that client to one agent. A second agent can receive a different client. I did not find a setup command that interviews the user.

## Options for AE

AE already stores user settings in `<copilot-home>/harness/config.yaml` and project settings in `.github/harness/config.yaml`. Shipped agents omit `model`. These options are recorded so Krish can choose. None is selected here.

### Leave the agents unset

Krish sets each host's native field by hand, using the pages above. AE stays as it is.

Tradeoff: nothing new to install, and an omitted field keeps today's inherit behavior. The cost is four different files and no single question list. A Copilot model name that contains parentheses can fail to resolve in agent frontmatter ([copilot-intellij-feedback#1536](https://github.com/microsoft/copilot-intellij-feedback/issues/1536)). The VS Code page quoted above does not mention that failure.

### A user rule the skills read

Follow pstack: a setup skill asks once, writes one user file, and the engineer skill tells the model to pass that model when the host tool has a model argument. A missing line keeps the current default, which for AE is omit the field.

Tradeoff: AE still never calls a model. Cursor and Claude Code can take a model on the spawn, as their docs and the pstack adapter describe. Copilot's published control is the `model` field on the agent file, and I did not find a spawn argument for it. A rule alone would not change Copilot subagents. The skill text would have to stay inside the engineer token cap.

### Stamp host files at install

A setup step writes the same user config, and `ae install` copies the value into each generated agent file: Copilot `model`, Claude Code `model`, Cursor `model` with an `[effort=...]` suffix, and a Codex profile with `model` and `model_reasoning_effort`. Empty or `inherit` leaves the field out.

Tradeoff: one answer can reach every host AE generates, and a later inherit plus install can remove the field. The formats differ, so the installer owns the translation. A parentheses name has to be skipped for Copilot. Install would rewrite agent files when the preference changes. This pins a model into files every user of that home receives.
