# Scope, context, and workspace architecture investigation

Research baseline: AE local candidate `8699e9e6c73ad8fae164ded22085ffa53b9df6f1`, PR #104 `34ccbf003f9dd31d3ad8215f9da80e44097dea6a`, main `0d44caad145bb3ef8ab9a7cf301ecfa00569615a`. Reference source: pstack v0.15.36 at `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`. This is read-only investigation; no AE source was changed during this research.

## Decision

Default orientation should state the bound Git root, its local repository classification, and the actual selected project store. A saved workspace file is a source of candidate roots only when explicitly selected. It is not evidence of the active editor window, task relevance, investigation scope, mutation authority, or domain membership.

Remove the inference that discovering N repositories requires N researchers. Preserve explicit domain authority, task-based delegation, current intent, gate, and verification requirements.

## Original problem and PR #104's choice

The exact original user transcript is not retained in this checkout. The recorded note describes a mistake in a multi-root editor window and proposes making the bound repository visible (`docs/workspace-layout-detection.md:149`). That supports a binding-visibility need. It does not prove that automatic sibling workspace discovery, domain drafting, and per-root investigation were necessary.

PR #104 adds this feature in `dfee028582e817c4de637db69d4791a39491ac3f` ("feat(ae): report workspace layout from orient"): a 419-line module and changes across 17 files, 763 additions. The doc records an earlier user choice of option 3 (`docs/workspace-layout-detection.md:3,143`). The present user explicitly authorizes reconsidering that approach. It would be incorrect to describe the feature as originally unauthorized; it is also incorrect to preserve it merely because it was chosen before.

## Actual AE path

1. The CLI resolves its explicit `--workspace` or process cwd (`packages/ae/lib/commands.mjs:770-787`). The workspace directory is the binding; editor filenames do not change it.
2. Session hooks resolve the bound workspace from explicit payload, transcript metadata, absolute touched targets, or cwd (`corpus/hooks/lib/tool-payload.mjs:833-883`). The generic host adapter currently uses its process cwd (`corpus/hooks/lib/host-adapter.mjs:112`). No live editor folder-array contract exists here.
3. `collectOrientationFacts` always calls `detectWorkspace` (`lib/orientation-facts.mjs:90`), alongside selected plan, recall, gate, trust, index, and evidence facts. This happens for ordinary orientation and the read-only slice.
4. Session start calls `orient --read --context-version 2`, with an 8-second timeout (`corpus/hooks/load-context.mjs:41-66`). The host adapter has the same deadline (`corpus/hooks/lib/host-adapter.mjs:63-82`). If orientation fails or times out, the injected slice falls back to unknown/empty values.
5. Workspace detection enumerates the bound root and its immediate parent (`lib/workspace-layout.mjs:240-264`), parses saved `.code-workspace` files, and probes listed folders with Git. IntelliJ `.idea/vcs.xml` is a fallback (`:296-342`). It is not recursive source-content indexing.
6. When more than one saved file includes the bound root, the file with the most other Git roots wins (`:308`). The same largest-root heuristic is applied to VCS mappings (`:340`). Neither is an active-window observation.
7. Detection also looks through existing domain files and assembles YAML (`:366-419`). The YAML is returned but not saved. `domainSuggestion` is suppressed for truncation (`:444`). The local candidate's caps and per-call Git cache reduce repeated work but preserve this policy.
8. Global instructions (`corpus/instructions/harness-global.instructions.md:38`) and the investigation playbook (`corpus/skills/references/playbooks/investigation.md:7`) declare every returned other root in read-only scope and request one researcher per repository. This is the significant scope expansion. Existing mutation gates still require their own authority; this is not a demonstrated write bypass.

The plan and knowledge stores remain selected by the existing project/home resolver. Default workspace discovery does not itself open sibling plan or knowledge stores. A researcher subsequently sent to another root can, however, orient there and load that project's data; relevance must therefore be decided before delegation.

## Reproduced behavior

Fresh experiment in disposable Git repos A, B, and C:

- `active.code-workspace` lists only A.
- `inactive.code-workspace` lists A, B, and C.
- Calling `detectWorkspace(A)` without any selected workspace file returns `inactive.code-workspace`, roots B/C, and a domain draft.

Observed output:

```json
{"actualSelected":"inactive.code-workspace","actualOtherRoots":["repo-b","repo-c"],"domainDraftProduced":true,"defaultRetainsOnlyBoundRepo":false}
```

The filenames are illustrative; AE has no input identifying which one is active. Renaming them cannot fix the missing information. A largest-folder rule is not a substitute for host or user selection.

Earlier confirmed synthetic performance reproduction used two repos and twelve saved files with 64 alternating repeated folder entries each. PR #104 launched 782 Git subprocesses (769 root observations, 13 origin reads); the candidate launched 4 (2 roots, 2 origins). The ~1,604 ms versus ~21 ms elapsed figures are single-fixture/environment observations, not representative user-workload benchmarks. The counts establish amplification, not the necessity or outcome quality of discovery. Removing implicit discovery is stronger than polishing this microbenchmark.

## What to learn from pstack

| Mechanism | Pinned source evidence | AE decision |
| --- | --- | --- |
| Explicit topic/workspace boundaries | `pstack/skills/recall/SKILL.md:18` locks topic, time window and workspace; another project's transcripts need a request. `:33` excludes adjacent features unless they block the task. | Apply task relevance before cross-repo retrieval or delegation. Do not equate a saved folder list with scope. Preserve AE's project isolation repair. |
| Proportional decomposition | `pstack/skills/how/SKILL.md:15-24` states an interpretation when scope is ambiguous, takes the simple path when doubtful, and decomposes complex subsystems into 2–4 distinct angles. | Delegate concrete questions for a known task. No researcher-per-discovered-root rule. Do not copy mandatory explainer/model-routing ceremony. |
| A declared fan-out contract | `pstack/skills/swarm/SKILL.md`, Frame and Aggregate, requires a done predicate, declared slices/race rule, exact revisions and methods, and treats gaps as gaps. | Preserve AE specialist ownership and review separation, but bound each brief and qualify missing results. Filesystem discovery must not silently invent workstreams. |
| Context conservation | `pstack/skills/principle-guard-the-context-window/SKILL.md:9-12` sizes phases and scope and accounts for mechanism cost. | Preserve AE's compact frozen instructions, 2 KiB pack, on-demand evidence and explicit omissions. Remove irrelevant roots and domain YAML from default startup before adding another cache or budget subsystem. |
| Subtraction before polish | `pstack/skills/principle-subtract-before-you-add/SKILL.md:9-18` removes redundant code and speculative machinery before construction. | Delete automatic discovery/domain-draft machinery rather than retain it merely because tests cover it. |
| Explain measured changes | `pstack/skills/principle-explain-the-number/SKILL.md:9-16` separates repeated work from benchmark and task-outcome claims. | Assert bounded read/probe counts and correctness. Do not claim model token savings or native usability from a synthetic Git fixture. |
| Stop repeated verification swarms | Commit `ce649c03ac3b75b6ae80cbd15b7e2c536caedb5a` (#613) changes multi-phase PR review to one full swarm at code-ready head, renewed for materially new behavior; minor follow-ups use a verifier. | Supports PR #104's goal of proportional review and no repeated whole task fan-out. Keep fresh evidence binding; never reuse an invalid authority record just because a change is small. |

These are source-derived design lessons. They do not establish that pstack has a better success rate, lower end-to-end token usage, or native Windows/IntelliJ parity. No pstack code needs to be copied to adopt them.

## Existing AE structure worth preserving

- `corpus/skills/references/context-budget.md` already starts with task intent, expands only for requirements/dependencies/failures/questions, preserves source omissions and mandatory constraints, and requires complete-task measurement before changing defaults.
- `lib/context-record.mjs:31-69` binds worktree, plan, query, selected files, source state, policy and evidence. Its coverage explicitly says semantic completeness is unverified; a bounded context is not proof the task is understood.
- `lib/change-impact.mjs:85-90` already offers task-selected question kinds rather than a universal code-understanding expansion. Keep that ownership.
- The native host evaluation protocol (`eval/host/README.md`) requires installed archive identity, controlled product behavior, actual editor execution, interrupted/resumed work, independent preservation checks, and explicit unavailable results. Scripted providers do not prove agent quality. Use this existing protocol; do not add another framework.

## Recommended implementation contract

1. `detectWorkspace` defaults to the current bound root and classification only. It must not enumerate the parent, read arbitrary saved workspace files, probe neighboring repos, inspect domain configuration, or prepare a domain draft.
2. Preserve the existing layout keys for consumers: `boundRoot`, `kind`, `markers`, `workspaceType`, `workspaceFile`, `roots`, `domainSuggestion`. Default `workspaceType: none`, `workspaceFile: null`, `roots: []`, `domainSuggestion: null`. This is a deliberate behavior correction, documented as such.
3. If multi-root inspection is retained in this change, use one explicit `orient --workspace-file <saved-file>` selection. Read exactly that regular, bounded file; support the already reviewed `.code-workspace` or `vcs.xml` formats. Do not search for a different file or guess an active editor. Parsed roots are candidates; they do not change selected project/store, plan authority, trust, or investigation scope. Preserve duplicate-root collapsing and explicit truncation. Input failure must not erase the independently observed bound root.
4. Do not add a second automatic host-folder discovery API. The current adapters do not expose live folders. A future host-provided list needs an observed adapter contract; until then report unknown rather than infer it.
5. Keep `domainSuggestion: null` on ordinary and explicit workspace inspection. Existing explicit domain commands own authored membership. Remove YAML/domain lookups from workspace orientation rather than add an auto-draft opt-out.
6. Surface the actual selected project store if needed for binding visibility, using `projectStoreDir`/`workspaceStorageId` with the selected home and existing aliases. Never compute it with a separate origin/path slug. The trust ledger path is not the project store. The exact new field should be agreed with the authority/home implementation owner.
7. Change global and investigation instructions: selected extra roots are candidates; include a root only because the user/task or a demonstrated dependency needs it. Delegate a bounded question when separate expertise/coverage is useful. Do not require one agent per listed repo. Keep mutation gates and explicit domain delivery unchanged.

The smaller alternative is to remove saved-workspace inspection entirely and use host reads plus existing `--workspace` when a multi-repo task arises. That deletes more code but loses a reviewed convenience. Recommendation: retain only a single explicit selected-file reader if the integrated plan needs that convenience; do not retain implicit enumeration in either case.

## Proposed files and ownership

- `lib/workspace-layout.mjs`: simplify default binding path; remove search enumeration, largest-root selection and automatic domain assembly. Retain only reusable bounded parsers needed by explicit selection.
- `lib/orientation-facts.mjs`: pass an explicit selected workspace file only when requested; resolve selected project store through the existing authority owner.
- `lib/flags.mjs`, `lib/registry.mjs`: only if retaining `--workspace-file`; typed flag metadata, parsing, help and command-index classification must agree. Root owns coordination with other command changes.
- `corpus/instructions/harness-global.instructions.md`, `corpus/skills/references/playbooks/investigation.md`: remove scope promotion and obligatory fan-out/domain showing. These are shipped primitive changes and use the existing create-primitive governance.
- `corpus/agents/engineer.agent.md`: preserve actual bound-root reporting, clarify it is not discovery-derived task scope if needed. Avoid duplicating the normative scope policy.
- `corpus/hooks/lib/host-adapter.mjs` and `corpus/hooks/load-context.mjs`: retain compatible empty layout fallback; only update shape if selected store metadata requires it. Do not invent live editor observations.
- `test/workspace-layout.test.mjs`, `test/orient-read-slice.test.mjs`, `test/orientation-context.test.mjs`, `test/installed-context.test.mjs`, `test/host-adapter.test.mjs`: user-path acceptance and compatibility. Command contract/enumerability/flag tests are required if adding the explicit flag.
- `docs/workspace-layout-detection.md`, `docs/adaptive-engineering.md`: replace shipped-policy description, preserve the historical choice as history, explain missing native folder input and default scope.

## Acceptance and meaningful regressions

1. An ordinary single-repo orientation amid several saved workspaces returns only the actual bound root/store, even if another file lists more roots. Assert no reads of those saved files or Git subprocesses against their listed directories. The current code fails this case.
2. Changing, adding or deleting an unrelated saved workspace cannot change default context output or its context identity for the same source/task/policy state. This tests relevance and reproducibility, not just speed.
3. Explicit selection reads the named file even when another larger saved file exists. Return canonical distinct candidate roots and stable order; do not change the bound store or write any domain file. A malformed/missing/unsafe selected file must retain bound-root identity and report unavailability.
4. A selected file containing duplicates, excessive folders, or an invalid path stays bounded with explicit truncation/unavailability. Never infer completeness from a prefix. This is a real external-input boundary.
5. Installed startup/adapter output preserves layout keys, has no automatic roots/domain draft, and stays useful when no workspace file or active plan exists. Test the actual installed corpus path, not a repository-only string search.
6. Corpus assertions reject the old normative phrases declaring all discovered roots in scope or requiring one researcher per repo. Forward-test a single-repo request with unrelated saved roots: a role following the installed instruction must keep the task scoped and not generate extra workstreams. A source assertion is helpful but cannot prove model behavior.
7. Existing explicit domain planning/gating and per-project knowledge isolation tests continue to pass. Changing advisory discovery must not change authored multi-repo authority.
8. Record read/probe counts on the same synthetic fixture before/after, while keeping elapsed numbers and task outcomes separate. Native task-cost improvement remains unproven until actual host observations are retained.

## Qualification and limits

No live VS Code/IntelliJ folder array, actual Copilot task trace, or native Windows result was produced by this research. The original binding failure is reconstructed from the committed note; the active/inactive workspace counterexample is directly reproduced. Full source review can establish the inference defect and contract boundaries; only the existing native-host protocol can establish that the installed Engineer chooses the intended repo and avoids irrelevant delegation in practice.
