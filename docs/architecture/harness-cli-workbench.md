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
- **Three output lanes, produced at the source:** every command renders its one canonical result as ledger (human), envelope (programs/TUI), and agent (LLM) lanes — deterministically, never via a model pass, and never by converting one lane into another. This is the target every command converges on, not a capability that already exists everywhere: Phase 1 shipped the lanes on `orient`, `learnings`, and `status` (plus JSONL streaming on `verify`), and every other command rejects `--output` with a structured `E_USAGE` error rather than degrading to ledger text. See "Output lanes" below.

## Output lanes: the three-audience contract

Every workbench-dispatched command renders one canonical result three ways. All three
renderings are deterministic CLI work — never a model pass. No output is ever converted
from one audience's format into another's; each lane is produced at the source. The table
below is the contract a command must satisfy once it produces a canonical result; a
command joins the contract when it gains a `resultOf` producer.

| Lane | Audience | Format | Contract |
|---|---|---|---|
| Ledger | Human | Styled ledger rows (`lib/style.mjs` conventions: glyph/key/value, truecolor → 256 → ASCII degradation) | What the TUI panes and plain terminal output render |
| Envelope | Programs / TUI | Versioned JSON envelope; JSONL streaming for long-running operations | Summary scalars first, detail arrays after, so one payload serves both a one-line footer and an expanded view. Long operations stream row-per-event with distinct `cancelled` vs `timed-out` terminal outcomes |
| Agent | LLM | Budgeted plain text | Token/byte-capped at the source; injection-hardened; byte-metered |

**Delivered scope as of Phase 1.** `orient`, `learnings`, and `status` produce all three
lanes; `verify` produces the ledger lane plus JSONL streaming (no `json-envelope`/`agent`
of its own). Every other registered command has no `resultOf` producer yet and rejects
`--output` with a structured `E_USAGE` error, so an unsupported lane fails loudly instead
of quietly returning ledger text. Expanding `resultOf` to the remaining commands is Phase 2
work — see the debt table and Phase 2 AC7 in `harness-cli-workbench-delivery.md`.

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
harness get --docid <id> | --path <path> [--offset <n>] [--lines <n>]
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

### Agent tools

The turn loop's tools are these same commands. `dispatchToolCall` maps each one
onto a command argv, so a tool inherits the audit event, the run journal, the
environment allowlist and the side-effect class of the command it maps to, and
no capability reaches the model that an operator cannot also reach.

```text
search  →  harness search      find a path before reading it
read    →  harness get         a window of a file, plus its sha256
edit    →  harness edit        one exact, unique replacement
write   →  harness write       create, or replace what you can prove
bash    →  harness bash        a shell line
exec    →  harness exec        one program, no shell
```

`undo` is deliberately **not** a tool. It is the operator's recourse when the
agent got it wrong, and a model able to reverse its own last change can also
quietly reverse one it was asked to keep.

`search` is listed first because it is the one that makes `read` usable: given
`read` and no way to find a path, a model guesses filenames. A read-only
question spent eight turns and 143k tokens on `read` calls for files that did
not exist; with `search` it answered correctly in three turns and 10k tokens.

### File mutation

```text
harness edit  --path <rel> --old <text> --new <text>
harness write --path <rel> --content <text> [--expect <sha256>]
harness undo
```

`get` reads, `edit` and `write` change, `exec` and `bash` run. Those five are
the whole set of ways the harness touches a working tree, and they are declared
in escalating order of consequence — `read`, then `mutate`, then `execute`.

These are commands, not agent-only capabilities, and that is the point. The
agent loop maps each of its tools onto a command argv, so `edit` and `write`
reach the model through the same code an operator runs from the CLI or picks
from the palette. There is one write path and `controls` sees all of it.

#### `edit`

Features:

- Exact-string replacement, never a regex or a line number
- The match must be **unique** — zero or several occurrences refuse, and nothing
  is written (enforced)
- Read-before-edit enforced structurally: a unique `--old` cannot be produced
  without having read the file
- Workspace containment, symlink-refusing, on every path (enforced)
- Per-file exclusive lock across the read-verify-write (enforced)
- Refuses files containing NUL bytes rather than corrupting them
- Audit event carrying the path, the outcome and the digests either side — never
  the content
- Undo entry recorded before the change lands

#### `write`

```text
harness write --path notes/new.md --content "first line"
harness write --path README.md --content "..." --expect 9f86d081884c
```

Features:

- Creating a new file requires nothing beyond the content
- Replacing an existing file requires `--expect`, the digest of the content being
  replaced (enforced) — a compare-and-swap, so a concurrent modification is
  caught rather than silently overwritten
- `harness get --json` reports the `sha256` that `--expect` consumes
- Same containment, locking, audit and undo controls as `edit`

#### `undo`

Features:

- Restores what the most recent `edit` or `write` replaced, or removes a file
  that a `write` created
- Refuses when the file has changed since — an undo over someone else's later
  work is a second unreviewed write, not an undo
- Not itself pushed onto the stack, so running it twice reverses two mutations
  rather than toggling one
- **Not offered to the agent.** It is the operator's recourse when the agent got
  it wrong; a model able to reverse its own last change can also quietly reverse
  one it was asked to keep.

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
  - timed-out
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

### Interactive TUI — the Session Ledger

```text
harness tui
```

**The design of record lives in this document, not outside it.** The approved
mock and the research round behind it (`approved.json`, `research.md`, the
`harness-tui-*` design board) settled the form; phase 4b shipped a four-sided
box anyway, because the repository's own pointer to that direction was one glob
in a delivery doc and nobody opened it. What follows is the direction itself, in
enough detail to build from — a prose paraphrase somewhere else is not a
substitute, and neither is a link.

#### The shape

A flowing transcript in the terminal's **main buffer**. Persistent chrome is
three rows and no more:

```text
● ~/repo · main @ 9f2c1e4 · harness 2.0.0        plan phase1-core.md · gate ■ blocked · run —
                                                            ← header, printed ONCE into scrollback

▌ ❯ checks run build-assets                                 ← a block: command, verbatim
▌   failed · exit 6 · 0m12s · actor you · 14:07:03          ← the journal record, made visible
▌   ✗ E_ASSET_BUILD                                         ← output, folded past a threshold
▌     asset manifest references a retired skill wrapper
▌   … 7 more lines (ctrl+o)
▌   1 err → exit 6 → patch fix-manifest.patch               ← tally, and the one action that follows

────────────────────────────────────────────────────────────  ← hairline, tinted by GATE STATE
❯ compound --insight "windows taskkill needs its own probe"
────────────────────────────────────────────────────────────  ← hairline
  deliver · gate ✓ ok · shell allowed · !! re-runs verify · ↵ run · esc interrupt
  plan phase1-core ● locked · gate ✓ · run 9a12f4 ✓            930 tests · 34 learnings · gen 8c31f0
```

- **Two hairlines, not a box.** The editor is a rule above, a rule below, and
  the text flush between them. Four dashboard-styled variants were rejected
  before the research round that produced this; panel and tab chrome in a
  terminal is the thing being avoided, and a bordered composer is that thing.
- **The hairlines carry the gate state** as colour — the one adaptation taken
  from Pi, whose editor border carries thinking level. An unknown gate is muted,
  never green: an unverified gate is not a passing one.
- **The header is printed once**, into scrollback. A bar pinned to the viewport
  needs the alternate screen, and the alternate screen costs scrollback,
  selection and the terminal's own search.
- **The hint row is consequence context** (from Cursor CLI): mode, gate posture,
  whether the shell is allowed, and what `!!` would repeat — stated where Enter
  is pressed. Under pressure it drops the keys before the posture, because keys
  are learned once and the posture changes under you.
- **The footer is two columns**: workspace and branch first — outside the
  configurable item list, because they decide which repository every block
  above acted on — then lifecycle; scale on the right. Clipping drops the
  right column whole, then lifecycle from the right; the workspace is the
  last thing standing.

#### A block is a record, not a rendering

Each block stores command, status, exit code, duration, actor and time. The run
journal (§Runs and evidence) is its storage: the ledger opens a run before
dispatch and closes it after, exactly as `bin/harness.mjs` does, so work done in
the TUI appears in `run list` and `run tree` like any other. Tint, fold, mark,
re-run and restore are views over that one structure.

- **What persists is the record, never the transcript.** A restored block
  carries its record line and no output — the same line `harness agent` holds,
  for the same reason: a transcript is where a pasted credential ends up, and
  the journal is durable. Output is what a re-run regenerates.
- **Status is encoded four times** — tint, painted stripe, glyph, and the status
  word in plain text — because each channel dies in a different terminal. The
  design asks for two; the rest are free once the record exists.
- **Tints are pre-composited** for a dark or light ground (`tui.tint`), degrade
  to greyscale separation at 256 colours, and vanish at the contrast floor. They
  never carry meaning alone.

#### Views dissolve into commands

There are no screens. `runs` prints the run table, `plan show` renders the plan
inline, `resources` prints what is loaded — each as a block in the flow. What
would have been seven views is seven commands that already exist, which is what
makes "one kernel, one behaviour path" literal rather than aspirational.

Pickers are **ephemeral overlays** that replace the editor and vanish; you never
live inside one. Overlays are the one place the ledger draws a border, because a
bordered box is fine as a gesture and wrong as furniture.

#### Verbs interactively, flags for machines

A person types `search lease fencing`; a script or an LLM host passes
`harness search "lease fencing" --scope code --output json-envelope`. Both reach
the same registry entry. Defaults live in policy and configuration, never in
anyone's fingers, and every flag stays available non-interactively.

#### Sigils

| typed | means | governed as |
|---|---|---|
| `!npm test` | run through the shell | explicit shell — separately policy-gated, recorded, redacted |
| `!!` | re-run the previous block | replays that record, appends a new one — never edits history |
| `!! 5e08c7` | re-run any block by id | same command, same cwd, fresh record |
| `/` , `/text` | open or filter the palette | registry dispatch, same as the CLI |
| `@path` | complete a workspace path | fuzzy find, read-only, workspace-confined |

`!!` means **re-run**, not "run privately". Pi's reading — run without telling
the model — is meaningless here, because the harness never talks to one; the
shell's own meaning is the useful one, and blocks-as-records make it exact.

#### Keyboard

| tier | keys |
|---|---|
| typing | `↵` run · `shift+↵` newline · `!` shell · `!!` re-run · `@` file · `/` palette — the sigil opens it **immediately** on an empty line and filters live from the next keystroke; no Enter, no numbered list |
| navigating | `ctrl+↑` leaves the editor, then `↑↓` walk blocks, `↵` inspects |
| block | `ctrl+o` fold · `y` copy · `m` mark (persists) · `r` re-run · `t` run tree |
| overlay | `ctrl+p` palette (`cmd+k` aliased; `ctrl+k` when the line is empty) · `esc esc` run tree · `esc` closes |
| session | `esc` interrupt · `q` quit from block navigation, printing the tally and resume line |

`ctrl+p` rather than the mock's `ctrl+k`: `ctrl+k` is readline's
kill-to-end-of-line and taking it costs a reflex every shell user has. It still
opens the palette when there is nothing to kill, and the chord is configurable.

Block navigation happens **in an overlay** rather than in place. In the main
buffer a block that has scrolled past the top of the viewport cannot be
highlighted where it sits, and redrawing it lower would duplicate it in
scrollback; walking in an ephemeral overlay is the design's own rule for every
other picker.

#### Command palette

The palette is a **searchable index over the command registry**, not a second
command grammar. It is the TUI's only command-entry surface.

**The CLI grammar does not change to accommodate it.** Every flag the CLI
accepts today it still accepts; nothing is removed, renamed, or deprecated. The
model invokes `harness <command> --flags` through the agent lane and never sees
the palette; a person in a shell keeps `--help` and shell completion. The
palette exists because the TUI is the one surface with neither.

**Typing a row is choosing it.** A line that names a command the palette offers
but does not supply its values opens the same value queue that choosing the row
opens, carrying whatever was already typed:

```text
config set                 →  key picker, then value, then scope
config set tui.scheme      →  value picker (the key is already answered)
model set                  →  the model picker
edit                       →  path, then old, then new
```

Before this, the two paths disagreed: `config set` chosen from the palette asked
for its three values, while `config set` typed printed
`E_USAGE: config set requires a key`. The registry knew what was missing on both
paths; only one of them asked. **No palette row may dead-end when typed** —
`packages/harness/test/typed-line.test.mjs` walks every row in the index and
fails if one does.

Only a *missing value* routes. An unknown flag, a value the registry states
outright and the operator got wrong, more words than the command has places for,
and anything after `--` all still produce the usage error they should: the
operator asserted something specific, and a picker over the top would hide the
mistake rather than correct it.

**No `--` is ever typed in the TUI.** The index contains options so a capability
can be *found*; it must never require one to be *written*. The palette presents
**noun + verb**, and the registry maps the verb onto the argv the CLI already
accepts:

```text
index structural      →  harness index --structural
index status          →  harness index --status
learnings why         →  harness learnings --why <id>
knowledge promote     →  harness knowledge promote --branch <key>
```

The left column is the TUI's entire vocabulary. The resolved argv is echoed into
the ledger as the block's own command row, so the surface stays auditable and
the shell form is learned by observation rather than by being typed.

Contract:

- **One flat namespace.** Commands, their verbs, and skills are sibling entries —
  reaching a capability never requires knowing its parent. `structural` resolves
  without the user knowing it lives under `index`.
- **Skills are namespaced with `:`.** `/consolidate` is the deterministic
  command; `/skill:consolidate` is the workflow that calls it.
- **Ranking is word-boundary weighted**, not substring. Exact match preselects;
  declared aliases outrank prefix matches.
- **Values come from pickers.** A verb needing a value opens a chooser populated
  from live state (branch keys, learning ids, plan paths) — never a typed flag.
  The registry declares the KIND of value a slot wants (`choices: 'provider'`, or
  a literal set); `lib/tui/values.mjs` knows how to enumerate that kind, because
  registration is pure data and enumerating needs the workspace and environment.
  A later question may be answered in terms of an earlier one — the model list is
  the chosen provider's. Typing is never taken away: every list filters as you
  type, an open source (a path, a model id) accepts an answer that is not on it,
  and a source that cannot enumerate degrades to the free-text prompt rather than
  to a dead end.
- **A command whose TUI form is a chooser contributes ONE row** (`tuiPicker`).
  `model` is one gesture, not four: showing is what the picker does on open,
  setting is what choosing does, clearing is a row inside it. The CLI keeps every
  verb, where scripting needs them.
- **Only a connected provider offers models.** The order is: enable agent mode
  (`agent.enabled`, off by default — everything else in the harness runs without a
  provider), connect a provider, then choose among the models it serves. A model
  list is a property of the provider serving it, so offering one earlier is
  offering a guess. Providers you have not connected collapse to a single line.
- **Results are things you open.** A command states what it found as data
  (`ctx.reportSelection`), never as lines to be parsed back; the block says how
  many can be opened, and `results` — or `o` in the block navigator — opens a
  chooser over them. A retrieval surface that can find a file and not open it has
  done the hard half and stopped.
- **Dependent options are refinements, not entries.**
- **Every row carries its side-effect class** — `read`, `mutate`, `execute` — so
  the consequence of a command is visible before it runs. It is the last thing a
  narrow row gives up; the note is clipped first.
- **Availability is explained, not hidden.** A command that cannot currently run
  stays listed, greyed, and selectable, carrying its reason (`no plan under
  docs/plans/`). Navigation does not skip past it, because the reason is the
  part that teaches.
- **Typed prefixes narrow the same flat index** — `run:`, `plan:`, `search:`,
  `check:`, `res:`, `learn:` — a way to say less, never a way to reach something
  otherwise unreachable.
- **Filtering happens inside the overlay**, so a keystroke costs a repaint rather
  than a round trip.

#### Settings, not opinions

The things people argue about are configurable (§Configuration and trust). All
merge by plain precedence — they are taste and accessibility, never authority.

| key | default | what it decides |
|---|---|---|
| `tui.density` | `comfortable` | blank line between blocks — the mock's own inter-block gap; `compact` is the zero-gap opt-in |
| `tui.dividers` | `false` | a rule between blocks instead of relying on the tint |
| `tui.statusline` | `plan, gate, run, knowledge` | footer items, **in order** |
| `tui.tint` | `auto` | tint ground: auto-detect, force dark/light, or `off` |
| `tui.palette_chord` | `ctrl+p` | the chord that opens the palette |
| `tui.startup` | `context, knowledge, shortcuts` | what the ledger shows on open |
| `tui.verbosity` | `normal` | `screen-reader` drops the repainting region and the tints |
| `tui.alt_screen` | `false` | render in the alternate screen (costs scrollback) |
| `tui.restore` | `8` | prior runs restored from the journal on open |

`tui.statusline` keeps the order it was written in; every other list key is a
set and is normalised. The order *is* the setting.

#### Accessibility

Both gaps the design named as "must be specified, not discovered later" have
answers:

- **Screen-reader verbosity** is `tui.verbosity=screen-reader`. A region that
  repaints on every streamed line is announced on every streamed line, so that
  mode drops the live region entirely, drops the tints, and states each block's
  status in words — which the record line already does.
- **A contrast floor** is `tui.tint=off`. Nothing is painted over the operator's
  own background, and block state falls back to the stripe, the glyph and the
  status word — three channels that never depended on the tint.

Status never depends on colour alone at any setting.

#### Common TUI features

- Multiline editor, with display-cell measurement (grapheme clusters and East
  Asian width), so CJK and emoji neither overflow a rule nor split
- Keyboard navigation and configurable shortcuts
- Streaming process output into the running block, with a sticky header naming
  the command and how to stop it
- Cancellation from the keyboard during a run — `esc` or `ctrl+c` — which the
  sticky header promises and raw mode would otherwise swallow
- Bounded previews and folding
- Human-readable next actions
- Existing `ok`, `warn`, `error`, `active`, `blocked`, and `cancelled` visual
  states rendered through `lib/style.mjs`; no TUI-private palette exists
- ASCII fallback for limited terminals
- Every repaint delivered as one frame via synchronized output (CSI ?2026),
  so a keystroke never shows the region half-erased; terminals without the
  extension ignore it. Rendering smoothness is a converged feature of the
  field, not a nicety
- A stripe means exactly one thing — a record of something that ran. Messages
  (help, prompts, refusals) are plain ledger rows; blocks are separated by one
  row of untinted ground so consecutive same-state blocks stay distinct; a
  success ends on its own output and only failures and folds carry a tally

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
- Unified error and status model, including distinct `cancelled` and `timed-out` terminal outcomes with stable exit codes
- Central event registry
- Secret redaction
- Async process runner
- Timeout and cancellation
- Actor and execution metadata
- Migrate all existing commands to the new command registry — including the M1–M4 knowledge commands; `.github/skills/references/harness-tool-contract.md` and the existing JSON shapes are the compatibility fixtures

Done when every current command dispatches through the registry with one canonical error and status model; `orient`, `learnings`, and `status` support ledger, envelope, and agent output; `verify` supports ledger plus JSONL streaming (not `json-envelope` or agent output); every other command rejects `--output` with a structured `E_USAGE` error; and `verify` can stream and cancel. Extending the lanes to the remaining commands is Phase 2 work, tracked as the AC3 lane-scope amendment in the delivery plan's debt table.

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

### Delivered scope, and the two decisions that changed it (2026-08-09)

**Third-party executable extensions are declined.** The "done when" above is
not the shipped contract. Plugin lifecycle commands, extension commands, search
sources, policies and TUI panels are NOT built and are not planned: the wanted
capability was "get a skill or an agent in front of every host", and that has
two routes that need no executable extension.

- **Unmanaged** — copy the file into `~/.copilot` by hand. Discovered,
  validated and explicitly registered (`resources list|show|register|
  unregister`). Never in the harness lock, so `upgrade` and `uninstall` leave
  it alone.
- **Managed** — install a bundle. `resources add|update|remove|bundles`, placed
  on every `install`/`upgrade` and withdrawn exactly when the bundle is
  disabled or removed, with provenance, precedence and integrity pinning.

Two rules the placement layer enforces, stated because they are permissions
decisions rather than mechanics. **The package always wins:** a bundle
contributing a path the harness itself ships is refused, not layered over —
replacing `skills/engineer/SKILL.md` would let an installed extension silently
redefine the harness's own behavior, which is a much larger permission than
"add a skill". **Installing is not approving:** `resources add` strips any
`.enabled` marker a bundle shipped with, so nothing arrives pre-approved.

**The plugin protocol is wired for exactly one first-party caller.** The
"Provider and host adapters through the plugin protocol" line above reserved
this seam before there was anything to put in it, and that is where the model
call now lives: `lib/provider.mjs` starts an adapter process that holds the
credential and returns data. Out-of-process placement is what keeps the settled
invariant — *CLI never calls an LLM; Harness never consumes a model* —
literally true rather than reinterpreted, since core links no SDK and reads no
key.

This does not reopen the third-party door. A bundle cannot start a plugin, no
operator command starts a plugin, there is no registration path, and the
sanctioned-caller list is exported as data so `test/provider-seam.test.mjs`
asserts the count rather than trusting the comment. A bundle manifest may still
carry a `plugin:` field; nothing reads it.

**Adapters stream.** Every completion is requested with `stream: true`, parsed
as it arrives, and each content delta crosses the plugin protocol as a `chunk`
message — the multi-part response the protocol always defined, now live end to
end. Streaming is the timeout mechanism, not a nicety: a socket-inactivity
timer on a buffered response silently becomes a cap on generation time, because
no byte arrives until the completion is finished. Streamed, the same timer
means what it says. Retries happen only before the first byte — a
partially-consumed completion is not idempotent — and a gateway that ignores
`stream: true` and answers with a single JSON body is still accepted.

**The Copilot catalogue is verified by call, and refresh spends money saying
so.** `harness model refresh github-copilot` filters the provider's `/models`
answer by metadata, then sends each surviving candidate one `max_tokens: 1`
completion — billed to the operator's account — and lists only what answered;
the output reports `verified N of M candidates by live probe`. Metadata alone
was measured wrong in both directions on a real account. The refresh also asks
the VS Code update API what client version is current and caches the answer
beside the catalogue: the Copilot API enforces a minimum client version, so the
adapter's declared identity is resolved at runtime (operator override, the
installed editor, the cached update-API answer — newest wins) with its
constants as an explicitly stale floor.

**The Copilot credential is a ladder, not a variable.** The seam normalizes
whatever the operator exported into harness-authored variables, and the
adapter's zero-setup fallback is the editor's own credential store on disk
(`~/.config/github-copilot/`). The deny-all child environment governs what the
adapter *inherits*; the documented disk fallback is how a machine that never
exported anything still works, and it is a path the seam names, not a key. The
exchanged bearer also names the account's own API endpoint (`proxy-ep=…` inside
the token — how Individual, Business and Enterprise plans route differently),
and the adapter prefers it over the generic host; an explicit
`HARNESS_PROVIDER_BASE_URL` still wins.

**One wire format per adapter, today.** Copilot's `/models` advertises some
models on other wire surfaces (`/v1/messages`, `/responses`); a second wire
would be a second adapter behind the same seam, selected per model family. It
is deliberately deferred: probed on a live account, the alternate wires
unlocked nothing the chat/completions wire refused — the entitlement gap is
server-side, not a routing problem.

**The seam's defaults are spelled once, and its knobs actually cross.** The
default provider is one constant (`DEFAULT_PROVIDER` in `lib/provider.mjs`)
that the config schema, the registry declaration and the command surface all
read — it was once spelled in five places, two of which said `anthropic` while
the runtime resolved `github-copilot`. An unset or `auto` model resolves
through the **fetched catalogue** before the static table, so a refreshed
account is answered from its own list rather than a guess. The adapter
environment stays deny-all, with named passthroughs: the tuning variables
(`HARNESS_PROVIDER_REQUEST_TIMEOUT_MS`, `HARNESS_PROVIDER_RETRIES`,
`HARNESS_PROVIDER_RETRY_BASE_MS`), the proxy contract (`HTTPS_PROXY` /
`HTTP_PROXY` / `NO_PROXY`, honoured by CONNECT tunnelling in the adapters),
and for Copilot a `GITHUB_COPILOT_EXCHANGE_URL` override so a GHE or
data-residency account can exchange its OAuth grant against its own host. The
turn budgets are configuration (`agent.max_turns`, `agent.max_seconds` —
restrictive by minimum, flag still wins), and `model clear` removes the keys
rather than pinning the current default's literal into the file.

`harness agent` is the loop that consumes the seam — orient, model call,
governed tool call through `exec`/`bash`, one journal record per turn, stop on
a stated condition. It runs a **benchmark profile** that keeps orientation,
retrieval, governed execution and journaling, and drops `gate`, `verify`,
`compound` and human review, whose preconditions a bare container lacks. The
drops are reported rather than synthesized: a plan file written to satisfy
`gate` would measure ceremony instead of capability.
