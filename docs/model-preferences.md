# Model preferences

The `ae` CLI does not call a model and does not route models. Preferences live in the existing user config, `<copilot-home>/harness/config.yaml`. Empty and `inherit` leave the host field unset, which is the previous behavior.

`/setup-models` asks once. The host agent stores each answer with `ae config set`, then `ae install` stamps the generated files.

## Questions

The default for every role is `inherit`.

1. Engineer or orchestrator: `models.engineer`
2. Specialists: `models.specialist`
3. Researchers: `models.researcher`
4. Reviewers: `models.reviewer`
5. High thinking, used when the engineer or a reviewer has no model of its own: `models.high`
6. Low thinking, used when a specialist or researcher has no model of its own: `models.low`

```sh
ae config set models.reviewer claude-haiku-4-5 --scope user
ae install
```

A later `ae config set models.reviewer inherit --scope user` and `ae install` removes the field.

## What install writes

Copilot `agents/*.agent.md` gets a `model` line. A name that contains parentheses is stored, and the Copilot field is left unset, because those names fail to resolve in the agent frontmatter. Claude, Cursor, and Codex files are written under `<copilot-home>/hosts/` with that host's field:

- Claude: `model`
- Cursor: `model` plus `[effort=high]` for the engineer and reviewers, or `[effort=low]` for specialists and researchers
- Codex: `model` and `model_reasoning_effort` in `<role>.config.toml`

```yaml
model: "claude-opus-5"
```

```yaml
model: "claude-opus-5[effort=high]"
```

```toml
model = "claude-opus-5"
model_reasoning_effort = "high"
```

## Hosts

This follows the same shape as pstack's `/setup-pstack`, which asks for a budget and per-role models and writes one user rule. AE uses the config file it already has.

- Copilot: [Custom agents in VS Code](https://code.visualstudio.com/docs/copilot/customization/custom-chat-modes), [custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration), [premium requests](https://docs.github.com/en/copilot/concepts/billing/copilot-requests)
- Claude Code: [subagents](https://code.claude.com/docs/en/sub-agents), [costs](https://code.claude.com/docs/en/costs)
- Cursor: [subagents](https://cursor.com/docs/subagents)
- Codex: [advanced configuration](https://developers.openai.com/codex/config-advanced)
- pstack: [setup-pstack](https://github.com/cursor/plugins/blob/main/pstack/skills/setup-pstack/SKILL.md)
