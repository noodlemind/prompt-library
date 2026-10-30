# AE qualification and PR #104 disposition research

Research scope: the complete changed-file inventory of PR #104 at
`34ccbf003f9dd31d3ad8215f9da80e44097dea6a` versus its main base
`0d44caad145bb3ef8ab9a7cf301ecfa00569615a`, the current local candidate at
`8699e9e`, actual package/CLI/hook verification entry points, and pstack's
verification architecture at `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`.
This is source and deterministic integration research. It does not claim a
native Copilot model trial, live IntelliJ qualification, or a fresh TLC check.

## Findings that change the implementation plan

1. **Reuse AE's existing installed-artifact lifecycle proof.**
   `packages/ae/test/deterministic-delivery.test.mjs:103` already packs and
   installs the archive outside the checkout, hydrates the runtime, drives real
   checks and hooks, observes failed behavior, tests stale/unfinished completion
   refusal, and recovers completion. It is a better base for this work than a new
   coordinator, evaluation engine, or duplicate generic harness.
2. **Separate portable release qualification from the macOS experiment pilot.**
   `.cursor/skills/verify-harness/scripts/prove-installed-release.mjs:10`
   deliberately requires Darwin because its release drive also performs the
   bounded numerical experiment. That constraint should not prevent qualifying
   ordinary package/plan/hook behavior on Linux or Windows. Keep its experimental
   contract explicit; use the existing portable lifecycle test for the ordinary
   delivery bar.
3. **Test the supported minimum runtime on the packed artifact.**
   `.github/workflows/package-candidate.yml` runs Node 24; the normal Linux and
   Windows suites run Node 22. The package declares Node >=20. A local focused
   Node 20 run is useful, but the minimum-runtime archive installation is not an
   existing CI release bar. Add Node 20 to the package-candidate qualification,
   keeping its full archive path rather than checking source imports only.
4. **Host support is a capability matrix, not one boolean.**
   The current GitHub customization matrix marks JetBrains skills/custom agents
   as preview and native hooks as unsupported. VS Code hooks are preview and
   Copilot CLI hooks are supported. Hydration can work while native mutation
   denial is unavailable. Doctor should inspect the selected supported surface
   and report these dimensions separately; it must not report installed prompts
   as proof that the host enforces a gate.
5. **Do not infer a CLI bug from event-name casing.**
   The current official Copilot hooks reference accepts PascalCase aliases,
   VS Code-compatible snake_case input, top-level `permissionDecision`, and
   `decision`/`reason`. AE already emits both top-level and VS Code-shaped
   decisions. The actual configuration shape, tool result parsing, discovery,
   and host-observed deny behavior must be tested. A new format fork is not
   justified merely because the preferred CLI examples use camelCase.
6. **A passed source/contract test is not a native-host result.**
   `packages/ae/eval/host/README.md` already states the right stronger protocol:
   exact installed archive, broken product baseline, actual selected Engineer,
   interruption/resumption, stale-source denial, review/verify/learning/complete,
   independent acceptance after the model stops, and retained evidence. Preserve
   this boundary rather than redefining a scripted response as a native trial.

## Executed observations

- Independent installed lifecycle check:
  `node --test --test-name-pattern='installed package proves behavior, hook layout' test/deterministic-delivery.test.mjs`
  from `packages/ae`: **1/1 passed, 0 skipped**, 19.35 seconds.
  Log: `research/qualification-installed-lifecycle.log`.
- A baseline serial-equivalent PreToolUse observation ran the three current
  source hooks on a read-file payload, in owned temporary homes, one warmup and
  20 measured runs: median 293.37 ms, p95 320.56 ms, maximum 320.75 ms. It uses
  three Node commands per tool call. Log:
  `research/qualification-pretool-timing.json`.
- That is a mechanism measurement under this machine's concurrent load, not
  actual native host scheduling or end-to-end model latency. It supports an
  explicit budget and a measured consolidation decision, not removal of a guard
  just because three processes look inelegant.
- `code` exists on PATH. `copilot`, `codex`, and `idea` were not found in that
  read-only PATH inventory. No editor, signed-in session, extension account, or
  native user application was probed or launched.
- The previous frozen full-suite result remains 3,655 passes / 20 failures /
  41 skips. The 20 process-suite failure locations match the untouched PR #104
  baseline and the observed PID/proc namespace mismatch. Do not change process
  identity controls to obtain a green number in this environment.

## PR #104: complete changed-subsystem disposition

The 189 changed paths are grouped below by owning behavior. Tests, supporting
corpus text, agent-context, and documentation changes are evaluated with their
owning behavior rather than treated as independent capabilities.

| Changed behavior / owning source | Disposition | Reason and acceptance |
| --- | --- | --- |
| Per-command help, global flags, equals-form flags, positional parsing (`bin/ae.mjs`, `lib/commands.mjs`, `flags.mjs`, `positionals.mjs`, `registry.mjs`) | Keep | The help path must not execute the command. Invoke real CLI from foreign cwd; preserve `--` semantics and selected homes. Existing `command-help` and registry/flag tests cover this boundary. |
| Target validation (`sync.mjs`, install help/tests) | Keep, qualify accurately | Unsupported targets must fail before writes. Do not imply Cursor/Codex/Grok are installed or guarded. Installed target names alone do not prove native hook support. |
| Selected-home doctor and effective enforcement (`doctor.mjs`, doctor-truth tests) | Keep and revise selected-target diagnosis | Empty homes must fail instead of inspecting package source; absent optional knowledge is n/a. `doctor.mjs:902–915` currently has only a VS Code host path. Add capability-aware selected-host diagnosis without manufacturing native proof. |
| Installed corpus reference resolution (`corpus-reference.mjs`, `get-cmd.mjs`, installed-reference tests, all associated corpus read pointers) | Keep | A product workspace cannot search globally hydrated skill files. Test installed locations with an empty product workspace and decoy local schema. Preserve explicit home identity and bound reads. |
| Corpus slash command inventory, stripped repository prose, host-read leading alternatives | Keep, simplify prose where redundant | These repair actual unreachable references and accidental global injection. Contract string tests establish text hygiene; an installed runtime drive must establish that the command/path works. |
| Nested subagent VS Code settings and reviewer allowlist (`vscode-settings.mjs`, agent frontmatter) | Keep as declared discovery capability | Verify exact settings and emitted agent names. Do not equate a setting with actual model delegation, and do not add delegation for every discovered folder. |
| Impacted-file parsing (`plan-scope.mjs`, `hooks/lib/impacted-files.mjs`) | Keep | One shared parser avoids CLI/hook disagreement, including quoted spaces/commas. Actual gate denied/allowed file cases should accompany parsing assertions. Directory-versus-glob authorship must remain explicit. |
| Standalone stdin decisions and recovery guidance (`plan-new`, `plan-update`, gate and corpus references) | Keep | Decisions should reach a supported canonical entry point without mixed shell operations or accidental product writes. Test real dispatcher/hook admission and interrupted operation replay. |
| Intent discovery exclusions (`intent-sources.mjs`, prepare/repo-map integration) | Keep | Ephemeral `.harness` artifacts are not authored product intent. Gitignored docs remain observable preparation failure, not an excuse to silently fabricate a spec. |
| Stable repository IDs (`knowledge/store.mjs`, git-context/worktree/storage aliases) | Keep | A subdirectory, linked worktree, symlink spelling and supported Windows casing should not fragment one repository's state. Check canonical identity and preserve distinct repositories. |
| Knowledge/project migration and branch recovery (`knowledge/admin.mjs`, storage-aliases, migration docs/tests) | Keep | Existing stranded data is a real user problem. Preserve source bytes, conflicting variants, nested checkout boundaries and occupied destinations. Verify a second run and dry run. Do not delete old stores to appear clean. |
| Canonical trust identities, alias revocation and inherited worktree trust (`trust.mjs`, worktree registration) | Keep | Approval must bind current policy and legitimate checkout identity; a canonical alias must not revive revoked authority. Unregistered sibling checkouts cannot inherit trust. |
| Hook authority deadlines and caching (`authority-bin`, proof-authority, policy) | Keep and measure | Reusing one invocation's observations can avoid exceeding a host deadline. A new command must still observe current bytes. Timeout/failure must not be converted to successful proof. |
| Domain completion observation cache (`git-observation-cache`, domain/completion/flow model) | Keep | Invocation-local caching repairs repeated Git metadata work without a cross-command stale cache. Assert observations refresh on a later command. |
| Windows command shims, archive extraction, process-tree cancellation (`runner`, global-bin, package tests) | Keep | Real platform integration faults; test installed `.cmd` execution, extraction deadline diagnostics, descendant cleanup, and unchanged cancellation semantics. Local Linux evidence does not qualify Windows. |
| macOS process creation identity (`experiment-state.mjs`, process-identity test) | Keep with supported-platform proof | Liveness/ownership must identify the intended process rather than the current process. Do not infer absence when observation is unavailable. The sandbox failure is an unavailable observer case, not justification to relax the invariant. |
| Finish/review budget and specialist selection (`review-preparation`, review/synthesis and corpus skill) | Keep principle, qualify selection and fresh coverage | Review one finished diff, bound follow-up rounds, and require every perspective selected by the fresh packet. Do not preserve stale results after changed sources. Tests establish selection/collection mechanics; native judgment independence remains declared rather than host-authenticated. |
| Review provenance declarations (`findings-schema`, reviewer corpus and `review.mjs`) | Keep explicit limits | A named specialist record is useful mechanical evidence, not proof that the host actually invoked an independent specialist. Same-context Engineer results must not be mislabeled independent. Do not make governance labels stand in for a transcript. |
| Smallest-change policy and removal of duplicate-guard experiment | Keep subtractive intent | The branch correctly reverted a speculative duplicate-guard feature. Review should identify a defect or requirement, not demand helper/abstraction growth unrelated to the requested behavior. |
| Investigate without plans (`engineer`, investigation playbook, ensure-plan and corpus) | Keep | A read-only explanation must not enter a mutation lifecycle or create an accepted change plan. When the user asks for a change, switch to Deliver. |
| Saved-workspace discovery, automatic domain draft, and one researcher per root (`workspace-layout`, orient and global instructions) | Revise; remove automatic consequences | Original need is visible repository binding. A saved file selected by largest root list is not the active window or task scope. Default to bound root/store; explicit task-relevant roots can be advisory inputs. Discovery alone must not trigger delegation or domain setup. |
| Per-role model setup (`setup-models`, model-preferences, spawn-site corpus reads) | Keep only as opt-in native-host preference | A user-selected role rule was explicitly chosen, but Cursor/Claude rule files do not configure Copilot subagents. Preserve host ownership and inherit defaults; do not invent models, pin provider versions, or make this a mandatory startup ceremony. No CLI model-selection engine is warranted. |
| Test home/process isolation (`isolate-test-home`, runtime-env, npm-launch, runner) | Keep | Product tests must not touch the real user home or accidentally inherit an evaluator's runtime. Exercise foreign cwd and paths with spaces, and assert the selected candidate binary/home. |
| Windows complete-suite shards and package-candidate CI | Keep and extend the minimum runtime bar | Verify all manifest/shards; do not count skipped shards as green. Archive tests should cover Node 20 as declared and real installed CLI/hook paths. Native editor activation remains separate. |
| Documentation/inventory/feature-map updates | Revise to final behavior, not speculative architecture | Rewrite around the accepted result rather than retaining abandoned choices as normative defaults. Preserve prior options as historical rationale only where needed. Count actual corpus inventory; don't hand-maintain contradictory totals. |

## Original issue labels: what is established and what is not

The current PR body is the available source for labels. The original full
numbered user bug report was not located in repository source or PR discussion;
therefore individual meanings for grouped labels must not be invented.

| Labels in PR body | Current evidence / required disposition |
| --- | --- |
| B1, B2, B4, B5, B10–B14, N1, N2, P0 | The body calls these fixed in slices 1–6. The corresponding help/install/doctor/corpus/settings mechanisms and tests exist. Reuse actual installed checks and keep claims bounded to what they drive. |
| B9, G2 | Unsupported target errors are fixed; target installation and enforcement are different capabilities. Do not add unsupported host adapters merely to turn a partial label green. Qualify each requested primary surface and diagnose unsupported contracts truthfully. |
| B3 | Concrete remaining issue: doctor supports `--host vscode` only (`doctor.mjs:902–915`), despite multiple install targets. Capability-aware selected-target diagnostics are warranted. |
| B6, B7, B8, B16, N3, N5 | Body groups these as host path/hook/deny contracts. Trace installed config, payload normalization, successful read activation, mutation denial, post-tool recording and stop behavior for VS Code/CLI; distinguish JetBrains customization from absent native hooks. Exact original per-label descriptions unavailable. |
| B15 | Three PreToolUse commands are concrete. The local serial mechanism measurement is above. Preserve all guards; choose a consolidation only with equivalence tests and an explicit budget, not aesthetic process-count reduction. |
| B17, B18, G3 | Body groups second-agent / ungated write/edit/apply/bash/exec. The actual governed Deliver dispatcher and native hooks must deny a second actor lacking current authority. Optional autonomous profile is explicitly a different lane and must not claim Deliver guarantees. Direct CLI use and arbitrary terminal commands are not an OS sandbox. |
| G1, N4 | Authority research confirms untrusted repo policy is parsed diagnostically but not applied. After human approval, the existing init stub's `observe` becomes effective; a new `enforce` default can fix the surprising new-project transition while existing explicit observe remains an opt-in with a truthful warning. Do not automatically approve trust or silently rewrite existing chosen policy. |
| G4, G5 | Current v2 source hashes and frozen intent selection already exist. Test structured start/amend/relock and changed/missing selected bytes before calling these open. Keep legacy paths-only contracts visibly legacy instead of relabeling them content-bound. |

## Minimal installed acceptance plan

Extend maintained entry points rather than create another runner. The tests must
run against the package under test, not a fallback source checkout or real user
state. Keep model-free setup records explicitly separate from host attestations.

1. Pack one exact candidate; retain source SHA/archive hash. Install offline into
   a path with spaces and private Copilot/AE homes. Remove source checkout and
   default user-home resolution from the execution path. Require candidate
   version, hydrated runtime/corpus/license identities, and no JAR payload or
   runtime acquisition.
2. Create two Git repositories and at least one inactive saved workspace that
   includes unrelated roots. For a one-repository task, the installed orientation
   must bind repository A and its store, without enumerating sibling workspaces,
   importing B's private knowledge, or promoting B into research scope. An
   explicit task-selected workspace can report candidates but cannot create a
   domain or widen write authority.
3. Use a small real product flow (catalog case/whitespace search or equivalent),
   with an evaluator outside the writable product scope. Prove the broken
   baseline first and preserve fixture data/order. Then exercise real read,
   start/gate, allowed scoped edit, forbidden external/ungated edit, named check,
   review collection, learning/no-learning and completion boundaries. A fixed
   expected stdout string alone is insufficient.
4. Interrupt after gate and after edit; rerun the same actual CLI operation and
   confirm idempotent owned recovery. Modify a selected spec and executable mode
   between check and completion. Require stale refusal; restore/amend by the
   supported path and run a fresh check. Verify failed checks and incomplete
   learning/review continue to block Stop.
5. Drive the native AE diagram compiler through the installed command using
   independent retained evidence fixtures. Preserve ordered duplicate states,
   negative-control identity, temporal loops, unsupported/incomplete outcomes,
   freshness, input bounds and injection/path containment. Assert this module's
   transitive import boundary excludes subprocess/network/tool acquisition.
   Do not substitute an upstream import or a freshly renamed vendor tree.
6. Run the ordinary portable acceptance on Node 20 and the package's current
   supported CI runtime/OS matrix. Keep macOS numerical experiment and actual
   model/editor trials as separately identified capabilities. Store all failed,
   skipped and unavailable observations with their prerequisite.

## Lessons grounded in pstack verification source

- `pstack/skills/create-verification-skill/SKILL.md:27–40` defines usable launch,
  doctor, one feature drive, retained evidence and cleanup, then requires the
  generated instructions to be executed. Adapt that behavioral unit, not another
  inventory-only checklist.
- `pstack/skills/maintain-verification-skill/SKILL.md:29–38` separates source
  readers from a single coordinator-owned live pass, verifies every mapped
  feature, rechecks health after surprises, preserves evidence, and removes
  residue. AE already has feature maps: complete missing user routes rather than
  introduce a parallel map format or new agent entry point.
- `pstack/skills/statechart/scripts/test/pipeline.test.ts:66–113` enforces pure
  import boundaries transitively, and its corpus/differential tests compare
  semantically meaningful outcomes. AE can own an equivalent purity invariant
  and original fixtures without carrying pstack's implementation.
- `pstack/docs/guide/06-verify-and-ship.md` distinguishes a CLI's actual command,
  real user behavior, independent checking and unreachable prerequisites. Its
  claim is bounded by the path actually driven; it does not prove universal
  stability merely because pstack has iterated more often.

## Primary host references checked during this research

- [GitHub customization matrix](https://docs.github.com/en/copilot/reference/customization-cheat-sheet):
  JetBrains native hook support is absent; custom agents/skills are preview.
  VS Code and CLI have different host integration surfaces.
- [GitHub hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference):
  user hooks discovery, PascalCase aliases and compatible payloads, decisions,
  fail-open host timeouts, and continuation caps. AE must not claim an
  unbypassable OS boundary from these hooks.
- [VS Code hooks](https://code.visualstudio.com/docs/agent-customization/hooks):
  primary IDE hook setup/reference. Verify the installed target and actual
  extension version, not only the source schema.

These are current documentation observations on 2026-10-29. They do not prove a
particular installed user's extension version or session behavior.
