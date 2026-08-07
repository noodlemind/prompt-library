# Harness CLI Workbench — Feature Plan

Finalized 2026-07-29. Execution begins after PR #37 (knowledge layer M1–M4) merges. The live execution plan for the current phase is the single dated file under `docs/plans/` (Phase 1: `2026-07-29-harness-cli-phase1-core.md`); this document is the durable contract the phase plans derive from.

## TL;DR

The concrete target is five releases: **CLI modes → knowledge navigation → governed execution → durable runs/TUI → resource and plugin system**.

The new command families are: `search`, `lookup`, `tree`, `checks`, `exec`, `bash`, `run`, `config`, `trust`, `resources`, `plugin`, and `tui`.

## Boundary and invariants

Harness owns deterministic capabilities; the host owns LLM reasoning. Constraints that bind every phase:

- **CLI never calls an LLM.** An LLM host consumes Harness; Harness never consumes a model.
- **Knowledge-layer invariants (settled on PR #37, do not re-litigate):** read paths never create the learnings store; the ops-JSON sole writer is `consolidate --apply`; the store lives at `~/.harness/knowledge/<repo-id>/` (local git, never pushed); promoted learnings are immutable targets in both lanes; human authority derives from on-disk verified evidence and must be at least as recent as any recorded governance decision.
- **Search, lookup, and tree comply with the read-path rule** — navigation never creates or mutates the store.
- **Resources and plugins never write the learnings store, the run journal, or evidence.** Plugins may contribute knowledge *sources*; ingestion still flows through the consolidation loop.
- **Gate (vocabulary):** a gate is the existing plan/verification gate mechanism (`lib/gate.mjs`) that blocks lifecycle transitions until named checks and evidence pass. Later phases expose and record gates; they do not reinvent them.
- **Enforcement classes:** every control in this plan is one of — **enforced** (blocks pre-execution), **detect-and-block** (best-effort detection that halts on trip), or **audit-only** (recorded, never blocks). Each control names its class where it is specified; "governed" always means at least detect-and-block.
- **TUI boundary:** the TUI consumes the kernel in-process through the same command registry as the CLI — one behavior path, no separate implementation, no CLI shell-out requirement. This is the settled answer to the earlier SDK question; the CLI JSON/JSONL contracts serve out-of-process consumers on their program side (CI, hooks, Copilot, Codex) — the model side of any host consumes the agent lane per the output-lanes contract below.
- **Three output lanes, produced at the source:** every command renders its one canonical result as ledger (human), envelope (programs/TUI), and agent (LLM) lanes — deterministically, never via a model pass, and never by converting one lane into another. See "Output lanes" below.

## Output lanes: the three-audience contract

Every workbench-dispatched command renders one canonical result three ways. All three
renderings are deterministic CLI work — never a model pass. No output is ever converted
from one audience's format into another's; each lane is produced at the source.

| Lane | Audience | Format | Contract |
|---|---|---|---|
| Ledger | Human | Styled ledger rows (`lib/style.mjs` conventions: glyph/key/value, truecolor → 256 → ASCII degradation) | What the TUI panes and plain terminal output render |
| Envelope | Programs / TUI | Versioned JSON envelope; JSONL streaming for long-running operations | Summary scalars first, detail arrays after, so one payload serves both a one-line footer and an expanded view. Long operations stream row-per-event with distinct `cancelled` vs `timed-out` terminal outcomes |
| Agent | LLM | Budgeted plain text | Token/byte-capped at the source; injection-hardened; byte-metered |

### Agent-lane requirements

1. **Budgeted at the source.** Every agent rendering carries a hard local cap, following
   the existing harness precedents: 2048-byte context pack, 220-token plan slice,
   bounded `harness get` excerpts (40 lines / 2048 bytes), 1000-token repo map.
   Truncation happens at item boundaries; the reported size never exceeds the budget.
2. **Deterministic.** Produced by the CLI from the canonical result — never by asking a
   model to summarize the envelope. This preserves the system-wide guarantee that
   `orient`/`recall` and every read surface involve no model, network, or embedding call.
3. **Hardened.** Wherever the content is retrieved text (knowledge, search hits, doc
   excerpts), the rendering passes the existing data boundary: data-not-instructions
   preamble framing, `inertLine` neutralization, and secret redaction.
4. **Metered.** Rendered bytes are measured and emitted with the command's event so
   `harness report` token/utilization SLOs account for the agent lane's real cost.

### The consumption rule

Agents consume the agent lane, never the envelope. JSON is token-inefficient and its
arrays are unbounded, so envelope output must never enter model context. The envelope
belongs to the TUI and tooling; the ledger belongs to humans. This is what makes the
dual human/LLM promise real: zero tokens are ever spent translating tool output.

### Boundary with the harness-evolution track

The workbench defines the registry, envelope schema, and run-journal contracts; the
harness evolution blueprint (`knowledge/proposals/harness-evolution-blueprint.md`, §9)
commits its new surfaces (`knowledge status/promote/prune`, `index --structural`, the
structural query) to being conforming citizens of them — registry-dispatchable,
envelope-emitting, streaming-capable, and shipping an agent rendering per this contract.

## Final command surface

### Knowledge and workspace navigation

```text
harness index [--status]
harness search <query>
harness lookup <kind> <identifier>
harness tree <workspace|knowledge|run|resources>
harness get --docid <id> | --path <path>
harness orient --query <task>
```

#### `search`

```text
harness search "lease fencing" \
  --scope code,knowledge,plans \
  --match ranked \
  --explain
```

Features:

- Scopes:
  - `code`
  - `knowledge`
  - `learnings`
  - `plans`
  - `skills`
  - `checks`
  - `events`
  - `runs`
  - `all`
- Match modes:
  - `ranked`: BM25/knowledge ranking
  - `literal`: exact content search
  - `regex`: regex content search
  - `path`: file/path discovery
  - `symbol`: indexed symbol search
- Filters:
  - path/glob
  - collection
  - result type
  - minimum score
  - limit
- Pagination cursor
- Snapshot-specific search
- Retrieval explanation
- Explicit partial-result handling
- Source, freshness, score and provenance in every result
- Empty search returns success with zero results

This command incorporates ranked search, grep-like content search, find-like path search, and symbol lookup without creating separate public commands for each tool.

Federation semantics (`--scope` with multiple sources or `all`) are deterministic: per-source scores are normalized before merging; result identity for dedup is (source, entity id); ordering ties break stably by (score, source, id); cursors remain valid across sources; a failed source is reported explicitly in the result envelope, never silently dropped.

#### `lookup`

```text
harness lookup <kind> <identifier>
```

Supported kinds:

```text
file | symbol | document | plan | skill | check | run | event | resource | learning | episode
```

Features:

- Exact entity retrieval
- Metadata and source provenance
- Bounded content preview
- Related entities
- Current index generation
- Structured not-found error

`get` remains the document/file compatibility command; `lookup` handles the broader entity model. `lookup learning` and `lookup episode` are read-only views over the knowledge store and respect the read-path invariant.

#### `tree`

```text
harness tree workspace [path] --depth 3
harness tree knowledge [collection]
harness tree run <run-id>
harness tree resources
```

Features:

- Workspace hierarchy respecting ignore rules
- Knowledge collections, documents, and the learnings store (episodes → learnings → primitives, with provenance and governance state)
- Run lifecycle and evidence hierarchy
- Resource origin and override hierarchy
- Depth, type and path filters
- Human, JSON and TUI rendering

`tree` is the single navigation verb: `harness tree resources` is canonical, and the resources family does not carry a duplicate `resources tree` subcommand.

### Checks and execution

```text
harness checks list
harness checks show <name>
harness checks run <name>

harness exec [options] -- <program> <args...>
harness bash [options] -- <script>
harness verify --plan <path>
```

#### `checks`

Features:

- List configured named checks
- Inspect command, timeout, network and evidence policy
- Run one named check directly
- Stream output
- Cancel execution
- Show previous result and duration
- Record diagnostic results

Only `verify` binds check results to a plan and produces completion evidence.

#### `exec`

```text
harness exec \
  --cwd packages/harness \
  --timeout 120s \
  --network deny \
  -- npm test
```

Features:

- Safe argv execution without shell interpretation
- Working-directory containment (enforced)
- Configurable timeout (enforced)
- Environment allowlist (enforced)
- Network policy (enforced via the isolation backend; degrades to detect-and-block where the platform lacks isolation primitives, and the degradation is recorded in the audit event)
- Streaming stdout/stderr
- Ctrl-C cancellation
- Descendant-process termination
- Redacted terminal output (enforced)
- Full-output artifact when output is truncated
- Execution identity and audit event (audit-only)
- Side-effect classification

#### `bash`

```text
harness bash \
  --cwd packages/harness \
  --timeout 60s \
  --network deny \
  -- "git status --short"
```

Features:

- Explicit shell interpretation
- Same containment, redaction, timeout, cancellation and audit controls as `exec`
- Clearly identified as shell execution in events and evidence
- Policy can separately allow or deny Bash (enforced)

The isolation backend defines per-platform behavior explicitly — which shell `bash` resolves to on Windows hosts and how descendant-process termination is implemented there — since the primary consumption platforms are Windows-based.

### Runs and evidence

```text
harness run list
harness run show <run-id>
harness run resume <run-id>
harness run tree <run-id>

harness events [filters]
harness report [filters]
```

Features:

- Stable run IDs
- Append-only run journal
- Command start/progress/result entries
- Plan and gate entries
- Execution and mutation entries
- Verification and evidence entries
- Cancellation and timeout entries
- Run status:
  - running
  - succeeded
  - failed
  - inconclusive
  - blocked
  - cancelled
  - timed out
- Resume from an explicitly safe boundary
- No automatic replay of interrupted commands
- Evidence freshness against repository and plan digests
- Query runs by status, command, host, plan and date
- Redacted output and configurable retention

### Configuration and trust

```text
harness config show [--effective]
harness config get <key>
harness config set <key> <value> --scope user|project
harness config validate

harness trust status
harness trust approve
harness trust revoke
```

Features:

- User and project configuration
- Effective-value display with source provenance
- Schema validation
- Atomic configuration updates
- Project identity and trust status
- Explicit trust approval and revocation
- Project resources and execution policies load only after trust (enforced)
- Trust changes recorded in events

### Resource management

```text
harness resources list
harness resources show <resource-id>
harness resources add <bundle>
harness resources update <bundle>
harness resources enable <resource-id>
harness resources disable <resource-id>
harness resources remove <bundle>
harness resources reload
```

Supported resource types:

```text
skill | prompt | instruction | check | policy | preset | theme
```

Features:

- Bundle manifests
- Local, project and configured sources
- Resource provenance
- Deterministic precedence
- Version and integrity pinning
- Capability declarations
- Explicit trust
- Enable/disable controls
- Recoverable updates
- Reload without reinstalling Harness
- Resource visibility from CLI and TUI (`harness tree resources`)

Resource management **extends the existing hydration machinery** (`harness install`/`harness upgrade`, `retired.json` retirement) rather than introducing a parallel mechanism: bundles are the packaging and trust layer on top of the same discovery, precedence, and retirement pipeline.

### Plugin management

```text
harness plugin list
harness plugin show <plugin>
harness plugin add <source>
harness plugin enable <plugin>
harness plugin disable <plugin>
harness plugin update <plugin>
harness plugin remove <plugin>
```

Plugin contributions:

- Commands
- Search scopes
- Knowledge sources
- Named checks
- Policies
- Event handlers
- Output renderers
- TUI panels
- Provider and host adapters

Plugin controls:

- Out-of-process JSON/JSONL protocol
- Protocol version negotiation
- Manifest-declared capabilities
- Explicit capability approval
- Network and environment policy
- Timeout and cancellation
- Crash isolation
- Redacted communication
- No direct policy, journal, evidence, or learnings-store mutation (contributed knowledge sources flow through the consolidation loop)

### Interactive TUI

```text
harness tui
```

Primary views:

1. **Overview**
   - Workspace
   - Harness health
   - Current plan
   - Gate status
   - Active run
   - Required next action

2. **Search**
   - Query editor
   - Scope and match-mode selectors
   - Ranked results
   - File/document preview
   - Retrieval explanation
   - Knowledge and workspace trees

3. **Plans**
   - Active plans
   - Plan readiness
   - Impacted files
   - Acceptance criteria
   - Named checks
   - Gate and verification state

4. **Checks**
   - Available named checks
   - Run check
   - Streaming output
   - Duration and previous result
   - Cancel current check

5. **Runs**
   - Run history
   - Status filters
   - Run tree
   - Commands, evidence and failures
   - Resume safe interrupted work

6. **Events**
   - Live lifecycle events
   - Failures and blocks
   - Host and actor filters
   - Cancellation and timeout events

7. **Resources**
   - Loaded skills, prompts, checks and policies
   - Provenance and precedence
   - Enable/disable/reload actions

### Command palette

The palette is a **searchable index over the command registry**, not a second command grammar. It is the TUI's only command-entry surface.

**The CLI grammar does not change to accommodate it.** Every flag the CLI accepts today it still accepts; nothing is removed, renamed, or deprecated. The model invokes `harness <command> --flags` through the agent lane and never sees the palette; a person in a shell keeps `--help` and shell completion. The palette exists because the TUI is the one surface with neither.

**No `--` is ever typed in the TUI.** The index contains options so a capability can be *found*; it must never require one to be *written*. The palette presents **noun + verb**, and the registry maps the verb onto the argv the CLI already accepts:

```text
index structural      →  harness index --structural
index status          →  harness index --status
learnings why         →  harness learnings --why <id>
knowledge promote     →  harness knowledge promote --branch <key>
```

The left column is the TUI's entire vocabulary. The resolved argv is echoed into the ledger after the run, so the surface stays auditable and the shell form is learned by observation rather than by being typed.

Contract:

- **One flat namespace.** Commands, their verbs, and skills are sibling entries — reaching a capability never requires knowing its parent. `structural` resolves without the user knowing it lives under `index`.
- **Skills are namespaced with `:`.** `/consolidate` is the deterministic command; `/skill:consolidate` is the workflow that calls it. The command owns the bare name; the qualified form is the escape hatch.
- **Ranking is word-boundary weighted**, not substring. Exact match preselects; declared aliases outrank prefix matches.
- **Values come from pickers.** A verb needing a value opens a chooser populated from live state (branch keys, learning ids, plan paths) — never a typed flag.
- **Dependent options are refinements, not entries.** An option valid only alongside another (`--since` requires `--structural`) attaches to its parent verb and is offered after selection, never listed independently.
- **Every row carries its side-effect class** — `read`, `mutate`, `execute` — so the consequence of a command is visible before it runs. This is possible because the registry already declares it per command.
- **Availability is explained, not hidden.** A command that cannot currently run stays listed and greyed, carrying its reason (`no plan under docs/plans/`).
- **Entry points:** `/` at line start, plus a configurable chord defaulting to `Ctrl-P` (`Cmd-K` aliased on macOS). `Ctrl-K` is reserved for readline's kill-to-line-end.
- **Composer sigils:** `!` runs a shell command and puts its output in context, `!!` runs it privately, `@` completes file paths. No other sigil dispatches.

Common TUI features:

- Multiline editor
- Keyboard navigation
- Configurable shortcuts
- Streaming process output
- Cancellation
- Bounded previews
- Human-readable next actions
- Existing `ok`, `warn`, `error`, `active`, `blocked`, and `cancelled` visual states rendered through `lib/style.mjs` (the design-system total-coverage rule applies to the TUI)
- ASCII fallback for limited terminals

## Implementation sequence

Prerequisite: PR #37 merges first. Phase 1 begins from the post-merge `main` so the registry migration covers the M1–M4 knowledge commands (`remember`, `learnings`, `learning …`, `consolidate`, `knowledge`, `eval-knowledge`) in one pass instead of racing them.

## Phase 1 — CLI core and modes

Implement:

- Central command registry
- Strict argument parser
- Human output mode
- Versioned JSON result mode
- Versioned JSONL streaming mode
- Agent-lane renderer: budgeted, hardened, metered plain-text rendering per command (see "Output lanes")
- Unified error and status model, including distinct `cancelled` and `timed out` terminal outcomes with stable exit codes
- Central event registry
- Secret redaction
- Async process runner
- Timeout and cancellation
- Actor and execution metadata
- Migrate all existing commands to the new command registry — including the M1–M4 knowledge commands; `.github/skills/references/harness-tool-contract.md` and the existing JSON shapes are the compatibility fixtures

Done when every current command supports consistent ledger, envelope, and agent output, and `verify` can stream and cancel.

## Phase 2 — Knowledge operator

Implement:

- `search`
- `lookup` (including `learning` and `episode` kinds)
- `tree workspace`
- `tree knowledge` (collections, documents, learnings store)
- Enhanced `get`
- Enhanced `orient`
- Content-addressed indexes
- Search snapshots
- Ranked/literal/regex/path/symbol modes
- Multi-source federation with the deterministic merge semantics above
- Pagination and filters
- Retrieval explanations
- `recall` compatibility migration
- Surface deferred M4 polish where it naturally lands (e.g., quarantined-learnings visibility in search/tree results)

Done when code, knowledge, learnings and plans can be searched, exactly retrieved and structurally navigated through the CLI.

## Phase 3 — Governed execution and control

Implement:

- `checks list/show/run`
- `exec`
- `bash`
- Streaming `verify`
- Configuration commands
- Project trust commands
- Environment allowlisting
- Network policy
- Isolation backend (with explicit per-platform behavior, Windows included)
- Redacted output artifacts
- Host hook enforcement
- CI completion enforcement
- Per-command-family authorization: which actors (user, CI, hook, LLM host, plugin) may invoke each family, recorded in policy
- Cross-host validation through Copilot CLI and Codex CLI

Done when hosts and users can execute commands through Harness with consistent policy, cancellation, evidence and audit behavior.

## Phase 4 — Durable runs and TUI

Two release boundaries inside one phase:

**4a — Durable runs (ships first):**

1. Append-only run journal
2. `run list/show/resume/tree`
3. Evidence and event queries
4. Safe interruption recovery

**4b — TUI:**

5. TUI shell and command palette
6. Search, plans and checks views
7. Streaming execution and cancellation
8. Runs, events and evidence views
9. Resource inspection view

Done when the TUI can perform the same search, lifecycle and execution operations as the CLI without implementing a separate behavior path.

## Phase 5 — Resources and plugins

Implement:

- Resource manifests and bundles, extending the existing hydration/retirement machinery
- Resource list/show/add/update/enable/disable/remove/reload and `tree resources`
- Trust and integrity validation
- Out-of-process plugin protocol
- Plugin lifecycle commands
- Extension commands, search sources, checks and policies
- Extension TUI panels
- Provider and host adapters through the plugin protocol

Done when an external plugin can add one command, one search scope, one named check, and one TUI panel without modifying Harness core.
