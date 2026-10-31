# AE authority and runtime research

Baseline: AE `8699e9e6c73ad8fae164ded22085ffa53b9df6f1`; PR #104
`34ccbf003f9dd31d3ad8215f9da80e44097dea6a`; pstack v0.15.36 at
`4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`. Read-only source investigation;
no product code edited during this research. Tests and probes use disposable
fixtures and do not establish native Copilot execution.

## Scope examined

- AE plan creation, revision-bound decisions, gate/readiness, current proof,
  review collection, completion, trust and effective-policy snapshots.
- Installed hook configuration, payload normalization, skill-read activation,
  Pre/Post/Stop behavior, headless Deliver dispatcher, process execution and
  cancellation/experiment identity.
- pstack native orchestration, pause/pickup/cleanup responsibilities, verification
  recipe, idempotency principle, statechart process owner, pure/I/O separation,
  and selected relevant history. Other researchers own complete capability and
  learning/packaging inventories; this note does not substitute for them.

## Architectural comparison and decisions

| Concern | pstack evidence | AE behavior | Disposition |
| --- | --- | --- | --- |
| Coordination ownership | `poteto-agent.md` assigns all spawns/todos/playbook to parent. `orchestrate.md` uses host Task, project tracker/store and subscriptions. Commit `c742dd6` (#1043) deletes 6,348 lines including orch scripts. | `@engineer` owns ordinary delivery. CLI kernel is deterministic. Optional `agent-loop.mjs` has separately declared Deliver and autonomous/eval profiles. | Keep host-first boundary. Do not add another scheduler or shared coordination DB. Keep autonomous proofs distinct from Deliver completion. |
| Resumption | `pause-safely.md` checkpoints durable work; `session-pickup.md` reconstructs prior state and verifies inherited claims on actual artifacts. | Managed plans and operation journals bind intent/revisions, retain interrupted transitions and recover exact retries. | Preserve AE's stronger executable recovery contracts. Improve observability rather than add parallel resume prose/state. |
| Real verification | `create-verification-skill/SKILL.md` requires Launch/Doctor/Drive/Evidence/Cleanup, actual user path and retained evidence; stand-in setup must be declared. | AE already adopts project recipes and feature maps. Named checks and artifacts bind actual results. | Adapt method, not pstack implementation. Installed hook-contract drives are needed in addition to unit fixtures; native editor proof remains separate. |
| Atomic output and cancellation | `statechart.ts` stages privately, owns worker group and janitor, publishes only valid completed outcome via rename. `run.ts` separates tool invocation and parsing. | `runner.mjs` owns child/process-group shutdown; evidence and operations use contained atomic publication. | Preserve owned cleanup and no-publication-on-incomplete semantics. Do not copy pstack's POSIX shell janitor or automatic mise Java/JAR installation into AE. |
| Plan machinery | `check-plan.mjs` validates a particular multi-phase program with ten live lanes, screenshots, style and program sections. | AE full/short plans are proportional accepted intent contracts, with content hashes and selected checks. | Reject wholesale copying of pstack's program-specific lint. Keep proof proportional to actual affected boundary. |
| Assurance | pstack independently verifies one current PR head before broader fan-out; source and fixture output are examined rather than summary-only approval. | AE review declares roles but explicitly has no host-attested transcript. Content bindings invalidate stale coverage. | Preserve exact-byte/current-head checks. Never relabel declared reviewer provenance as authenticated execution. |

## Confirmed defects and contract gaps

### A1. Official CLI camelCase tool arguments disappear

`corpus/hooks/lib/tool-payload.mjs:893–949` accepts `toolName` but parses only
`tool_input`; it does not read documented `toolArgs`. Runtime names such as
`bash`, `powershell`, `view`, `create` also need explicit supported mappings.

The isolated probe in `research/authority-activation-probe.mjs` shows the same
destructive command is a mutation through snake_case `Bash/tool_input` but
non-mutation through camelCase `bash/toolArgs` (`command` becomes empty).
The shipped PascalCase registration can avoid this path, so this is not evidence
that every installed call bypasses the guard. It is a real mismatch in the shared
adapter's advertised alias handling.

Fix: normalize documented input aliases and known runtime tool names once at
the shared boundary. Keep unknown targeted tools mutating and unknown executable
syntax opaque. Test actual installed commands with both payload forms.

### A2. Official CLI result metadata is not consumed

`toolMutationSucceeded` (`tool-payload.mjs:952–960`) ignores `tool_result` and
`toolResult`, including explicit failure result types. The probe's failure result
is recognized as success. `record-successful-edit.mjs:40` accepts complete reads
only through `tool_response.truncated === false` or a dedicated read-skill tool.
The documented successful CLI full-read envelope therefore records incomplete
activation. A real agent can repeatedly read the correct workflow yet fail the
skillsUsed amendment / primitive mutation prerequisite.

Fix: canonicalize result aliases and failed event aliases. A recognized failure
must never activate a skill. For CLI output without explicit completeness
metadata, require evidence that the returned content covers the whole bound
skill; do not turn success into assumed completeness.

### A3. A repository decoy can activate the privileged workflow name

`activatedSkillFromPayload` (`tool-payload.mjs:962–981`) matches the path suffix
`skills/<name>/SKILL.md`, without checking the source against selected installed
or bundled corpus. A disposable fixture reads
`workspace/tmp/skills/create-primitive/SKILL.md` containing one unrelated sentence;
the hook records complete `create-primitive` activation although the actual
selected Copilot-home workflow was never read.

This is a workflow-fidelity problem, not proof of an OS-level privilege escape.
It directly relates to the original user failure of searching the checkout for
globally hydrated references. The wrong file must not satisfy the read contract.

Fix: bind privileged activation to the selected actual source path and its bytes,
using existing home/runtime resolution. Preserve supported packaged/headless
source reads. Reject look-alike workspace files, unsafe symlinks, missing sources,
changed source bytes and mismatched names. Store enough binding data that later
amendment and mutation checks can reject a stale activation.

### A4. Partial requested reads can be mistaken for full activation

The hook equates `tool_response.truncated:false` with an entire-file read, while
the payload can explicitly request only `startLine:1,endLine:1` (or `view_range`,
`offset/lines`). A successful response to that range is not proof the complete
workflow was loaded. Existing tests only reject a partial read with no explicit
`truncated:false`, so they do not cover this distinction.

Fix: derive completeness from both requested coverage and output status. A range
can count only if it covers all source lines. Explicit clipped results or offsets
after the beginning cannot count. Default/read-skill/headless cases retain their
specific actual proof; do not invent a native host transcript.

## Controls examined that should remain

- `loadPolicy` applies repository policy only when current human trust permits
  it; parsing ignored YAML for diagnostics does not itself grant authority.
- `verify.mjs:437–450` refusing to execute untrusted named-check argv is correct.
  Do not self-approve a cloned repo to satisfy this session's completion gate.
- `plan-decisions.mjs:186–195` requires current-session complete activation for
  a later skillsUsed amendment. Actual full source reading and source `ae get`
  alone do not create a native observation. Existing headless Deliver read
  dispatch is a legitimate supported lane; it cannot prove native Copilot use.
- `agent-delivery.mjs` runs the same real hooks before/after product tools and
  validates completion; standalone operator CLI and autonomous/eval execution
  do not become governed Deliver merely because they use the same low-level
  tools. Host hooks are mediation, not an OS sandbox.
- Current v2 plans bind selected source bytes. Ordinary relock cannot accept new
  bytes or rerank a frozen source set. Legacy paths-only plans remain explicitly
  weaker until deliberate migration. Do not silently reinterpret legacy proof.
- Current byte/mode-bound evidence, review packets, check artifacts and completion
  have existing negative controls. Keep them when simplifying prompts/loading.
- `experiment-state.mjs:324–357` fails when it cannot observe process identity.
  This sandbox's namespace/proc mismatch must not be fixed by assuming absence
  or weakening owned cleanup. A source guard that diagnoses the mismatch can be
  considered separately; no process-kill behavior was changed here.

## PR #104 residual issue disposition

The current PR body groups residual IDs; original per-ID reports are not retained
in the inspected source. Do not invent what individual labels meant.

| PR group | Current evidence | Minimal disposition |
| --- | --- | --- |
| G1/N4, trust/enforcement | Untrusted project policy is ignored. `init-repo.mjs:36` still authors observe; once trusted that explicit policy applies. Critical/destructive rules remain enforce absent explicit override. | Change new scaffold default to enforce if accepted product intent; preserve existing selected observe/warn policies and explain effective source. Do not make trust silently rewrite user's policy. Qualification researcher owns. |
| G4/G5, plan lock/hash | Current content-v1 and relock tests establish selected-byte authority; legacy guarantee is explicitly paths-only. | Keep current contracts; qualify current behavior rather than apply stale labels. |
| B6/B7/B8/B16/N3/N5, host contracts | Native payload/activation gaps A1–A4 above; official CLI casing aliases and AE deny/block fields are already compatible. | Repair demonstrated payload/read-evidence gaps. Verify exact installed registration. No speculative casing fork. |
| B17/B18/G3, second agent/ungated tools | Supported headless Deliver mediates calls; direct operators and unguarded hosts are not an OS sandbox. | Drive a fresh second session through installed hook contract; reject stale activation/proof and missing gate. Report native-host limits, do not claim unsupported host guard. |
| B15, three hook processes | Qualification researcher measured 20 warmed source-hook serial drives, median293ms/p95321ms, three Node commands. | Record measured baseline and a budget. Consolidate only if behavior-preserving improvement is justified; avoid blind refactor. |

## Targeted validation executed

`authority-controls.log`: **15/15 passed**, zero skips, covering revision-bound
start/interruption, blocked start, source amendment forgery, frozen relock,
concurrent stale decisions, actual skill-read provenance, executable proof
identity, check artifact integrity, executed-proof requirement and policy trust.
This targeted run does not claim full-suite or native-host proof.

`authority-activation-probe.json`: synthetic hook-contract repro confirmed A1–A3
and the documented successful CLI full-read incompleteness. A4 is source-backed
and needs a failing partial-range regression before implementation.

## Proposed bounded implementation and acceptance

1. **Normalize the actual host boundary.** Add failing installed-hook tests for
   official camel/snake request/result envelopes, native tool aliases, explicit
   failures and mixed malformed data. Implement only canonicalization, leaving
   deny/trust/scope semantics unchanged.
2. **Bind actual skill activation.** Add decoy, partial-range, stale-byte,
   wrong-home and symlink refusals plus full installed and real headless reads.
   Implement source binding + complete coverage once; share it at recording,
   skillsUsed amendment and privileged mutation consumption. Legacy unbound
   privileged activation should require a reread, not acquire new assurance.
3. **Improve recovery precision.** Distinguish missing observation, incomplete
   read, wrong source and stale source in bounded diagnostics. State that an
   unsupported host cannot manufacture native activation by running `ae get`.
4. **Qualify delivery.** Install packed artifacts into isolated homes, execute
   real hook commands using captured documented payload shapes, and drive a
   successful headless Deliver lifecycle with real CLI artifacts and negative
   controls. Keep native IDE/manual and Windows evidence separate.

## Primary references

- Pstack pinned source paths and history above under
  `https://github.com/cursor/plugins/tree/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack`.
- Official GitHub hooks contract, inspected 2026-10-29:
  <https://docs.github.com/en/copilot/reference/hooks-reference>.
  CLI accepts PascalCase aliases and corresponding snake_case payloads as well
  as camelCase `toolArgs`/`toolResult`. Top-level deny/block fields match AE.
  Command-hook errors deny; timeouts return to the host permission flow. This
  limits any claim that hooks alone guarantee enforcement under all failures.

Remaining assumptions: source-bound activation proves a recorded complete read
through a supported adapter, not model comprehension or cryptographically
authenticated native-host execution. Local state integrity does not defend
against an actor with unrestricted write access to the user's AE home.
