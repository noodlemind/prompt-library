# Factual context

Use `harness report --facts --plan <path> --json` when a requested report needs inventory, versions, declared graphs, plan states, named checks or completion fields. Ordinary Answer mode can inspect one relevant source without loading the full inventory. `orient` retains its bounded pack and exposes plan-state counts plus current review-coverage facts.

The schema1 report uses actual Git-visible regular files, bounded source snapshots and existing review/proof/completion validators. Source references contain exact paths and SHA256 bindings. Product declarations come from `.github/agents` and `.copilot/agents`; the separately rooted installed Harness graph is capability context. Graphs contain declared delegation/handoffs only. Inferred architecture, runtime flow, impact, effort and priority remain agent explanations.

Npm manifest ranges and supported lockfile versions have distinct assurance labels. Unsupported manifests, unsafe files and missing indexes are explicit. A historical passed outcome or completion timestamp does not establish current proof. Completion tables show both observed record fields and validation of their currentness.

Output defaults to16KiB. Use --max-bytes between2048 and65536; omitted rows have exact counts. `harness lookup file <path>` and `harness get --path <path>` retrieve product source excerpts. Read source paths directly for records not supported by an indexed lookup, and use an explicit root for installed/private sources. No generated context service is introduced. Gate, selected intent and coverage survive pack shortening; optional omissions are marked.
