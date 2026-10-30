# AE setup reliability audit — 2026-10-30

## Scope and evidence

This audit follows the mainstream reliability review and examines setup rather than
agent behavior: product initialization, orientation artifacts, runtime resolution,
installation and upgrade, editor discovery, doctor recovery, private/shared
configuration, version guidance and the supplied CI template. The baseline is local
`88152be1c077d49897f5d7adec1b92adbbd2ba05`, equivalent to published PR104 tree
`747b52e1090e4d6c76d6f1897c834a82e1bbcec1` at
`a1b28093dcc4e7eb83092d7905c60a024a43e1eb`.

Findings below describe the baseline. Repair status and exact qualification belong
to the final implementation and test receipts; an entry here does not independently
claim that its repair shipped. Static inspection and disposable Git/filesystem
fixtures establish the stated observations. No actual user's installation, editor
settings, repository trust, package registry or Java/TLC installation was changed.
Native Copilot/IntelliJ behavior, Windows execution and crash-at-every-operation
coverage require their own qualification.

## Findings

| ID | Severity | Concrete failure | Root cause and required correction |
| --- | --- | --- | --- |
| S1 | P2 | Initialization introduces three untracked `.github/harness/*.yaml` files outside an unrelated source-only plan. | `lib/init-repo.mjs` writes shared configuration unconditionally. Select personal project storage for new private setup, explicitly choose shared configuration, and preserve established repository policy. |
| S2 | P2 | Hiding setup files with root `.gitignore` makes `.gitignore` the scope violation; hiding already tracked files does not suppress their edits. | Setup ownership and task scope are mixed. Do not waive shared policy or `.gitignore` from all plans. Resolve setup before the accepted product task and use local metadata for private artifacts. |
| S3 | P2 | `ae worktree` itself creates/changes root `.gitignore` with `.worktrees`. | `lib/worktree.mjs:ensureWorktreeIgnore` treats a machine-local checkout location as a shared product edit. Use safe Git-local exclude metadata, accounting for linked and separate Git directories. |
| S4 | P2 | Routine initialization/orientation leaves `.harness/.gitignore`, `run.mjs` and `repo-map.md` visible in Git status. | The ignore list in `lib/session.mjs` is incomplete. `.harness/**` is already excluded from Harness scope and product diff, so status noise and scope failures must not be conflated. Tool-owned runtime output should remain private. |
| S5 | P2 | A generated runner carrying a current version marker can retain obsolete installation advice. An unrelated unversioned `run.mjs` can be overwritten. | `lib/resolve-harness-bin.mjs:writeHarnessRunner` uses marker presence as freshness and otherwise rewrites blindly. Recognize owned generators, compare current generated content, preserve unrelated files, and refuse unsafe targets. Doctor must use the same status check. |
| S6 | P2 | A selected custom Copilot home receives installed assets while VS Code is configured to discover the default home. Doctor can then report that default discovery as valid. | `lib/vscode-settings.mjs` hardcodes `~/.copilot/{agents,instructions,skills,hooks}` and `doctor.mjs:vscodeDiscoveryConfigured` checks the same default. Derive discovery paths from the selected home and test actual installation output, including paths with spaces and existing unrelated locations. |
| S7 | P2 | README/tool contract promise a `.harness-version` or product `devDependency` pin, but generated runner can execute the global installation instead. | No runtime reader for `.harness-version` was found. Resolver prefers global overrides/shims/runtime/PATH; workspace runner does not resolve the product dependency. Remove unsupported pin claims or implement explicit, tested selection and compatibility. Do not imply arbitrary teammate-version compatibility. |
| S8 | P2 | The supplied verification workflow tries to download an unpublished registry package, then expects committed legacy plans and fresh CI trust/evidence. | `.github/workflow-templates/harness-plan-verification.yml` assumes a distribution/authority contract that current AE does not provide. Use an explicit reviewed archive/source setup contract, or retire the unsupported template. Do not automatically approve repository commands in CI. |
| S9 | P2 | Failed runtime upgrade can leave a new CLI entry point alongside old library files. | `lib/install-harness-bin.mjs` copies directly into final `.ae-bin` before the final installation lock is published. Stage and qualify a complete runtime with recoverable publication, or record a failed-install state that refuses mixed execution and gives deterministic repair. |

### Reproductions and limits

**S1–S4:** A clean temporary Git product repository with a plan allowing only
`src/app.js` yields three scope violations after real `runInitRepo`:
`.github/harness/checks.yaml`, `policy.yaml`, and `routing.yaml`. Adding a root
`.gitignore` that hides `.github/harness/` and `.harness/` changes the result to the
single violation `.gitignore`. Force-tracking checks before ignoring and editing
retains both `checks.yaml` and `.gitignore` as changed product files. No
`.harness/**` path enters `collectChangedFiles`; that exclusion already exists.

**S5:** The installed source currently contains no live `@devkit/harness` or
`npx @devkit/harness` recovery command. The current `INSTALL_FIX_HINT` uses a
checkout installation of `ae-harness`. The reported obsolete text can survive in a
previously generated product runner because its marker is accepted without
checking the rest of its content. The runtime implementer's regression fixtures
must establish the exact old-generator migration supported by the repair; source
search alone does not identify the user's particular file.

**S6:** Baseline `mergeVSCodeSettings({})` emits default home locations and accepts
no selected-home input. The real `doctor-target-recovery.test.mjs` custom-home
fixture currently verifies that V3 passes after configuration without asserting
that its discovery path equals the custom installed home. Both sides agree on the
same incorrect default; this is an example of a passing test that misses the
product contract.

**S7:** Source search for `harness-version` finds the README and tool contract,
not runtime consumption. The old example pins version `0.13.0` although the current
package is `0.14.0`; updating the numeral alone would not fix selection.

**S8:** This finding is static. The package README explicitly says the package is
not published; the supplied template uses `npm install --global
"ae-harness@${HARNESS_VERSION}"`. It searches only changed `docs/plans/*.md`,
although fresh plans live in the external project store. It does not provision
human-approved execution authority, current review or accepted plan evidence for
the new runner. No live workflow or registry request was run for this audit.

**S9:** A tiny disposable package with `bin/ae.mjs` and `lib/helper.mjs` was
installed through the real `installHarnessBin`. Its source was changed, and an
injected `ENOSPC` was raised on the second actual `copyFileSync` call. The command
threw; reading the final installed directory returned new CLI bytes and old helper
bytes. This proves the partial-publication behavior under a selected I/O failure,
not that a real machine experienced disk exhaustion. The fixture was removed.

The local S9 repair stages the complete runtime and preserved unowned siblings,
then publishes the directory under the existing per-home lock. A small contained
journal binds stage/backup directory identities. Copy failures leave the old
runtime intact; publication failures restore it, and a later install can recover
a retained interrupted retirement. Invalid recovery metadata is retained and
refused. The new three positive failure reproductions initially failed 0/3; after
repair, the expanded five transaction tests and existing installation boundaries,
real CLI install/upgrade and lock-ownership selections passed 56/56 on Linux
Node24. That selected run does not establish a final-revision full-suite or Windows
result. Directory publication may briefly make the runtime absent; it does not
guarantee uninterrupted dynamic imports by an already-running process. Copilot
corpus and editor settings installation remain separate operations rather than a
single cross-directory transaction.

## Architecture direction

The highest-leverage change is one explicit setup identity: selected runtime,
selected customization home, selected state home and selected project authority.
Every setup and runtime consumer must resolve that same identity, and diagnostics
must describe the actual selected sources. Copies, marker strings and a successful
install command do not establish host activation or completed task proof.

1. New private setup stores project authority and private artifacts outside the
   product change set. Shared team authority is an explicit reviewed choice.
2. Existing shared policy is honored. Malformed, redirected or conflicting sources
   cannot silently choose another source or establish approval.
3. Approval remains user-local and binds the selected authority. It does not
   transfer through Git, certify transitive scripts or provide OS containment.
4. Shared policy edits remain normal scoped product edits. Runtime bookkeeping
   does not weaken plan scope, review freshness or proof binding.
5. Runtime refresh is ownership-aware and reports the actual executable selected.
   Recovery never downloads a renamed/unpublished package speculatively.
6. Qualification follows actual installed commands in isolated homes, not only
   matching helper implementations: fresh install, rerun, upgrade, clone, linked
   worktree, separate Git directory, missing runtime, custom home, invalid source,
   unrelated user files and interrupted publication.

## Remaining qualification boundaries

The source audit is broad within setup, but it is not an assertion that every
platform, editor or filesystem failure has been exercised. Cross-platform package
jobs must run the exact final candidate. Native model sessions must separately
show that the selected editor loads the selected files and preserves the intended
human authority boundary. A failed or untrusted named verification result cannot
be promoted to a passing completion record.
