# Global Install and Sync Guide

This prompt library is **source material**, not an IDE extension. Policy:

**Prompts, agents, skills, and instructions are installed globally only** — not copied into product repositories.

Install and upgrade use the **`harness`** CLI. The npm package is named **`@dev-kit/harness`** for registry uniqueness, but daily commands should use `harness` ([Nexus setup](./onboarding/nexus-registry-setup.md), [distribution plan](./architecture/npm-harness-distribution-plan.md)).

## Quick install

### Enterprise (Nexus)

After `.npmrc` maps `@dev-kit` to your registry:

```bash
npm install -g @dev-kit/harness@latest
harness install --configure-vscode --autonomy balanced
harness doctor
```

Pin versions in team runbooks when you need reproducibility.

### Maintainers / unpublished package (this repo)

Install the local package globally from the prompt-library clone. This builds the ignored assets bundle before packing, so no registry publish is required:

```bash
npm install -g ./packages/harness
harness install --configure-vscode --autonomy balanced
harness doctor
```

If you do not want to put `harness` on `PATH`, you can run the repo script directly for setup:

```bash
node packages/harness/bin/harness.mjs install --configure-vscode --autonomy balanced
node packages/harness/bin/harness.mjs doctor
```

Or in VS Code: **Tasks: Run Task** → **Dev Kit: Install Harness**.

Other tasks: **Dev Kit: Upgrade Harness**, **Dev Kit: Harness Doctor**.

## What gets installed

The harness syncs into:

| Host | Global root |
|------|-------------|
| VS Code / Copilot CLI | `~/.copilot/` (Windows: `%USERPROFILE%\.copilot\`) |
| IntelliJ IDEA | `%LOCALAPPDATA%\github-copilot\intellij\` (Windows) or platform equivalent |

```text
~/.copilot/
├── agents/
├── skills/
├── instructions/
├── prompts/
├── knowledge/          # manifest, profile, solutions (team memory)
├── enterprise/         # optional corp overlay
├── copilot-instructions.md
└── .harness-lock.json  # version + file manifest for safe upgrades
```

Product repos keep **`docs/plans/`** only. Team learnings live in global `knowledge/solutions/` after `/compound-learnings` and `harness index`.

Bundled review checks ship inside `skills/code-review/references/checks/` (not a separate global folder).

## VS Code discovery

`harness setup` (and `install` / `upgrade`) merges recommended VS Code settings by default:

```json
{
  "chat.agentFilesLocations": { "~/.copilot/agents": true },
  "chat.instructionsFilesLocations": { "~/.copilot/instructions": true },
  "chat.agentSkillsLocations": { "~/.copilot/skills": true },
  "chat.customAgentInSubagent.enabled": true,
  "chat.useAgentSkills": true
}
```

Confirm in the Copilot chat customization diagnostics view.

## IntelliJ IDEA

The harness installs the same artifacts under the IntelliJ global root and writes `global-copilot-instructions.md` from library instructions.

Enable:

- **Settings** → **Tools** → **GitHub Copilot** → **Customizations**
- **Settings** → **Tools** → **GitHub Copilot** → **Chat** → **Agent** (Agent Skills if required)

Re-run **`harness upgrade`** after pulling prompt-library updates (from any machine with the CLI).

## Update process

1. Pull latest prompt-library (maintainers) or wait for a new **`@dev-kit/harness`** publish (enterprise).
2. Run **`harness upgrade`** (or `install` — same sync engine).
3. Run **`harness doctor`**.

Upgrades use **`.harness-lock.json`** and **`retired.json`** to remove only harness-owned paths. **`knowledge/solutions/`** and **`profile.md`** are preserved by default.

## Bootstrap a product repo

```bash
harness init-repo
```

Creates `docs/plans/` and `docs/agent-context.md`.

## Verification

- `/` shows skills such as `/btw`, `/code-review`, `/harness-doctor`
- `@engineer` and coordinators appear in the agent menu
- `harness doctor` — all required checks PASS
- Smoke: `@engineer` or `/btw` on a small question

## More detail

- [Harness quickstart](./onboarding/harness-quickstart.md)
- [Memory system](./architecture/engineer-memory-system.md)
- [Skill-driven standard](./architecture/skill-driven-prompt-library.md)
