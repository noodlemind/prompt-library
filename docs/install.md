# Global Install and Sync Guide

This prompt library is source material, not an IDE extension. The target policy is:

**Prompts, agents, skills, and instructions are installed globally only.**

Do not hydrate product repositories with prompt-library artifacts. Product repositories remain clean, and developers update their global Copilot customizations from this source repo.

For the current target users, assume **Windows**, **GitHub Copilot**, **VS Code**, and **IntelliJ IDEA**.

## Recommended Windows Layout

Clone the prompt library once:

```powershell
git clone <prompt-library-url> $env:USERPROFILE\prompt-library
$PromptLibrary = "$env:USERPROFILE\prompt-library"
```

Global Hydrate copies the library into:

```text
C:\Users\<you>\.copilot\agents
C:\Users\<you>\.copilot\skills
C:\Users\<you>\.copilot\instructions
C:\Users\<you>\.copilot\prompts
C:\Users\<you>\.copilot\checks
```

`checks` are copied as support artifacts for prompt-library skills. They are not a standard Copilot primitive.

## VS Code Hydrate Task

The preferred Windows workflow is:

1. Open the prompt-library checkout in VS Code.
2. Pull the latest prompt-library changes.
3. Open the Command Palette.
4. Run `Tasks: Run Task`.
5. Choose `Prompt Library: Hydrate Global Copilot Customizations`.

The task definition lives in `.vscode/tasks.json`. It copies source artifacts from the current prompt-library checkout into `%USERPROFILE%\.copilot`.

Run this task again whenever the prompt-library repo is updated.

## VS Code Global Discovery

VS Code can discover some user-level Copilot customizations directly. To make discovery explicit, add these user settings in VS Code:

```json
{
  "chat.agentFilesLocations": {
    "C:\\Users\\<you>\\.copilot\\agents": true
  },
  "chat.promptFilesLocations": {
    "C:\\Users\\<you>\\.copilot\\prompts": true
  },
  "chat.instructionsFilesLocations": {
    "C:\\Users\\<you>\\.copilot\\instructions": true
  }
}
```

Skills are installed under `%USERPROFILE%\.copilot\skills`, which Copilot supports for personal skills.

Use the VS Code chat customization diagnostics view to confirm which agents, prompts, and instructions are loaded.

### What VS Code Loads Globally

VS Code supports user-level instruction files, prompt files, custom agents, and skills. The hydrate task installs this library into those global user-level locations:

| Artifact | Global location | VS Code behavior |
|---|---|---|
| Instructions | `%USERPROFILE%\.copilot\instructions\*.instructions.md` | Loaded as user instructions when configured through VS Code customization settings |
| Agents | `%USERPROFILE%\.copilot\agents\*.agent.md` | Available across workspaces when configured as custom agent files |
| Skills | `%USERPROFILE%\.copilot\skills\<skill>\SKILL.md` | Available as personal skills and slash commands |
| Prompts | `%USERPROFILE%\.copilot\prompts\*.prompt.md` | Available as user prompt files and slash commands |
| Checks | `%USERPROFILE%\.copilot\checks\*.md` | Prompt-library support files read by library skills; not a native Copilot primitive |

`agent-context.md` is not a VS Code global customization primitive. Treat it as repository knowledge, not as something VS Code automatically discovers globally. For this prompt-library repo, `.github/agent-context.md` records library-specific learnings. For product repositories, persistent product context should live in product-owned docs such as `docs/plans/`, `docs/solutions/`, `docs/codebase-snapshot.md`, `docs/agent-context.md`, or `README.md` when a skill intentionally creates or updates them.

Keep `.github/copilot-instructions.md` in this repo. It is still useful when developing the prompt library itself and when GitHub/Copilot needs repository-wide guidance. Do not copy it into product repositories under the global-only policy; use global `.instructions.md` files for reusable team behavior instead.

## IntelliJ IDEA Global Usage

IntelliJ IDEA does not use VS Code tasks and does not have identical global customization discovery.

Use this policy:

- Run the Hydrate task from VS Code to keep `%USERPROFILE%\.copilot` current.
- In IntelliJ IDEA, configure **global Copilot instructions** through the GitHub Copilot settings UI.
- Keep the global IntelliJ instruction short: tell Copilot to follow the globally hydrated prompt-library conventions and name the expected workflows (`/start`, `/btw`, `/capture-issue`, `/plan-issue`, `/work-on-task`, `/code-review`, `/project-readme`, `/java`, `/python`, `/sql`, `/aws`).
- Verify whether the installed IntelliJ Copilot plugin discovers global prompt files and custom agents. If it does not, users can still manually invoke the workflow names in chat, but slash-command and agent-dropdown behavior may differ from VS Code.

Do not copy prompt-library artifacts into product repositories just to make IntelliJ discover them. That violates the global-only policy.

JetBrains currently supports repository `.github/copilot-instructions.md` and a global Copilot instructions file through its Copilot settings UI. Treat IntelliJ as instruction-first unless a team's installed plugin version confirms broader global prompt/agent/skill discovery.

## Manual Global Fallback

If VS Code tasks are unavailable, run the equivalent PowerShell from the prompt-library checkout:

```powershell
$PromptLibrary = "$env:USERPROFILE\prompt-library"
$Copilot = "$env:USERPROFILE\.copilot"

New-Item -ItemType Directory -Force $Copilot | Out-Null

robocopy "$PromptLibrary\.github\skills" "$Copilot\skills" /E
robocopy "$PromptLibrary\.github\agents" "$Copilot\agents" /E
robocopy "$PromptLibrary\.github\instructions" "$Copilot\instructions" /E
robocopy "$PromptLibrary\.github\prompts" "$Copilot\prompts" /E
robocopy "$PromptLibrary\.github\checks" "$Copilot\checks" /E
```

## Verification Checklist

After hydration:

- In VS Code, type `/` and confirm prompts such as `/start`, `/btw`, `/project-readme`, `/java`, `/python`, `/sql`, and `/aws` appear.
- In VS Code, type `@` and confirm `@engineer` and coordinator agents are available.
- In VS Code diagnostics, confirm agents, prompts, and instructions are loaded from `%USERPROFILE%\.copilot`.
- In IntelliJ IDEA, confirm global Copilot instructions are enabled.
- Run a small smoke test: `/btw What is the workflow for implementing a feature?`

## Sync Policy

Use copied files for stability. Symlinks on Windows can require Developer Mode or elevated permissions and are harder for teams to troubleshoot.

Recommended update process:

1. Pull the latest prompt-library repo.
2. Review the diff.
3. Run `Tasks: Run Task` -> `Prompt Library: Hydrate Global Copilot Customizations`.
4. Verify VS Code and IntelliJ behavior.

Hydrate overwrites same-named global library artifacts. If a prompt-library release retires an artifact, delete the stale global file explicitly from `%USERPROFILE%\.copilot`.
