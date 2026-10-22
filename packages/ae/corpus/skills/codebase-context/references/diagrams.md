# Local architecture and flow diagrams

Use this reference when the user requests a rendered view, or a diagram materially clarifies the requested codebase explanation. Keep ordinary orientation lightweight. Reuse this skill; a renderer does not need a separate agent, model, MCP server, or workflow entry point.

The Engineer chooses the question, inspects evidence, authors the explanation, and judges whether it is useful. Harness performs deterministic source capture, bounded rendering, artifact publication, and receipt checks. Neither a successful render nor a current receipt proves that the authored relationships are correct or complete.

## Choose the evidence and view

| Need | Input and operation | Interpretation |
| --- | --- | --- |
| Explain an architecture boundary or proposed design | Authored `.d2` or `.mmd` and explicit source paths with `diagrams render` | Agent-authored inference; name assumptions and uncertainty |
| Inspect module dependencies or dependents | Current repository file with `diagrams graph` | Bounded observed import relationships, not runtime calls |
| Visualize a published descriptive statechart | Existing exact flow ID with `diagrams flow` | The recorded committed-default-branch model, with its freshness and limitations |

For an architecture view, inspect entry points, configuration, state writers, and the relevant dependencies. Record which relationships are directly observed, inferred, proposed, or unresolved in the accompanying explanation. A declared product or harness delegation graph is not a runtime architecture map. Do not silently convert an import edge into a request, event, or data-flow assertion.

Use a small view around one question. Keep context, components, deployment, and behavior in separate views when combining them would obscure the answer. Preserve readable labels, meaningful boundaries, edge direction, and uncertainty before spending effort on appearance.

## Render an authored view

```bash
ae diagrams render --file docs/diagrams/architecture.d2 --sources src/orders,config/orders.json --renderer d2 --layout tala --json
ae diagrams render --file docs/diagrams/recovery.mmd --sources src/orders --renderer pele --json
```

All paths are repository-relative. `--sources` is a comma-separated selection of explicit files or directories. Include likely locations of additional writers: directory watches capture their inventory so a new file can invalidate freshness. A diagram source alone cannot establish source coverage. Without `--sources`, the result is explicitly `diagram-only`; do not present it as source-bound architecture evidence.

Pele renders Mermaid to SVG without a browser. D2 uses its bundled JavaScript/WASM engine; TALA is the architecture layout, while ELK and Dagre are available for directional views. The dependencies load on demand in bounded workers. Rendering invokes no model, fetches no remote, and installs no executable, package, or browser at runtime. Users do not need global D2, TALA, Graphviz, Java, or Chromium installations for these commands.

The Harness accepts a deliberately restricted subset of each source language, rather than every feature in upstream Mermaid or D2. Use plain Mermaid flow or state syntax without author-controlled directives, clicks, styles, or HTML. Use plain D2 nodes, labels, containers, and connections without imports, configuration, variables, links, icons, or markup. Harness owns renderer options and TALA seeds. A rejected feature is an explicit unsupported-input result; simplify the view rather than bypassing validation or installing another renderer during the task.

## Inspect existing facts and flows

```bash
ae diagrams graph --root src/orders/service.ts --operation deps --depth 2 --limit 40 --json
ae diagrams graph --root src/orders/service.ts --operation dependents --depth 2 --limit 40 --json
ae diagrams flow --flow order-recovery --json
```

Dependency views reuse the current worktree import query. Read coverage, unresolved imports, clipping, and other limitations before interpreting missing edges. Current worktree bytes may differ from feature HEAD and from the default branch. This is an import graph, not a complete codebase or architecture extractor.

Flow views reuse the published model from [flow-models.md](flow-models.md); they do not author or regenerate one. Its baseline is the locally observed committed default branch, not dirty files or an unseen remote tip. Preserve the returned generation and freshness when explaining it. An absent or stale model is not repaired by rendering. Regeneration is a separate explicit source-inspection and publication procedure.

## Review artifacts and freshness

A successful creation returns an `id` and `artifacts` paths for `svg`, `html`, and `receipt`. The default output is an immutable directory under `.harness/diagrams/<id>/`. Open the self-contained HTML or SVG and inspect labels, boundaries, crossings, and clipping. Keep the source as the editable input; rendered output is a derived artifact.

```bash
ae diagrams status --receipt .harness/diagrams/<id>/receipt.json --json
```

Use the returned receipt path rather than constructing an identity. Status rechecks the retained artifacts and the relevant source bindings. Changed or missing evidence must remain visible; a successful old render is not evidence of current source. Open the canonical SVG or HTML path returned in `artifacts`; there is no diagram-specific output destination flag.

Report the view's purpose, input scope, authored versus extracted provenance, currentness, omissions, and artifact paths. If the diagram conflicts with accepted intent, preserve the finding and follow the ordinary amendment or defect workflow. Diagrams never accept requirements, grant mutation authority, satisfy correctness checks, or upgrade a descriptive statechart into TLA+ proof. Deep model checking remains in the selected product verification recipe.
