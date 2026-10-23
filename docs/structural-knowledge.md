# Structural evidence and impact context

AE keeps extraction and source validation inside the Harness CLI. Engineer chooses the question, inspects evidence and decides scope. Intent, plan, review and named-check authority remain unchanged.

## Ask a bounded question

```bash
ae graph deps src/orders/service.ts --depth 2 --limit 40 --json
ae graph dependents src/orders/service.ts --depth 2 --json
ae graph path src/api/orders.ts src/orders/repository.ts --json
ae graph explain src/api/orders.ts src/orders/service.ts --json
ae graph impact src/orders/service.ts --depth 2 --limit 40 --json
```

These are directed module-import relationships. `explain` returns supporting occurrences and resolver details. `impact` traverses reverse imports to affected candidates; it does not claim every caller or affected test. Live CLI/native paths prepare the shipped AST index when necessary; publication refusal, including the 10 MB table bound, returns explicitly labeled lexical evidence and a preparation reason. Source mutation still fails closed. Direct synchronous library queries can report a degraded lexical tier without a compatible prepared index. Read tier, scope, omissions and unresolved relationships before acting.

The default structural inventory covers recognized **Git-tracked source**, capped at 4,000 files and 200,000 bytes per file. Untracked callers are outside it. Complete inventory under this scope is not semantic completeness. AST syntax, lexical observations, resolver deductions and runtime observations have different guarantees. Qualified definitions and import bindings narrow candidates, but unsupported DI, Spring profiles, reflection, dynamic imports and generated code require further evidence.

AST JavaScript/TypeScript call candidates reject detected import shadows and require a supported direct named export. Private declarations, nested methods, default-export aliases, re-export routes and CommonJS export surfaces without supported provenance remain unresolved. Lexical named-import references remain labeled approximations for existing structural warnings; they do not establish call sites. Module-import observations remain available independently.

## Select evidence for the task

```bash
ae orient --read --context-version 2 --question-kind change-impact --file src/orders/service.ts --query 'change retry behavior' --json
ae orient --read --context-version 2 --question-kind dependency-path --file src/api/orders.ts --file src/orders/repository.ts --query 'trace persistence' --json
ae orient --read --context-version 2 --question-kind lookup --file src/orders/service.ts --json
ae orient --read --context-version 2 --question-kind prior-lesson --query 'retry ordering' --json
```

Select question kind explicitly. Ordinary orientation remains lightweight. `dependency-path` requires two files; at most four explicit seeds are accepted. Without seeds, eligible lookup/impact questions use lexical code search. A no-hit result needs a more specific symbol or path rather than an invented semantic match. Safe explicit lookup can inspect untracked files without adding them to the graph.

The v2 `slice.impactContext` contains `graphs`, occurrence-focused `sources`, `learnings`, `gaps`, `suggestedVerificationAreas`, coverage and content identity. Excerpts preserve source/representation hashes, exact ranges and redaction. The complete packet is bounded. Read a smaller batch when evidence clips or outer orientation returns a read barrier. Suggested verification areas are advisory paths and cannot select or waive named checks.

The native Harness tool accepts the same arguments. SessionStart and host-adapter reads preserve v2 `contextEvidence` beside the flat host slice, including coverage and barriers. Returned references do not prove that a model or editor consumed them.

## Immutable snapshots and currentness

```bash
ae index --structural --json
ae graph impact src/orders/service.ts --generation <returned-generation-id> --json
```

Use a returned generation identity. Selected generations read recorded facts and identify historical freshness; missing, corrupt, obsolete or evicted generations fail explicitly. They never fall back to live source. Existing retention keeps current and previous generations. New immutable table manifests authenticate historical reads; forward/reverse adjacency stays inside the same publication boundary.

Live freshness still validates bounded inventory, source bytes, recognized configuration and extractor identity. Reusing adjacency cannot justify checking only old nodes: new callers and previously missing targets can alter relationships. Configuration hashes detect change; they do not imply every build/framework configuration is understood. Differential fixtures compare normalized incremental output with clean rebuilds after source, inventory and config mutations.

## Self-contained parsing

Pinned ESM loader, runtime WASM and Java/JS/TS/TSX/Python grammars ship with license/provenance files. Loader and grammar hashes are verified. Ordinary offline installation needs no native parser bindings, build tool, extra executable or server, and performs no runtime download. Unsupported formats retain labeled lexical extraction.

The standalone test installs the actual archive with lifecycle scripts enabled and optional dependencies omitted, using a fresh offline cache, paths with spaces and a working directory outside the package. It parses all five languages, repacks the installed archive and rejects damaged grammar bytes. Installed-package proof remains separate from native editor acceptance.

## Learning applicability

New anchored learnings retain `applicability_version` and selected `{path, sha256}` source bindings. Retrieval and `ae learnings --why` compare them with current safe bytes and return `current`, `needs-review` or `unknown`, qualified as source bindings only.

Changed, missing or unsafe sources request review. Legacy, malformed, unavailable or foreign-repository bindings remain unknown. Even a comment-only edit can request review; it does not invalidate a general lesson by itself. Strengthening and promotion preserve old bindings instead of silently accepting changed bytes. Historical proof and claim status remain intact; no applicability result retires, promotes or verifies a learning. Golden/human authority and branch-local subordination remain unchanged. Memory is untrusted data.

## Qualification

The named `verify-structural-context` drive exercises actual CLI impact, citations, snapshots and packets. Run the separate multi-language corpus with `node packages/ae/eval/context/run-structural.mjs --out <new-external-directory>`. Its receipts are explicitly mechanical: model usage is unavailable and they cannot promote a context policy.

Live studies require frozen tasks, exact model identity, retention policy, budget and acceptance checks. Measure correctness, missed evidence, unsupported assertions, citations and abstention before time or tokens. Existing promotion requirements and legacy defaults remain unchanged. Mechanical tests establish no model-quality or productivity gain.

Use `ae diagrams graph` for a rendered dependency view. Its projections retain the additive graph evidence. Cited imports remain descriptive evidence, not runtime traces, architecture correctness or formal proof; flow diagrams separately retain their committed-default-branch model scope.
