# Diagram sources and local rendering

These small, hand-authored examples exercise the local diagram commands. They are explanatory inferences, not automatically extracted architecture facts, exhaustive behavior models, or model-checker results.

Open the [rendered gallery](generated/gallery.html) or inspect the [architecture](generated/architecture.svg), [dependency](generated/dependencies.svg), and [recovery](generated/recovery.svg) SVGs. These are actual CLI outputs; [samples.json](generated/samples.json) records the commands, renderer settings, observed freshness and output hashes. They are saved examples and must be regenerated to describe later source changes.

| Source | Purpose | Evidence and limits |
| --- | --- | --- |
| [ae-rendering.d2](ae-rendering.d2) | Explain the Engineer/Harness rendering boundary | The documented diagram command contract and [Adaptive Engineering](../adaptive-engineering.md); conceptual responsibilities, not a runtime call graph |
| [recovery.mmd](recovery.mmd) | Explain a simplified structured plan-update retry | `structuredPlanUpdate` in [plan-update.mjs](../../packages/ae/lib/plan-update.mjs); omits detailed locks, authority checks, completion prerequisites, and conversion handling |

The Engineer authors the view after inspecting sources. Harness renders the selected text and records source/artifact bindings. Optional directory watches include newly added regular files in freshness checks. Keeping a receipt current does not validate the explanation's semantics.

From the repository root with AE installed:

```bash
ae diagrams render --file docs/diagrams/ae-rendering.d2 --sources docs/adaptive-engineering.md,packages/ae/lib/diagram.mjs,packages/ae/lib/diagram-cmd.mjs,packages/ae/lib/diagrams --renderer d2 --layout tala --json
ae diagrams render --file docs/diagrams/recovery.mmd --sources packages/ae/lib/plan-update.mjs --renderer pele --json
ae diagrams graph --root packages/ae/lib/diagram-cmd.mjs --operation deps --depth 2 --limit 24 --max-nodes 7 --json
```

The JSON result supplies immutable `.harness/diagrams/<id>/` paths for the SVG, self-contained HTML, and receipt. Open the returned HTML locally. Check freshness with `ae diagrams status --receipt <returned-receipt-path> --json`. Raw rendering without `--sources` remains `diagram-only`.

`ae diagrams flow --flow <existing-flow-id> --json` visualizes an already published descriptive statechart; it does not generate or update that model. Flow baselines describe the locally observed committed default branch. Dependency diagrams describe current worktree imports and retain coverage limitations. Neither is a complete runtime architecture map.

The bundled renderers load on demand; these operations require no MCP server, network request, runtime package installation, or global rendering executable. Only a bounded subset of Mermaid/D2 is accepted. Keep examples plain: no imports, remote assets, links, directives, configuration, or injected markup. The Harness chooses renderer options and TALA seeds.

In regular work, ask the Engineer to inspect the sources and explain one boundary or recovery question. Use the import view to check dependency assumptions, author the explanation in D2 or Mermaid, render it, and inspect the returned HTML. Before reusing it during review, run receipt status. The editable diagram source stays with the design; SVG/HTML are derived outputs. PNGs in this folder are documentation previews, produced from the SVGs outside the runtime CLI.
