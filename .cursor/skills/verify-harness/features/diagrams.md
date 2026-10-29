# Self-contained diagram rendering

Named check: `adaptive-diagram-tests`.

Run the ordinary doctor first. This check runs disposable workspaces and fresh package installations; it starts no server and requires no renderer executable or browser. The source checkout needs its declared package dependencies installed. Offline installation fixtures use private empty npm caches, omit optional grammars, and keep lifecycle scripts enabled.

The command tests invoke the actual `ae diagrams` CLI, inspect the SVG, HTML, source and receipt, then run `diagrams status`. Optional `--png` also writes `diagram.png`, records its sha256, and prints absolute artifact paths. They exercise authored rendering, current worktree imports, published committed-flow projections, changed source and inventory, conflicting or edited artifacts, dry runs, unsafe paths and freshness changes during rendering. Native tool coverage proves the existing Engineer Harness tool admits the strict command grammar without a product implement gate and rejects unknown or mixed shell mutations.

Renderer checks cover Pele plus D2 TALA, ELK and Dagre, deterministic output, deadlines, input/output limits, policy rejection and network refusal in D2's nested worker. V8 worker limits do not impose a total WASM memory quota. These libraries execute restricted diagram text; they are not a sandbox for arbitrary code.

Package tests pack the actual source, install it both locally and globally with `--offline --omit=optional`, invoke the installed CLI from foreign directories and paths containing spaces, and render both engines. They repack the installed package and compare archive bytes within the selected npm/runtime. Package notices and release guards retain the upstream worker, WASM, font and license assets.

Success proves these CLI behaviors. A current receipt binds declared source and artifact bytes; it does not prove the host-authored architecture explanation, runtime behavior, native editor activation, or model quality. Inspect the resulting diagrams as well as the exit code. Repository examples live in `docs/diagrams/` and disclose their scope and omissions.

For an exact minimum-runtime check, repeat the renderer/projection and installed-package tests with Node 20.0.0 and a compatible npm. Record the actual versions; do not infer minimum support from a newer Node 20 patch.

Each test owns and removes its temporary workspaces and installation prefixes. Node's TAP report supplies commands/assertions and failures; the configured verification controller retains the check execution. No optional TLC/Java setup is needed.
