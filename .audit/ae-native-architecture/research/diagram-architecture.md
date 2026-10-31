# AE-owned formal diagrams: architecture research and implementation plan

Research baseline: AE `8699e9e6c73ad8fae164ded22085ffa53b9df6f1` on PR #104
`34ccbf003f9dd31d3ad8215f9da80e44097dea6a`; pstack v0.15.36 at
`4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`.

## Result

Replace the vendored parser/formatter subsystem with a small AE-owned evidence
compiler. Preserve recorded TLC values as opaque text, not interpreted JavaScript
values. Use one explicit AE graph representation for retained witnesses and
retained explored graphs. Render exact nodes and edges through the existing
bounded Pele worker and immutable diagram artifacts. A diagram never runs a
checker or changes verification authority.

Provide a real producer path for explored graphs in the existing formal-check
starter, rather than ship an input schema which nothing can produce. Graph
capture is an explicit option on that already opt-in checker. It uses only the
deliberately installed, pinned Java/TLC configured by the caller. It performs no
tool acquisition, and local diagram generation continues to work without either
tool. The first implementation renders exact recorded states; it does not port
pstack's executable views, quotient projection, parallel regions, or coloring.

## What pstack actually does

All paths below are under `pstack/skills/statechart` in the pinned public source.

| Mechanism | Evidence | Lesson for AE |
| --- | --- | --- |
| Tool execution is separate from compilation | `scripts/run.ts:270` produces CheckResult; `scripts/pipeline.ts:57` consumes it | Separate observed evidence from pure transformation, rather than make rendering another verification command |
| Tool acquisition is automatic upstream | `scripts/run.ts:193-212` uses mise and installs Java/TLC when absent; SKILL.md states first run needs network | Do not adopt this behavior under the user's explicit no-JAR/no-download constraint |
| Full graph generation is more than parsing TLA | `scripts/run.ts:412-462` writes ChartRun, requests `-dump dot,actionlabels`, instruments per-state rule marks, and links recorded counterexamples | A parser-only integration cannot claim equivalent reachable-state diagrams or marks |
| Failure continuation and rule coverage are explicit | `scripts/run.ts` judge loop removes broken rules and reruns, distinguishes not checked, limits reruns to 100,000 states | A single first failure is not proof about all rules or all states; AE should display only claims actually present in its receipt |
| Graph budget is deliberate | SKILL.md and IR cap full charts at 500 states; above that only failure paths are drawn | Never silently clip a bug path or describe a limited graph as complete |
| Views can alter apparent behavior | `scripts/pipeline.ts:48` calls regionsLie, falls back to parent states; loopCheck verifies temporal witnesses | AE can avoid the entire abstraction hazard by initially drawing exact recorded states and transitions |
| Hidden steps and merges need semantic checks | SKILL.md's Pick the chart and Read the report rules; passes/region-check.ts and passes/loop-check.ts | Do not add arbitrary grouping or hiding as merely visual styling |
| Compilation purity is enforced | `scripts/test/pipeline.test.ts:66-114` checks imports, globals, transitive runtime dependencies | A meaningful architecture test should ensure AE's evidence parser/projection has no filesystem/process/network authority |
| Tests exercise hard semantic boundaries | `scripts/test/differential.test.ts` compares ordinary TLC with compiler output using generated models, includes prototype keys and varied values; its TLC-dependent test explicitly skips without TLA2TOOLS | Use saved real protocol fixtures plus independently constructed boundary cases; do not call fixture replay fresh model checking |
| Publication/cancellation is owned at boundary | `scripts/statechart.ts` worker group and janitor, staged output and rename; `worker.ts:18-30` draft->done | Reuse AE's existing worker limits and atomic output publication rather than import POSIX shell process ownership |

The statechart history is not just the port: #741 introduced it, #776 records six
fixes, #779 simplifies helper/comment surface, #791 updates rendering, #977 ports
the compiler, #982 preserves qualified action names in temporal traces, and #981
corrects process reaping expectations. These show semantic fidelity, ownership,
and platform qualification matter more than copying the current directory.

## AE's current behavior and gap

- `lib/diagrams/formal.mjs` is 174 lines of AE validation/projection which imports
  a 736-line generated upstream parser/IR closure. Production needs only EC and
  defaultState from its 295-line IR; it carries general graph helpers and DOT
  parsing it does not actually use for rendering.
- `lib/diagram.mjs:139-151` reads a retained formal-verification receipt and binds
  its hash plus declared source/model/configuration hashes. It rechecks those
  inputs before publication. This is the right I/O owner and should remain.
- `lib/diagrams/render.mjs` already bounds input/output, rejects dynamic renderer
  controls and external assets, uses resource-limited workers, terminates them,
  and optionally rasterizes to PNG. Do not create another renderer.
- `corpus/skills/create-primitive/assets/formal-verification/check.mjs:246-253`
  invokes an explicitly supplied pinned JAR, classifies tool frames and writes
  each model's execution into a receipt. It currently exports no explored graph.
- A successful positive model has exploration statistics, but no states/edges to
  draw. Expected negative controls already have witness output; an overall
  passing receipt can therefore contain deliberate model failures.
- `classifyTlc` requires completion, success marker, no errors, nonzero distinct
  states and empty queue for a positive pass. This can determine the recorded
  exploration-completion label for a graph captured from that exact same run.
- The starter permits no VIEW/SYMMETRY/CONSTRAINT/configuration reductions. Its
  conservative grammar is valuable for the first graph exporter. Do not loosen
  it just to match pstack's larger feature surface.

## Recommended native contract

One pure AE `FormalGraph` object is sufficient:

```text
kind: recorded-trace | recorded-state-graph
nodes: [{ id, initial, variables: [{ name, valueText }] }]
edges: [{ from, to, action, role: transition | loop | stutter }]
witness: { violation: invariant | temporal, property, loopIndex? } | null
coverage: { exploration: complete | partial | trace-only, states?, limit?, reason? }
recorded: { expectation, modelPass, receiptStatus, toolIdentity, sourceIdentity }
```

IDs are occurrence IDs for a trace and original checker IDs for a graph. TLA+
valueText remains a bounded opaque representation from TLC. No Number conversion,
semantic canonicalization, evaluation, or sorting inside sets/functions occurs.
Strings, records, tuples, sets, model values and integers outside JavaScript's
safe range can therefore retain their exact displayed representation. Explicit
limits bound each name/value, total input, state count, transition count and
nesting observed by the framing scanner.

Parsing a state must recognize assignment boundaries without discarding trailing
content, reject duplicate/missing variable names and inconsistent variable sets,
and reject incomplete quoted/bracketed value text. It must not accept malformed
TLC output as a plausible prefix. Object/prototype names are data, preferably
stored in arrays or Maps rather than assigned to object prototypes.

Projection keeps every state/edge, preserves qualified action names and exact
ordering, and encodes all label content before Mermaid generation. It does not
merge same-label states, hide transitions, use parent/parallel regions, invoke
view modules, or infer initial/final states absent evidence.

An invariant witness is not necessarily a terminal state. A temporal violation
is a lasso or explicit infinite stutter; missing/invalid loop evidence refuses a
diagram. Expected negative controls, unexpected violations and mismatched
controls remain distinct metadata and visible notes.

## Explored graph producer and importer

Prefer extending the retained formal receipt over introducing another unrelated
global statechart source or command. Proposed shape:

```json
{
  "module": "Positive.tla",
  "expected": "pass",
  "execution": { "status": 0, "stdout": "..." },
  "graph": {
    "format": "tlc-dot",
    "file": "Positive.graph.dot",
    "sha256": "<hash>",
    "exploration": "complete"
  }
}
```

The graph path is a regular basename relative to the receipt, never an arbitrary
absolute/parent/URL path. The file lives alongside the receipt when copied from a
CI artifact or an explicitly configured local checker. Diagram I/O verifies its
size/hash and includes it in currentness checks and immutable artifact identity.

With explicit `--capture-graph`, the existing starter adds TLC's
`-dump dot,actionlabels <owned graph path>` to the very same model invocation,
checks a regular bounded output file, and publishes the reference/hash with the
receipt. Successful complete positive runs may record complete exploration;
negative controls or interrupted/incomplete exploration must record partial or
unavailable. Do not remove invariants, rerun with a changed config, instrument
rules, or imply every other state is safe. Capture failure cannot manufacture a
graph; the requested capture must report unavailable explicitly.

The native DOT reader accepts only the TLC output subset needed here: numeric
IDs retained as strings, quoted labels, initial style and labeled directed
edges; harmless graph layout wrappers can be ignored by a narrowly enumerated
grammar. Reject duplicate conflicting nodes/edges, missing endpoints, malformed
escapes and unexpected meaningful statements. No DOT renderer, script, URL or
arbitrary attributes are executed. A full graph is rendered with neutral states;
it records finite checker coverage rather than inventing rule-specific marks.

Without a graph reference, the existing command replays an available valid
counterexample. A passing receipt without exported graph refuses with specific
capture guidance. A .tla model alone cannot supply reachable states without a
checker; there is no Java-free TLA+ evaluator here.

## Implementation tasks and acceptance

1. Add a native pure protocol module with bounded frame scanning, lossless
   value-text states and lasso/stutter extraction. First add failing regressions
   for large integers, nested value text, qualified action labels, repeated
   values, prototype names, CRLF, truncated/duplicate/missing variables, and
   malformed terminal frames. Preserve the current raw saved upstream witness
   as a protocol fixture, with its original notice.
2. Add pure AE graph validation and static Mermaid projection, reusing existing
   receipt bindings, redactor, worker renderer and atomic publication. All
   witnesses retain their steps, roles and temporal behavior. Input limits
   refuse rather than clip; no fresh verification/authority is emitted.
3. Add strict bounded native TLC DOT support and graph-source hash/currentness
   integration. Cases include signed >53-bit node IDs as strings, escaped
   newlines/quotes, multiple initial nodes, self-loops, dangling edges,
   conflicting duplicates, unsupported attributes, partial coverage and
   over-budget graphs. Keep all nodes neutral, with explicit coverage note.
4. Add explicit graph capture to the existing opt-in starter and documentation,
   producing real referenced artifacts from the same configured TLC run. No tool
   acquisition. Test preparation/arguments/classification/publication via a
   boundary seam or deterministic saved protocol; fresh checker qualification
   must remain marked unavailable when no caller-provided JAR exists.
5. Remove the vendor directory and upstream parser imports; update attribution
   to architecture/protocol-test inspiration. Retain copyright/license for any
   retained upstream fixture. Avoid claiming the AE implementation is clean-room.
6. Exercise the actual AE command, native hook admission, renderer and package
   archive offline. Assert no JAR payload, no process/network calls in the pure
   compiler import closure, no dynamic view option, Node 20 compatibility,
   stable immutable output, stale graph/source handling and selected-home use.

## Explicit boundaries

- This fully delivers native retained-evidence diagrams and a real producer path
  for finite explored graphs. It does not promise pstack feature parity.
- Arbitrary TLA+ evaluation without a checker, rule-removal reruns, state marks
  beyond evidence, quotient merging, executable label views, parallel regions
  and unrestricted themes are separate features, not unfinished hidden tasks.
- Receipt hashes provide identity and drift detection, not authentication.
- A complete finite model is not proof of correspondence to all real code;
  implementation conformance remains the existing separate named check.
- Native Windows/IDE behavior and fresh TLC execution must be observed in their
  real environment; saved-fixture and fake-boundary tests cannot establish them.
