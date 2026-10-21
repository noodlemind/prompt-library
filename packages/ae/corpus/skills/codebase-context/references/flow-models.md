# Shared descriptive application flows

Use this reference for an explicit flow-model request, relevant orientation expansion, or a compound maintenance advisory. The Engineer interprets source and authors the map. Harness binds committed inputs, validates the structured statechart, publishes immutable generations, and reports freshness. It never calls a model or fetches a remote.

## Read relevant context

```bash
ae flows status --json
ae flows show --json
```

Status is `absent`, `current`, `stale`, or `unknown`. Show returns the recorded model and preparation when available. Keep the returned generation commit, source hashes, default reference, and limitations when explaining it. Invalid or unavailable evidence stays unknown.

Orientation supplies at most 4096 bytes of flow pointers only when the task files or flow ID match an existing model. It supplies the reference, hash, matched IDs, freshness, and omissions, not the model body. Read this reference and expand with `flows show` only when those flows matter. A missing optional map adds no plan or delivery requirement.

`scope: committed-default-branch` means the locally observed default ref, resolved from configuration or `origin/HEAD`, preferring its available origin tracking ref and otherwise its matching local branch. It is not a claim about an unseen remote tip. Feature HEAD and dirty worktree bytes are not this baseline. Inspect the task candidate separately before deciding intent completeness or correctness.

## Prepare observed source bindings

Choose directories or exact files containing the flow's entry points, state writers, configuration, and recovery logic. Include likely locations of new writers. Use a contained JSON scope file, for example:

```json
{"watchPaths":["src/orders","config/orders.json"]}
```

```bash
ae flows prepare --file .harness/decisions/flow-scope.json --json
```

Without `--file`, prepare reuses an existing map's watch paths, or starts with `.`. Narrow an oversized inventory rather than silently omit sources. The returned preparation binds the existing project identity, observed generation commit and default ref, watch paths, exact committed regular files and modes, source SHA-256 hashes, and a digest. Preserve that object verbatim; do not manufacture hashes or edit its selection after preparation.

Preparation reads raw committed blobs. Before authoring the model, inspect the listed files at the returned commit using source tools, not whichever bytes happen to be in a feature checkout. Map relevant event order, guards, state changes, failure, cancellation, and recovery. Keep observed behavior distinguishable from assumptions and uncovered paths. A detected contradiction with accepted intent is a finding, not permission to rewrite the requirement.

## Author and publish

The candidate has exactly `version: 1`, the returned `preparation` object, and an authored `model`. The model has `version: 1`, `format: "statechart"`, and `flows`; optional `assumptions` and `limitations` are arrays of explanatory strings.

Each flow supplies:

| Field | Meaning |
| --- | --- |
| `id`, `title` | Stable lowercase kebab ID and readable title |
| `sources` | Exact captured source paths supporting this flow |
| `initial`, `states` | Initial state ID and records with `id`; optional `kind` is `normal`, `initial`, `terminal`, or `error` |
| `transitions` | Records with `from`, `to`, and `event`, plus an optional descriptive `guard` |
| `properties` | Optional descriptive observations; these are not accepted proof obligations |

State IDs begin with a letter and contain letters, digits, underscores, or hyphens. Every transition endpoint must name a declared state. Every flow source must belong to the preparation. Record assumptions and limitations even when the schema permits their omission. The shared format is a structured statechart; deeper TLA+/PlusCal models belong to the selected repository verification recipe.

```bash
ae flows publish --file .harness/decisions/flow-candidate.json --json
ae flows status --json
```

Publish rejects changed preparation, another project identity, invalid edges, and conflicting bytes for an existing generation. Identical publication can replay. Do not hand-edit the private store or its current pointer. Use CLI-returned references instead of reconstructing repository IDs. Linked worktrees share the project's generations in the selected Harness home; this is local shared state, not automatic cross-machine synchronization.

## Maintain after relevant advancement

A later observed default tip with changed watched files makes the map stale, including newly committed files beneath watched directories. An unrelated linear advance may leave the older generation current for its declared scope. Divergence, changed default resolution, missing objects, corrupt records, or unresolved metadata are unknown. Status does not fetch or repair them.

After a successful compound, `flowMaintenance` appears only for an existing stale map. It is an advisory read/prepare pointer, not an agent invocation or a new completion gate. Compound does not merge main, publish a model, or create a map when none exists. The Engineer explicitly prepares again, inspects the new committed inputs, authors the replacement generation, and publishes within the authorized scope. Explicit requests can use the same procedure independently of compound.

## Limits and authority

- The inventory permits at most 64 watch paths, 2048 committed sources, 1 MiB per source, and 16 MiB of source bytes. Unsupported or oversized inputs fail explicitly.
- A candidate permits at most 64 flows and 1 MiB of serialized JSON. Each flow has at most 128 states and 512 transitions. Context pointers report omissions within their own budget.
- A structurally valid map is not a model-checker result, complete behavioral coverage, accepted intent, or permission to edit. It never becomes an automatic `intent_sources` entry.
- Use the map to ask better completeness questions. Required correctness evidence stays with trusted named checks and the maintained product recipe; stale required proof remains a real verification gap.
