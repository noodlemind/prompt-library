# Workspace layout detection

Krish chose option 3 on 2026-10-29. `ae orient` labels the bound Git root, reads a saved VS Code or IntelliJ workspace file, and prints a domain draft. It does not write that file.

`layout` is on the full `ae orient` JSON and on `ae orient --read` (including context version 2's `slice`):

```json
{
  "boundRoot": "/work/repo-a",
  "kind": "monorepo",
  "markers": ["pnpm-workspace.yaml"],
  "workspaceType": "vscode",
  "workspaceFile": "/work/dev.code-workspace",
  "roots": [
    { "root": "/work/repo-b", "kind": "product-repo", "markers": [] }
  ],
  "domainSuggestion": {
    "path": "<harness-home>/domains/repo-a-repo-b.yaml",
    "yaml": "domain_version: 2\nname: repo-a-repo-b\nrepos:\n  - id: repo-a\n    origin: https://example.invalid/team/repo-a\n"
  }
}
```

`kind` is `monorepo` or `product-repo`. `unknown` means the directory is not a Git work tree. A monorepo marker is `pnpm-workspace.yaml`, a non-empty `package.json` `workspaces` array or `workspaces.packages`, `lerna.json`, `nx.json`, `turbo.json`, `settings.gradle` or `settings.gradle.kts` with more than one `include`, a Maven `<modules>` list that contains a `<module>`, `MODULE.bazel`, `WORKSPACE`, or `WORKSPACE.bazel`. One Gradle `include` stays a product repo. `includeBuild` alone is not counted.

`workspaceType` is `vscode`, `intellij`, or `none`. The reader looks for `*.code-workspace` in the bound root and its parent, and for `.idea/vcs.xml` in those same two places. Relative folder paths resolve from the workspace file. `%USERPROFILE%`, `~`, backslashes, and drive letters are accepted. `$PROJECT_DIR$` in a mapping expands to the directory that contains `.idea`. A saved VS Code file that includes the bound root wins over `vcs.xml`. `none` is also an unsaved Add Folder window: there is no file to read.

`roots` lists the other Git roots from that file, each with its own kind and markers. Orient does not open their plan or knowledge stores. Plans stay on the bound repo's store. When `roots` is non-empty, those checkouts are in scope for read-only investigation, one researcher per repo.

`domainSuggestion` is present only when the saved workspace has more than one Git root and no `<harness-home>/domains/*.yaml` already covers every one of them. The yaml is `domain_version: 2` with `origin` or `local_identity: {id, approved: true}`, and `bindings` hold the absolute roots. A person saves it at `path`. AE does not create the file. An invalid domain file is ignored. A credential-bearing origin is not copied into the draft; that repo is named with `local_identity` instead.

The engineer states the bound repo and its kind at the start of the reply.

The rest of this note is the research behind that choice.

AE today binds one directory. `flags.workspace` defaults to `process.cwd()` (`packages/ae/lib/flags.mjs`). Git identity is `git rev-parse --show-toplevel` from that directory (`packages/ae/lib/git-context.mjs`). The plan and knowledge store is `<harness-home>/projects/<repo-id>/`, and the id is a slug of `origin` or `local-` plus a hash of that one checkout (`packages/ae/lib/project-layout.mjs`, `packages/ae/lib/knowledge/store.mjs`). Hooks walk up from a touched file until they see `.git` or `.harness` (`packages/ae/corpus/hooks/lib/tool-payload.mjs`). Before this change there was no reader for `.code-workspace`. `ae inventory` records editor installs and does not scan the live window during orient (`docs/adaptive-engineering.md`, "Optional environment observations").

A multi-repo question already has a hand-written home: `<harness-home>/domains/<name>.yaml`. Version 2 names repos by origin, keeps absolute paths in `bindings`, and caps membership at 32 (`packages/ae/lib/domain-contract.mjs`). `ae domain show` reads that file and does not invent one. The paths `docs/multi-repo-domains.md` and `docs/user-feature-maps-and-ide-discovery.md` are not in this checkout. The domain contract that is in the checkout is the section "Shared intent and domain delivery" in `docs/adaptive-engineering.md`.

Three shapes are different things:

- A **monorepo** is one Git root that contains several packages or modules.
- A **product repo** is one Git root without that marker.
- A **multi-repo workspace** is several Git roots opened together in one editor window. A Gradle or Maven multi-module tree inside one Git root is the first shape, not the third.

## How other tools tell those shapes apart

### One Git root, many packages

These markers sit at the root of one repository. Presence of the file is the usual signal. A few files are only a monorepo when an inner field lists more than the root.

| Signal | What it means | Source |
| --- | --- | --- |
| `pnpm-workspace.yaml` with `packages:` | pnpm workspace. pnpm does not use `package.json` `workspaces`. | [pnpm-workspace.yaml](https://pnpm.io/pnpm-workspace_yaml) |
| `package.json` `workspaces` | npm and Yarn workspace globs. | [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) |
| `lerna.json` | Lerna. By default it reuses a `workspaces` config when one exists. | [Lerna configuration](https://lerna.js.org/docs/api-reference/configuration) |
| `nx.json` | Nx workspace config. Nx finds projects from the package manager's workspaces, plus `project.json` / `package.json`. | [Nx mental model](https://nx.dev/docs/concepts/mental-model) |
| `turbo.json` | Turborepo pipeline. Nx's migration guide treats `nx.json` as the equivalent file. | [Nx from Turborepo](https://nx.dev/docs/guides/adopting-nx/from-turborepo) |
| `settings.gradle` or `settings.gradle.kts` with `include` | Gradle multi-project build: one settings file, subprojects under that root. `includeBuild` is a composite build and can point outside the root. | [Gradle multi-project builds](https://docs.gradle.org/current/userguide/multi_project_builds.html) |
| Maven `<modules>` | One reactor, several module directories. | [Maven multi-module guide](https://maven.apache.org/guides/mini/guide-multiple-modules.html) |
| `MODULE.bazel` or `WORKSPACE` / `WORKSPACE.bazel` | Bazel module or workspace root. | [Bazel MODULE.bazel](https://bazel.build/rules/lib/globals/module) |

A single `include ':app'` in an Android `settings.gradle` is a normal one-app layout. Counting includes matters. I did not re-run Gradle or Maven here.

Rush (`rush.json`), Cargo `[workspace]`, and `go.work` are the same kind of marker. I did not fetch their current manuals in this pass.

### Several folders in one VS Code window

VS Code stores a multi-root window in a `.code-workspace` file. `folders` is an array of `{ "path", "name?" }`. File, Add Folder to Workspace, and dragging a folder into the explorer create that window. Until the user saves the workspace, there is no file on disk. Extensions see the live list through `workspace.workspaceFolders`, map a file with `workspace.getWorkspaceFolder(uri)`, and are told not to use the old single `rootPath`. Folders may overlap. A folder URI is not always a local `file:` path.

Sources: [Multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces), [Adopting multi-root workspace APIs](https://github.com/microsoft/vscode-wiki/blob/main/Adopting-Multi-Root-Workspace-APIs.md).

Copilot, Claude, and Codex sessions in that window still have one primary directory. It is the session cwd. Hooks and some instructions load only from that directory. The agent can still read the other folders. The primary directory is fixed after the first message. The Agents window does not support multi-root sessions yet. The same page says an agent can still be asked to work across projects in one session.

Source: [Multi-root workspace support in Chat](https://github.com/microsoft/vscode/wiki/Multi%E2%80%90root-Workspace-support-in-Chat), [Agents window](https://code.visualstudio.com/docs/agents/run/agents-window).

A Claude Code issue reports that the VS Code extension uses the first `folders` entry and ignores `terminal.integrated.cwd`. That is a report, not a specification. [anthropics/claude-code#24739](https://github.com/anthropics/claude-code/issues/24739).

A Cursor community post says the Cursor CLI takes one workspace directory, and that a parent folder plus `.cursorignore` is the CLI workaround. A third-party write-up says the desktop app opens `.code-workspace` files and that shell commands still have one primary folder. I did not fetch a Cursor-owned manual that defines this. [Cursor forum](https://forum.cursor.com/t/multi-repository-code-analysis-with-cursor-cli/159483).

### IntelliJ, Gradle, and Maven in one project

Project settings live under `.idea/`. VCS directory mappings are the Version Control settings page. IntelliJ scans for Git roots it has not registered and lists them as unregistered. Git submodules are registered as extra roots when a project is imported. A mapping can be the whole project or one directory. The stored file people edit by hand is `.idea/vcs.xml`, with one `<mapping directory="..." vcs="Git"/>` per root.

Sources: [Directory mappings](https://www.jetbrains.com/help/idea/settings-version-control-directory-mappings.html), [Set up a Git repository](https://www.jetbrains.com/help/idea/set-up-a-git-repository.html), [Project settings](https://www.jetbrains.com/help/idea/configure-project-settings.html).

`.idea/workspace.xml` is personal and is not the shareable project description. `modules.xml` and `*.iml` are often generated for Maven and Gradle and are on JetBrains' do-not-commit list for those projects. So a committed `modules.xml` is not a reliable signal.

Copilot for JetBrains has no published "here is the folder array" that I found. Two reports are the evidence:

- Agent mode on several content roots was reported broken, then called supported in plugin 1.5.61. Ask mode was said to see more than Agent mode. [copilot-intellij-feedback#769](https://github.com/microsoft/copilot-intellij-feedback/issues/769).
- Plugin 1.10.1 still picks a workspace root with `guessProjectDir`, and that root can be a submodule. The directory differs across machines. Custom prompts under `.github/` at the project base are then missed. The report points at the same class of bug as JetBrains [LLM-27204](https://youtrack.jetbrains.com/issue/LLM-27204). [copilot-intellij-feedback#1809](https://github.com/microsoft/copilot-intellij-feedback/issues/1809).

JetBrains' own Copilot page says automatic context is the open file and the selection. Other files are attached with `@`. Instructions are read from `AGENTS.md` and `CLAUDE.md` in "the root project directory." [GitHub Copilot in AI Assistant](https://www.jetbrains.com/help/ai-assistant/copilot-agent.html).

I did not find a JetBrains API page that lists every module root to an agent the way `workspace.workspaceFolders` does.

### Other agent harnesses

- **Aider** uses one Git repo. `--subtree-only` limits the map to the directory where it was started. The FAQ says it cannot work with multiple Git repos at once. The workaround is `/read` of a file or a repo map from the other repo. [Aider FAQ](https://aider.chat/docs/faq.html).
- **Cline** reads VS Code multi-root folders and records path, name, VCS type, and HEAD per folder. Rules, skills, and `@git` use the first folder only. Checkpoints are off in multi-root. [Cline multi-root](https://docs.cline.bot/features/multiroot-workspace).
- **Continue** context providers (`@File`, `@Tree`, `@Repository Map`) are documented against the current workspace. I did not find a multi-root classifier on that page. [Continue context providers](https://docs.continue.dev/customize/deep-dives/custom-providers).
- **Sourcegraph Cody.** I did not fetch a Sourcegraph page that says Cody reads `.code-workspace`. A third-party comparison describes local file, local repo, and remote Sourcegraph repo context. That is not Cody's own spec, so I am not treating it as the product behavior.
- **pstack.** The setup skill I read writes a user model rule. It does not classify a workspace. I did not re-read every skill in [cursor/plugins `pstack`](https://github.com/cursor/plugins/tree/main/pstack) for this note.

## Signals AE can read with Node and git

No editor API, and no search tool. The same checks work on Windows, macOS, and Linux if paths use `path` and Git is invoked as an argv array.

From the bound directory, walk to the Git toplevel. Then:

1. **One root or several.** `git rev-parse --show-toplevel` and `git remote get-url origin`. If the directory is not inside a work tree, say so. Do not guess a parent that contains several clones.
2. **Monorepo markers on that one toplevel.** Look for the files in the table above. For `package.json`, parse JSON and require a non-empty `workspaces` array or `workspaces.packages`. For Gradle, a settings file with two `include` entries, or any `includeBuild`, is the multi-project signal. For Maven, a `<modules>` list. Read with a byte cap. A missing or invalid file is "marker absent," not a monorepo.
3. **Saved VS Code workspace.** If cwd, or a parent of cwd, is a `.code-workspace` file, or `--workspace-file` names one, parse `folders`. Resolve each `path` relative to the file. Run the Git identity check in each folder. Two different toplevels means multi-repo. One toplevel means a monorepo or a product repo that was opened as several folders. Overlapping folders are one repo.
4. **IntelliJ mappings.** If `.idea/vcs.xml` exists under the bound directory, read `mapping` `directory` attributes. Resolve `$PROJECT_DIR$`. Run the Git identity check per directory. Several Git toplevels means multi-repo. One toplevel with several modules is a monorepo or a multi-module product repo. Do not trust `workspace.xml` or a generated `modules.xml`.
5. **Unsaved Add Folder.** There is no file. Node cannot see those folders. The host would have to pass the folder list. Until it does, the honest result is "editor folders unknown; bound to this Git root."

`ae inventory` does not supply this. It avoids editor state databases (`docs/adaptive-engineering.md`).

## Where a result would live

Orient already returns the active plan, the Git context, and a procedure pointer. A layout object fits that JSON. It would name:

- `kind`: `product-repo`, `monorepo`, `multi-repo`, or `unknown`
- `boundRoot`: the Git toplevel actually used
- `origin`: or the local id
- `markers`: which files matched
- `roots`: the other folders, only when a workspace file or `vcs.xml` was actually read
- `store`: the `projects/<repo-id>` path for the bound root

The engineer would say that bound root in the first reply of an Investigate or Deliver turn. A multi-repo list would be a list of roots, not a license to write in all of them.

Store selection stays as it is:

- Product repo and monorepo: one repo id, one project store. Packages inside a monorepo do not get their own stores.
- Multi-repo, no domain file: one store, the bound root. Other roots are names the model can pass as `--workspace` on a later command. Orient does not open them.
- Multi-repo, with a domain file: the existing parent plan under `domains/<name>/plans/` and one child plan per member store. Showing the layout does not create that file.

Auto-writing a domain yaml from `.code-workspace` or `vcs.xml` would turn an editor window into authority. Domain version 2 treats membership and path bindings as authored, and drift requires an amendment. An automatic write fights that.

## Options

Smallest change first. Krish chose the third, which includes the label and the workspace read. The behavior at the top of this note is what shipped.

### Report the bound root

Orient adds the layout object for the one Git root it already uses. Monorepo markers are a label. A missing `.code-workspace` is `editorFolders: unknown`. The engineer sentence is which repo it is bound to. Plans and knowledge stay on that repo id.

Tradeoff: Krish sees the mistake that happened in the multi-root window. AE still cannot list the other folders unless a file on disk names them. No domain, gate, lock, trust, or hook change.

### Read a workspace file when one is on disk

Same orient object, plus folders from a `.code-workspace` or `.idea/vcs.xml` found next to cwd or passed with a flag. Each folder gets a Git identity. The active store remains the cwd root. The engineer is told to repeat `--workspace` for another root.

Tradeoff: a saved workspace and a saved IntelliJ mapping become visible. An unsaved Add Folder window stays unknown. A parent directory that is not a Git root still needs the file path. Parsing `vcs.xml` and Gradle `include` can mis-count. The result is advisory.

### Print a domain draft, do not write it

A command prints a version 2 domain body from those roots and stops. A person copies it into `<harness-home>/domains/<name>.yaml` and runs the domain commands that already exist.

Tradeoff: the multi-repo plan and knowledge story stays the one AE already has. The cost is a new command and a review of the draft, because a wrong folder list would become a domain if someone saves it. Still no gate or hook change.

## Decisions

- Marker file names are enough. Package directories inside one Git root are not listed.
- An unsaved Add Folder window stays `workspaceType: none`. No hook payload was added.
- `.idea/vcs.xml` is read when it is on disk next to the bound root or its parent. A missing file stays `none`.
- The bound root is `git rev-parse --show-toplevel` for the directory AE was given.
- `layout` is part of the orient slice. Session start already injects that slice, so the field is visible there without a hook change.
