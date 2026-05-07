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
C:\Users\<you>\AppData\Local\github-copilot\intellij\global-copilot-instructions.md
```

Library-managed review checks are bundled inside the `/code-review` skill under `skills\code-review\references\checks`. They are not copied to a separate global checks folder because checks are not a standard Copilot primitive.

## VS Code Hydrate Task

The preferred Windows workflow is:

1. Open the prompt-library checkout in VS Code.
2. Pull the latest prompt-library changes.
3. Open the Command Palette.
4. Run `Tasks: Run Task`.
5. Choose `Prompt Library: Hydrate Global Copilot Customizations`.

The task definition lives in `.vscode/tasks.json`. It syncs source artifacts from the current prompt-library checkout into `%USERPROFILE%\.copilot`, removes stale files previously created by this library, removes known retired legacy artifacts, and updates IntelliJ IDEA's global Copilot instructions file.

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
  },
  "chat.agentSkillsLocations": {
    "C:\\Users\\<you>\\.copilot\\skills": true
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
| Bundled checks | `%USERPROFILE%\.copilot\skills\code-review\references\checks\*.md` | Skill-local review criteria loaded by `/code-review`; not a native Copilot primitive |

`agent-context.md` is not a VS Code global customization primitive. Treat it as repository knowledge, not as something VS Code automatically discovers globally. For this prompt-library repo, `.github/agent-context.md` records library-specific learnings. For product repositories, persistent product context should live in product-owned docs such as `docs/plans/`, `docs/solutions/`, `docs/codebase-snapshot.md`, `docs/agent-context.md`, or `README.md` when a skill intentionally creates or updates them.

Keep `.github/copilot-instructions.md` in this repo. It is still useful when developing the prompt library itself and when GitHub/Copilot needs repository-wide guidance. Do not copy it into product repositories under the global-only policy; use global `.instructions.md` files for reusable team behavior instead.

## IntelliJ IDEA Global Usage

IntelliJ IDEA does not use VS Code tasks from inside IntelliJ and does not have identical global customization discovery.

Use this policy:

- Run the Hydrate task from VS Code to keep `%USERPROFILE%\.copilot` current.
- The Hydrate task also writes IntelliJ IDEA's global Copilot instructions file at `%LOCALAPPDATA%\github-copilot\intellij\global-copilot-instructions.md`.
- The IntelliJ global instructions file is compiled from every `.github/instructions/*.instructions.md` file so Java, Python, PostgreSQL, AWS SDK, Spring Boot, TypeScript, and prompt-library workflow standards are all present.
- In IntelliJ IDEA, confirm **global Copilot instructions** are enabled through the GitHub Copilot settings UI.
- Verify whether the installed IntelliJ Copilot plugin discovers global prompt files and custom agents. If it does not, users can still manually invoke the workflow names in chat, but slash-command and agent-dropdown behavior may differ from VS Code.

Do not copy prompt-library artifacts into product repositories just to make IntelliJ discover them. That violates the global-only policy.

JetBrains currently supports repository `.github/copilot-instructions.md` and a global Copilot instructions file through its Copilot settings UI. Treat IntelliJ as instruction-first unless a team's installed plugin version confirms broader global prompt/agent/skill discovery.

## Manual Global Fallback

If VS Code tasks are unavailable, run the equivalent PowerShell from the prompt-library checkout:

```powershell
$PromptLibrary = "$env:USERPROFILE\prompt-library"
$Copilot = "$env:USERPROFILE\.copilot"

New-Item -ItemType Directory -Force $Copilot | Out-Null

function Sync-PromptLibraryDir($From, $To) {
  if (!(Test-Path $From)) { return }

  New-Item -ItemType Directory -Force $To | Out-Null
  $Manifest = Join-Path $To ".prompt-library-manifest.txt"

  if (Test-Path $Manifest) {
    Get-Content $Manifest | ForEach-Object {
      if ($_) {
        $Old = Join-Path $To $_
        $Replacement = Join-Path $From $_
        if ((Test-Path $Old) -and !(Test-Path $Replacement)) {
          Remove-Item $Old -Recurse -Force
        }
      }
    }
  }

  robocopy $From $To /E /NFL /NDL /NJH /NJS /NP /XF .prompt-library-manifest.txt
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

  Get-ChildItem $From -Recurse -File |
    ForEach-Object { $_.FullName.Substring($From.Length).TrimStart([char]92) } |
    Sort-Object |
    Set-Content -Path $Manifest -Encoding utf8
}

$Retired = @(
  "agents\compounding-python-reviewer.agent.md",
  "agents\compounding-rails-reviewer.agent.md",
  "agents\dhh-rails-reviewer.agent.md",
  "agents\every-style-editor.agent.md",
  "instructions\rails.instructions.md",
  "prompts\create-agent-skills.prompt.md",
  "skills\create-agent-skills",
  "checks\README.md",
  "checks\skill-description-quality.md",
  "checks\primitive-boundary-quality.md"
)

foreach ($Relative in $Retired) {
  $RetiredPath = Join-Path $Copilot $Relative
  if (Test-Path $RetiredPath) { Remove-Item $RetiredPath -Recurse -Force }
}

Sync-PromptLibraryDir "$PromptLibrary\.github\skills" "$Copilot\skills"
Sync-PromptLibraryDir "$PromptLibrary\.github\agents" "$Copilot\agents"
Sync-PromptLibraryDir "$PromptLibrary\.github\instructions" "$Copilot\instructions"
Sync-PromptLibraryDir "$PromptLibrary\.github\prompts" "$Copilot\prompts"

$IntelliJ = "$env:LOCALAPPDATA\github-copilot\intellij"
New-Item -ItemType Directory -Force $IntelliJ | Out-Null
$InstructionRoot = "$PromptLibrary\.github\instructions"
if (Test-Path $InstructionRoot) {
  $InstructionFiles = @(
    Get-ChildItem $InstructionRoot -Filter "*.instructions.md" |
      Sort-Object @{ Expression = { if ($_.Name -eq "prompt-library-global.instructions.md") { 0 } else { 1 } } }, Name
  )

  $Parts = @(
    $InstructionFiles | ForEach-Object {
      $Text = Get-Content $_.FullName -Raw
      $Text = $Text -replace '(?s)^---\r?\n.*?\r?\n---\r?\n', ''
      "<!-- Source: $($_.Name) -->`r`n$($Text.Trim())"
    }
  )

  if ($Parts.Count -gt 0) {
    Set-Content "$IntelliJ\global-copilot-instructions.md" ($Parts -join "`r`n`r`n") -Encoding utf8
  }
}
```

## Verification Checklist

After hydration:

- In VS Code, type `/` and confirm prompts such as `/start`, `/btw`, `/project-readme`, `/java`, `/python`, `/sql`, and `/aws` appear.
- In VS Code, type `@` and confirm `@engineer` and coordinator agents are available.
- In VS Code diagnostics, confirm agents, prompts, and instructions are loaded from `%USERPROFILE%\.copilot`.
- In IntelliJ IDEA, confirm global Copilot instructions are enabled and that `%LOCALAPPDATA%\github-copilot\intellij\global-copilot-instructions.md` exists.
- Run a small smoke test: `/btw What is the workflow for implementing a feature?`

## Sync Policy

Use copied files for stability. Symlinks on Windows can require Developer Mode or elevated permissions and are harder for teams to troubleshoot.

Recommended update process:

1. Pull the latest prompt-library repo.
2. Review the diff.
3. Run `Tasks: Run Task` -> `Prompt Library: Hydrate Global Copilot Customizations`.
4. Verify VS Code and IntelliJ behavior.

Hydrate overwrites same-named global library artifacts. It also keeps a `.prompt-library-manifest.txt` in each hydrated folder so later runs can remove files that this library previously installed but no longer ships. The cleanup only targets files recorded in that manifest plus known retired legacy artifacts, so unrelated user customizations in `%USERPROFILE%\.copilot` are not deleted.
