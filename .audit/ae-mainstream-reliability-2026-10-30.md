# AE mainstream reliability audit and stabilization plan

Date: October 30, 2026. Owner: Chai. Repository: `noodlemind/prompt-library`.

## Decision and source identity

Chai authorized applying the previously reviewed implementation directly to PR #104 and requested a fresh audit of AE as a mainstream agentic stack, particularly human/agent trust and tool reliability. The earlier 13-task implementation is now published directly on `cursor/ae-slices-1-6-0005` as `fe9d16a8eb25b436fae1b2af8da8ba804f0d2b09`, without merging. Its Git tree is exactly `3dca3189747604cfc640f9f8889fc7ef0eb11fef`, matching qualified local source `189a8afccb42e669af5f918b1991157fe0b314ef`. Its parent is the original PR104 head `34ccbf003f9dd31d3ad8215f9da80e44097dea6a`.

This audit is a new investigation of that tree. It does not retroactively claim that the prior review covered these newly reproduced defects. Three independent audit tracks examined trust/onboarding, runtime tools/recovery, and product architecture. A fourth reviewer independently reproduced the trust/configuration and locking findings before repairs.

The central finding: AE's deterministic safety machinery is stronger than its end-to-end usability contract. Users can encounter successful commands that leave the wrong target repaired, an approval that changes enforcement unexpectedly, and concurrent state changes that lose decisions. These defects create manual work even when the agent and each individual tool appear reasonable. Adding another agent or more mandatory workflow would not address that failure class.

## Findings and root causes

| ID | Priority | Reproduced behavior | Root cause | Required correction |
|---|---|---|---|---|
| T1 | P1 | Effective configuration can change while the approval digest remains unchanged for unreadable pinned sources | Trust pinning and configuration/routing loading accept different input boundaries | Refuse invalid present authority and use the same bounded, contained reader |
| T2 | P2 | Two different-project revocations both succeed, but only one survives | Whole-store read/modify/atomic-replace is not serialized | Reread and mutate under one owner-safe resource lock, including migration |
| T3 | P2 | A new project's applied policy reduces ordinary guards to observe after approval | Initialization seeds observe while the untrusted resolver safely defaults to enforce | Seed enforce for new files, preserve existing user policies, expose missing checks |
| R1 | P2 | A second process enters a plan critical section while its original owner remains live | Lock takeover depends only on age; release is not owner-bound | Record ownership, prove absence before takeover, release only the owned instance |
| R2 | P2 | IntelliJ doctor's proposed repair installs CLI assets and leaves IntelliJ instructions missing | Diagnostic recipes drop the selected target while retaining its directory | Preserve target and home through actual suggested repair commands |
| R3 | P2 | A healthy CLI installation fails the doctor skill's VS Code-specific command | The skill hardcodes an unrelated host | Select requested/observed target and preserve selected homes; unknown stays unselected |
| R4 | P2 | Agent guidance treats usage refusals as warnings that permit progress | Shared exit-code prose disagrees with command-specific outcomes | Interpret structured errors/outcomes and current authority; exit 2 alone proves no success |
| M1 | P3 | A plan's earlier compound can make another plan's verification conversion look perfect | Growth conversion divides unrelated aggregate counts | Defer metric repair; do not use it as a delivery reliability gate |

P1 means an authority guarantee can fail under the reproduced input class; it is not an assertion of observed exploitation. P2 denotes a concrete correctness/recovery defect. M1 concerns measurement, not a demonstrated authority bypass.

### Trust and configuration evidence

The actual `policyDigest` reader was capped at 1 MiB and refused redirected sources, but represented invalid present files by a stable sentinel. Configuration and routing used unbounded file reads and followed links. A source that could not be pinned could therefore still affect execution after trust was applied. The probe changed effective `bash_enabled` and model selection while the digest stayed identical, using both an oversized valid YAML fixture and a symlink fixture. It did not approve the working repository or perform an external command with the changed authority.

The fix must protect approval, currentness, legacy matching and worktree inheritance together. It must distinguish absent optional files from invalid present sources. Fixing only the configuration loader leaves routing exposed; fixing only new approvals leaves old sentinel approvals eligible. Ordinary readable legacy approvals and explicit child revocations must retain their guarantees.

A separate actual two-process probe synchronized two revocations at the existing publication boundary. Both returned success; one decision disappeared. Atomic rename prevents torn bytes, not lost read/modify/write updates. Approval, revocation and legacy migration need one serialized mutation boundary, with a fresh read after acquisition. Nested acquisition of the same trust-store lock must be avoided.

Actual initialization in an owned temporary project generated `enforcement: observe` and empty checks. The untrusted resolver used enforce, but applying that source changed ordinary rules to observe. Source application was exercised directly; no human approval interaction was invented. New init should preserve safe enforcement while continuing to refuse invented executable checks. An existing intentionally authored observe policy must remain unchanged.

### Lock and recovery evidence

The plan-lock probe used two real processes. It aged a live owner's actual lock directory by 31 seconds to reproduce the old-lock state without waiting. The rival entered, exited successfully, and removed the lock while the first callback remained inside its critical section. Revision comparisons do not make a later check-and-publish sequence atomic. Owner liveness, instance identity and conditional release are necessary; unavailable process identity must remain a bounded refusal, not permission to steal a lock.

The selected-target repair probe ran the actual CLI on an empty owned IntelliJ home, executed the returned H2 repair argv unchanged, and reran doctor. The repair exited zero but selected CLI, recorded CLI ownership, and left required IntelliJ global instructions missing. This is a broken recovery transition, not merely an inaccurate hint. Tests must execute the suggested command and observe the correct target, rather than assert one string.

Custom IntelliJ home selection still depends on preserving the configured `AE_INTELLIJ_HOME` environment. The corrected skill explicitly preserves it. Repair argv alone does not persist that choice into another environment; an installation-profile contract remains future design work.

The doctor skill independently selected VS Code for a CLI-only installation that passed CLI diagnosis. The correction must preserve the distinction between installation health, mechanical hook probes and actual host admission. IntelliJ customization support does not establish unavailable native lifecycle enforcement.

Actual `status --bogus --json` and unsupported-target invocations exited 2 with `E_USAGE`. Shared prose described exit 2 as a warning allowing continuation. Command-specific advisory results can remain advisory, but neither an advisory nor a usage error can supply a passed implement gate or current verified completion.

## Scope and authorization for bounded repairs

The existing complete-stabilization authorization covers necessary repairs to the reproduced trust, concurrency and recovery defects. Chai also explicitly authorized updating PR104. No force push, merge, user-trust approval, production data operation or additional agent authority is included.

These changes maintain existing deterministic operations and existing doctor/tool-contract guidance. They create no skill, agent, dependency, model selector, runtime installer or general lock framework. Existing owner-lock and bounded file-reader patterns are preferred. The actual managed bug-fix plan has three phases, nine tasks and seven acceptance criteria. Required named checks are `harness-tests` and `prompt-contracts`; a successful implement start/gate was recorded before source changes. Accepted progress is distinct from executed proof and machine completion.

| Existing owner | Why reuse it | Maintenance boundary |
|---|---|---|
| Trust/configuration/routing runtime | Owns executable source authority | Align readers and reject invalid authority |
| Plan-update resource lock | Existing synchronous mutation serialization | Harden ownership and reuse for trust-store mutation |
| Initialization | Owns newly generated configuration | Change new-file defaults and setup guidance only |
| Doctor and recovery diagnostics | Owns mechanical diagnosis and repair recipes | Preserve selected target/home and real unsupported states |
| Harness Doctor skill | Owns contextual diagnosis procedure | Choose applicable host; no new discovery trigger |
| Shared tool-contract reference | Owns command-result interpretation | Correct outcome semantics; no new tool permission |
| Existing code review and corpus validation | Owns assurance of maintained primitives | Reuse required independent perspectives and validators |

Human decision: authorized by Chai, October 30, 2026, under the complete AE stabilization request and direct PR104 instruction. Conditions: preserve safeguards, user-authored policies and truthful evidence; no self-approved trust, fabricated native activation, destructive changes or merge. This record documents the user's instruction; a field in the plan does not grant authority.

## Implementation and acceptance plan

1. **Authority and serialized state.** Repair T1 and T2 with bounded readers and a serialized fresh store read. Repair R1 with an owner-bound lock. Required negatives include oversized and redirected sources, legacy sentinel approvals, inherited authority, unrelated concurrent mutations, live old owners, unknown/malformed owners and replaced lock instances. Contended or unknown ownership must produce actionable refusal while preserving the store and active lock.
2. **Onboarding and recovery.** Repair T3, R2, R3 and R4. Test fresh enforce defaults and unchanged preexisting observe configuration. Execute actual selected-target repair commands for CLI, VS Code and IntelliJ. Preserve unrelated homes and accurate unsupported-hook status. Exercise real usage errors and legitimate command-specific advisories without converting either to authority.
3. **Qualification and publication.** Run focused failing-before/after regressions, relevant compatibility tests, corpus validation, installed-package recovery and the full source suite. Obtain independent architecture, simplicity, security and primitive-boundary judgments. Update the same PR and preserve exact source/test/CI identities. Do not treat a blocked named check, unfinished test, elapsed deadline or unavailable native session as a pass.

The current implementation/test results are recorded below after qualification. Growth conversion, global workspace binding, persistent installation profiles, aggregate trust-review UX and the optional headless exploration cap are explicitly outside this bounded repair; their architectural implications follow.

### Integration corrections discovered during qualification

The first ownership repair used a small owner file inside the adjacent lock. Full lifecycle qualification exposed a compatibility defect: for legacy in-repository plans, that file became a Git-observed product change, so a valid verification could no longer complete. An isolated proof check reproduced the difference outside and inside the lock. The final representation encodes version, PID and token in a single strictly validated empty child directory. Git omits empty directories naturally; resource identity, strict product scope and cross-home serialization remain unchanged. No arbitrary lock-looking product paths are excluded. Actual legacy Deliver completion and the new Git-observation regression failed before and passed after this correction.

Independent review also caught a release-time replacement race. Final release uses a recovery guard and private retirement before validating and deleting only its owned stamp. Changed ownership retains conflicting state and the guard; a separate process is refused entry. The guarantee is cooperative same-host exclusion. Arbitrary same-user filesystem mutation, distributed PID namespaces and automatic removal of unknown ownership are outside that guarantee.

The initial published implementation passed Linux source CI and all four Linux/Windows Node20/24 package jobs. Its Windows source run found two test assumptions about native versus DOS 8.3 path aliases, plus a contention test that required sixteen captures to succeed on their first attempt within a five-second acquisition budget. Native-canonical expected paths preserve the exact source/hash and manifest-race assertions. The concurrency test must distinguish a no-publication busy refusal from a completed publication and retain all sixteen distinct episode/path assertions. No global deadline is raised and no publication or release failure becomes retryable by implication. Busy recovery remains a caller-owned usability limitation to address in the actor-aware recovery contract.

Oldest Node20 qualification separately exposed an example-fixture portability error: its ES-module JavaScript had no explicit module declaration. The fixture now declares its intended module semantics before its initial Git commit. This changes neither the behavior assertion nor the shipped runtime. Existing unrelated source tests that use newer `import.meta.dirname` syntax cannot qualify the oldest Node20; selected runtime/installed checks and the current-Node20 CI matrix are recorded separately.

## Highest-leverage architecture direction

Make one supported first-delivery journey the product boundary. A user should approve a concrete authority proposal once per accepted authority revision. AE should then own ordinary planning, gating, execution, review, verification and recovery within that authority.

The initial supported guarded path should follow the actual primary audience: Windows VS Code with GitHub Copilot and its installed AE CLI. Linux/macOS CLI and customization-only IntelliJ remain distinct supported capabilities; native parity must be established independently. A platform matrix and thousands of helper tests cannot substitute for observing the actual host/model journey.

The design should extend existing receipts, allowed-next-actions and diagnostics rather than introduce another orchestrator:

- One selected identity across a task: product root, state home, corpus home, target, session, plan and authority revision. Recovery preserves that selection.
- One reviewable authority proposal: exact named-check argv, effective enforcement, source digest and environment/network behavior. Named checks are real programs; existing environment inheritance and network permissions must be disclosed accurately. Approval is not an operating-system sandbox.
- A command-specific recovery contract: stable reason, observed state, who can act (agent or person), exact safe next action and the identity it applies to. The person chooses authority; routine bookkeeping belongs to AE.
- Separate visible readiness dimensions: installation, configuration validity, human approval, behavioral-check adequacy, native admission and current task proof. A healthy installation does not imply the rest are ready.
- Current evidence after interruption and upgrade. Resume the accepted operation where possible; ask again only when the actual authority/intent changed or a new decision is required.

### Further stabilization sequence

| Stage | Concrete work | Promotion evidence |
|---|---|---|
| 1. Close reproduced defects | The bounded repairs above, before merging/promotion | Failing-before regressions, passing repair drives, independent review |
| 2. Define one first-task contract | Installation profile, reviewable check/authority selection and actor-aware recovery using existing tools | Same identities through every step; no manual state-file edits |
| 3. Qualify real native journeys | Run the existing native-host protocol on the exact candidate archive with a real Copilot session | Actual host/tool observations, positive delivery and safety negatives, retained receipts |
| 4. Promote based on intervention rate | Fix the largest measured intervention class and repeat | Unassisted completion, false denial, retry, resume and setup-assistance measurements |

The native matrix should include a simple documentation change, one-file bug, language change, failing check, stale selected spec, missing reviewer, custom home, linked worktree, interruption and upgrade. A proposed initial promotion bar is zero authority violations or false completion, all applicable safety negatives refusing, at least 90% unassisted completion over repeated fixed scenarios, and no manual internal-state edits. These are proposed product targets, not measured outcomes or a statistically established service-level objective. Setup assistance and the expected human authority decision must be measured separately from normal execution.

### Explicitly deferred decisions

The optional headless Deliver loop refuses a fourth consecutive exploratory read before processing lifecycle prerequisites. Three actual successful reads followed by the refused fourth reproduced this behavior. It is an explicit efficiency policy that can conflict with evidence-before-editing. Evaluate task-linked prerequisite reads while retaining time, output and total-turn budgets; compare correctness, cost and interventions before changing the benchmark profile.

Growth's current aggregate verify/compound ratio must not be used as proof of conversion. A later repair should join plan/proof identity and temporal order without double counting, or rename the measure to describe its aggregate meaning. Unrelated, earlier or stale compounding must not improve a delivery's result.

CLI workspace selection, host-hook environment overlays and stale-approval review also need design work. Ordinary commands currently expect a bound repository root, while store identities can canonicalize subdirectories. Custom state-home flags on one invocation do not permanently configure the host's future hook environment. Approval stores an aggregate digest rather than an exact old/new source review. These are documented constraints/design gaps, not additional reproduced authority bypasses.

## Pivotal assumption and test

The working assumption is that much of the reported unreliability comes from broken identity/state/recovery handoffs and repeated setup decisions, rather than insufficient specialist capability. The audit supplies concrete supporting defects, but cannot establish their share of real user failures.

Test the assumption on the exact installed candidate using actual Copilot sessions. Count human interventions after initial authority acceptance, first-success time, command retries, false denials, stale-proof recovery, completed checks and unassisted resume. Preserve failed attempts and compare before/after scenarios. If handoff repairs do not reduce interventions, investigate model interpretation and task capability with the same evidence rather than adding ceremony speculatively.

## Evidence, results and limits

Initial source qualification: 3,775 tests, 3,714 passed, 20 failed and 41 skipped. The same 20 process-identity failures were reproduced on untouched PR104; they were not hidden or weakened. Exact archived Node20 installed delivery passed. The published initial implementation's GitHub package matrix on Linux/Windows and Node20/24 passed, as did documentation. Source-suite CI and subsequent repair qualification have their own exact revisions and results below.

Audit evidence used actual CLI calls, real two-process probes, source reads and independent reruns. Owned fixtures were used; the working repository was never granted trust. Direct source-applied policy tests are not human-approval observations. No native Copilot/IntelliJ model trial or fresh caller-provided TLC run was performed here.

The execution environment briefly became unavailable during repair preparation, before production changes. It was restored and the source state rechecked before resuming. Interrupted preparation and unreturned test invocations establish no successful repair evidence.

### Final repair qualification

The runtime and regression source was frozen clean at `f4461229cd930d51dee869d10a7699d9e6431f42`. Subsequent audit-result edits change this report only; they do not change the package or test payload.

| Evidence | Result | Practical limit |
|---|---|---|
| Complete source suite, Node24/Linux | **3,823 tests: 3,762 passed, 20 failed, 41 skipped**, exit 1, 457.487 seconds | The same 20 failure names as the untouched PR104 baseline; every cause is `process identity is unavailable; absence is not proven`. No additional failure. This is not a green full suite. |
| Final exact packaged archive, Node20.0.0 | Installed delivery lifecycle **1 selected test passed**, zero failures; 23 other tests not selected | Real installed runtime, hooks, broken/fixed behavior check, review/verification/compounding/completion/replay. Mechanical fixtures do not establish native model behavior. |
| Trust and context repair selection | Node24 **128/128**; oldest Node20 selection **88/88**; separate home compatibility **32/32** | Selections overlap the full suite. Two unrelated older-Node source fixtures using newer `import.meta.dirname` remain outside the oldest-Node selection. |
| Lock/recovery correction | Node24 **58/58**, plus four new malformed-stamp negatives; oldest Node20 owned fixtures **21/21** | Includes actual legacy completion and selected-host repair commands. Same-host cooperative locking only. |
| Corpus and interpretation | Full prompt contracts **49/49**; corpus validation passed, zero diagnostics | 28 skills, 22 agents, five instructions; no inventory expansion. Fresh-context language observations are not native Copilot trials. |
| Independent security | **76/76** selected cases; six additional adversarial owner forms refused; 32 readable/legacy digest permutations compatible | Source change during approval returned stale/untrusted. Separate process could not enter after a replaced lock was retained. |
| Independent final perspectives | **106/106** selected cases; six required perspectives collected, no outstanding finding in the repair scope | Five perspectives came from one independent Codex review thread and security from another. Provenance is declared, not native-host authenticated. |
| Windows-specific fixture correction | Affected path/activation files **35/35** on Linux; capture file **17/17** and oldest-Node selected refusal/concurrency **2/2** | Actual Windows rerun must confirm the runner-specific corrections; its initial failures are preserved, not relabeled as passes. |

These are overlapping selections, not additive totals. The first diagnostic full run exposed the owner-file compatibility defect and is superseded by the final frozen run. Its failed observations were retained. The final source log SHA-256 is `2c4d1466b35f3d39e7339f6c5d59bf2f845569f87affdebc01474041cb55b07b`.

Final archive: `ae-harness-0.14.0.tgz`, 35,692,702 bytes, SHA-256 `a52670027fa5b0fcfdf6e969b22ffd92904d59aab5ae64f6e1f1fc9b9e47fd6c`. Payload inspection found no JAR and no vendored pstack parser. The earlier 85db345 archive was superseded by this empty-stamp correction and is not the final package.

The required review packet at the frozen code revision collected architecture, simplicity, capability maintenance, primitive boundary, skill description and security judgments. The exact code revision and test receipts remain distinct from report-only commits and the GitHub commit identities used to apply the same trees to the PR.

### Remaining release boundaries

The reviewed repairs and audit are implemented. The next-stage native journey, installation-profile UX and measurement work remain explicitly planned, not implemented or certified by these tests. Current CI results belong to their exact revision; the new PR head requires its own Linux/Windows rerun. Check [PR104](https://github.com/noodlemind/prompt-library/pull/104) for those current results.

The working checkout remains untrusted. An agent must not approve its repository-authored commands merely to obtain a machine completion receipt. Direct source qualification and accepted task progress do not substitute for that person-owned authority decision, passed named verification, or observed native activation. This audit does not certify the absence of other AE defects or claim mainstream readiness from deterministic tests alone.
