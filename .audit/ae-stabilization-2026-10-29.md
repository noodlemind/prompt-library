# AE stabilization: findings, delivery plan, and qualification

This is the provisional first-pass record. The user subsequently requested a
complete pstack-reference architectural investigation and an AE-owned
implementation. See the [replacement research and implementation plan](ae-native-architecture-2026-10-29.md).

## Scope and baseline

The user authorized implementation of Lauren Tan's pstack statechart architecture
with README attribution, a detailed review of AE, and repairs to demonstrated
stability problems. The follow-up also explicitly includes PR #104 and its root
causes. This delivery builds on PR #104 at
`34ccbf003f9dd31d3ad8215f9da80e44097dea6a`; it does not overwrite that branch or
merge it into main.

Sources:

- AE main: `0d44caad145bb3ef8ab9a7cf301ecfa00569615a`.
- PR [#104](https://github.com/noodlemind/prompt-library/pull/104): the pinned
  candidate above, 189 changed files, approximately 5,220 additions and 721
  deletions across 66 commits (GitHub's current PR metadata).
- pstack v0.15.36: `cursor/plugins` at
  `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`.

The work follows the existing Engineer/Harness boundary: the host owns reasoning,
delegation, and model choice; Harness owns deterministic authority, bounded data
operations, and evidence. No new autonomous coordinator, memory database, or
globally installed skill is introduced.

## Current structure and diagnosis

| Layer | Existing responsibility | Review conclusion |
| --- | --- | --- |
| Engineer and on-demand corpus | Intake modes, task procedure, specialist judgment | Preserve the sole entry point and bounded native-host delegation. More orchestration prose is not a substitute for qualification. |
| Plan, gate, review, verification, completion | Accepted intent, current authority, recorded proof, recovery | Strong explicit contracts exist, but executable identity and corrupt-journal handling left reproducible gaps. |
| Installation and hydrated runtime | Relocatable CLI/corpus, managed upgrades, host configuration | Default-home fixtures concealed custom-home failures; destination and retirement tests did not cover the current runtime tree. |
| Episodes, manifests, postings, recall | Capture and retrieve relevant knowledge, inform later behavior | Date-only freshness could retain stale rankings. Shared workspace-private metadata also needs project isolation. |
| Orientation and workspace detection | Supply bounded current context | Leaf symlinks escaped write boundaries; repeated workspace observations amplified startup work. |
| Diagrams and selected formal verification | Descriptive views; optional bounded formal checks | Reuse pstack's pure parsing/IR/projection separation while keeping checker execution out of local diagram generation. |

The recurring failure pattern is a mismatch at a real boundary: byte identity
versus executable behavior, shared manifests versus private provenance, selected
homes versus default-path assumptions, or a valid receipt versus a synthetic
test shape. Repairs therefore add failing user-path regressions and change the
owning implementation, rather than adding another instruction to the Engineer.

## PR #104 assessment and interaction

PR #104 repairs genuine integration faults: command help and targets, selected
home diagnostics, installed references inaccessible to workspace search,
hook-compatible recovery guidance, repository identity/migration, and repeated
review expense. It also adds workspace/model-preference functionality, so its
actual scope is broader than its original slices 1–6 title.

The exact pinned head has passing GitHub Linux, four Windows shards plus their
aggregate, package-candidate, and documentation workflows. The PR body's older
`d3a60ce` verification table is stale, but current-head CI is also green. Its two
unresolved inline comments are outdated: commit `86bfa340` already fixed fresh
full-review-packet coverage and suppression of incomplete workspace domain
drafts. They are not reintroduced as current findings here.

This follow-up preserves those fixes. The bounded workspace scan repairs a new
PR #104 path; the remaining changes repair independently reproduced omissions
that still exist on that head. The declared later host-enforcement, trust, and
authority slices remain qualification work unless separately proven and fixed.
Passing scripted tests does not establish native editor behavior.

## Demonstrated defects and repairs

| Area | Reproduced failure on PR #104 | Repair and regression boundary |
| --- | --- | --- |
| Proof currentness | Change an already-dirty script from executable to nonexecutable without changing its bytes: retained proof remains accepted while the actual named check now fails. | Bind normalized executable mode into shared workspace identity. Old byte-only evidence becomes stale; real CLI verification regression covers reuse. |
| Operation recovery | A truncated/falsy journal for a structured plan decision is treated as absent and overwritten by a successful retry. | Refuse an existing unreadable/invalid journal and preserve its bytes, matching conversion recovery. |
| Custom-home runtime | A shim installed under an explicit Copilot home searches the default home unless an environment override is also set. | Resolve the runtime relative to the installed shim, preserving an explicit environment override. |
| Destination ownership | Current runtime, hydrated corpus, or shim destination symlinks can direct writes outside the selected home. | Reuse contained-path checks and refuse unsafe destinations before writes. Tests preserve outside sentinels. |
| Runtime retirement | Files removed from a new release remain in the prior hydrated runtime and can rehydrate retired corpus later. | Remove only regular stale leaves named in a prior AE/harness lock; preserve unrelated files and unsafe paths. |
| PATH setup and discovery | Custom-home PATH setup still writes the default bin; POSIX discovery counts a nonexecutable file as a runnable command. | Configure the actual selected bin with literal shell quoting; require executable permission on POSIX while retaining Windows command-file semantics. |
| Retrieval freshness | A same-date manifest edit leaves BM25 postings apparently current, omitting new terms or ranking old ones. | Bind actual corpus/manifest identity at build and read boundaries; old unbound indexes safely fall back until rebuilt. |
| Project knowledge isolation | After repo B indexes a shared home, repo A loses its private episode and can receive B's metadata for a same-path document. | Preserve project-private manifest data beside the existing per-project index; read global and current-project rows under one effective corpus. |
| Orientation output | Symlinked context-pack, repo-map, or local ignore leaves can overwrite a sibling sentinel outside the workspace. | Contained atomic output writes; required context failure is explicit and unsafe optional maps are omitted. |
| Workspace scan cost | Saved files with duplicate folders repeat Git observations; candidate enumeration has no global cap. | Cache observations within one scan only; cap saved candidates at 16 and directory entries at 1,024; report truncation and withhold incomplete domain drafts. |

All repairs are scoped to the owning modules. Existing trust, gate, locked intent,
and verification requirements are not disabled to make a check pass.

## Statechart integration

The first working surface is:

```text
ae diagrams formal --file <formal-verification.json> --model <Module.tla> --json
```

It consumes retained framed TLC output and recorded source/model bindings. It
does not explore a TLA+ model, run Java, acquire a JAR, install a tool, execute a
supplied view module, or upload a model to a service. Existing bundled Pele
rendering writes the ordinary immutable SVG/HTML/optional PNG artifacts.

The implementation adapts Lauren's pure message/trace/value parsing and typed
IR, with an AE static backend that preserves ordered witness steps. Its source
revision, adaptation details, and complete MIT license ship with the parser.
README and third-party notices explicitly credit Lauren Tan and pstack.

Important assurance distinctions:

- Overall receipt success can include expected failures from deliberately broken
  models. The diagram labels those as negative controls, not current AE bugs.
- A temporal witness needs its recorded backedge or stuttering marker; a finite
  prefix cannot stand in for infinite behavior.
- A successful render remains `descriptive-context` / `not-verified` and never
  advances formal synchronization or creates a fresh passing formal receipt.
- Missing/redacted/malformed values, unsafe integer representations, incomplete
  frames, and unsupported witnesses fail explicitly rather than changing states.
- The producer's `<copied-runner>` hash is retained as provenance, not read as a
  fictitious workspace file.
- Current/stale/unknown describe the recorded file inventory only. New writers
  outside that inventory are not discovered by drawing a trace.

Full reachable-state diagrams remain a separate increment: export a bounded
graph, per-state rule marks, verdicts, configuration/bounds, and coverage. DOT
plus one counterexample cannot justify coloring every other state safe. The
current receipt does not contain that full graph.

## What pstack's iterations teach AE

1. **Separate I/O from semantic transformation.** The statechart compiler's pure
   boundary is enforced by upstream import-graph tests. Reuse the matching
   parsers and regression witnesses, not the TLC/mise/shell launcher.
2. **Prove the first real unit before fan-out.** Native workflows need an installed
   archive, an actual failing product path, cancellation/resumption, and
   independent acceptance. A scripted agent reply is not that evidence.
3. **Remove duplicated orchestration.** pstack
   [#1043](https://github.com/cursor/plugins/pull/1043) removed its separate orch
   CLI. AE should keep host coordination and its deterministic kernel distinct.
4. **Bound follow-up work.** pstack
   [#613](https://github.com/cursor/plugins/pull/613) reduced repeated swarms;
   PR #104's review-budget and fresh-packet rules follow the same principle.
5. **Recover at the owning boundary.** pstack
   [#151](https://github.com/cursor/plugins/pull/151) refined health rechecks,
   owned cleanup, and evidence preservation. Corrupt journals or unsafe paths
   should remain observable, not be silently repaired into success.
6. **Test the delivered artifact and platform.** Compiler port
   [#977](https://github.com/cursor/plugins/pull/977) and process-test repair
   [#981](https://github.com/cursor/plugins/pull/981) show why Linux source tests
   alone cannot establish another host's behavior.

These sources do not establish that pstack has a higher real-world success rate
than AE. They provide concrete implementation and verification methods to reuse.

## Delivery and release plan

1. Pin PR #104 and inspect current CI/review status. **Completed.**
2. Reproduce defects, add failing regressions, and commit surgical fixes per
   boundary. **Completed with failing-before/passing-after regressions.**
3. Integrate offline formal replay, attribution, and exact producer-shape checks.
   Test saved upstream witnesses, real CLI rendering, and local/global packed
   offline installation. **Completed with parser/data review findings repaired.**
4. Independently review current changes from architecture, security/data, and
   simplicity perspectives. Findings require reproduction and fresh review
   after fixes. **Completed for the examined code and reference changes; no
   remaining reproduced P1/P2 finding. Native-host evidence is not implied.**
5. Run focused regressions, release/corpus/command checks, Node 20 compatibility,
   full candidate tests, and candidate GitHub Linux/Windows workflows. Preserve
   environmental failures separately from product defects. **Local results are
   recorded below at code commit `d874116`; candidate remote CI remains pending.**
6. Publish a follow-up PR based on the pinned PR #104 branch. Reconcile a later
   base advance before merging; do not silently duplicate or overwrite PR #104.
   **Local branch: `codex/ae-stability-statecharts-20261029`. Publication is
   pending explicit approval after automatic approval review rejected public
   source/audit disclosure. The remote branch contains only the PR #104 baseline;
   no follow-up code or PR has been published.**

## Validation record

These runs overlap; their counts must not be added as one unique test total.

| Check | Observed result |
| --- | --- |
| Core evidence/plan/recovery/review suites | 145 passed |
| Domain evidence alignment | 13 passed |
| Formal trace/command/projection suites | 47 passed, no skips |
| Packed offline local/global rendering and formal replay | 2 passed, no Java/JAR acquisition; archive asserted free of JAR payloads |
| Final expanded Node 20 compatibility selection | 77 passed, no skips; native-hook selection additionally passed 4/4 |
| Final knowledge focused suite | 55 passed |
| Knowledge/domain/admin/context integration | 142 passed, one existing chmod/root skip |
| Independent knowledge isolation/freshness review run | 10 passed |
| Independent formal/native and installer/orientation/isolation security selections | 18/18 and 25/25 passed, no skips |
| Context/reference fixtures plus project isolation | 21 passed; fixtures declare the actual repository identity without changing the omission policy |
| Corpus validation and package-local release validator | Passed |
| Full local suite at `d874116`, Node 24, concurrency 4 | 3,716 tests: 3,655 passed, 20 failed, 41 skipped; exit 1 |
| Untouched PR #104 process suites | 27 tests: 7 passed, 20 failed; exactly the same failure locations as the candidate |

An early broad diagnostic run during implementation produced 3,601 passes,
30 failures, and 41 skips across 3,672 cases. Those results are not labeled a
final candidate pass. The failures identified old digest/identity fixtures that
were corrected, plus Linux process-identity observation unavailable in this
sandbox. The latter was independently reproduced on untouched PR #104; its
process controls are deliberately unchanged. The final full run has only those
20 process failures, in `experiment-state.test.mjs` and `process-identity.test.mjs`;
all failure locations match the untouched baseline. A probe confirms this
sandbox's PID namespace does not match `/proc`: Node reports PID 5 while
`/proc/self/stat` reports PID 415461. Its observer cannot establish the required
process identity. This is an environment qualification failure, not a full-suite
pass. The final report-only commit does not change the tested runtime or tests.

The 41 skips remain visible rather than being counted as passes. Two
`git diff --check` notices are intentional retained blank lines at EOF in the
upstream MIT license and raw TLC witness; those source bytes are preserved.
The deliverable patch is independently applied to a temporary index at PR
#104's pinned base and must reconstruct the exact final Git tree.

An actual `ae verify` attempt did not pass. This isolated checkout is untrusted,
so Harness refused to run repository-authored named checks; it did not manufacture
a receipt from manual test logs. The later exact-file scope also exposed the
primitive activation/governance prerequisite for refreshing the gate. The
create-primitive source and workflow were read, but this Codex session has no
native Copilot skill-read activation record. No activation or trust record was
forged. The managed plan remains in progress; native gate/proof/completion and
candidate GitHub Linux/Windows CI remain pending.

## Qualification limits and next acceptance work

- Run the existing `packages/ae/eval/host/README.md` protocol on the actual
  installed Copilot/IntelliJ host. Capture archive identity, cold start,
  interrupted/resumed delivery, stale-intent refusal, and independent acceptance.
- Keep PR #104's explicit remaining host enforcement/trust/plan-authority slices
  visible. Do not describe non-Copilot hosts as guarded without their adapters
  and observed deny behavior.
- Do not treat declared reviewer provenance as authenticated host invocation, or
  scripted CLI success as model-quality/token-cost evidence.
- Keep richer graph projection, semantic theme presets, and any review-confidence
  policy change separate from the verified defect fixes above.

The release objective is demonstrated behavior with explicit unavailable cases,
not a claim that every unknown AE failure has been eliminated in one audit.
