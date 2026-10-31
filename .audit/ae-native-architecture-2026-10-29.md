# AE native architecture: research, decisions, and implementation plan

This work replaces the provisional pstack parser integration with a researched,
AE-owned design and reassesses PR #104 against the problems it addresses. The
user explicitly authorized the complete investigation, detailed plan and full
implementation on October 29, 2026. The earlier candidate is a baseline to review,
not an architectural constraint or a release recommendation.

All 13 implementation tasks in the accepted six-phase plan are finished on
`codex/ae-native-architecture-20261029`. The plan has eight acceptance criteria.
The frozen code and archive qualification is bound to
`417362edce3ea19d0415d3c798e48ee82752f6ed`; the final audit-only commit changes no
tested runtime, corpus, CI or test source. This supersedes the provisional
integration. Unavailable native editor/model, Windows runner and caller-provided
TLC observations remain explicit; source tests do not manufacture them.

## Sources and investigation coverage

| Source | Pinned identity | Examined coverage |
| --- | --- | --- |
| AE main | `0d44caad145bb3ef8ab9a7cf301ecfa00569615a` | Canonical architecture and pre-PR responsibilities |
| PR #104 | `34ccbf003f9dd31d3ad8215f9da80e44097dea6a` | All 189 changed paths grouped by 25 owning behaviors; retained issue-label groups, current source/tests and selected introduction history |
| Provisional AE candidate | `8699e9e6c73ad8fae164ded22085ffa53b9df6f1` | Earlier ten reproduced defect families, copied parser closure, actual regression/package evidence and disclosed limits |
| pstack v0.15.36 | `cursor/plugins@4dd1d05818d19792e7cd6e818f1667f95f7e1dbe` | Complete checkout inventory, all capability families, all 23 playbooks, ten guide chapters, relevant runtime/compiler/host code and meaningful historical changes |
| Host protocols | Current official GitHub Copilot hooks/customization and VS Code hook documentation | Accepted payload/result aliases, hook discovery and selected-surface capability differences; not a live editor trial |

The source inventory contains 573 tracked pstack files: 566 UTF-8 text files and
seven binary assets. There are 58 top-level skills, including 24 principle
leaves, three Benny automation skills, and two agents. All families have an
adopt/adapt/omit decision. The history investigation indexed 169 pstack commits
and examined 17 substantive lifecycle milestones plus the detailed statechart
evolution. This establishes architecture/source coverage; it does not claim that
every helper line was individually audited, every upstream test ran, or every
workflow was executed in Cursor/Claude/Copilot.

The pinned checkout's generated-host-tree check passed. No Bun, Java, JAR or
external checker was acquired. pstack's source and iteration history are useful
evidence, not proof that its real-world task success rate exceeds AE's.

Detailed source evidence, tradeoffs, reproductions and acceptance tasks:

- [Lifecycle, complete capability families and history](ae-native-architecture/research/architecture-lifecycle.md)
- [Authority, runtime and host evidence](ae-native-architecture/research/authority-research.md)
- [Task scope, context and workspace alternatives](ae-native-architecture/research/scope-context-research.md)
- [Knowledge, distribution and ownership](ae-native-architecture/research/knowledge-packaging-research.md)
- [Native formal evidence and diagram architecture](ae-native-architecture/research/diagram-architecture.md)
- [All PR #104 changed behaviors and qualification](ae-native-architecture/research/qualification-research.md)

The original complete numbered bug transcript is not retained in the repository
or PR discussion inspected here. The PR body preserves grouped labels and
specific follow-ups. The disposition ledger covers those available groups and
their implementations without inventing unavailable per-label descriptions.

## Architectural conclusion

Keep the host-owned Engineer and deterministic Harness boundary. The host owns
reasoning, task relevance, model selection, delegation and interruption. Harness
owns identity, accepted intent, scoped gates, observed checks, current evidence,
contained writes and recoverable publication. AE already has useful stronger
contracts than prose alone: content-bound plans, revision-bound decisions,
executable-mode-aware proof, captured index generations and completion checks.

The highest-leverage improvement is to remove inferred work before adding more
orchestration. Saved workspace files do not establish the active editor window,
the task's repository set, or a need for additional agents. A coherent edit can
stay with its owner; delegation must earn its cost through expertise, isolation
or useful parallelism. Installed user-path proof precedes claims about adaptation
or model quality.

## What AE adopts, adapts, and omits

| pstack mechanism or lesson | AE decision | Concrete implication |
| --- | --- | --- |
| Parent chat owns orchestration; latest Orchestrate deletes a separate CLI | Keep host-first ownership | No new scheduler, autonomous coordinator or coordination database |
| First independently verified real unit before fan-out | Adapt through existing installed lifecycle drive | Real packed CLI, hydrated hooks, broken/fixed checks and recovery; no duplicate evaluation engine |
| Task/topic/workspace boundaries and bounded briefs | Adapt | Bound-root/store orientation; no saved-folder-to-scope inference or mandatory researcher per root |
| Subtract before caching; explain measured numbers | Adopt | Remove automatic discovery/domain drafting rather than retain it merely because a cache makes it cheaper |
| Caller-first architecture and typed semantic boundaries | Adapt to actual AE data | One small evidence graph; opaque lossless TLC value text; existing I/O and renderer owners |
| Pure compiler and independent semantic regression fixtures | Adapt, not copy | Native bounded frame/DOT parsing, occurrence/loop preservation and import-closure checks |
| TLC runner, mise installation, executable view modules and custom POSIX janitor | Omit | No tool acquisition or dynamic diagram code; preserve AE's existing worker/cleanup ownership |
| Quotient state merging, hidden steps and parallel regions | Omit from accepted feature | Exact recorded states/transitions; no invented grouping or unsupported safety coloring |
| Reflect/correct/teach through the correct durable source | Adapt at existing owners | Keep private project knowledge, contained provenance and single-writer consolidation; no new memory layer |
| Generated host mappings with checked differences | Adapt | Truthful selected-target doctor and real protocol fixtures; installed customization is not native enforcement proof |
| Mandatory feature delegation, arena, fixed model slugs and prose rituals | Omit | Existing proportional planning and host-selected models remain; direct implementation is valid |

The comparison includes automation, watcher/PR helpers, benchmark/hillclimb,
explanation, style and principle families. Their detailed disposition is in the
lifecycle brief. They do not become AE features simply because pstack has them.

## Capability maintenance and recorded authorization

### Summary and trigger evidence

The user requested pstack as an architectural reference, an AE-owned
implementation, a complete investigation and a fully implemented plan. The
prototype copied an upstream parser subsystem and preserved automatic workspace
inference. Existing owners are sufficient, but their implementation and shipped
guidance need correction. This proposal records that already-authorized
maintenance; it does not create a public skill, agent or approval ceremony.

### Existing Primitive Check

| Area checked | Existing artifact | Reuse or gap decision |
| --- | --- | --- |
| Skills | Engineer, architect, ensure-plan, Codebase Context, create-primitive | Reuse the current entry, planning and interpretation owners. No new skill. |
| Agents | Engineer and existing specialists | Preserve judgment boundaries; no statechart agent or compulsory research panel. |
| Instructions | harness-global instructions and investigation playbook | Remove discovered-root scope and mandatory fan-out; preserve task and mutation authority. |
| Prompt wrappers | Retired prompt surface | Keep retired; no wrapper for the new deterministic command behavior. |
| Review checks | Existing code-review primitive/capability checks | Reuse; independent review judges boundary and assurance, not a new automatic policy engine. |
| References/assets | Existing diagrams/formal-verification references and formal-check starter | Extend these owners with retained graph coverage and explicit same-run capture; no separate recipe generator. |
| Solution docs | Existing verified learning writers | No automatic promotion or new knowledge writer. Research remains an audit record; verified learning follows the existing proof contract. |

### Proposed Primitive and Behavior Contract

The primitive change is maintenance of existing references, supporting assets
and instructions. Reusable parsing, graph transformation, provenance and path
checks stay in Harness code. Expected users are the existing Engineer,
maintainers and diagram readers. No additional tool authority, network access,
model selector or delegation permission is requested.

Use the references when explaining an actual recorded witness or captured graph,
or maintaining the configured formal check. They do not trigger fresh model
checking, tool installation, arbitrary model evaluation, unrelated repository
research or automatic domain creation. Inputs are the exact receipt/module and
bound recorded artifacts; outputs are descriptive diagrams and currentness
observations. A missing, malformed, oversized or incomplete input refuses or
reports unavailable under its existing owner; it does not create successful proof.

### Risks and Validation Coverage

| Concrete scenario | Priority | Required behavior |
| --- | --- | --- |
| Explain a saved safety counterexample with a deliberately broken control | P1 | Preserve ordered states and label the negative control; no fresh verifier pass. |
| Draw a positive finite run with a same-run captured graph | P1 | Bind raw graph bytes, exact states/transitions and recorded exploration coverage; rendering runs no checker. |
| Investigate one repository while an inactive saved file names three others | P2 | Good: keep the actual bound root/store. Bad: create three researchers or a domain draft from that file. |
| Implement a coherent source/test edit without special expertise | P2 | Good: direct ownership and required final review. Bad: delegate solely because the playbook says Feature or Refactor. |
| A read result is clipped, comes from a decoy, or names changed workflow bytes | P1 | Reject complete activation and provide the existing real-read recovery path. |
| Install/upgrade with a symlinked lock or another home's ownership ledger | P1 | Refuse unsafe publication and preserve unrelated files. |

Safety and data risks are misleading evidence, source confusion and ownership
escapes; their regressions run at the real boundary. Cost risk is unnecessary
discovery/fan-out; removal is structurally tested, without claiming measured
native token savings. Maintenance risk is format expansion; the accepted parser
is deliberately bounded and unsupported exports refuse rather than approximate.

### Human Decision

- **Decision:** Approved by prior direct user authorization in this conversation.
- **Reviewer:** Chai.
- **Date:** October 29, 2026.
- **Authorization:** Use pstack as reference and implement AE's own design; do
  the complete targeted investigation and architectural research, prepare the
  detailed plan, and implement it completely.
- **Conditions:** No sneaked Java/JAR files or runtime acquisition; retain
  appropriate attribution and notices; reconsider PR #104's choices instead of
  assuming their implementation must survive. Native proof and trust must not be
  fabricated. Public source/audit disclosure remains separately unapproved.

The managed plan references this architecture record. This section records the
existing human decision under AE's capability-gap/human-approval contracts; it
does not infer authorization from a generated `approved` payload field.

## Demonstrated problems and owning repairs

| Finding | Evidence and root cause | Planned repair |
| --- | --- | --- |
| Inferred repository scope | An inactive saved file listing A/B/C beats a saved A-only file; instructions then request researchers for B/C. Metadata was promoted into task scope. | Report bound root/classification and actual selected store only; preserve empty compatibility fields; remove automatic domain drafting and per-root fan-out. |
| Repeated workspace metadata work | Twelve saved files with 64 duplicated folders produced 782 Git subprocesses on PR #104; the provisional cache reduced this to four. The necessity of discovery remained unproven. | Remove this default work. Treat the synthetic counts as mechanism evidence, not a model-cost benchmark. |
| Unconditional implementation delegation | Feature and Refactor playbooks require a delegate even for one coherent edit. This conflicts with agent-optional proportional delivery. | Allow direct ownership; delegate only a useful bounded question/scope. Preserve required independent final review. |
| Copied diagram subsystem | Six upstream modules/736 lines plus an AE adapter carry unused typed-value/general graph machinery. This is not the requested AE-owned implementation. | Replace the parser closure with native exact-evidence parsing and graph projection; remove vendor code. |
| Private manifest provenance escape | Actual CLI recall accepts a workspace manifest symlink to another repository's legacy private metadata because lexical location becomes `workspaceBound`. | Establish bounded physical containment before granting provenance; retain ordinary contained legacy support. |
| Installer lock write escape | Actual install follows a symlinked `.harness-lock.json` and overwrites an outside sentinel. | Preflight every selected home before any install write; validate ownership input and publish contained atomic locks. |
| Cross-home retirement authority | IntelliJ upgrade uses a Copilot ledger to delete an unrelated IntelliJ personal file at the same relative path. | Each physical target home owns its ledger; legacy aggregate metadata cannot authorize cross-home deletion. |
| Host argument/result mismatch | Documented camelCase tool arguments disappear; an explicit CLI failure can appear successful; successful full reads can remain incomplete. | Normalize supported envelopes once and preserve failure/unknown/completeness semantics through actual installed hooks. |
| Decoy or partial workflow activation | A path suffix can activate a privileged workflow name; a requested one-line range can be treated as whole-file reading. | Bind activation to the selected actual source path/bytes and complete coverage; reject look-alikes, stale or clipped evidence. |
| Host diagnosis conflates surfaces | Existing doctor path assumes VS Code. Current official support differs for CLI, VS Code and JetBrains. | Inspect the selected home/target and distinguish customization, native hook availability and observed enforcement. |
| Minimum runtime is not an archive release bar | Package promises Node >=20 but package CI uses Node24 and normal suites use Node22. | Qualify the packed artifact on Node20 through the existing package workflow and installed drives. |

The earlier independently reproduced proof, journal, shim, runtime retirement,
PATH, freshness, project snapshot and orientation write fixes remain in the
candidate and remain subject to final regression/review. They are not discarded
because the earlier diagram design was provisional.

## AE-owned diagram design

The command consumes retained evidence. Rendering does not run a checker,
evaluate arbitrary TLA+, acquire Java/JAR files, upload models or execute a view
module. The existing optional formal checker still requires deliberately supplied
tools; an explicit capture option exports the graph from that same run/config.

| Boundary | Owned behavior | Assurance limit |
| --- | --- | --- |
| Formal protocol parser | Bounded complete tool frames, state assignments as raw value text, qualified actions, exact ordinal occurrences and temporal backedges/stutter | No JavaScript number conversion or TLA expression evaluation |
| Native evidence graph | Recorded state IDs or trace occurrence IDs, exact variables/edges, witness role, explicit complete/partial/trace-only coverage | No merged states, hidden edges, invented regions or rule marks |
| Optional checker graph capture | Same configured invocation emits TLC DOT; receipt retains graph basename/hash and exploration status | No rule-removal reruns, automatic tool installation or fabricated graph when capture fails |
| Diagram I/O | Read receipt/source/graph through bounded contained paths; bind hashes and recheck currentness before publication | Hash identity does not authenticate imported evidence or establish implementation conformance |
| Existing renderer worker | Encode labels, render static Mermaid with bounded resource use, publish immutable SVG/HTML/optional PNG | A readable diagram remains descriptive context, not a new verification receipt |

Violating models retain witness-first presentation so a liveness lasso does not
disappear into a partial state graph. A complete positive run can draw a bound
recorded graph. Older receipts with counterexamples remain readable; a positive
receipt without a graph gives capture guidance rather than inventing states from
the model file. All graph nodes remain neutral unless corresponding evidence
actually supplies stronger marks.

Native implementation attribution credits Lauren Tan and pstack's architecture,
semantic safeguards and research. Retained upstream protocol fixtures keep their
required notices. This is not described as a clean-room implementation.

## Detailed execution plan

The CLI-owned managed plan is authoritative for accepted task progress. This
table is the reviewable implementation/acceptance map, not a second state machine.

| Phase / task | Concrete output and owner | Acceptance | Status |
| --- | --- | --- | --- |
| P1T1 Research coverage | Six source-pinned briefs; complete capability-family and PR104 behavior dispositions | Evidence separates source/history, executed tests and unavailable native observations | Complete |
| P1T2 Architecture before edits | Native evidence graph and scope/ownership decisions, explicitly accepted managed plan | No vendored subsystem or inferred domain authority in final design | Complete |
| P2T1 Task scope | Reduced workspace layout, selected store, compatible empty fields and installed context | Inactive saved workspaces cannot change roots/context identity; no neighbor probes or domain draft | Complete |
| P2T2 Proportional work | Existing feature/refactor/investigation guidance | One coherent task can stay direct; broader useful work can delegate; final review remains | Complete |
| P3T1 Native protocol/graph | AE-owned pure parser and exact projection, vendor deletion | Large integers/text preserved, qualified actions, repeated states and liveness survive; malformed input refuses | Complete |
| P3T2 Same-run graph export/import | Existing configured checker capture plus bound native DOT input | Complete/partial coverage accurate; graph hash/path drift refuses; no checker runs during rendering | Complete |
| P3T3 Public command/artifact contracts | Existing help, references, attribution and packed renderer | Real offline CLI and hydrated native-admission routes work, no JAR or upstream parser payload | Complete |
| P4T1 Manifest provenance | Existing shared/workspace manifest reader | Real recall/search reject foreign symlink metadata and preserve contained legacy/private generations | Complete |
| P4T2 Target-home ownership | Existing lock writer and installer | All locks preflight before writes; outside sentinels/unowned personal files survive; owned retirement still works | Complete |
| P5T1 Host evidence | Existing payload/read activation owners | Supported documented aliases agree; failure/partial/decoy/stale observations cannot establish successful activation | Complete |
| P5T2 Target qualification | Doctor, existing archive CI and installed lifecycle test | Selected home checked truthfully, unsupported native surface explicit, packed Node20 route tested | Complete |
| P6T1 Qualification | Focused TDD, actual installed drives, corpus/release/Node20 and full suite | New failures repaired; known environmental failures compared with untouched baseline rather than hidden | Complete |
| P6T2 Independent review and delivery | Final source-bound reviews, findings repaired, research/plan/report and exact patch | No outstanding actionable finding in examined scope; final patch reconstructs committed tree; no forged trust/native proof | Complete |

## Implemented changes and validation

| Change | Commits | Observed acceptance |
| --- | --- | --- |
| Bound-only scope and proportional workflow | `87c3046`, `ab73c8b` | Three regressions failed before; context/read/adapter selection 29 passed with one existing root/chmod skip; Node20 context 20/20; offline archive/hydrated adapter 3/3 |
| Native formal evidence and same-run capture | `0fbb530`, `fd0d7bd`, `5870eef` | Runtime compiler about 358 native lines replaces about 910 vendor/adapter lines; actual CLI/native admission/offline local/global install/repack 31/31; focused Node24 and20 each 27/27; producer each 37 passed, one explicit fresh-TLC skip |
| Contained manifest and per-home install ownership | `a491789`, `417362e` | Thirteen of fifteen new regressions failed before; retrieval integration 83/83; installer integration 78/78; Node20 boundary/isolation 27/27; stricter read-cap integration 31/31 on both runtimes |
| Source-bound complete activation and host envelopes | `c772787`, `72db38a` | Initial negative cases failed before; full hook runtime 61/61; final host/headless 55/55; final Node20 host 27/27; independent actual-hook P2 recheck 10/10 |
| Selected-target diagnosis and archive CI | `0279766`, `5870eef` | Three new doctor cases failed before; doctor/hook/adapter 22/22; CI contracts eight passed with one platform skip; Node20/24 and Linux/Windows archive matrix configured |
| Research, explicit authorization, capability descriptions | `ab73c8b`, `62950d4`, `4f8278c`, `72db38a` | Five required review perspectives completed; missing structured record and stale headless description corrected under existing approval |

These selections overlap. Their counts are not added into a fictitious unique
test total. Two fresh Codex scenario interpretations of the changed playbooks
chose direct work for one coherent greeting change and bounded SQL delegation
for independent storage/formatter work. Those are source-interpretation trials,
not actual Copilot outcomes or a token-cost benchmark.

### Final frozen candidate qualification

- Source: `417362edce3ea19d0415d3c798e48ee82752f6ed`, clean working tree.
- Full command: `node test/run.mjs --test-concurrency=4` from `packages/ae`.
- Result: **3,775 tests: 3,714 passed, 20 failed, 41 skipped**, exit 1,
  444,069 ms. This is not labeled a full-suite pass.
- All 20 failure locations match the untouched PR #104 process-suite baseline
  exactly; every failure reports `process identity is unavailable; absence is
  not proven`. There are no non-baseline failure locations. The sandbox's
  observed PID namespace does not match its `/proc` view. Process controls remain
  unchanged and fail closed.
- Untouched baseline comparison: 27 process tests, seven passed and 20 failed.
- Final log SHA-256:
  `fbc431b22bf9005ce2c9bf5a8e4970ef69f9758eae48ae70ff3036c866c1ed9b`.
- Release validator passed for `ae-harness@0.14.0`; corpus validator passed with
  28 skills, 22 agents and five instructions. No primitive count was added.
- Branch whitespace checking reports only two retained upstream fixture EOF
  blank lines in `LICENSE.pstack` and the raw CounterJump witness. Their source
  bytes are intentionally preserved.

The preceding diagnostic integration run found the old oversized-manifest test
expecting silent omission. The accepted contract requires an explicit refusal.
The corrected test retains the source diagnostic, proves zero descriptor or
whole-file content reads, and verifies retrieval refuses the oversized input.
It passed 31/31 on Node24 and20 before the final frozen run. No production
containment check or process control was weakened to obtain a better count.

### Exact archive and offline boundary

The archived `ae-harness@0.14.0` candidate was packed from that same clean source.
It contains no `.jar` file or `vendor/pstack` parser payload. The existing
installed lifecycle drive used this exact prebuilt archive on Node20, passed its
one selected journey, and did not select the other 23 tests in that file. The
drive exercises real runtime hydration, named broken/fixed checks, Stop refusal,
review/learning/completion mechanics in owned fixtures, inactive workspace
isolation, source-bound complete reads and decoy rejection. It is not a native
model trial.

Archive SHA-256:
`ab0adde3d46c830ed14394f504c7a0574aba725deb7cac039f8daf294496b8bb`.
Archive size: 35,692,474 bytes. The final audit-only commit does not change this
qualified package's source payload.

### Independent review and repaired findings

Architecture and simplicity review independently exercised 58 targeted cases
and examined the final correction deltas. Security review exercised ten bounded
compiler/filesystem/diagnostic cases and ten actual hook/headless cases after its
P2 finding was repaired. Capability and primitive-boundary reviewers rechecked
their structured-record and tool-description findings after correction.

Substantive fixes discovered during implementation/review include unsupported
state frames being omitted, quadratic multiline parsing, graph hashing over
decoded text rather than raw bytes, a native relative-path workflow decoy, and
clipped structured bodies/name-only reads being mistaken for complete activation.
Each code correction has failing-before/passing-after coverage. Final required
perspectives have no outstanding actionable finding in their examined scope.
Reviewer-role provenance is declared evidence, not a host-authenticated transcript;
the source research records authored-code exclusions and independent coverage.

## Qualification and release boundaries

The implementation work includes all tasks above. Native editor/model trials, candidate
Windows CI and fresh TLC execution need their real environments. This cloud
session must not turn a scripted provider, source test, saved witness or imported
hash into proof of those outcomes.

An isolated untrusted checkout must continue refusing repository-authored named
checks through `ae verify` until a person approves the policy. Manual tests and
real disposable fixture drives are evidence of their actual actions; they do not
grant trust or satisfy the managed completion gate. Public GitHub publication
also remains separately blocked by the prior automatic approval review until
the user explicitly authorizes public source/audit disclosure. No main merge or
original PR #104 rewrite is part of this implementation.

All implementation outputs are complete. The managed plan's accepted progress
is distinct from its machine completion record: trust-gated named verification
and completion are not fabricated from manual logs. The current PR #104 and main
heads were rechecked and remain the pinned baseline. No code has been uploaded,
no follow-up PR opened, and no original PR branch overwritten. The final patch
is checked by applying it to a temporary index at the pinned PR #104 base and
requiring the exact final Git tree; the readable delivery includes these results
and all six research briefs.
