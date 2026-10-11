# Harness repair verification — 2026-10-11

This change repairs the implementation seams reproduced during the internal audit and comparison of the two supplied Parallel reports. The starting source was `e6a2e829566b61509e16a1296a4ab2e8f47f56ce`, Harness 0.10.0. The isolated branch is `feature/harness-research-repairs`. The primary checkout and installed Copilot homes were preserved.

## Summary

- **Requested outcome:** Implement the accepted repair-first plan for Adaptive Engineering and Harness.
- **Observed gap:** Opaque terminal commands escaped mutation accounting; document review rejected valid external drafts; long check output lost late errors; workflow instructions contradicted current tool authority and lifecycle gates.
- **Why existing capabilities are insufficient:** Existing owners are correct, but these handoffs and boundary implementations were incomplete. Repair them rather than add another planner, task runner, review merger or memory store.
- **User impact if not addressed:** Commands can leave unchecked changes, draft review cannot run, failure diagnosis loses the final error, and agents receive unusable workflow instructions.

## Trigger Evidence

The user requested external and internal research, asked to compare the reports, supplied additional Parallel interaction `trun_9b1e8d8f7d5e43b3b1cec648bf498b44`, then authorized implementation: “Using this as our plan, please go ahead and start the implementation.” The later request “Go full poteto-mode” added its review, audit and PR workflow.

The raw reports and source-scrutinized synthesis remain in the primary checkout's `docs/research/`. Regression cases in this branch encode the demonstrated mechanisms; vendor descriptions are not outcome evidence.

## Existing Primitive Check

| Area checked | Existing owner | Decision |
|---|---|---|
| Skills | engineer, ensure-plan, architect, create-primitive, project-readme, code-review, document-review | Repair contracts in place. |
| Agents | Engineer, implementer, review coordinator | Engineer owns CLI calls; coordinator supplies judgment. |
| Instructions | copilot-instructions and shared workflow references | Align storage, TDD and completion guidance. |
| Prompt wrappers | Retired | Add none. |
| Review checks | capability expansion, primitive boundary, skill description | Retain existing checks and collect their judgments. |
| References/assets | plan operations, capture gate, tool-native loop, knowledge locations | Correct existing procedures. |
| Solution docs | Canonical adaptive-engineering.md and this audit | Record mechanics and verification limits; create no new promoted capability. |

## Proposed Primitive

- **Primitive type:** Maintenance of existing skills, agents, references and runtime hooks.
- **Paths:** Changed corpus files and `docs/adaptive-engineering.md`; no new reusable primitive.
- **Boundary reason:** Deterministic admission, source binding, capture and persistence stay in Harness; intent and review judgment stay with agents.
- **Expected users:** Engineer, internal coordinator, reviewers and maintainers.
- **Required tool authority:** Existing Engineer terminal/edit authority and coordinator read/delegate authority. No authority expansion.

## Behavior Contract

- **Should trigger:** Product delivery, external plan document review, named-check execution and README delivery.
- **Should not trigger:** Answer-mode Q&A, read-only investigation, or unrelated plan/store files.
- **Inputs:** Existing tool payloads, plan decisions, exact trusted named-check argv and prepared review packets.
- **Outputs:** Gate decisions, pending verification, exact source references and bounded redacted diagnostics.
- **State changes:** Existing Harness lifecycle records only; contained decision inputs remain agent-authored.
- **Verification evidence:** Regression-first focused runs and the full package suite; final authority requires collected review and source CLI verification.
- **Failure handling:** Fail closed on opaque unplanned commands, changed trust or sources; preserve pending verification after potentially mutating terminal failures.

## Risks

Conservative command classification can require a planned trusted named check for commands formerly admitted as read-only. Exact argv admission does not inspect script behavior or provide an OS sandbox. Bounded output omits the middle, and unknown secret formats remain outside the detector's guarantee. Reviewer identities are declared provenance, not authenticated execution. Native VS Code/IntelliJ acceptance, release installation and productivity gains require separate evidence.

## Validation Coverage

| Scenario | Expected behavior |
|---|---|
| Engineer delivers a product change or updates a README | Plan and gate apply; focused TDD precedes final review and proof. |
| Engineer requests a code review | Engineer prepares and assembles; coordinator returns the packet's required judgments. |
| Reviewer selects an unlocked external project draft | Exact current file can be reviewed, with nonempty findings. |
| User asks a quick answer | No mutation lifecycle is required. |
| Agent runs a recognized read query | No false mutation accounting. |
| Reviewer selects another project's plan | Reject without granting arbitrary absolute-path access. |
| Terminal runs a trusted required check exactly | Admit with a current gate and trust. |
| Script, preprocessor, inline runtime or shell expansion bypasses exact admission | Deny; failed mutating attempts still require verification. |
| Selected draft changes, disappears, becomes a symlink/FIFO or project identity changes | Reject stale or unsafe assembly. |
| Named check emits more than the runner limit | Preserve bounded beginning/end and omission counts. |
| Secret spans chunks or a truncation boundary | Suppress secret-bearing truncated evidence; preserve raw callback compatibility. |

## Human Decision

- **Decision:** Approved within the existing repair scope.
- **Reviewer:** User, through the direct implementation instruction quoted above.
- **Date:** 2026-10-11.
- **Conditions or required edits:** Repair existing owners, preserve unrelated work, use regression-first tests and review, and prepare a reviewable PR. No release, merge, deployment, home hydration or external-framework expansion. This records prior authorization; it does not claim a separate review of this artifact.

## Verification Receipts

Focused results before the final package run:

- External-plan review: 30 passed, including actual CLI draft creation, prepare, assembly and amendment; unrelated, changed, missing, symlinked and nonregular paths rejected.
- Diagnostics: 124 tests, 123 passed, 0 failed, 1 existing platform skip. Boundary-secret regressions failed before repair and then passed.
- Integrated plan and prompt contracts: 81 passed. The explicit loaded-skill input and Engineer handoff regressions failed before their fixes.
- Final terminal and full-package results are recorded below after the source freezes.

The accidental invocation of installed Harness 0.8.8 returned exit 2/inconclusive and is excluded from proof. The source CLI in this worktree supplies authoritative verification. Separate native agent contexts were used; model identity and cross-provider independence were not established.

Receipts for the candidate before the final review:

- Terminal and baseline hook tests passed 68/68. Independent security review retested the final changed-byte cases, 5/5, and reported no remaining actionable finding.
- The short incomplete-PEM regression failed on both streams; the full checks-command file then passed 33/33. Independent privacy/runner/streaming review passed 62/63, with one existing Windows-only skip.
- The first full suite passed 2,493 tests and failed one legacy sed diagnostic assertion, with three skips. That fixture now asserts opaque denial separately from explicit-writer scope.
- That candidate full package suite passed 2,494 of 2,497 tests, with zero failures and three platform skips.
- Whitespace checks passed. Remote main still matches the starting source.

Harness review assembly, final source-CLI verification, learning decision and completion are bound after the final commit. Their records stay in the ignored `.harness/` store; committing them or editing this artifact afterward would invalidate the captured head/content. The PR reports that final outcome.

The first commit, `8080dc1`, contains the regression tests before the fixes. An archive of that commit failed all eight selected private-key and head/tail cases with real assertions. The same command on the fixed source passed all eight. These results establish a reproducible red commit rather than relying on a narrative claim.

```text
Before fixes
ℹ pass 0
ℹ fail 8
After fixes
ℹ pass 8
ℹ fail 0
```

## Findings resolved during final review

Review found stale repository startup review instructions and a successful-mutation-only hook reference. The two new contract regressions failed before repair and then passed; the integrated prompt and orientation suite passed 45/45. Exact-claim agreement still uses the existing declared confidence policy, with reviewer independence explicitly unverified.

Actual disposable Git fixtures demonstrated external diff, filesystem monitor and text conversion helper execution during apparent queries. Terminal admission now inspects effective helper configuration with an uncached, bounded metadata read and treats executable or unresolved queries as opaque. Configured filters conservatively make affected query classes opaque even when current attributes do not select the filter. An exact cat pager and Boolean builtin monitor remain usable. This classification is not a general Git sandbox.

The existing authoritative diff and scope readers also executed configured helpers. Three public-export regression tests failed before repair, then passed with builtin monitor overrides and raw diff flags. All helpers wrote only disposable fixture markers. The regression-only commit is `159114d`; the terminal and stale-prose regression commit is `e268682`. POSIX helper execution tests skip explicitly on Windows; Windows policy assertions remain separate.

Final collected review and source-CLI verification bind the subsequent final head and current plan. Earlier full-suite receipts above cover their stated candidate only.

The final comment/style pass removed six introduced narration lines and named the secret-pattern overlap bound without changing behavior. Exported API contracts and the demonstrated lone-surrogate platform explanation were retained. The subsequent privacy/runner/streaming run passed 80/81 with one existing Windows-only skip; the combined terminal, hook and first internal Git regression run passed 78/78. No constraint approval or broad refactor was required.

Clean-filter controls then exposed execution despite monitor and diff flags. Two actual filter regressions failed before repair; the shared existing-owner Git args helper now disables each effective filter driver, preserving its case, through ephemeral options. The seven reader tests (five actual helper cases plus malformed/oversized metadata) passed, and the impacted gate/hooks/review/evidence suite passed 132/132. Metadata inspection remains bounded and uncached, with one read reused by each scope collection. The additional regression commit is `27ae603`.

Fresh security review demonstrated a pre-existing hard link from a decision-input file to protected session bytes. The critical-file guard now rejects multiply linked decision leaves. The actual shared-byte regression failed before repair (commit `75a25ef`); both decision-authoring tests then passed. Plan-gate exemption and critical-file sensitivity remain separate existing responsibilities. These checks do not guarantee filesystem race isolation.

## Greptile follow-up on PR 89

Greptile reviewed `47801ae` with confidence 2/5 and two P1 findings. Both were valid and escaped the earlier collected review. The same plan was amended and reopened for these repairs; earlier completion and verification do not cover this follow-up.

The actual default-branch startup fixture failed isolation, then blocked the prescribed canonical worktree command. Worktree was missing from the existing control registry, and a failed gate's null checks digest also prevented recovery. Standalone canonical gate and worktree commands can now recover through the existing guard. Mixed, wrapped, ambiguous and redirected commands retain their gate requirements. A disposable installed runtime and hook also created a real linked worktree; invalid slugs still fail in the CLI.

Actual ripgrep preprocessing from `RIPGREP_CONFIG_PATH` wrote a hidden fixture marker while the pre-hook admitted the query and post-hooks recorded no pending effects. Configured queries now remain opaque unless their first argument is `--no-config`. Explicit helper options stay opaque. A second runtime probe showed why searching all arguments for that string is unsafe: a pattern or filename named `--no-config` does not disable configuration. Two further failing regressions cover that distinction.

Regression-only commit `3b5de80` reproduces the original findings. The root's combined run had eight failures and four passing controls. The first repair passed all 99 impacted terminal, startup and hook cases. Regression-only commit `b66bb80` then reproduced both option-value escapes. All 14 final reproduction and control cases passed on the corrected source, with no skips. POSIX helper execution is exercised on macOS; hook policy assertions and actual worktree startup also execute on Windows. Native editor-host acceptance remains unverified.

```text
Original findings before repair
ℹ pass 4
ℹ fail 8
Option-value escapes before repair
ℹ pass 0
ℹ fail 2
All final reproduction cases after repair
ℹ pass 14
ℹ fail 0
```

Raw local receipts are `/tmp/harness-greptile-combined-red.log`, `/tmp/harness-greptile-impacted-green.log`, `/tmp/harness-greptile-ripgrep-value-red.log` and `/tmp/harness-greptile-final-repros-green.log`. Fresh collected review and authoritative source-CLI verification bind the subsequent final head before this PR is updated. A later Greptile score requires a new review; local repair proof does not change the recorded score.

The fresh security review then reproduced another escape in the existing Git-query classifier. Git grep accepts a pager helper through clustered `-nO` and abbreviated long options, including `--op`. Four actual helper regressions failed before the existing predicate was repaired; ordinary grep remained a passing read-only control. Regression-only commit `7e8bb9d` precedes the fix. The final combined reproduction suite passed all 19 cases with no skips, in `/tmp/harness-greptile-final-repros-green-v2.log`; the failed cases are in `/tmp/harness-greptile-git-grep-red.log`. POSIX pager execution remains platform-specific, while its hook admission and post-effect assertions run on Windows too.

```text
Git pager spellings before repair
ℹ pass 1
ℹ fail 4
All final reproduction cases after the Git repair
ℹ pass 19
ℹ fail 0
```

## Windows CI correction and worktree helper follow-up

Both Windows full-suite jobs failed at PR head `ab2d672`, in runs `38153024521` and `38153022012`. The source CLI startup passed, but the hydrated runtime test rebuilt its executable path from `env.PATH`. Windows supplied `Path`; spreading the inherited environment into a plain object lost case-insensitive lookup. The added uppercase key omitted the inherited path and hid Git from the installed CLI. This was a fixture error. A real subprocess regression exercises both spellings and requires one path key with the complete inherited value. Regression-only commit `7f00c62` failed one of seven tests. The minimal fixture fix in `00aa481` passed all seven with no skips and checks that the hydrated child can execute Git before creating its worktree.

```text
Installed-runtime path regression before repair
ℹ pass 6
ℹ fail 1
After repair
ℹ pass 7
ℹ fail 0
```

Raw receipts are `/tmp/harness-ci-root-path-red.log` and `/tmp/harness-ci-root-path-green.log`. These are local subprocess observations; successful Windows CI requires a fresh pushed-head run.

Greptile's subsequent review at `ab2d672` reported another P1. Independent disposable untrusted repositories confirmed that canonical worktree startup executed configured post-checkout, smudge, process and filesystem-monitor helpers. Each wrote a fixture marker and primary source before any trust or implement gate. A single primary-checkout helper override still missed a filter activated by `includeIf.onbranch:harness/**` in the new checkout. The demonstrated repair sequence creates the checkout without files, resolves the existing helper metadata reader there, then populates raw committed bytes with hooks, monitors and filters suppressed. The existing worktree owner handles cleanup and retries; no new configuration parser or lifecycle owner is introduced. The raw probes are `/tmp/harness-worktree-trust-probe.json`, `/tmp/harness-worktree-safe-prefix-probe.json` and `/tmp/harness-worktree-conditional-filter-probe.json`. Source regression and final pushed-head receipts are recorded separately after verification. These probes establish the named helper mechanisms, not a general Git sandbox.

Regression-only commit `b871e49` reproduced all eight worktree failures. The corrected source passes all eight without skips, including actual helper execution controls, required target-branch filters, malformed and oversized metadata, populated retries and ordinary reuse. Cleanup uses this invocation's successful Git add as its ownership receipt; a failed add cannot delete another invocation's checkout. The oversized configuration fixture writes its bytes directly, avoiding Windows command-line limits. Existing startup and issue-intake coverage plus the new cases passed 47 tests without skips. The root independently ran both changed regression files on the final source and passed all 15 cases without skips. Raw receipts are `/tmp/harness-ci-root-worktree-red.log`, `/tmp/harness-worktree-helper-green.log`, `/tmp/harness-worktree-existing-green.log` and `/tmp/harness-ci-root-focused-green.log`.

```text
Worktree helper regressions before repair
ℹ pass 0
ℹ fail 8
After repair
ℹ pass 8
ℹ fail 0
Both changed regression files after repair
ℹ pass 15
ℹ fail 0
```

Final source-CLI review, named-check verification and pushed-head CI outcomes live in the same plan's generated evidence and the updated PR description. Source changes require new evidence. Native VS Code and IntelliJ acceptance remains unverified.
